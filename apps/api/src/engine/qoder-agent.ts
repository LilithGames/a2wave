/**
 * Qoder execution engine
 *
 * Wraps qodercli (https://qoder.com/cli) as a standard a2wave AgentEngine.
 * The headless protocol is isomorphic to Claude Code's (observed with 1.1.51):
 * `-p <prompt> --output-format stream-json` emits a CC-style NDJSON event
 * stream; sessions resume via `--resume <session_id>`. Stream parsing is
 * shared with trae via cc-stream-parser; process/env mechanics come from
 * BaseCliAgentEngine.
 *
 * Auth modes:
 * - apiKey       → injects `QODER_PERSONAL_ACCESS_TOKEN` (a PAT generated at
 *                  qoder.com/account/integrations). Note qodercli's semantics:
 *                  an already-stored login state takes precedence over the env
 *                  PAT — a2wave's runtime-isolated HOME contains no login
 *                  state, so the env PAT takes effect.
 * - localSession → uses the host's `qodercli login` state (`~/.qoder/`,
 *                  HOME-relative); the host HOME is preserved at execution time.
 * - oauth is not supported.
 *
 * Minimum required version 1.0.0: `qodercli status` / `--list-models` do not
 * exist in 0.2.x.
 *
 * Common capabilities (provided by BaseAgentEngine): prompt assembly + safety
 * wrapping, model fallback, MCP sync (writes workspace `.mcp.json`, same
 * convention as Claude Code).
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../lib/logger.js'
import { createCcStreamParser } from './cc-stream-parser.js'
import { BaseCliAgentEngine, type CliEngineBaseConfig, stripPromptArg } from './cli-engine-base.js'
import { formatExitError } from './cursor-agent.js'
import { toDisplayExecParams } from './exec-params.js'
import { createHeartbeatTracker } from './heartbeat.js'
import { runStatusProbe, truncateForRaw } from './login-status-helper.js'
import type {
  ExecuteResult,
  ListModelsOptions,
  LoginStatus,
  ModelListResult,
  StreamExecuteRequest,
} from './types.js'

const ENGINE_TYPE = 'qoder'

/** Heartbeat interval for in-flight tool calls (ms). */
const TOOL_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * Credential-class env vars: authMode is the single source of truth for the
 * credential mode; agentEnv must not carry these keys to override the
 * isolation result (aligned with claude-code's credential-isolation invariant).
 */
const PROTECTED_QODER_ENV_NAMES = ['QODER_PERSONAL_ACCESS_TOKEN', 'QODER_ACCESS_TOKEN'] as const

/** Lenient shape for model-id lines (`ultimate` / `Qwen3.7-Max` / `deepseek-v4-pro`, etc.) */
const MODEL_LINE_PATTERN = /^[A-Za-z0-9._/@:-]+$/

export interface QoderAgentEngineConfig extends CliEngineBaseConfig {
  /** Deployment-level default Personal Access Token (per-agent providerApiKey wins) */
  apiKey: string
  /** Whether to pass --dangerously-skip-permissions ("ask" permissions auto-deny in headless mode) */
  force: boolean
  /** Whether to auto-approve MCP tool calls (--allowed-tools mcp__*) */
  approveMcps: boolean
}

export class QoderAgentEngine extends BaseCliAgentEngine {
  readonly type = ENGINE_TYPE
  protected readonly cliName = 'qodercli'
  private config: QoderAgentEngineConfig

  constructor(config: QoderAgentEngineConfig) {
    super(config)
    this.config = config
  }

  // ----------------------------------------------------------
  // Public: login status / model list
  // ----------------------------------------------------------

  /**
   * Probes host login state via `qodercli status` (available since 1.0.x).
   * Output looks like:
   *   Version: 1.1.51
   *   Username: Alice
   *   Email: alice@example.com
   * When not logged in, the line is `Account: Not logged in`.
   */
  async checkLoginStatus(): Promise<LoginStatus> {
    const result = await runStatusProbe(this.config.path, ['status'], { logTag: 'qoder' })
    if (result.notFound) {
      return {
        installed: false,
        loggedIn: false,
        error: `qodercli not found in PATH (${this.config.path})`,
      }
    }
    if (result.timedOut) {
      return {
        installed: true,
        loggedIn: false,
        error: 'qodercli status timed out',
        raw: truncateForRaw(result.stdout || result.stderr),
      }
    }

    const out = result.stdout
    const email = out.match(/^\s*Email:\s*(\S+)\s*$/im)?.[1]
    const username = out.match(/^\s*Username:\s*(.+?)\s*$/im)?.[1]
    const notLoggedIn = /not\s+logged\s+in/i.test(out)
    const loggedIn = result.exitCode === 0 && !notLoggedIn && Boolean(email || username)
    return {
      installed: true,
      loggedIn,
      ...(loggedIn
        ? { detail: `Logged in as ${email || username}`, method: email || username }
        : {
            error: notLoggedIn
              ? 'Not logged in (run `qodercli login` on host)'
              : result.stderr.trim() || `exit ${result.exitCode}`,
          }),
      raw: truncateForRaw(out || result.stderr),
    }
  }

  /**
   * Lists the models available to the current account via
   * `qodercli --list-models` (available since 1.0.x).
   *
   * - localSession → runs directly against the host `~/.qoder/` login state
   * - apiKey       → injects the `QODER_PERSONAL_ACCESS_TOKEN` env var and
   *                  points `--config-dir` at a throwaway empty directory:
   *                  under qodercli's "stored login takes precedence over the
   *                  env PAT" semantics, only an empty config dir guarantees
   *                  the probe authenticates with the PAT
   */
  async listAvailableModels(options: ListModelsOptions): Promise<ModelListResult> {
    if (options.authMode === 'oauth') {
      return {
        models: [],
        error: 'Qoder CLI does not support oauth mode (use apiKey or localSession)',
        code: 'unsupported_mode',
      }
    }

    const args = ['--list-models']
    let env: NodeJS.ProcessEnv | undefined
    let isolatedConfigDir: string | undefined
    if (options.authMode === 'apiKey') {
      if (!options.apiKey) {
        return { models: [], error: 'apiKey is required for apiKey mode', code: 'invalid_input' }
      }
      isolatedConfigDir = mkdtempSync(join(tmpdir(), 'a2wave-qoder-probe-'))
      args.push('--config-dir', isolatedConfigDir)
      env = { QODER_PERSONAL_ACCESS_TOKEN: options.apiKey }
    }

    let result: Awaited<ReturnType<typeof runStatusProbe>>
    try {
      result = await runStatusProbe(this.config.path, args, {
        logTag: 'qoder-models',
        timeoutMs: 20_000,
        ...(env ? { env } : {}),
      })
    } finally {
      // The probe has awaited to completion (CLI exited), so the throwaway
      // config dir is safe to remove — otherwise it leaks one empty dir per
      // apiKey probe under the API process's tmpdir.
      if (isolatedConfigDir) {
        try {
          rmSync(isolatedConfigDir, { recursive: true, force: true })
        } catch (err) {
          logger.warn({ err, dir: isolatedConfigDir }, '[qoder] failed to remove probe config dir')
        }
      }
    }
    if (result.notFound) {
      return { models: [], error: 'qodercli not found in PATH', code: 'spawn_failed' }
    }
    if (result.timedOut) {
      return { models: [], error: 'qodercli --list-models timed out', code: 'timeout' }
    }
    const combined = result.stdout || result.stderr
    if (/not\s+logged\s+in/i.test(combined)) {
      return {
        models: [],
        error:
          options.authMode === 'apiKey'
            ? 'Personal Access Token was not accepted by qodercli'
            : 'Not logged in (run `qodercli login` on host)',
        code: 'local_session_not_logged_in',
        details: { raw: truncateForRaw(combined, 300) },
      }
    }
    if (result.exitCode !== 0) {
      const stderrSample = truncateForRaw(result.stderr, 300)
      return {
        models: [],
        error: stderrSample || `qodercli exit ${result.exitCode}`,
        code: 'cli_failed',
        details: { exitCode: result.exitCode, stderr: stderrSample },
      }
    }
    // Simple table output: a `MODEL` header row, then one model name per line
    const models = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line !== 'MODEL' && MODEL_LINE_PATTERN.test(line))
    if (models.length === 0) {
      return {
        models: [],
        error: 'qodercli --list-models returned no parseable model names',
        code: 'parse_failed',
        details: { raw: truncateForRaw(result.stdout, 300) },
      }
    }
    logger.info({ count: models.length, sample: models.slice(0, 3) }, '[qoder] listAvailableModels')
    return { models }
  }

  // ----------------------------------------------------------
  // Protected: execution (single model) — called by BaseAgentEngine
  // ----------------------------------------------------------

  protected async executeStreamWithModel(
    request: StreamExecuteRequest,
    model: string,
  ): Promise<ExecuteResult> {
    const {
      taskId,
      workDir,
      prompt,
      chatId: inputChatId,
      onUpdate,
      onLogEntry,
      agentConfig,
    } = request
    const perAgentApiKey = agentConfig?.providerApiKey as string | undefined
    const authMode =
      (agentConfig?.authMode as 'apiKey' | 'oauth' | 'localSession' | undefined) ?? 'apiKey'
    const resolvedWorkDir = workDir || this.config.defaultWorkDir

    const args = this.buildArgs(prompt, model, inputChatId, {
      readOnly: agentConfig?.readOnly !== undefined ? Boolean(agentConfig.readOnly) : undefined,
      force: agentConfig?.force !== undefined ? Boolean(agentConfig.force) : undefined,
      approveMcps:
        agentConfig?.approveMcps !== undefined ? Boolean(agentConfig.approveMcps) : undefined,
    })
    const resolvedApiKey = perAgentApiKey || this.config.apiKey
    const execEnv = this.buildCredentialEnv({
      protectedNames: PROTECTED_QODER_ENV_NAMES,
      // apiKey mode injects the PAT; localSession clears it and keeps the
      // host HOME (credentials live under ~/.qoder/)
      ...(authMode !== 'localSession'
        ? { inject: { QODER_PERSONAL_ACCESS_TOKEN: resolvedApiKey } }
        : { omitRuntimeKeys: ['HOME'] }),
      agentEnv: agentConfig?.agentEnv as Record<string, string> | undefined,
      runtimeEnv: request.runtimeContext?.env,
    })
    const streamTimeoutMinutes = agentConfig?.timeoutMinutes ?? this.config.timeoutMinutes
    const streamTimeoutMs = streamTimeoutMinutes * 60 * 1000

    const execParams: Record<string, unknown> = {
      cmd: this.config.path,
      args: stripPromptArg(args),
      cwd: resolvedWorkDir,
      authMode,
      timeout: streamTimeoutMs,
      runtimeHome: request.runtimeContext?.home.dir,
      workspaceDir: request.runtimeContext?.workspace.dir,
      workspaceType: request.runtimeContext?.workspace.type,
      artifactsDir: request.runtimeContext?.artifacts.dir,
    }
    if (authMode === 'apiKey' && resolvedApiKey) {
      execParams.apiKey = `${resolvedApiKey.slice(0, 8)}***`
    }
    logger.info({ taskId, ...execParams }, '[qoder] execute (stream) params')
    onLogEntry?.({
      type: 'exec_params',
      engine: 'qoder',
      params: toDisplayExecParams(execParams),
      ts: Date.now(),
    })
    onLogEntry?.({ type: 'system', subtype: 'preparing', ts: Date.now() })

    const heartbeat = createHeartbeatTracker({
      intervalMs: TOOL_HEARTBEAT_INTERVAL_MS,
      emit: (entry) => onLogEntry?.(entry),
    })
    const parser = createCcStreamParser({
      onUpdate,
      onLogEntry,
      heartbeat,
      initialSessionId: inputChatId,
      // Qoder uses credit-based billing and emits placeholder token usage.
      // Leave it untracked rather than persisting a misleading zero.
      collectUsage: false,
    })

    return this.runCliStream({
      taskId,
      args,
      env: execEnv,
      cwd: resolvedWorkDir,
      timeoutMs: streamTimeoutMs,
      onStdoutLine: parser.parseLine,
      parseStderrLines: true,
      onSpawned: () => onLogEntry?.({ type: 'system', subtype: 'spawned', ts: Date.now() }),
      cleanup: () => heartbeat.stop(),
      settle: ({ exitCode, stderr }) => {
        const { resultIsError, resultErrorText, resultReceived, outputBuffer, sessionId } =
          parser.state
        logger.info({ taskId, exitCode, resultReceived, resultIsError }, 'qoder process exited')
        // Usage is intentionally omitted; see collectUsage above.
        if (resultIsError) {
          return {
            ok: false,
            error: new Error(resultErrorText || stderr || 'Qoder stream execution failed'),
          }
        }
        if (resultReceived || exitCode === 0) {
          return {
            ok: true,
            result: { success: true, output: outputBuffer, chatId: sessionId },
          }
        }
        return { ok: false, error: new Error(formatExitError(exitCode ?? 1, stderr)) }
      },
    })
  }

  // ----------------------------------------------------------
  // Private: CLI args
  // ----------------------------------------------------------

  private buildArgs(
    prompt: string,
    model: string,
    chatId?: string,
    extras?: { readOnly?: boolean; force?: boolean; approveMcps?: boolean },
  ): string[] {
    const args = ['-p', prompt, '--output-format', 'stream-json']
    if (extras?.readOnly) {
      args.push('--permission-mode', 'plan')
    }
    // In headless (-p) mode, "ask"-class permissions are automatically denied,
    // so unattended execution typically needs the bypass enabled
    if (extras?.force ?? this.config.force) {
      args.push('--dangerously-skip-permissions')
    }
    if (extras?.approveMcps ?? this.config.approveMcps) {
      args.push('--allowed-tools', 'mcp__*')
    }
    if (chatId) args.push('--resume', chatId)
    if (model) args.push('-m', model)
    return args
  }
}
