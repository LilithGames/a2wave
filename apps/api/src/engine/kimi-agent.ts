/**
 * Kimi Code execution engine
 *
 * Wraps the Kimi Code CLI (https://moonshotai.github.io/kimi-code/, Moonshot
 * AI) as a standard a2wave AgentEngine. Headless runs use
 * `kimi -p <prompt> --output-format stream-json`, which emits NDJSON on stdout
 * (verified on 0.30.0); sessions resume via `-r <session_id>`.
 *
 * Why this engine does NOT reuse cc-stream-parser: unlike qoder/trae, Kimi's
 * stream-json is OpenAI-chat-shaped (`{role, content, tool_calls}`) rather than
 * Claude Code's `type`-tagged envelope, and it has no `system`/`result` rows at
 * all. Parsing lives in kimi-stream-parser.ts; see its header for the format.
 *
 * Auth mode: localSession only. Kimi Code authenticates through an RFC 8628
 * device-code OAuth flow (`kimi login`), storing credentials under
 * `$KIMI_CODE_HOME/credentials/` (default `~/.kimi-code/`). Per the official
 * env-var docs, credential variables such as `KIMI_API_KEY` are deliberately
 * **not** read from the process environment — they must be written into
 * `config.toml` — so there is no env-injection channel for a per-agent API key
 * and no apiKey/oauth mode to offer. Like opencode, this makes the host login a
 * deployment-level shared account, so execution must preserve the host `HOME`
 * (and any operator-set `KIMI_CODE_HOME`): pointing the data root at the
 * platform's isolated runtime HOME was verified to lose the login state
 * entirely ("No providers configured").
 *
 * Minimum required version 0.30.0: `--output-format stream-json` and
 * `provider list --json` (the model-discovery channel) are relied upon.
 *
 * Common capabilities (provided by BaseAgentEngine): prompt assembly + safety
 * wrapping, model fallback, skill sync (`.kimi-code/skills`), MCP sync (writes
 * the workspace `.kimi-code/mcp.json`, standard `mcpServers` shape).
 */

import { logger } from '../lib/logger.js'
import { BaseCliAgentEngine, type CliEngineBaseConfig, stripPromptArg } from './cli-engine-base.js'
import { formatExitError } from './cursor-agent.js'
import { toDisplayExecParams } from './exec-params.js'
import { createHeartbeatTracker } from './heartbeat.js'
import { createKimiStreamParser } from './kimi-stream-parser.js'
import { runStatusProbe, truncateForRaw } from './login-status-helper.js'
import type { McpConfigDialect } from './mcp-sync.js'
import type {
  ExecuteResult,
  ListModelsOptions,
  LoginStatus,
  ModelListResult,
  StreamExecuteRequest,
} from './types.js'

const ENGINE_TYPE = 'kimi'

/** Heartbeat interval for in-flight tool calls (ms). */
const TOOL_HEARTBEAT_INTERVAL_MS = 20_000

/**
 * Env names an Agent editor must never be able to set.
 *
 * localSession is a deployment-level shared account, so anything that can move
 * the data root, redirect the API/OAuth endpoint, or inject code into the
 * subprocess would expose or misuse the host's shared Kimi credentials:
 * - `KIMI_CODE_HOME` — relocates the data root, i.e. which credential store is
 *   read (and could point at an attacker-writable config.toml);
 * - `KIMI_CODE_BASE_URL` / `KIMI_CODE_OAUTH_HOST` / `KIMI_OAUTH_HOST` /
 *   `KIMI_BASE_URL` — redirect the managed API or the OAuth host, sending the
 *   host's bearer token to an attacker endpoint;
 * - the `KIMI_MODEL_*` family — the one documented channel that *does* read
 *   credentials from the shell: setting `KIMI_MODEL_NAME` synthesizes a whole
 *   provider (key + base URL) in memory and outranks `default_model`, so it can
 *   silently redirect every request off the operator's account;
 * - `KIMI_WEB_SEARCH_*` / `KIMI_WEB_FETCH_*` — service endpoint + key overrides;
 * - `HOME` — resolves the default data path when `KIMI_CODE_HOME` is unset;
 * - `PATH` / `NODE_OPTIONS` and the dynamic-linker family — subprocess
 *   injection vectors (Kimi spawns bash/git/node for its tools).
 *
 * `PATH` / `NODE_OPTIONS` are covered by the PROCESS_INJECTION_ENV_NAMES array
 * and the `LD_*` / `DYLD_*` dynamic-linker family by the isProcessInjectionEnvName
 * prefix patterns, both applied inside buildCredentialEnv; they are named here
 * too so the credential surface reads completely in one place.
 */
const PROTECTED_KIMI_ENV_NAMES = [
  'KIMI_CODE_BASE_URL',
  'KIMI_CODE_OAUTH_HOST',
  'KIMI_OAUTH_HOST',
  'KIMI_BASE_URL',
  'KIMI_API_KEY',
  'KIMI_MODEL_NAME',
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_BASE_URL',
  'KIMI_MODEL_PROVIDER_TYPE',
  'KIMI_WEB_SEARCH_BASE_URL',
  'KIMI_WEB_SEARCH_API_KEY',
  'KIMI_WEB_FETCH_BASE_URL',
  'KIMI_WEB_FETCH_API_KEY',
] as const

/**
 * Blocked from agentEnv but PRESERVED from the operator's process env.
 *
 * `KIMI_CODE_HOME` and `HOME` both select which credential store `kimi` reads.
 * An Agent editor must not be able to redirect them, but clearing them from the
 * inherited env (which `protectedNames` does) would delete the very pointer to
 * the login this engine is built to reuse — leaving the CLI to guess from the
 * OS passwd entry, which is not the documented resolution path and need not
 * match an operator-relocated data root.
 */
const AGENT_ENV_ONLY_KIMI_NAMES = ['KIMI_CODE_HOME', 'HOME'] as const

/** Max chars of stderr surfaced in a run error. */
const STDERR_SAMPLE_CHARS = 300

/**
 * Keep the LAST `STDERR_SAMPLE_CHARS` of stderr.
 *
 * `truncateForRaw` samples the head, which is the wrong end here: the CLI writes
 * thinking and tool progress first and its actual error last, so the head is
 * narration and the tail is the cause.
 */
function truncateStderrTail(stderr: string, maxLen = STDERR_SAMPLE_CHARS): string {
  const trimmed = stderr.trim()
  return trimmed.length <= maxLen ? trimmed : `...${trimmed.slice(-maxLen)}`
}

/** Shape of `kimi provider list --json`. */
interface KimiProviderListJson {
  providers?: Record<string, unknown>
  models?: Record<string, unknown>
}

/**
 * Extract model aliases from `kimi provider list --json`.
 *
 * The `models` keys are the aliases `-m` accepts (e.g. `kimi-code/k3`), which
 * is why the JSON channel is preferred over the human-readable table (the
 * latter prints provider rows and a count, not the alias list).
 */
export function parseKimiModelAliases(stdout: string): string[] {
  let parsed: KimiProviderListJson
  try {
    parsed = JSON.parse(stdout) as KimiProviderListJson
  } catch {
    return []
  }
  const models = parsed.models
  if (!models || typeof models !== 'object' || Array.isArray(models)) return []
  return Object.keys(models).filter((alias) => alias.trim().length > 0)
}

/**
 * No engine-specific options: `-p` rejects `--yolo`/`--auto`/`--plan` and always
 * runs the `auto` permission policy, so there is no force/approveMcps knob to
 * carry, and localSession means no credential field either. Same shape as
 * OpenCode, the other localSession-only engine.
 */
export type KimiAgentEngineConfig = CliEngineBaseConfig

export class KimiAgentEngine extends BaseCliAgentEngine {
  readonly type = ENGINE_TYPE
  protected readonly cliName = 'kimi'
  private config: KimiAgentEngineConfig

  constructor(config: KimiAgentEngineConfig) {
    super(config)
    this.config = config
  }

  /**
   * Kimi names the remote transport with a `transport` key and treats a `url`
   * entry *without* one as streamable HTTP — so an SSE server written in the
   * Claude-family shape would be connected over the wrong transport silently
   * rather than failing loudly.
   */
  protected override get mcpDialect(): McpConfigDialect {
    return 'kimi'
  }

  // ----------------------------------------------------------
  // Public: login status / model list
  // ----------------------------------------------------------

  /**
   * Probes host login state via `kimi provider list --json`.
   *
   * Kimi has no dedicated auth-status subcommand. Signed in, the managed
   * provider (`managed:kimi-code`, `source=oauth`) and its model aliases are
   * listed; signed out the command still exits 0 but returns
   * `{"providers":{},"models":{}}`. loggedIn therefore means "has a usable
   * model", which is exactly the precondition `-p` needs — a signed-out run
   * fails with "No model configured".
   */
  async checkLoginStatus(): Promise<LoginStatus> {
    const result = await runStatusProbe(this.config.path, ['provider', 'list', '--json'], {
      logTag: 'kimi',
      completeEnv: this.buildKimiEnv(),
    })
    if (result.notFound) {
      return {
        installed: false,
        loggedIn: false,
        error: `kimi not found in PATH (${this.config.path})`,
      }
    }
    if (result.timedOut) {
      return {
        installed: true,
        loggedIn: false,
        error: 'kimi provider list timed out',
        raw: truncateForRaw(result.stdout || result.stderr),
      }
    }

    const models = parseKimiModelAliases(result.stdout)
    const loggedIn = result.exitCode === 0 && models.length > 0
    return {
      installed: true,
      loggedIn,
      ...(loggedIn
        ? { detail: `${models.length} model(s) available`, method: 'oauth (device code)' }
        : {
            error:
              result.stderr.trim() ||
              'Not logged in (run `kimi login` on host to start the device-code flow)',
          }),
      raw: truncateForRaw(result.stdout || result.stderr),
    }
  }

  /**
   * Lists the model aliases configured for the host account via
   * `kimi provider list --json`. localSession is the only supported mode, so
   * the probe always runs against the host login state.
   */
  async listAvailableModels(options: ListModelsOptions): Promise<ModelListResult> {
    if (options.authMode !== 'localSession') {
      return {
        models: [],
        error:
          'Kimi Code CLI only supports localSession mode (credentials come from `kimi login`; the CLI does not read API keys from environment variables)',
        code: 'unsupported_mode',
      }
    }

    const result = await runStatusProbe(this.config.path, ['provider', 'list', '--json'], {
      logTag: 'kimi-models',
      timeoutMs: 20_000,
      completeEnv: this.buildKimiEnv(),
    })
    if (result.notFound) {
      return { models: [], error: 'kimi not found in PATH', code: 'spawn_failed' }
    }
    if (result.timedOut) {
      return { models: [], error: 'kimi provider list timed out', code: 'timeout' }
    }
    if (result.exitCode !== 0) {
      // Tail again: the CLI's `error:` line is the last thing it writes.
      const stderrSample = truncateStderrTail(result.stderr)
      return {
        models: [],
        error: stderrSample || `kimi exit ${result.exitCode}`,
        code: 'cli_failed',
        details: { exitCode: result.exitCode, stderr: stderrSample },
      }
    }

    const models = parseKimiModelAliases(result.stdout)
    if (models.length === 0) {
      return {
        models: [],
        error:
          'kimi provider list returned no models — not logged in, or no provider configured (run `kimi login` on host)',
        code: 'local_session_not_logged_in',
        details: { raw: truncateForRaw(result.stdout, 300) },
      }
    }
    logger.info({ count: models.length, sample: models.slice(0, 3) }, '[kimi] listAvailableModels')
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
    // localSession is the only mode the manifest offers; an older Agent row
    // could still carry another value, so normalize rather than trust it.
    const authMode = 'localSession'
    const resolvedWorkDir = workDir || this.config.defaultWorkDir

    const args = this.buildArgs(prompt, model, inputChatId)
    const execEnv = this.buildKimiEnv({
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
    logger.info({ taskId, ...execParams }, '[kimi] execute (stream) params')
    onLogEntry?.({
      type: 'exec_params',
      engine: 'kimi',
      params: toDisplayExecParams(execParams),
      ts: Date.now(),
    })
    onLogEntry?.({ type: 'system', subtype: 'preparing', ts: Date.now() })

    const heartbeat = createHeartbeatTracker({
      intervalMs: TOOL_HEARTBEAT_INTERVAL_MS,
      emit: (entry) => onLogEntry?.(entry),
    })
    const parser = createKimiStreamParser({
      onUpdate,
      onLogEntry,
      heartbeat,
      ...(inputChatId ? { initialSessionId: inputChatId } : {}),
    })

    return this.runCliStream({
      taskId,
      args,
      env: execEnv,
      cwd: resolvedWorkDir,
      timeoutMs: streamTimeoutMs,
      onStdoutLine: parser.parseLine,
      // stderr carries thinking, tool progress and resume notices as plain
      // transcript text (never JSON), so feeding it to the parser would only
      // add noise. Failures surface via the exit code plus the collected
      // stderr in `settle`.
      parseStderrLines: false,
      onSpawned: () => onLogEntry?.({ type: 'system', subtype: 'spawned', ts: Date.now() }),
      cleanup: () => heartbeat.stop(),
      settle: ({ exitCode, stderr }) => {
        const { resultIsError, resultErrorText, outputBuffer, sessionId } = parser.state
        logger.info({ taskId, exitCode, resultIsError }, 'kimi process exited')
        // Kimi's stderr is a prose transcript (thinking + tool progress), so it
        // is never surfaced raw: it would store megabytes of model
        // self-narration in `runs.error`, and classifyOAuthExecutionError
        // substring-matches that text — a stray "rate limit" inside the model's
        // own reasoning would relabel an unrelated failure as a retryable 503.
        //
        // Sample the TAIL, not the head. Both ends of this pipeline agree on
        // "last wins": the runner keeps the final 64KB (appendBoundedTail) and
        // Kimi writes its actual error last, after the narration. Head-sampling
        // would yield a clean-but-causeless excerpt and, worse, hide the cause
        // from the classifier on every run that did work before failing —
        // trading a false positive for a false negative.
        const stderrSample = truncateStderrTail(stderr)
        if (resultIsError) {
          return {
            ok: false,
            error: new Error(resultErrorText || stderrSample || 'Kimi stream execution failed'),
          }
        }
        // The format has no result row, so the exit code is the primary verdict.
        // A signed-out run exits 1 with "No model configured" on stderr.
        if (exitCode === 0) {
          // Exit 0 alone is not proof of completion: with no result row to
          // confirm it, a run that emitted nothing on stdout (everything went
          // to stderr as thinking/progress) would otherwise be persisted as a
          // successful run with an empty answer. Same rule as copilot, which
          // fails an exit-0 run that produced no output.
          if (!outputBuffer) {
            return {
              ok: false,
              error: new Error(
                `Kimi exited without producing any output (exit 0)${stderrSample ? `: ${stderrSample}` : ''}`,
              ),
            }
          }
          return {
            ok: true,
            result: { success: true, output: outputBuffer, chatId: sessionId },
          }
        }
        return { ok: false, error: new Error(formatExitError(exitCode ?? 1, stderrSample)) }
      },
    })
  }

  // ----------------------------------------------------------
  // Private: env & CLI args
  // ----------------------------------------------------------

  /**
   * The single Kimi env constructor, shared by the login probe, the model
   * probe and execution.
   *
   * The three paths MUST agree on the environment: execution clears the
   * `KIMI_MODEL_*` family and the endpoint overrides (see
   * PROTECTED_KIMI_ENV_NAMES), and Kimi synthesizes an in-memory env provider
   * from `KIMI_MODEL_NAME` that outranks `default_model`. A probe that
   * inherited those host variables would therefore report models — and a
   * login state — that no real run can use: the platform would show "logged
   * in" with bindable models while every execution fails with "No model
   * configured". Probes call this with no agent/runtime env; execution passes
   * both.
   */
  private buildKimiEnv(
    options: { agentEnv?: Record<string, string>; runtimeEnv?: Record<string, string> } = {},
  ): NodeJS.ProcessEnv {
    return this.buildCredentialEnv({
      protectedNames: PROTECTED_KIMI_ENV_NAMES,
      agentEnvOnlyNames: AGENT_ENV_ONLY_KIMI_NAMES,
      // The OAuth credential store is resolved through the host HOME (or an
      // operator-set KIMI_CODE_HOME), so the runtime's isolated HOME must not
      // override it — pointing the data root at a fresh dir was verified to
      // present as "not logged in". XDG_CONFIG_HOME is omitted for the same
      // reason, matching the other localSession engines (trae / opencode).
      omitRuntimeKeys: ['HOME', 'XDG_CONFIG_HOME'],
      agentEnv: options.agentEnv,
      runtimeEnv: options.runtimeEnv,
    })
  }

  private buildArgs(prompt: string, model: string, chatId?: string): string[] {
    const args = ['-p', prompt, '--output-format', 'stream-json']
    // Documented flag conflicts: `-p` may not be combined with `--yolo`,
    // `--auto` or `--plan`. Non-interactive runs already apply the `auto`
    // permission policy (static deny rules still hold), so a2wave's
    // force/readOnly execution options have no valid flag here and the
    // manifest deliberately exposes none.
    if (chatId) args.push('-r', chatId)
    if (model) args.push('-m', model)
    return args
  }
}
