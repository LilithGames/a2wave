/**
 * Cursor Agent execution engine
 *
 * Modeled on cursor-agent-hub/agent/executor.go, wrapping the cursor-agent CLI
 * as a standard a2wave AgentEngine.
 *
 * Core capabilities:
 * - Execute tasks via the cursor-agent CLI (streaming)
 * - Session resumption (--resume)
 * - Process timeout & zombie-process protection (via BaseCliAgentEngine)
 *
 * Common capabilities (provided by BaseAgentEngine): prompt assembly + safety
 * wrapping, model fallback.
 */

import { join } from 'node:path'
import { unsetEnv } from '../lib/env-utils.js'
import { logger } from '../lib/logger.js'
import { removeMemoryOverride } from '../lib/memory-storage.js'
import { BaseCliAgentEngine, type CliEngineBaseConfig } from './cli-engine-base.js'
import { parseCursorStreamLine, statKeyFor } from './cursor-stream-parser.js'
import { toDisplayExecParams } from './exec-params.js'
import { createHeartbeatTracker } from './heartbeat.js'
import { runStatusProbe, truncateForRaw } from './login-status-helper.js'
import {
  buildSafeAgentProcessEnv,
  omitRuntimeEnvKeys,
  sanitizeAgentRuntimeEnv,
} from './runtime-context.js'

/** Heartbeat interval for in-flight tool calls (ms). */
const TOOL_HEARTBEAT_INTERVAL_MS = 20_000

import type {
  ExecuteRequest,
  ExecuteResult,
  ListModelsOptions,
  LoginStatus,
  ModelListResult,
  StreamExecuteRequest,
  TokenUsage,
} from './types.js'

// ============================================================
// Constants
// ============================================================

const ENGINE_TYPE = 'cursor'
/** Default executable name; cursor-agent is resolved via PATH. */
const CURSOR_CLI = 'cursor-agent'

// ============================================================
// Helpers
// ============================================================

/** Truncate a string for logging */
function truncate(s: string, maxLen = 200): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}...`
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const result = JSON.parse(text)
    return typeof result === 'object' && result !== null
      ? (result as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Exit code → friendly message map */
const EXIT_CODE_MESSAGES: Record<number, string> = {
  1: 'Execution failed',
  2: 'Command argument error',
  126: 'Permission denied, cannot execute',
  127: 'Command not found',
  128: 'Invalid exit signal',
  130: 'User interrupted execution (Ctrl+C)', // 128 + SIGINT(2)
  137: 'Process forcibly terminated (out of memory or timeout)', // 128 + SIGKILL(9)
  143: 'Execution cancelled', // 128 + SIGTERM(15)
}

/** Format an exit code and stderr into a user-friendly error message. Shared by
 *  the CLI engines (qoder / trae / copilot / opencode / kimi / pi) for their exit paths. */
export function formatExitError(code: number, stderr: string): string {
  const friendlyMsg = EXIT_CODE_MESSAGES[code] ?? `Execution error (code ${code})`
  const stderrTrimmed = stderr.trim()

  if (stderrTrimmed) {
    return `${friendlyMsg}\nDetails: ${stderrTrimmed}`
  }
  return friendlyMsg
}

// ============================================================
// CursorAgentEngine config
// ============================================================

export interface CursorAgentEngineConfig extends Partial<CliEngineBaseConfig> {
  /** cursor-agent CLI API Key */
  apiKey: string
  /** Execution timeout (minutes) */
  timeoutMinutes: number
  /** Whether to pass the --force flag */
  agentForce: boolean
  /** Whether to auto-approve MCP tool calls */
  approveMcps: boolean
  /** Default work directory */
  defaultWorkDir: string
}

// ============================================================
// CursorAgentEngine implementation
// ============================================================

export class CursorAgentEngine extends BaseCliAgentEngine {
  readonly type = ENGINE_TYPE
  protected readonly cliName = CURSOR_CLI
  private config: CursorAgentEngineConfig

  constructor(config: CursorAgentEngineConfig) {
    // cursor-agent is invoked by name and resolved via PATH; the base uses
    // cliConfig.path for spawn/version/health, so default it here.
    super({ ...config, path: config.path ?? CURSOR_CLI })
    this.config = config
  }

  /**
   * Cursor additionally clears the legacy memory override in .cursorrules (the
   * base handles CLAUDE.md / AGENTS.md).
   */
  protected override prepareMemoryOverride(request: ExecuteRequest): void {
    super.prepareMemoryOverride(request)
    const workDir = request.workDir
    if (!workDir) return
    try {
      removeMemoryOverride(join(workDir, '.cursorrules'))
    } catch (err) {
      logger.warn({ workDir, err }, 'Failed to remove legacy memory override from .cursorrules')
    }
  }

  /**
   * Probes host login state via `cursor-agent about` (fast; since 2026.09 it
   * also looks up the latest CLI version and prints a `Latest` row). The
   * output is a multi-line table with a key
   * line like `User Email          alice@example.com`; when not logged in that
   * line reads `User Email          Not logged in`.
   */
  async checkLoginStatus(): Promise<LoginStatus> {
    const result = await runStatusProbe(this.cliConfig.path, ['about'], { logTag: 'cursor' })
    if (result.notFound) {
      return {
        installed: false,
        loggedIn: false,
        error: 'cursor-agent CLI not found in PATH',
      }
    }
    if (result.timedOut) {
      return {
        installed: true,
        loggedIn: false,
        error: 'cursor-agent about timed out',
        raw: truncateForRaw(result.stdout || result.stderr),
      }
    }

    const out = result.stdout
    const emailLine = out.match(/^\s*User\s+Email\s+(.+?)\s*$/im)
    const emailField = emailLine?.[1]?.trim()
    const isNotLoggedIn = !emailField || /^not\s+logged\s+in$/i.test(emailField)
    const loggedIn = result.exitCode === 0 && !isNotLoggedIn
    logger.info(
      { exitCode: result.exitCode, emailField, loggedIn },
      '[cursor] checkLoginStatus parsed',
    )
    return {
      installed: true,
      loggedIn,
      ...(loggedIn && emailField
        ? { detail: `Logged in as ${emailField}`, method: emailField }
        : {}),
      ...(!loggedIn
        ? {
            error: isNotLoggedIn
              ? 'Not logged in'
              : result.stderr.trim() || `exit ${result.exitCode}`,
          }
        : {}),
      raw: truncateForRaw(out || result.stderr),
    }
  }

  /**
   * Lists the Cursor model ids available for the current (authMode,
   * credential) combination.
   *
   * Strategy: spawn `cursor-agent --list-models` (a native CLI command)
   * - apiKey mode       → inject env CURSOR_API_KEY=<userKey>
   * - localSession mode → inject no env; the CLI reads the host `~/.cursor/`
   *                       login state
   * - oauth mode        → unsupported_mode (no such credential form at the
   *                       Cursor product layer; the UI already hides the radio)
   *
   * Output (observed with no key): "No models available for this account." →
   * treated as no_account_models. Output (with a key): one model id per line.
   */
  async listAvailableModels(options: ListModelsOptions): Promise<ModelListResult> {
    const { authMode } = options

    if (authMode === 'oauth') {
      return {
        models: [],
        error: 'Cursor does not support oauth mode',
        code: 'unsupported_mode',
      }
    }

    const envOverlay: NodeJS.ProcessEnv = {}
    if (authMode === 'apiKey') {
      if (!options.apiKey) {
        return { models: [], error: 'apiKey is required for apiKey mode', code: 'invalid_input' }
      }
      envOverlay.CURSOR_API_KEY = options.apiKey
    }
    // localSession mode injects no env; the CLI reads ~/.cursor/ itself

    logger.info(
      {
        authMode,
        hasApiKey: !!options.apiKey,
        apiKeyLen: options.apiKey?.length ?? 0,
      },
      '[cursor] listAvailableModels probing',
    )

    const result = await runStatusProbe(this.cliConfig.path, ['--list-models'], {
      logTag: 'cursor-list-models',
      timeoutMs: 20_000,
      env: envOverlay,
    })

    if (result.notFound) {
      return {
        models: [],
        error: 'cursor-agent CLI not found in PATH',
        code: 'spawn_failed',
      }
    }
    if (result.timedOut) {
      return {
        models: [],
        error: 'cursor-agent --list-models timed out',
        code: 'timeout',
      }
    }
    if (result.exitCode !== 0) {
      const stderrSample = truncateForRaw(result.stderr, 300)
      return {
        models: [],
        error: stderrSample || `cursor-agent exit ${result.exitCode}`,
        code: 'cli_failed',
        details: { exitCode: result.exitCode, stderr: stderrSample },
      }
    }

    const out = result.stdout
    if (/No models available/i.test(out)) {
      return {
        models: [],
        error: 'No models available for this account (not logged in or no usable models)',
        code: 'no_account_models',
        details: { raw: truncateForRaw(out, 200) },
      }
    }

    // Parse the model id from each line.
    // Since CLI 2026.05.20 the output format is `<id> - <display name>` (e.g.
    // "auto - Auto"); earlier versions may be a bare id (e.g. "gpt-5.3-codex").
    // The parser handles both forms:
    //   1. Skip blank lines, comment lines (# prefix), decoration lines (=== …)
    //   2. Take the first token segment (split on spaces or "  -  ", first
    //      non-empty segment)
    //   3. Skip section titles like "Available", validate the remaining token
    //      is a legal id
    const models = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      // Defense 1: strip everything before the "..." ellipsis (CLI loading
      // hints + ANSI-strip residue)
      .map((line) => (line.includes('...') ? line.slice(line.lastIndexOf('...') + 3) : line))
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !/^[#=]/.test(line))
      // Take the first segment: split on " - " / " — " / runs of spaces, keep
      // the first (handles both "<id> - <name>" and a bare id)
      .map((line) => line.split(/\s+-\s+|\s+—\s+|\s{2,}|\t+|\s+/)[0]?.trim() ?? '')
      .filter((id): id is string => id.length > 0 && /^[a-zA-Z0-9._/@-]+$/.test(id))
      // Section titles ("Available", "Models", etc.) — single word, capitalized, all letters
      .filter((id) => !/^[A-Z][a-z]+$/.test(id))

    if (models.length === 0) {
      return {
        models: [],
        error: 'cursor-agent --list-models returned no parseable model ids',
        code: 'parse_failed',
        details: { raw: truncateForRaw(out, 300) },
      }
    }

    logger.info(
      { count: models.length, sample: models.slice(0, 3) },
      '[cursor] listAvailableModels success',
    )
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
    const agentEnv = agentConfig?.agentEnv as Record<string, string> | undefined
    const runtimeEnv = request.runtimeContext?.env
    const perAgentApiKey = agentConfig?.providerApiKey as string | undefined
    // 'oauth' is a Claude-Code-only credential mode; Cursor doesn't support it,
    // so fall back to 'apiKey'
    const rawAuthMode =
      (agentConfig?.authMode as 'apiKey' | 'oauth' | 'localSession' | undefined) ?? 'apiKey'
    const authMode: 'apiKey' | 'localSession' =
      rawAuthMode === 'localSession' ? 'localSession' : 'apiKey'

    const resolvedWorkDir = workDir || this.config.defaultWorkDir

    // TODO: create-chat is temporarily disabled (has a timeout issue); each run
    // executes directly without --resume
    const chatId = inputChatId

    // The prompt is already processed by BaseAgentEngine.enrichPrompt; use as-is
    const args = this.buildArgs(model, 'stream-json', chatId, prompt, {
      readOnly: agentConfig?.readOnly !== undefined ? Boolean(agentConfig.readOnly) : undefined,
      force: agentConfig?.force !== undefined ? Boolean(agentConfig.force) : undefined,
    })

    const streamEnv = this.buildEnv(agentEnv, runtimeEnv, perAgentApiKey, authMode)
    const execParams: Record<string, unknown> = {
      cmd: 'cursor-agent',
      args: args.slice(0, -1), // drop last arg (prompt)
      cwd: resolvedWorkDir,
      authMode,
      runtimeHome: request.runtimeContext?.home.dir,
      workspaceDir: request.runtimeContext?.workspace.dir,
      workspaceType: request.runtimeContext?.workspace.type,
      artifactsDir: request.runtimeContext?.artifacts.dir,
    }
    if (streamEnv.CURSOR_API_KEY)
      execParams.cursorApiKey = `${streamEnv.CURSOR_API_KEY.slice(0, 8)}***`
    logger.info({ taskId, ...execParams }, '[cursor-agent] execute (stream) params')
    onLogEntry?.({
      type: 'exec_params',
      engine: 'cursor-agent',
      params: toDisplayExecParams(execParams),
      ts: Date.now(),
    })

    onLogEntry?.({ type: 'system', subtype: 'preparing', ts: Date.now() })

    const heartbeat = createHeartbeatTracker({
      intervalMs: TOOL_HEARTBEAT_INTERVAL_MS,
      emit: (entry) => onLogEntry?.(entry),
    })

    const streamTimeoutMinutes = agentConfig?.timeoutMinutes ?? this.config.timeoutMinutes
    const streamTimeoutMs = streamTimeoutMinutes * 60 * 1000

    let textBuffer = ''
    let extractedChatId = chatId
    let resultReceived = false
    let lastUsage: TokenUsage | undefined
    const messageStats: Record<string, number> = {}
    // Track tool calls that already have a terminal status (completed/failed)
    // to avoid duplicate log entries when both assistant tool_use and tool_result fire
    const settledToolCalls = new Set<string>()

    // Parse one JSON line and dispatch side effects (logging / onLogEntry /
    // onUpdate / state updates). Parsing lives in cursor-stream-parser.ts; this
    // closure only maps events → side effects.
    const parseJsonLine = (line: string) => {
      const { events, msgType: rawMsgType, subtype: rawSubtype } = parseCursorStreamLine(line)

      // Stats counting at line level — one increment per JSON line, key built
      // from the RAW msgType/subtype on the line. This preserves the original
      // semantics: an `assistant` line with N content blocks is still one
      // logical message (not N), and a `tool_call` whose JSON subtype is
      // `completed` but whose inner result carries `error` is still counted
      // under `tool_call:completed` (the failure is reflected only in the
      // dispatched event subtype + onLogEntry payload).
      if (rawMsgType) {
        const key = statKeyFor(rawMsgType, rawSubtype)
        messageStats[key] = (messageStats[key] || 0) + 1
      }

      for (const ev of events) {
        switch (ev.kind) {
          case 'non_json':
            return // non-JSON line, ignore
          case 'session':
            extractedChatId = ev.chatId
            break
          case 'system_init':
            logger.info({ taskId }, '[INIT] System initialized')
            onLogEntry?.({ type: 'system', subtype: 'init', model: ev.model, ts: Date.now() })
            break
          case 'user':
            logger.info({ taskId }, '[USER] User message received')
            break
          case 'assistant_text':
            logger.info(
              { taskId, blockIndex: ev.blockIndex, blockType: 'text', len: ev.text.length },
              `[ASSISTANT] ${truncate(ev.text)}`,
            )
            textBuffer += ev.text
            onUpdate?.(textBuffer)
            onLogEntry?.({ type: 'assistant', text: ev.text, ts: Date.now() })
            break
          case 'assistant_tool_use':
            logger.info(
              {
                taskId,
                blockIndex: ev.blockIndex,
                blockType: 'tool_use',
                toolName: ev.toolName,
                subtype: ev.subtype,
              },
              `[ASSISTANT] Tool use: ${ev.toolName} (${ev.subtype})`,
            )
            onLogEntry?.({
              type: 'tool_call',
              subtype: ev.subtype,
              callId: ev.callId,
              toolName: ev.toolName,
              input: ev.input,
              ...(ev.error ? { error: ev.error } : {}),
              ts: Date.now(),
            })
            if (ev.callId) {
              if (ev.subtype === 'started') heartbeat.onStarted(ev.callId, ev.toolName)
              else heartbeat.onSettled(ev.callId)
            }
            if (ev.subtype !== 'started' && ev.callId) settledToolCalls.add(ev.callId)
            break
          case 'result_success':
            resultReceived = true
            lastUsage = ev.usage ?? lastUsage
            logger.info(
              { taskId, durationMs: ev.durationMs, len: ev.text.length },
              '[RESULT] Success',
            )
            textBuffer = ev.text
            onUpdate?.(textBuffer)
            onLogEntry?.({
              type: 'result',
              subtype: 'success',
              durationMs: ev.durationMs,
              ...(lastUsage ? { usage: lastUsage } : {}),
              ts: Date.now(),
            })
            break
          case 'result_other':
            resultReceived = true
            lastUsage = ev.usage ?? lastUsage
            // logger uses raw subtype (may be undefined); onLogEntry applies
            // 'error' fallback. Mirrors original cursor-agent.ts asymmetry.
            logger.warn(
              { taskId, subtype: ev.subtype, error: truncate(ev.error ?? '', 500) },
              `[RESULT] Non-success result: ${ev.subtype}`,
            )
            onLogEntry?.({
              type: 'result',
              subtype: ev.subtype || 'error',
              ...(lastUsage ? { usage: lastUsage } : {}),
              ts: Date.now(),
            })
            break
          case 'thinking':
            break
          case 'tool_call':
            logger.info(
              { taskId, toolName: ev.toolName, callId: ev.callId, subtype: ev.subtype },
              `[TOOL_CALL] Calling tool: ${ev.toolName} (${ev.subtype})`,
            )
            onLogEntry?.({
              type: 'tool_call',
              subtype: ev.subtype,
              callId: ev.callId,
              toolName: ev.toolName,
              input: ev.input,
              ...(ev.error ? { error: ev.error } : {}),
              ts: Date.now(),
            })
            if (ev.callId) {
              if (ev.subtype === 'started') heartbeat.onStarted(ev.callId, ev.toolName)
              else heartbeat.onSettled(ev.callId)
            }
            if (ev.subtype !== 'started' && ev.callId) settledToolCalls.add(ev.callId)
            break
          case 'tool_result':
            if (ev.callId && settledToolCalls.has(ev.callId)) {
              logger.debug(
                { taskId, toolName: ev.toolName, callId: ev.callId },
                `[TOOL_RESULT] Skipping duplicate (already settled): ${ev.toolName}`,
              )
              break
            }
            logger.info(
              { taskId, toolName: ev.toolName, isError: ev.isError },
              `[TOOL_RESULT] Tool result: ${ev.toolName}${ev.isError ? ' (error)' : ''}`,
            )
            if (ev.callId) heartbeat.onSettled(ev.callId)
            onLogEntry?.({
              type: 'tool_call',
              subtype: ev.isError ? 'failed' : 'completed',
              callId: ev.callId,
              toolName: ev.toolName,
              ts: Date.now(),
            })
            break
          case 'error':
            logger.error(
              { taskId, errorDetail: truncate(ev.message, 500) },
              `[ERROR] Stream error: ${truncate(ev.message)}`,
            )
            onLogEntry?.({ type: 'error', message: truncate(ev.message, 500), ts: Date.now() })
            break
          case 'unknown':
            logger.debug(
              { taskId, type: ev.msgType, subtype: ev.subtype },
              `[UNKNOWN] Unhandled message type: ${ev.msgType}${ev.subtype ? `:${ev.subtype}` : ''}`,
            )
            break
        }
      }
    }

    return this.runCliStream({
      taskId,
      args,
      env: streamEnv,
      cwd: resolvedWorkDir,
      timeoutMs: streamTimeoutMs,
      onStdoutLine: (line) => {
        if (line.trim()) parseJsonLine(line)
      },
      // cursor-agent also emits some lines on stderr; parse those too
      parseStderrLines: true,
      getUsage: () => lastUsage,
      onSpawned: () => onLogEntry?.({ type: 'system', subtype: 'spawned', ts: Date.now() }),
      cleanup: () => heartbeat.stop(),
      settle: ({ exitCode, stderr }) => {
        logger.info(
          { taskId, exitCode, resultReceived, stats: messageStats },
          'cursor-agent process exited',
        )
        if (resultReceived) {
          return {
            ok: true,
            result: {
              success: true,
              output: textBuffer,
              chatId: extractedChatId,
              ...(lastUsage ? { usage: lastUsage } : {}),
            },
          }
        }
        if (exitCode !== 0) {
          return {
            ok: false,
            error: new Error(formatExitError(exitCode ?? 1, stderr)),
            usage: lastUsage,
          }
        }
        logger.warn({ taskId }, 'cursor-agent exited normally but no result message received')
        return {
          ok: false,
          error: new Error('cursor-agent exited without producing a result (exit 0, no result)'),
          usage: lastUsage,
        }
      },
    })
  }

  // ----------------------------------------------------------
  // Private: CLI argument construction
  // ----------------------------------------------------------

  /** Build the command arguments (see executor.go: buildCmdArgs) */
  private buildArgs(
    model: string,
    outputFormat: string,
    chatId: string | undefined,
    prompt: string,
    extras?: { readOnly?: boolean; force?: boolean },
  ): string[] {
    const args = ['-p', '--model', model, '--output-format', outputFormat, '--trust']
    if (extras?.readOnly) {
      args.push('--mode', 'ask')
    }
    if (extras?.force ?? this.config.agentForce) {
      args.push('--force')
    }
    if (this.config.approveMcps) {
      // Boolean option: a trailing value would be joined into the prompt.
      args.push('--approve-mcps')
    }
    if (chatId) {
      args.push('--resume', chatId)
    }
    args.push(prompt)
    return args
  }

  // ----------------------------------------------------------
  // Private: environment variables
  // ----------------------------------------------------------

  /**
   * Build the child-process env (see executor.go: setupCmdEnv). Kept
   * engine-local (not the base buildCredentialEnv) because it also logs the
   * injected agentEnv keys and its localSession clear targets CURSOR_API_KEY.
   *
   * When authMode === 'localSession' `CURSOR_API_KEY` must be **actively
   * removed**: otherwise a residual same-named key in the host / container env
   * would pass through via `...process.env` and keep overriding cursor-agent's
   * local login state.
   */
  private buildEnv(
    agentEnv?: Record<string, string>,
    runtimeEnv?: Record<string, string>,
    perAgentApiKey?: string,
    authMode: 'apiKey' | 'localSession' = 'apiKey',
  ): NodeJS.ProcessEnv {
    if (agentEnv && Object.keys(agentEnv).length > 0) {
      logger.debug({ envKeys: Object.keys(agentEnv) }, 'Injecting agent environment variables')
    }
    const env = buildSafeAgentProcessEnv()
    if (authMode === 'localSession') {
      unsetEnv(env, 'CURSOR_API_KEY')
    } else {
      const resolvedApiKey = perAgentApiKey || this.config.apiKey
      if (resolvedApiKey) env.CURSOR_API_KEY = resolvedApiKey
    }
    const sanitizedAgentEnv = sanitizeAgentRuntimeEnv(agentEnv)
    if (sanitizedAgentEnv) {
      unsetEnv(sanitizedAgentEnv, 'CURSOR_API_KEY')
    }
    const effectiveRuntimeEnv =
      authMode === 'localSession' ? omitRuntimeEnvKeys(runtimeEnv, ['HOME']) : runtimeEnv
    return { ...env, ...(sanitizedAgentEnv || {}), ...(effectiveRuntimeEnv || {}) }
  }
}
