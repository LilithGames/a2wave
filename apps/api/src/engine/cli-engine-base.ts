/**
 * BaseCliAgentEngine — shared adapter base for CLI-backed engines.
 *
 * Layering (hexagonal): `AgentEngine` (types.ts) is the port the run
 * orchestrator depends on; `BaseAgentEngine` owns cross-engine orchestration
 * (prompt assembly, skills/MCP/KB sync, model fallback); this class owns the
 * mechanics every "spawn a CLI" adapter repeats:
 *
 * - health check + version probe via `<cli> --version`
 * - work-dir setup and delegation to the process-wide `CliProcessRunner`
 * - the CLI-specific settle adapter around the shared spawn → timeout →
 *   line-buffered stdout → close/error pipeline
 * - the credential env matrix (`buildCredentialEnv`): protected-name
 *   stripping, per-mode injection, agentEnv sanitizing, runtime-env merging
 * - prompt-plaintext stripping for exec_params logs (`stripPromptArg`)
 *
 * All built-in engines stay thin: buildArgs + a stream parser + a settle verdict.
 */

import { unsetEnv } from '../lib/env-utils.js'
import { logger } from '../lib/logger.js'
import { BaseAgentEngine } from './base-engine.js'
import { cliProcessRunner } from './cli-process-runner.js'
import { probeCliVersion, runStatusProbe } from './login-status-helper.js'
import {
  buildSafeAgentProcessEnv,
  isProcessInjectionEnvName,
  omitRuntimeEnvKeys,
  PROCESS_INJECTION_ENV_NAMES,
  sanitizeAgentRuntimeEnv,
} from './runtime-context.js'
import type { ExecuteResult, TokenUsage } from './types.js'
import { attachUsageToError } from './usage.js'

export type { ErrorWithUsage } from './usage.js'
export { extractUsageFromError } from './usage.js'

// Process-injection env names are defined in runtime-context (the single point
// every engine funnels agent env through via sanitizeAgentRuntimeEnv) and
// re-exported here for buildCredentialEnv's blocklist. Keeping one source of
// truth means engines that override buildEnv (claude-code/cursor) and those that
// use the credential matrix (codex/opencode) strip the exact same set.
export { PROCESS_INJECTION_ENV_NAMES }

/** Config every CLI engine shares; engine-specific configs extend it. */
export interface CliEngineBaseConfig {
  /** CLI executable path */
  path: string
  /** Execution timeout (minutes) */
  timeoutMinutes: number
  /** Default agent work directory */
  defaultWorkDir: string
}

/** Outcome verdict a subclass returns from `settle` after the process closes. */
export type CliStreamVerdict =
  | { ok: true; result: Omit<ExecuteResult, 'durationMs'> }
  | { ok: false; error: Error; usage?: TokenUsage }

export interface RunCliStreamOptions {
  taskId: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
  /** Complete input to write to the child process stdin after spawn. */
  stdin?: string
  /** Called for each complete stdout line (line-buffered; remainder flushed on close) */
  onStdoutLine: (line: string) => void
  /** Also feed stderr lines to onStdoutLine (some CLIs emit events on stderr) */
  parseStderrLines?: boolean
  /** Fired once the child process has spawned */
  onSpawned?: () => void
  /** Always runs on close/error before settling (e.g. heartbeat.stop) */
  cleanup?: () => void
  /** Latest parsed usage, used when timeout/cancellation bypasses settle. */
  getUsage?: () => TokenUsage | undefined
  /** Decide success/failure from exit code + collected stderr */
  settle: (ctx: { exitCode: number | null; stderr: string }) => CliStreamVerdict
}

export abstract class BaseCliAgentEngine extends BaseAgentEngine {
  /** Human-readable CLI name for error messages (e.g. `qodercli`) */
  protected abstract readonly cliName: string
  protected readonly cliConfig: CliEngineBaseConfig
  protected constructor(cliConfig: CliEngineBaseConfig) {
    super()
    this.cliConfig = cliConfig
  }

  // ----------------------------------------------------------
  // Health / version
  // ----------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    const result = await runStatusProbe(this.cliConfig.path, ['--version'], {
      timeoutMs: 10_000,
      logTag: `${this.cliName}-health`,
    })
    if (result.notFound || result.timedOut || result.exitCode !== 0) {
      logger.warn(
        { path: this.cliConfig.path, stderr: result.stderr },
        `${this.cliName} CLI not found or not executable`,
      )
      return false
    }
    return true
  }

  async getVersion(): Promise<string | null> {
    return probeCliVersion(this.cliConfig.path)
  }

  protected override getDefaultWorkDir(): string {
    return this.cliConfig.defaultWorkDir
  }

  // ----------------------------------------------------------
  // Spawn pipeline
  // ----------------------------------------------------------

  /**
   * Shared spawn → timeout → line-buffer → close/error pipeline. Subclasses
   * provide the args/env and a `settle` verdict; event parsing happens in
   * `onStdoutLine`.
   */
  protected runCliStream(options: RunCliStreamOptions): Promise<ExecuteResult> {
    const { settle, getUsage } = options

    return cliProcessRunner
      .run({
        ...options,
        command: this.cliConfig.path,
        label: this.cliName,
      })
      .then((processResult) => {
        if (processResult.reason === 'timeout') {
          throw attachUsageToError(
            new Error(`${this.cliName} stream execution timed out`),
            getUsage?.(),
          )
        }
        if (processResult.reason === 'cancelled') {
          throw attachUsageToError(
            new Error(`${this.cliName} stream execution cancelled`),
            getUsage?.(),
          )
        }
        if (processResult.reason === 'spawn-error') {
          const error = processResult.error ?? new Error('Unknown spawn error')
          const isNotFound = (error as NodeJS.ErrnoException).code === 'ENOENT'
          throw new Error(
            isNotFound
              ? `${this.cliName} CLI not found in PATH ("${this.cliConfig.path}"). Please install it first.`
              : `${this.cliName} spawn error: ${error.message}`,
          )
        }

        const verdict = settle({
          exitCode: processResult.exitCode,
          stderr: processResult.stderr,
        })
        if (!verdict.ok) {
          throw attachUsageToError(verdict.error, verdict.usage)
        }
        return { ...verdict.result, durationMs: processResult.durationMs }
      })
  }

  // ----------------------------------------------------------
  // Credential env matrix
  // ----------------------------------------------------------

  /**
   * Build the child-process env under the credential-isolation invariant:
   * authMode is the single source of truth — protected names are stripped
   * from the inherited env AND from agentEnv, then the mode's own injection
   * is applied, then the runtime isolation env (minus `omitRuntimeKeys`,
   * e.g. HOME for localSession) wins.
   */
  protected buildCredentialEnv(options: {
    protectedNames: readonly string[]
    /**
     * Names blocked from `agentEnv`/`runtimeEnv` but PRESERVED from the
     * inherited `process.env`.
     *
     * For a var that relocates a credential store (e.g. Kimi's
     * `KIMI_CODE_HOME`, or `HOME` itself), the two sources need opposite
     * treatment: an Agent editor must never set it, yet the operator's own
     * value has to survive or the CLI cannot find the login it is supposed to
     * reuse. Putting such a name in `protectedNames` clears it from
     * `process.env` too and silently severs that login, so it belongs here.
     */
    agentEnvOnlyNames?: readonly string[]
    inject?: Record<string, string | undefined>
    agentEnv?: Record<string, string>
    runtimeEnv?: Record<string, string>
    omitRuntimeKeys?: string[]
  }): NodeJS.ProcessEnv {
    const { protectedNames, agentEnvOnlyNames = [], inject, agentEnv, runtimeEnv } = options
    const { omitRuntimeKeys } = options
    // The credential-token names plus the always-blocked process-injection
    // vectors. agentEnv (Agent-editor controlled) is stripped against this full
    // set; the inherited process environment is independently allowlisted so
    // unrelated service credentials never reach an Agent subprocess.
    const blocklist = [...protectedNames, ...agentEnvOnlyNames, ...PROCESS_INJECTION_ENV_NAMES]
    const env = buildSafeAgentProcessEnv(process.env, agentEnvOnlyNames)
    for (const key of protectedNames) unsetEnv(env, key)
    for (const [key, value] of Object.entries(inject ?? {})) {
      if (value) env[key] = value
    }

    const sanitizedAgentEnv = sanitizeAgentRuntimeEnv(agentEnv ? { ...agentEnv } : undefined)
    if (sanitizedAgentEnv) {
      for (const key of blocklist) unsetEnv(sanitizedAgentEnv, key)
    }
    // runtimeEnv is platform-built and currently carries no dangerous keys, but
    // strip as defense in depth so a future runtimeContext addition cannot
    // silently re-introduce a protected key (it is spread last). Use the full
    // predicate (exact names + LD_*/DYLD_*/GIT_CONFIG_*/npm_config_* patterns),
    // not just the exact-name blocklist, so pattern-family keys are covered too.
    let effectiveRuntimeEnv = omitRuntimeKeys?.length
      ? omitRuntimeEnvKeys(runtimeEnv, omitRuntimeKeys)
      : runtimeEnv
    if (effectiveRuntimeEnv) {
      effectiveRuntimeEnv = { ...effectiveRuntimeEnv }
      for (const key of protectedNames) unsetEnv(effectiveRuntimeEnv, key)
      for (const key of agentEnvOnlyNames) unsetEnv(effectiveRuntimeEnv, key)
      for (const key of Object.keys(effectiveRuntimeEnv)) {
        if (isProcessInjectionEnvName(key)) unsetEnv(effectiveRuntimeEnv, key)
      }
    }
    return { ...env, ...(sanitizedAgentEnv || {}), ...(effectiveRuntimeEnv || {}) }
  }

  /** Kill the process for a specific taskId */
  kill(taskId: string): boolean {
    return cliProcessRunner.cancel(taskId)
  }
}

/**
 * Strip a prompt-carrying flag and its value from an args array so
 * exec_params logs never contain the prompt plaintext.
 */
export function stripPromptArg(args: string[], promptFlags: string[] = ['-p']): string[] {
  const skip = new Set(promptFlags)
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (skip.has(args[i])) {
      i++ // skip flag and its value
    } else {
      result.push(args[i])
    }
  }
  return result
}
