/**
 * OpenAI Codex CLI execution engine
 *
 * Runs tasks via `codex exec --json` in non-interactive mode and subscribes to
 * the JSONL event stream on stdout, staying symmetric with CursorAgentEngine /
 * ClaudeCodeEngine.
 *
 * Core capabilities:
 * - Session resumption via `codex exec` / `codex exec resume <threadId>`
 * - JSONL event parsing (thread / turn / item events)
 * - Process lifecycle management (zombie protection + per-taskId cancel +
 *   timeout escalation, provided by BaseCliAgentEngine)
 *
 * Common capabilities (provided by BaseAgentEngine): prompt assembly + safety
 * wrapping, model fallback.
 */

import { createHash } from 'node:crypto'
import { unsetEnv } from '../lib/env-utils.js'
import { logger } from '../lib/logger.js'
import { BaseCliAgentEngine, type CliEngineBaseConfig } from './cli-engine-base.js'
import {
  composeCodexAssistantOutput,
  parseCodexStreamLine,
  statKeyFor,
} from './codex-stream-parser.js'
import { toDisplayExecParams } from './exec-params.js'
import { createHeartbeatTracker } from './heartbeat.js'
import { runStatusProbe, truncateForRaw } from './login-status-helper.js'
import type { ResolvedMcpServer } from './mcp-sync.js'
import {
  buildSafeAgentProcessEnv,
  omitRuntimeEnvKeys,
  sanitizeAgentRuntimeEnv,
} from './runtime-context.js'

/** Heartbeat interval for in-flight tool calls (ms). */
const TOOL_HEARTBEAT_INTERVAL_MS = 20_000

import type {
  ExecuteResult,
  ListModelsOptions,
  LoginStatus,
  ModelListResult,
  StreamExecuteRequest,
  TokenUsage,
} from './types.js'
import { mapCodexUsage } from './usage.js'

const ENGINE_TYPE = 'codex'
const CODEX_MCP_TOOL_TIMEOUT_SEC = 660
const A2WAVE_AGENT_ROUTER_MCP_NAME = 'a2wave-agent-router'
// Let the parent Run deadline terminate Codex first. The router then has time
// to forward CancelTask before the CLI process group reaches SIGKILL.
const A2A_ROUTER_CLEANUP_HEADROOM_SEC = 10
const PROTECTED_CODEX_ENV_NAMES = new Set([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_API_BASE',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'HOME',
  'PATH',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
])

function truncate(s: string, maxLen = 200): string {
  return s.length <= maxLen ? s : `${s.slice(0, maxLen)}...`
}

export function buildCodexPromptTransport(
  prompt: string,
  platform: NodeJS.Platform = process.platform,
): { promptArg: string; stdin?: string } {
  return platform === 'win32' ? { promptArg: '-', stdin: prompt } : { promptArg: prompt }
}

const EXIT_CODE_MESSAGES: Record<number, string> = {
  1: 'Codex execution failed',
  2: 'Codex command argument error',
  126: 'Permission denied, cannot execute codex',
  127: 'codex command not found',
  130: 'User interrupted execution (Ctrl+C)',
  137: 'Process forcibly terminated (SIGKILL)',
  143: 'Execution cancelled',
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function tomlValue(value: unknown): string {
  if (typeof value === 'string') return tomlString(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map((item) => tomlValue(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined && item !== null,
    )
    return `{${entries.map(([key, item]) => `${tomlKey(key)}=${tomlValue(item)}`).join(',')}}`
  }
  return '""'
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key)
}

interface CodexMcpInjection {
  configOverride: string
  env: Record<string, string>
  skipped: Array<{ name: string; type: string; reason: string }>
}

function envNamePart(value: string): string {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8).toUpperCase()
}

function withoutProtectedCodexEnv(env?: Record<string, string>): Record<string, string> {
  if (!env) return {}
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !PROTECTED_CODEX_ENV_NAMES.has(key)),
  )
}

export function buildCodexMcpInjection(
  servers: ResolvedMcpServer[],
  options: { a2aRouterToolTimeoutSec?: number } = {},
): CodexMcpInjection {
  const entries: string[] = []
  const env: Record<string, string> = {}
  const skipped: CodexMcpInjection['skipped'] = []
  for (const server of servers) {
    const toolTimeoutSec =
      server.name === A2WAVE_AGENT_ROUTER_MCP_NAME
        ? (options.a2aRouterToolTimeoutSec ?? CODEX_MCP_TOOL_TIMEOUT_SEC)
        : CODEX_MCP_TOOL_TIMEOUT_SEC
    if (server.type === 'stdio' && server.command) {
      const stdioEnv = withoutProtectedCodexEnv(server.env)
      const publicKeys = new Set(server.publicEnvKeys ?? [])
      // public (non-sensitive): inline each server's own literal env={...}
      // block, isolated from the others so a same-named var can't clobber it
      // (fixes the bug where multiple group proxies shared A2WAVE_GROUP_* config).
      const inlineEnv = Object.fromEntries(
        Object.entries(stdioEnv).filter(([k]) => publicKeys.has(k)),
      )
      // The rest (may contain secrets): still go through env_vars — only the
      // variable names are passed, values stay in the shared process env and
      // never touch the command line. Mutually exclusive with inlineEnv to
      // avoid ambiguity where a key is both inline and env_vars.
      const forwardedEnv = Object.fromEntries(
        Object.entries(stdioEnv).filter(([k]) => !publicKeys.has(k)),
      )
      Object.assign(env, forwardedEnv)
      entries.push(
        `${tomlKey(server.name)}=${tomlValue({
          command: server.command,
          args: server.args ?? [],
          ...(server.cwd?.trim() ? { cwd: server.cwd.trim() } : {}),
          ...(Object.keys(inlineEnv).length ? { env: inlineEnv } : {}),
          ...(Object.keys(forwardedEnv).length ? { env_vars: Object.keys(forwardedEnv) } : {}),
          tool_timeout_sec: toolTimeoutSec,
        })}`,
      )
    } else if (server.type === 'http' && server.url) {
      const envHttpHeaders: Record<string, string> = {}
      if (server.headers) {
        let headerIndex = 0
        for (const [headerName, headerValue] of Object.entries(server.headers)) {
          const envName = `A2WAVE_MCP_${envNamePart(server.name) || 'SERVER'}_HEADER_${envNamePart(headerName) || headerIndex}_${shortHash(`${server.name}\0${headerName}\0${headerIndex}`)}`
          env[envName] = headerValue
          envHttpHeaders[headerName] = envName
          headerIndex += 1
        }
      }
      entries.push(
        `${tomlKey(server.name)}=${tomlValue({
          url: server.url,
          ...(Object.keys(envHttpHeaders).length ? { env_http_headers: envHttpHeaders } : {}),
          tool_timeout_sec: toolTimeoutSec,
        })}`,
      )
    } else if (server.type === 'sse') {
      skipped.push({
        name: server.name,
        type: server.type,
        reason: 'Codex CLI mcp_servers override supports streamable HTTP, not SSE',
      })
    }
  }
  return { configOverride: `mcp_servers={${entries.join(',')}}`, env, skipped }
}

export function redactCodexArgs(args: string[]): string[] {
  const redacted = [...args]
  for (let i = 0; i < redacted.length - 1; i++) {
    if (redacted[i] === '-c' || redacted[i] === '--config') {
      const key = /^([A-Za-z0-9_.-]+)=/.exec(redacted[i + 1])?.[1] ?? 'config'
      redacted[i + 1] = `${key}=<redacted>`
    }
  }
  return redacted
}

function formatExitError(code: number, stderr: string): string {
  const friendlyMsg = EXIT_CODE_MESSAGES[code] ?? `Codex execution error (code ${code})`
  const stderrTrimmed = stderr.trim()
  if (stderrTrimmed) return `${friendlyMsg}\nDetails: ${stderrTrimmed}`
  return friendlyMsg
}

export interface CodexAgentEngineConfig extends CliEngineBaseConfig {
  /** OpenAI / Codex API Key (may be empty when a login session exists; prefers OPENAI_API_KEY) */
  apiKey: string
  /** Whether to pass --dangerously-bypass-approvals-and-sandbox */
  force: boolean
  /** Whether to auto-approve MCP tool calls (via --ask-for-approval never) */
  approveMcps: boolean
}

export class CodexAgentEngine extends BaseCliAgentEngine {
  readonly type = ENGINE_TYPE
  protected readonly cliName = 'codex'
  private config: CodexAgentEngineConfig

  constructor(config: CodexAgentEngineConfig) {
    super(config)
    this.config = config
  }

  /**
   * Probes host login state via `codex login status`.
   *
   * - Prefer stdout; fall back to stderr when stdout is empty (older versions
   *   write status to stderr)
   * - Explicitly detect "Not logged in" / "Please run codex login" failure
   *   signals first, so a bare "logged in" keyword doesn't misfire
   */
  async checkLoginStatus(): Promise<LoginStatus> {
    const result = await runStatusProbe(this.config.path, ['login', 'status'], {
      logTag: 'codex',
    })
    if (result.notFound) {
      return {
        installed: false,
        loggedIn: false,
        error: `codex CLI not found in PATH (${this.config.path})`,
      }
    }
    if (result.timedOut) {
      return {
        installed: true,
        loggedIn: false,
        error: 'codex login status timed out',
        raw: truncateForRaw(result.stdout || result.stderr),
      }
    }

    const stdoutTrim = result.stdout.trim()
    const stderrTrim = result.stderr.trim()
    const combined = stdoutTrim || stderrTrim

    const explicitNotLoggedIn =
      /not\s*logged\s*in/i.test(combined) ||
      /please\s+run\s+`?codex\s+login`?/i.test(combined) ||
      /no\s+credentials?/i.test(combined)
    const positiveLoggedIn = /logged\s*in/i.test(combined)
    const loggedIn = result.exitCode === 0 && positiveLoggedIn && !explicitNotLoggedIn

    const method = /chatgpt/i.test(combined)
      ? 'ChatGPT'
      : /api\s*key/i.test(combined)
        ? 'API Key'
        : undefined

    logger.info(
      {
        exitCode: result.exitCode,
        stdoutSample: truncateForRaw(stdoutTrim, 200),
        stderrSample: truncateForRaw(stderrTrim, 200),
        positiveLoggedIn,
        explicitNotLoggedIn,
        loggedIn,
        method,
      },
      '[codex] checkLoginStatus parsed',
    )

    return {
      installed: true,
      loggedIn,
      ...(loggedIn ? { detail: combined || 'Logged in', ...(method ? { method } : {}) } : {}),
      ...(!loggedIn ? { error: combined || `exit ${result.exitCode}` } : {}),
      raw: truncateForRaw(combined),
    }
  }

  /**
   * Lists the currently available Codex model ids.
   *
   * Strategy: spawn `codex debug models` (a native CLI command, no credentials)
   * - The Codex catalog is hardcoded JSON inside the CLI binary, fully
   *   independent of authMode / credentials
   * - apiKey and localSession take the same path (neither needs env injection)
   * - oauth mode: no such credential form at the Codex product layer →
   *   unsupported_mode (the UI already hides the radio)
   *
   * Output: `codex debug models` returns JSON with
   * `{ models: [{ slug, visibility, ... }] }`; keep `visibility === 'list'`
   * (hidden internal models like codex-auto-review are excluded).
   */
  async listAvailableModels(options: ListModelsOptions): Promise<ModelListResult> {
    if (options.authMode === 'oauth') {
      return {
        models: [],
        error: 'Codex does not support oauth mode',
        code: 'unsupported_mode',
      }
    }

    logger.info({ authMode: options.authMode }, '[codex] listAvailableModels probing')

    const result = await runStatusProbe(this.config.path, ['debug', 'models'], {
      logTag: 'codex-list-models',
      timeoutMs: 15_000,
    })

    if (result.notFound) {
      return {
        models: [],
        error: `codex CLI not found in PATH (${this.config.path})`,
        code: 'spawn_failed',
      }
    }
    if (result.timedOut) {
      return {
        models: [],
        error: 'codex debug models timed out',
        code: 'timeout',
      }
    }
    if (result.exitCode !== 0) {
      const stderrSample = truncateForRaw(result.stderr, 300)
      return {
        models: [],
        error: stderrSample || `codex exit ${result.exitCode}`,
        code: 'cli_failed',
        details: { exitCode: result.exitCode, stderr: stderrSample },
      }
    }

    let parsed: { models?: Array<{ slug?: string; visibility?: string }> }
    try {
      parsed = JSON.parse(result.stdout)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(
        { err: message, stdoutSample: truncateForRaw(result.stdout, 300) },
        '[codex] listAvailableModels JSON parse failed',
      )
      return {
        models: [],
        error: 'Failed to parse codex debug models JSON output',
        code: 'parse_failed',
        details: { raw: truncateForRaw(result.stdout, 300) },
      }
    }

    const models = (parsed.models ?? [])
      .filter((m) => m.visibility === 'list')
      .map((m) => m.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0)

    if (models.length === 0) {
      return {
        models: [],
        error: 'codex debug models returned no visible models',
        code: 'parse_failed',
      }
    }

    logger.info(
      { count: models.length, sample: models.slice(0, 3) },
      '[codex] listAvailableModels success',
    )
    return { models }
  }

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
    const perAgentBaseUrl = agentConfig?.providerBaseUrl as string | undefined
    const agentEnv = agentConfig?.agentEnv as Record<string, string> | undefined
    const runtimeEnv = request.runtimeContext?.env
    // 'oauth' is a Claude-Code-only credential mode; Codex doesn't support it,
    // so fall back to 'apiKey'
    const rawAuthMode =
      (agentConfig?.authMode as 'apiKey' | 'oauth' | 'localSession' | undefined) ?? 'apiKey'
    const authMode: 'apiKey' | 'localSession' =
      rawAuthMode === 'localSession' ? 'localSession' : 'apiKey'
    if (authMode === 'apiKey' && perAgentBaseUrl?.trim() && !perAgentApiKey?.trim()) {
      throw new Error(
        'Codex Agent Base URL requires providerApiKey in the same binding; refusing to send a deployment credential to an Agent-controlled proxy',
      )
    }
    const resolvedWorkDir = workDir || this.config.defaultWorkDir
    const streamTimeoutMinutes = agentConfig?.timeoutMinutes ?? this.config.timeoutMinutes
    const streamTimeoutMs = streamTimeoutMinutes * 60 * 1000
    const a2aRouterToolTimeoutSec = Math.max(
      CODEX_MCP_TOOL_TIMEOUT_SEC,
      Math.ceil(streamTimeoutMinutes * 60) + A2A_ROUTER_CLEANUP_HEADROOM_SEC,
    )

    const mcpInjection =
      agentConfig?.resolvedMcpServers !== undefined
        ? buildCodexMcpInjection(agentConfig.resolvedMcpServers as ResolvedMcpServer[], {
            a2aRouterToolTimeoutSec,
          })
        : undefined
    if (mcpInjection?.skipped.length) {
      logger.warn(
        { taskId, skippedMcpServers: mcpInjection.skipped },
        '[codex] skipped unsupported MCP servers',
      )
    }

    const promptTransport = buildCodexPromptTransport(prompt)
    const args = this.buildArgs(promptTransport.promptArg, model, inputChatId, {
      readOnly: agentConfig?.readOnly !== undefined ? Boolean(agentConfig.readOnly) : undefined,
      force: agentConfig?.force !== undefined ? Boolean(agentConfig.force) : undefined,
      mcpConfigOverride: mcpInjection?.configOverride,
      openaiBaseUrl: authMode === 'apiKey' ? perAgentBaseUrl : undefined,
    })
    const execEnv = this.buildEnv(agentEnv, mcpInjection?.env, runtimeEnv, perAgentApiKey, authMode)
    const resolvedApiKey = perAgentApiKey || this.config.apiKey
    const cleanResult = Boolean(agentConfig?.cleanResult)

    const filteredArgs = redactCodexArgs(args).slice(0, -1) // drop last arg (prompt)
    const execParams: Record<string, unknown> = {
      cmd: this.config.path,
      args: filteredArgs,
      cwd: resolvedWorkDir,
      authMode,
      proxyConfigured: authMode === 'apiKey' && Boolean(perAgentBaseUrl),
      mcpCount: agentConfig?.resolvedMcpServers?.length ?? 0,
      mcpNames: (agentConfig?.resolvedMcpServers as ResolvedMcpServer[] | undefined)?.map(
        (server) => server.name,
      ),
      timeout: streamTimeoutMs,
      runtimeHome: request.runtimeContext?.home.dir,
      workspaceDir: request.runtimeContext?.workspace.dir,
      workspaceType: request.runtimeContext?.workspace.type,
      artifactsDir: request.runtimeContext?.artifacts.dir,
    }
    if (resolvedApiKey) execParams.apiKey = `${resolvedApiKey.slice(0, 8)}***`
    logger.info({ taskId, ...execParams }, '[codex] execute (stream) params')
    onLogEntry?.({
      type: 'exec_params',
      engine: 'codex',
      params: toDisplayExecParams(execParams),
      ts: Date.now(),
    })

    onLogEntry?.({ type: 'system', subtype: 'preparing', ts: Date.now() })

    const heartbeat = createHeartbeatTracker({
      intervalMs: TOOL_HEARTBEAT_INTERVAL_MS,
      emit: (entry) => onLogEntry?.(entry),
    })

    let sessionId = inputChatId
    let outputBuffer = ''
    const assistantTexts: string[] = []
    let resultReceived = false
    let resultIsError = false
    let resultErrorText = ''
    let lastUsage: TokenUsage | undefined
    const messageStats: Record<string, number> = {}

    const parseLine = (line: string) => {
      if (!line.trim()) return
      const { events, msgType, subtype } = parseCodexStreamLine(line)
      if (msgType) {
        const key = statKeyFor(msgType, subtype)
        messageStats[key] = (messageStats[key] || 0) + 1
      }
      // Pass whole failure-event lines through to the log so model-access /
      // quota / auth root causes can be diagnosed.
      if (msgType === 'turn.failed' || msgType === 'thread.error') {
        logger.warn({ taskId, rawLine: truncate(line, 2000) }, '[codex] raw failure line')
      }

      for (const ev of events) {
        switch (ev.kind) {
          case 'non_json':
            return
          case 'session':
            sessionId = ev.chatId
            logger.info({ taskId, sessionId }, '[codex] Thread started')
            onLogEntry?.({
              type: 'system',
              subtype: 'init',
              ts: Date.now(),
            })
            break
          case 'turn_started':
            break
          case 'turn_completed':
            resultReceived = true
            // Codex turn.completed usage is cumulative within one exec process.
            // Keep the latest event instead of summing cumulative values. Follow-up
            // chat turns use separate exec processes, including exec resume.
            lastUsage = mapCodexUsage(ev.usage) ?? lastUsage
            logger.info({ taskId, usage: ev.usage }, '[codex] Turn completed')
            onLogEntry?.({
              type: 'result',
              subtype: 'success',
              ...(lastUsage ? { usage: lastUsage } : {}),
              ts: Date.now(),
            })
            break
          case 'result_other':
            resultReceived = true
            resultIsError = true
            resultErrorText = ev.error || 'Codex turn failed'
            logger.warn({ taskId, error: truncate(resultErrorText, 500) }, '[codex] Turn failed')
            onLogEntry?.({
              type: 'result',
              subtype: 'error',
              ts: Date.now(),
            })
            break
          case 'assistant_text':
            assistantTexts.push(ev.text)
            outputBuffer = composeCodexAssistantOutput(assistantTexts, cleanResult)
            onUpdate?.(outputBuffer)
            logger.info({ taskId, len: ev.text.length }, `[codex] ${truncate(ev.text)}`)
            onLogEntry?.({
              type: 'assistant',
              text: ev.text,
              ts: Date.now(),
            })
            break
          case 'tool_call':
            logger.info(
              { taskId, toolName: ev.toolName, callId: ev.callId, subtype: ev.subtype },
              `[codex] Tool ${ev.subtype}: ${ev.toolName}`,
            )
            onLogEntry?.({
              type: 'tool_call',
              subtype: ev.subtype,
              callId: ev.callId,
              toolName: ev.toolName,
              ...(ev.input ? { input: ev.input } : {}),
              ...(ev.error ? { error: ev.error } : {}),
              ts: Date.now(),
            })
            if (ev.callId) {
              if (ev.subtype === 'started') heartbeat.onStarted(ev.callId, ev.toolName)
              else heartbeat.onSettled(ev.callId)
            }
            break
          case 'error':
            logger.error(
              { taskId, errorDetail: truncate(ev.message, 500) },
              `[codex] Stream error: ${truncate(ev.message)}`,
            )
            resultErrorText = ev.message
            onLogEntry?.({
              type: 'error',
              message: truncate(ev.message, 500),
              ts: Date.now(),
            })
            break
          case 'unknown':
            logger.debug(
              { taskId, type: ev.msgType, subtype: ev.subtype },
              `[codex] Unhandled: ${ev.msgType}${ev.subtype ? `:${ev.subtype}` : ''}`,
            )
            break
        }
      }
    }

    return this.runCliStream({
      taskId,
      args,
      env: execEnv,
      cwd: resolvedWorkDir,
      timeoutMs: streamTimeoutMs,
      stdin: promptTransport.stdin,
      onStdoutLine: parseLine,
      // Codex's main event stream is on stdout in --json mode, but some error
      // messages land on stderr; parse those lines too (matching cursor-agent).
      parseStderrLines: true,
      getUsage: () => lastUsage,
      onSpawned: () => onLogEntry?.({ type: 'system', subtype: 'spawned', ts: Date.now() }),
      cleanup: () => heartbeat.stop(),
      settle: ({ exitCode, stderr }) => {
        logger.info(
          { taskId, exitCode, resultReceived, resultIsError, stats: messageStats },
          'codex process exited',
        )

        if (resultIsError) {
          return {
            ok: false,
            error: new Error(resultErrorText || stderr || 'Codex returned an error'),
            usage: lastUsage,
          }
        }
        if (resultReceived) {
          return {
            ok: true,
            result: {
              success: true,
              output: outputBuffer,
              chatId: sessionId,
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
        logger.warn({ taskId }, 'codex exited normally but no turn result received')
        return {
          ok: false,
          error: new Error('codex exited without producing a result (exit 0, no turn.completed)'),
          usage: lastUsage,
        }
      },
    })
  }

  /**
   * Builds the `codex exec [resume <id>] --json ...` argument list.
   *
   * CLI compatibility constraints (codex-cli 0.121):
   * - `--cd` is only supported by `codex exec`, not `codex exec resume` —
   *   pass workDir via spawn's cwd option instead of putting `--cd` in args
   * - `--sandbox` likewise applies only to the initial exec; resume inherits
   *   the original session, so only pass sandbox on the first exec
   * - `codex exec` has no `--ask-for-approval` flag (that's a top-level codex
   *   TUI arg); non-interactive mode never prompts for approval, so it's
   *   unnecessary to pass explicitly
   */
  private buildArgs(
    prompt: string,
    model: string,
    chatId?: string,
    extras?: {
      readOnly?: boolean
      force?: boolean
      mcpConfigOverride?: string
      openaiBaseUrl?: string
    },
  ): string[] {
    const isResume = !!chatId
    const args: string[] = ['exec']
    if (isResume) {
      args.push('resume', chatId as string)
    }
    args.push('--json', '--skip-git-repo-check')
    if (model) args.push('--model', model)
    if (extras?.openaiBaseUrl) {
      args.push('-c', `openai_base_url=${tomlString(extras.openaiBaseUrl)}`)
    }
    if (extras?.mcpConfigOverride) {
      args.push('-c', extras.mcpConfigOverride)
    }

    // sandbox / bypass flags: resume inherits the original session policy, so
    // they are not re-passed
    if (!isResume) {
      const force = extras?.force ?? this.config.force
      if (force) {
        args.push('--dangerously-bypass-approvals-and-sandbox')
      } else if (extras?.readOnly) {
        args.push('--sandbox', 'read-only')
      } else {
        args.push('--sandbox', 'workspace-write')
      }
    } else if (extras?.force ?? this.config.force) {
      // In resume mode only the bypass flag is accepted by the CLI
      args.push('--dangerously-bypass-approvals-and-sandbox')
    }

    args.push(prompt)
    return args
  }

  /**
   * Builds the child-process env. OPENAI_API_KEY / CODEX_API_KEY are both
   * injected for compatibility across codex versions.
   *
   * Kept engine-local (not the base buildCredentialEnv) because codex merges a
   * codex-specific `mcpEnv` map alongside agentEnv, and its localSession clear
   * targets a different key set (OPENAI_API_KEY / CODEX_API_KEY, plus omitting
   * HOME / CODEX_HOME from the runtime env).
   *
   * When authMode === 'localSession' both env vars must be **actively
   * cleared**: otherwise a same-named key in the host env would pass through
   * via `...process.env` and keep overriding codex's local login state
   * (~/.codex/auth.json).
   */
  private buildEnv(
    agentEnv?: Record<string, string>,
    mcpEnv?: Record<string, string>,
    runtimeEnv?: Record<string, string>,
    perAgentApiKey?: string,
    authMode: 'apiKey' | 'localSession' = 'apiKey',
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...buildSafeAgentProcessEnv(),
      ...withoutProtectedCodexEnv(sanitizeAgentRuntimeEnv(agentEnv)),
      ...withoutProtectedCodexEnv(sanitizeAgentRuntimeEnv(mcpEnv)),
    }
    if (authMode === 'localSession') {
      unsetEnv(env, 'OPENAI_API_KEY')
      unsetEnv(env, 'CODEX_API_KEY')
    } else {
      const resolvedApiKey = perAgentApiKey || this.config.apiKey
      if (resolvedApiKey) {
        env.OPENAI_API_KEY = resolvedApiKey
        env.CODEX_API_KEY = resolvedApiKey
      }
    }
    const effectiveRuntimeEnv =
      authMode === 'localSession'
        ? omitRuntimeEnvKeys(runtimeEnv, ['HOME', 'CODEX_HOME'])
        : runtimeEnv
    return { ...env, ...(effectiveRuntimeEnv || {}) }
  }
}
