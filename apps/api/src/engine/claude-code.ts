import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  FastModeAvailability,
  FastModeState,
  ModelCapabilities,
  ReasoningEffortOption,
} from '@a2wave/shared'
import { FAST_MODE_REASON_MAX, fastModeStateEnum } from '@a2wave/shared'
import { Agent as UndiciAgent } from 'undici'
import { unsetEnv } from '../lib/env-utils.js'
import { logger } from '../lib/logger.js'
import { resolveProviderUrl } from '../lib/url-safety.js'
import {
  createPinnedLookup,
  resolvePublicUrl,
  safeFetch,
  UnsafeUrlError,
} from '../lib/url-safety-core.js'
import { BaseCliAgentEngine, type CliEngineBaseConfig, stripPromptArg } from './cli-engine-base.js'
import { toDisplayExecParams } from './exec-params.js'
import { createHeartbeatTracker } from './heartbeat.js'
import { runStatusProbe, truncateForRaw } from './login-status-helper.js'
import { finalizeModelCapabilities, isReasoningEffortValue } from './model-capabilities.js'
import {
  buildSafeAgentProcessEnv,
  omitRuntimeEnvKeys,
  sanitizeAgentRuntimeEnv,
} from './runtime-context.js'
import type {
  ExecuteResult,
  ListModelsOptions,
  LoginStatus,
  ModelListResult,
  StreamExecuteRequest,
  TokenUsage,
} from './types.js'
import { extractClaudeStyleUsage } from './usage.js'

/** Heartbeat interval for in-flight tool calls (ms). */
const TOOL_HEARTBEAT_INTERVAL_MS = 20_000

const CLAUDE_OAUTH_BASE_URL = 'https://api.anthropic.com'
const CLAUDE_OAUTH_MODELS_URL = `${CLAUDE_OAUTH_BASE_URL}/v1/models`
const CLAUDE_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
] as const

const ENGINE_TYPE = 'claude-code'

/** Normalize Base URLs for explicitly configured Bearer proxy bindings. */
function normalizeClaudeProxyBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

function clearClaudeCredentialEnv(env: NodeJS.ProcessEnv): void {
  for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) unsetEnv(env, key)
}

/**
 * Read the reasoning-effort levels one model advertises on `GET /v1/models`.
 *
 * Anthropic reports them as `capabilities.effort`, a `supported` flag sitting
 * alongside one nested object per level. Levels are collected by walking that
 * object rather than by consulting a list of level names: the names are exactly
 * what must not be hard-coded here, and they already differ between models
 * (Opus 4.5 has no `xhigh`, Haiku 4.5 has no effort at all). Skipping the
 * `supported` flag needs no special case either — it is a boolean, not an
 * object, so it fails the per-level shape check on its own.
 *
 * Returns `undefined` when the model reports no effort capability at all, which
 * is what a proxy standing in for the vendor endpoint does. That is "unknown"
 * and is deliberately distinct from the empty array returned for a model that
 * says effort is unsupported.
 */
function readEffortCapability(capabilities: unknown): ReasoningEffortOption[] | undefined {
  if (!capabilities || typeof capabilities !== 'object') return undefined
  const effort = (capabilities as { effort?: unknown }).effort
  if (!effort || typeof effort !== 'object') return undefined
  if ((effort as { supported?: unknown }).supported === false) return []

  const options: ReasoningEffortOption[] = []
  for (const [level, detail] of Object.entries(effort as Record<string, unknown>)) {
    if (!detail || typeof detail !== 'object') continue
    if ((detail as { supported?: unknown }).supported !== true) continue
    if (!isReasoningEffortValue(level)) continue
    options.push({ value: level })
  }
  return options
}

const CLAUDE_FAST_MODE_URL = `${CLAUDE_OAUTH_BASE_URL}/api/claude_code_penguin_mode`

/**
 * Ask Anthropic whether these credentials may use fast mode.
 *
 * The switch alone cannot answer this: fast mode is premium usage, and an
 * account can be refused for several distinct reasons the operator would
 * otherwise only discover by reading a finished run. The CLI gates on the same
 * endpoint, which is why a2wave can pre-empt the outcome instead of guessing
 * from the model name.
 *
 * **Advisory only, by construction.** It is an internal CLI endpoint rather than
 * a published contract, so every failure path — non-200, malformed body, network
 * error, timeout — resolves to `undefined` ("not answered") and never to
 * `available: false`. A vanished endpoint therefore degrades to today's
 * behaviour (offer the switch, report the outcome afterwards) instead of locking
 * a working feature out.
 *
 * Skipped entirely when the binding points at a proxy: the question belongs to
 * Anthropic, and a proxy's answer — or its 404 — would say nothing about it.
 */
async function probeFastModeAvailability(
  token: string,
  useBearer: boolean,
): Promise<FastModeAvailability | undefined> {
  try {
    const { addresses } = await resolvePublicUrl(CLAUDE_FAST_MODE_URL, undefined, {
      allowPrivateDnsAnswers: true,
    })
    const dispatcher = new UndiciAgent({ connect: { lookup: createPinnedLookup(addresses) } })
    try {
      const res = await safeFetch(CLAUDE_FAST_MODE_URL, {
        method: 'GET',
        headers: {
          ...(useBearer
            ? { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }
            : { 'x-api-key': token }),
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(8_000),
        maxRedirects: 0,
        dispatcher,
      } as Parameters<typeof safeFetch>[1])
      if (!res.ok) return undefined
      const body = (await res.json()) as { enabled?: unknown; disabled_reason?: unknown }
      if (typeof body.enabled !== 'boolean') return undefined
      return {
        available: body.enabled,
        ...(body.enabled || typeof body.disabled_reason !== 'string'
          ? {}
          : { reason: body.disabled_reason.slice(0, FAST_MODE_REASON_MAX) }),
      }
    } finally {
      await dispatcher.close().catch(() => {})
    }
  } catch (err) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      '[claude-code] fast mode availability probe skipped',
    )
    return undefined
  }
}

/**
 * What actually happened to fast mode on this run.
 *
 * Two sources disagree, and only one of them is evidence:
 * - `usage.speed` is the speed Anthropic **served** — the fact.
 * - `fast_mode_state` is the CLI's own **intent**; it reads `on` as soon as the
 *   request is allowed to leave the client.
 *
 * They part company on the case that matters most. An account without usage
 * credits gets `fast_mode_state: on` and `speed: standard`, with no error
 * anywhere — recording the intent would mark that run "Fast" when it ran, and
 * billed, at normal speed. So the served speed wins whenever it is reported, and
 * `denied` — asked for, confirmed served at standard — gets its own verdict
 * rather than being flattened into `on` or `off`: it is the one state the
 * operator can act on (enable usage credits), and the switch alone cannot show it.
 *
 * The third verdict, `requested`, belongs to engines that never answer at all
 * (see codex): the request went out and nothing contradicted it, which is
 * strictly more than "off" and strictly less than "served".
 *
 * `cooldown` survives because the served speed cannot express it.
 *
 * The CLI's own token is validated against the closed set rather than forwarded.
 * It is third-party text that ends up in the run record, the web log and a
 * terminal, and every other value discovered in this file is already capped or
 * shape-checked (`disabled_reason.slice(0, 64)`, the effort-level regex). An
 * unrecognised state degrades to absent, which the UI already renders as "the
 * engine said nothing" — strictly better than echoing bytes nobody defined.
 */
export function resolveFastModeState(
  servedSpeed: unknown,
  claimedState: unknown,
): FastModeState | undefined {
  const parsed = fastModeStateEnum.safeParse(claimedState)
  const claimed = parsed.success ? parsed.data : undefined
  if (typeof servedSpeed !== 'string') return claimed
  if (servedSpeed === 'fast') return 'on'
  return claimed === 'on' ? 'denied' : (claimed ?? 'off')
}

/**
 * High-frequency counter-style system events in the Claude Code CLI stream
 * have no diagnostic value on their own — e.g. `thinking_tokens` fires once per
 * thinking token generated. Passing them through as log entries would flood
 * every run with hundreds of noise lines, bloat the full log file, and drown
 * out the viewer. These subtypes are dropped at the source (they enter neither
 * the NDJSON sidecar nor any display layer).
 */
const NOISE_SYSTEM_SUBTYPES = new Set(['thinking_tokens'])

const EXIT_CODE_MESSAGES: Record<number, string> = {
  1: 'Claude Code execution failed',
  2: 'Claude Code command argument error',
  126: 'Permission denied, cannot execute Claude Code',
  127: 'claude command not found',
  130: 'User interrupted execution (Ctrl+C)',
  137: 'Process forcibly terminated (SIGKILL)',
  143: 'Execution cancelled',
}

/**
 * Strip `-p` and `--append-system-prompt` (both flag and value) from an args
 * array for exec_params logs — the prompt plaintext and the injected identity
 * prompt must not appear in logs.
 */
export function filterClaudeCodeArgs(args: string[]): string[] {
  return stripPromptArg(args, ['-p', '--append-system-prompt'])
}

function formatExitError(code: number, stderr: string): string {
  const friendlyMsg = EXIT_CODE_MESSAGES[code] ?? `Claude Code execution error (code ${code})`
  const stderrTrimmed = stderr.trim()
  if (stderrTrimmed) return `${friendlyMsg}\nDetails: ${stderrTrimmed}`
  return friendlyMsg
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

export interface ClaudeCodeEngineConfig extends CliEngineBaseConfig {
  apiKey: string
  baseUrl: string
  force: boolean
  approveMcps: boolean
}

export class ClaudeCodeEngine extends BaseCliAgentEngine {
  readonly type = ENGINE_TYPE
  protected readonly cliName = 'claude'
  private config: ClaudeCodeEngineConfig

  constructor(config: ClaudeCodeEngineConfig) {
    super(config)
    this.config = config
  }

  /**
   * 通过 `claude auth status --json` 探测本机登录态。输出形如
   * `{"loggedIn":true,"authMethod":"claude.ai","email":"...","subscriptionType":"max"}`。
   */
  async checkLoginStatus(): Promise<LoginStatus> {
    const result = await runStatusProbe(this.config.path, ['auth', 'status', '--json'], {
      logTag: 'claude-code',
    })
    if (result.notFound) {
      return {
        installed: false,
        loggedIn: false,
        error: `claude CLI not found in PATH (${this.config.path})`,
      }
    }
    if (result.timedOut) {
      return {
        installed: true,
        loggedIn: false,
        error: 'claude auth status timed out',
        raw: truncateForRaw(result.stdout || result.stderr),
      }
    }

    const out = result.stdout.trim()
    let parsed: Record<string, unknown> | null = null
    try {
      parsed = out ? (JSON.parse(out) as Record<string, unknown>) : null
    } catch {
      parsed = null
    }

    if (!parsed) {
      const loggedIn = result.exitCode === 0 && /logged\s*in/i.test(out)
      return {
        installed: true,
        loggedIn,
        ...(loggedIn ? { detail: out || 'Logged in' } : {}),
        ...(!loggedIn ? { error: out || result.stderr.trim() || `exit ${result.exitCode}` } : {}),
        raw: truncateForRaw(out || result.stderr),
      }
    }

    const loggedIn = parsed.loggedIn === true
    const email = typeof parsed.email === 'string' ? parsed.email : undefined
    const method = typeof parsed.authMethod === 'string' ? parsed.authMethod : undefined
    const sub = typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : undefined
    const detail = loggedIn
      ? [email, sub ? `(${sub})` : undefined].filter(Boolean).join(' ') || 'Logged in'
      : undefined
    return {
      installed: true,
      loggedIn,
      ...(detail ? { detail } : {}),
      ...(method ? { method } : {}),
      ...(!loggedIn ? { error: 'Not logged in' } : {}),
      raw: truncateForRaw(out),
    }
  }

  /**
   * 从 ~/.claude/.credentials.json 读出 claude CLI 当前 OAuth 登录态的 accessToken。
   *
   * 返回结构联合：成功 = `{ token }`；失败 = 带 `error` 和 `code` 的 ModelListResult 形状，
   * 让 listAvailableModels 直接转发给前端。错误码按场景区分，方便前端做对应引导：
   *
   * - `local_session_not_logged_in` —— 文件不存在，让用户去容器里 `claude /login`
   *   或把宿主 `~/.claude/` mount 进容器
   * - `local_session_read_failed`   —— 文件存在但读不出来（权限 / I/O 错误）
   * - `local_session_invalid_format` —— JSON parse 失败 / 没找到期望字段（CLI 版本不兼容）
   *
   * 路径解析顺序（与官方 Authentication 文档一致）：
   *   1. `$CLAUDE_CONFIG_DIR/.credentials.json`（用户/运维 opt-in 覆盖）
   *   2. `~/.claude/.credentials.json`（Linux/Windows 默认）
   *   3. macOS Keychain（仅 process.platform === 'darwin' 且上面两条都不在时
   *      回退）—— 走 `security find-generic-password -s "Claude Code-credentials" -w`，
   *      Anthropic 官方文档化的兼容命令。
   *
   * homedir() 走 `process.env.HOME`，方便测试以及 lark-cli per-agent HOME 隔离场景。
   * macOS 上 claude CLI 默认把凭证存进 Keychain（不写文件）；本函数 darwin 自动
   * fallback 到 `security` 命令读 Keychain，输出 JSON 内容跟文件版完全一致，复用
   * 同一套 parse 逻辑。Linux 容器场景没有 `security` 命令也不会走 darwin 分支。
   */
  private readLocalSessionToken(): { token: string } | ModelListResult {
    const configDir = process.env.CLAUDE_CONFIG_DIR
    const credPath = configDir
      ? join(configDir, '.credentials.json')
      : join(homedir(), '.claude', '.credentials.json')

    let raw: string
    let source: string

    if (existsSync(credPath)) {
      source = credPath
      try {
        raw = readFileSync(credPath, 'utf-8')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          models: [],
          error: `Failed to read ${credPath}: ${message}`,
          code: 'local_session_read_failed',
          details: { credPath },
        }
      }
    } else if (process.platform === 'darwin') {
      // macOS Keychain fallback：claude CLI 在 mac 上把凭证存 Keychain 而非文件。
      // `security -w` 输出 generic-password 的 password value，即跟 .credentials.json
      // 完全一致的 JSON 文本（Anthropic 官方文档化的命令）。
      // 首次访问可能弹系统授权对话框；timeout 给 5s 兜底 SSH/headless 场景。
      try {
        raw = execFileSync(
          'security',
          ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
          { timeout: 5_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
        ).trim()
        source = 'macOS Keychain (Claude Code-credentials)'
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          models: [],
          error: `Claude CLI is not logged in on this machine: ${credPath} does not exist and reading the macOS Keychain failed (${message}). Run \`claude /login\` on macOS first, or mount the host's ~/.claude/ into the container for container/Linux deployments.`,
          code: 'local_session_not_logged_in',
          details: { credPath, keychainError: message },
        }
      }
    } else {
      return {
        models: [],
        error: `Claude CLI is not logged in on this machine (${credPath} does not exist). Run \`claude /login\` inside the container, or mount the host's ~/.claude/ into the container.`,
        code: 'local_session_not_logged_in',
        details: { credPath },
      }
    }

    let parsed: { claudeAiOauth?: { accessToken?: unknown } }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        models: [],
        error: `${source} is not valid JSON: ${message}`,
        code: 'local_session_invalid_format',
        details: { source },
      }
    }
    const token = parsed?.claudeAiOauth?.accessToken
    if (typeof token !== 'string' || token.length === 0) {
      return {
        models: [],
        error: `${source} is missing claudeAiOauth.accessToken (incompatible claude CLI version, or the stored login is corrupted)`,
        code: 'local_session_invalid_format',
        details: { source },
      }
    }
    return { token }
  }

  /**
   * List the Claude Code model IDs available for an auth mode and credential.
   * Claude Code has no list-models command, so this probes HTTP /v1/models:
   * - apiKey: user Base URL; legacy `sk-*` keys use x-api-key, while opaque
   *   proxy tokens use Bearer auth
   * - oauth: fixed api.anthropic.com endpoint with the supplied OAuth token
   * - localSession: read the local Claude login token and use the OAuth probe
   */
  async listAvailableModels(options: ListModelsOptions): Promise<ModelListResult> {
    const { authMode } = options

    let baseUrl: string
    let key: string

    if (authMode === 'apiKey') {
      if (!options.apiKey) {
        return { models: [], error: 'apiKey is required for apiKey mode', code: 'invalid_input' }
      }
      if (!options.baseUrl) {
        return { models: [], error: 'baseUrl is required for apiKey mode', code: 'invalid_input' }
      }
      baseUrl = options.baseUrl
      key = options.apiKey
    } else if (authMode === 'oauth') {
      if (!options.oauthToken) {
        return { models: [], error: 'oauthToken is required for oauth mode', code: 'invalid_input' }
      }
      // OAuth token 绑死 api.anthropic.com（CLI 行为一致）
      baseUrl = CLAUDE_OAUTH_BASE_URL
      key = options.oauthToken
    } else {
      // localSession：从本机 claude CLI 登录态文件抽 OAuth token，转走 oauth probe 路径。
      const cred = this.readLocalSessionToken()
      // 用 'token' in cred 做类型收窄：success 分支 token 是 required，error 分支
      // 无 token 字段；ModelListResult.error 是 optional 所以反向 'error' in cred
      // 无法可靠收窄（TS 不会把 optional 字段当判定锚点）。
      if (!('token' in cred)) return cred
      baseUrl = CLAUDE_OAUTH_BASE_URL
      key = cred.token
    }

    // Normalize the probe path idempotently so both `https://host` and
    // `https://host/v1` resolve to exactly one `/v1/models` suffix.
    const normalizedBase = normalizeClaudeProxyBaseUrl(baseUrl)
    const usesFixedClaudeOauthEndpoint = authMode === 'oauth' || authMode === 'localSession'
    const url = usesFixedClaudeOauthEndpoint
      ? CLAUDE_OAUTH_MODELS_URL
      : `${normalizedBase}/v1/models`
    const isOauthCredential = authMode === 'oauth' || authMode === 'localSession'
    const usesBearerAuth =
      isOauthCredential || (authMode === 'apiKey' && options.authHeaderStyle === 'bearer')
    const authHeaders: Record<string, string> = usesBearerAuth
      ? {
          Authorization: `Bearer ${key}`,
          ...(isOauthCredential ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
        }
      : { 'x-api-key': key }
    logger.info(
      {
        url,
        authMode,
        authHeaderStyle:
          authMode === 'apiKey'
            ? options.authHeaderStyle === 'bearer'
              ? 'bearer'
              : 'x-api-key'
            : undefined,
        authHeaderKind: usesBearerAuth ? 'Bearer' : 'x-api-key',
        keyLen: key.length,
      },
      '[claude-code] listAvailableModels probing',
    )

    let pinnedDispatcher: UndiciAgent | undefined
    try {
      // Only the non-user-controlled Claude OAuth endpoint may inherit the
      // enterprise-private DNS exception. A user-entered API-key Base URL,
      // including api.anthropic.com on another port/path, stays on the generic
      // Provider allowlist path.
      const { addresses } = usesFixedClaudeOauthEndpoint
        ? await resolvePublicUrl(CLAUDE_OAUTH_MODELS_URL, undefined, {
            allowPrivateDnsAnswers: true,
          })
        : await resolveProviderUrl(url)
      pinnedDispatcher = new UndiciAgent({
        connect: {
          lookup: createPinnedLookup(addresses),
        },
      })
      const res = await safeFetch(url, {
        method: 'GET',
        headers: {
          ...authHeaders,
          'anthropic-version': '2023-06-01',
        },
        signal: AbortSignal.timeout(15_000),
        maxRedirects: 0,
        dispatcher: pinnedDispatcher,
      } as Parameters<typeof safeFetch>[1])

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '')
        const body = bodyText.slice(0, 500)
        logger.warn(
          { url, status: res.status, body: truncateForRaw(body, 300) },
          '[claude-code] listAvailableModels http error',
        )
        return {
          models: [],
          error: `HTTP ${res.status}`,
          code: 'http_error',
          details: { status: res.status, body },
        }
      }

      const json = (await res.json()) as { data?: Array<{ id?: string; capabilities?: unknown }> }
      const entries = (json.data ?? []).filter(
        (m): m is { id: string; capabilities?: unknown } =>
          typeof m.id === 'string' && m.id.length > 0,
      )
      const models = entries.map((m) => m.id)

      const capabilitiesByModel = new Map<string, ModelCapabilities>()
      for (const entry of entries) {
        const efforts = readEffortCapability(entry.capabilities)
        if (efforts) capabilitiesByModel.set(entry.id, { reasoningEfforts: efforts })
      }
      const modelCapabilities = finalizeModelCapabilities(capabilitiesByModel)

      // Only meaningful against Anthropic's own endpoint — a proxy neither owns
      // the entitlement nor can speak for it.
      const fastMode = usesFixedClaudeOauthEndpoint
        ? await probeFastModeAvailability(key, true)
        : undefined

      logger.info({ url, count: models.length }, '[claude-code] listAvailableModels success')
      return {
        models,
        ...(modelCapabilities ? { modelCapabilities } : {}),
        ...(fastMode ? { fastMode } : {}),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn({ url, err: message }, '[claude-code] listAvailableModels failed')
      return {
        models: [],
        error: message,
        code:
          err instanceof UnsafeUrlError
            ? 'invalid_input'
            : err instanceof DOMException && err.name === 'TimeoutError'
              ? 'timeout'
              : 'http_error',
      }
    } finally {
      await pinnedDispatcher?.close().catch(() => {})
    }
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
    const perAgentOauthToken = agentConfig?.providerOauthToken as string | undefined
    const agentEnv = agentConfig?.agentEnv as Record<string, string> | undefined
    const runtimeEnv = request.runtimeContext?.env
    const authMode =
      (agentConfig?.authMode as 'apiKey' | 'oauth' | 'localSession' | undefined) ?? 'apiKey'
    const authHeaderStyle = agentConfig?.authHeaderStyle === 'bearer' ? 'bearer' : 'x-api-key'
    const approveMcpsOverride =
      agentConfig?.approveMcps !== undefined ? Boolean(agentConfig.approveMcps) : undefined
    const resolvedWorkDir = workDir || this.config.defaultWorkDir

    const args = this.buildArgs(prompt, model, 'stream-json', inputChatId, {
      readOnly: agentConfig?.readOnly !== undefined ? Boolean(agentConfig.readOnly) : undefined,
      force: agentConfig?.force !== undefined ? Boolean(agentConfig.force) : undefined,
      approveMcps: approveMcpsOverride,
      reasoningEffort:
        typeof agentConfig?.reasoningEffort === 'string' ? agentConfig.reasoningEffort : undefined,
      fastMode: agentConfig?.fastMode === true,
    })
    const execEnv = this.buildEnv(
      agentEnv,
      runtimeEnv,
      perAgentApiKey,
      perAgentBaseUrl,
      authMode,
      authHeaderStyle,
      perAgentOauthToken,
    )
    const resolvedApiKey = perAgentApiKey || this.config.apiKey
    const resolvedBaseUrl = perAgentBaseUrl || this.config.baseUrl
    const streamTimeoutMinutes = agentConfig?.timeoutMinutes ?? this.config.timeoutMinutes
    const streamTimeoutMs = streamTimeoutMinutes * 60 * 1000
    const execParams: Record<string, unknown> = {
      cmd: this.config.path,
      args: filterClaudeCodeArgs(args),
      cwd: resolvedWorkDir,
      authMode,
      authHeaderStyle: authMode === 'apiKey' ? authHeaderStyle : undefined,
      ...(typeof agentConfig?.reasoningEffort === 'string'
        ? { reasoningEffort: agentConfig.reasoningEffort }
        : {}),
      ...(agentConfig?.fastMode === true ? { fastMode: true } : {}),
      baseUrl: resolvedBaseUrl,
      timeout: streamTimeoutMs,
      runtimeHome: request.runtimeContext?.home.dir,
      workspaceDir: request.runtimeContext?.workspace.dir,
      workspaceType: request.runtimeContext?.workspace.type,
      artifactsDir: request.runtimeContext?.artifacts.dir,
    }
    if (resolvedApiKey) {
      execParams.apiKey = '***'
    }
    if (perAgentOauthToken) execParams.oauthToken = `${perAgentOauthToken.slice(0, 8)}***`
    logger.info({ taskId, ...execParams }, '[claude-code] execute (stream) params')
    onLogEntry?.({
      type: 'exec_params',
      engine: 'claude-code',
      params: toDisplayExecParams(execParams),
      ts: Date.now(),
    })

    // Startup marker — fires BEFORE spawn, useful when the CLI binary is
    // slow to launch (cold MCP/skill sync). Paired with `spawned` below.
    onLogEntry?.({ type: 'system', subtype: 'preparing', ts: Date.now() })

    const heartbeat = createHeartbeatTracker({
      intervalMs: TOOL_HEARTBEAT_INTERVAL_MS,
      emit: (entry) => onLogEntry?.(entry),
    })

    let sessionId = inputChatId
    let outputBuffer = ''
    let resultReceived = false
    let resultIsError = false
    let resultErrorText = ''
    let lastUsage: TokenUsage | undefined
    // Map callId -> toolName so terminal tool_call entries carry the name
    // the UI renders. CC's stream-json doesn't repeat the toolName on the
    // tool_result message, and the timeline component displays toolName
    // directly, so an empty toolName would show a blank ✓/✗ row.
    const toolNameByCallId = new Map<string, string>()

    const parseLine = (line: string) => {
      if (!line.trim()) return
      const data = tryParseJson(line)
      if (!data) return

      if (typeof data.session_id === 'string' && data.session_id) {
        sessionId = data.session_id
      } else if (typeof data.chat_id === 'string' && data.chat_id) {
        sessionId = data.chat_id
      }

      const type = data.type as string | undefined
      const subtype = data.subtype as string | undefined
      if (!type) return

      switch (type) {
        case 'system': {
          if (subtype && NOISE_SYSTEM_SUBTYPES.has(subtype)) break
          onLogEntry?.({
            type: 'system',
            subtype: subtype || 'system',
            model: data.model as string | undefined,
            ts: Date.now(),
          })
          break
        }
        case 'stream_event': {
          const event = data.event as Record<string, unknown> | undefined
          const delta = event?.delta as Record<string, unknown> | undefined
          if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
            outputBuffer += delta.text
            onUpdate?.(outputBuffer)
            onLogEntry?.({
              type: 'assistant',
              text: delta.text,
              ts: Date.now(),
            })
          }
          break
        }
        case 'assistant': {
          const message = data.message as Record<string, unknown> | undefined
          const content = message?.content as unknown[] | undefined
          if (!content) break
          for (const block of content) {
            if (!block || typeof block !== 'object') continue
            const typedBlock = block as Record<string, unknown>
            if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
              outputBuffer += typedBlock.text
              onUpdate?.(outputBuffer)
              onLogEntry?.({
                type: 'assistant',
                text: typedBlock.text,
                ts: Date.now(),
              })
            }
            if (typedBlock.type === 'tool_use') {
              // CC's stream-json emits tool_use in assistant events (start)
              // and tool_result content blocks in USER events (completion).
              // The `case 'user':` below parses the latter and emits the
              // matching `tool_call:completed|failed` entry.
              const rawInput = typedBlock.input
              const input =
                rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
                  ? (rawInput as Record<string, unknown>)
                  : undefined
              const callId = (typedBlock.id as string) || ''
              const toolName = (typedBlock.name as string) || 'unknown'
              if (callId) toolNameByCallId.set(callId, toolName)
              onLogEntry?.({
                type: 'tool_call',
                subtype: 'started',
                callId,
                toolName,
                input,
                ts: Date.now(),
              })
              if (callId) heartbeat.onStarted(callId, toolName)
            }
          }
          break
        }
        case 'user': {
          // CC emits tool results as USER messages containing tool_result
          // content blocks. Match them back to the `started` entry by
          // tool_use_id and emit the terminal subtype.
          const message = data.message as Record<string, unknown> | undefined
          const content = message?.content as unknown[] | undefined
          if (!Array.isArray(content)) break
          for (const block of content) {
            if (!block || typeof block !== 'object') continue
            const typedBlock = block as Record<string, unknown>
            if (typedBlock.type !== 'tool_result') continue
            const callId = (typedBlock.tool_use_id as string) || ''
            if (!callId) continue
            const isError = typedBlock.is_error === true
            // The text is usually either a string or an array of blocks.
            let errorText: string | undefined
            if (isError) {
              const raw = typedBlock.content
              if (typeof raw === 'string') {
                errorText = raw
              } else if (Array.isArray(raw)) {
                errorText =
                  raw
                    .map((b) => {
                      if (
                        b &&
                        typeof b === 'object' &&
                        'text' in b &&
                        typeof (b as { text: unknown }).text === 'string'
                      ) {
                        return (b as { text: string }).text
                      }
                      return ''
                    })
                    .filter(Boolean)
                    .join('\n') || undefined
              }
            }
            heartbeat.onSettled(callId)
            const toolName = toolNameByCallId.get(callId) ?? ''
            toolNameByCallId.delete(callId)
            onLogEntry?.({
              type: 'tool_call',
              subtype: isError ? 'failed' : 'completed',
              callId,
              toolName,
              ...(errorText ? { error: errorText } : {}),
              ts: Date.now(),
            })
          }
          break
        }
        case 'result': {
          resultReceived = true
          resultIsError = data.is_error === true
          // A later result without usage must not clear already captured usage.
          const usage = extractClaudeStyleUsage(data)
          if (usage) lastUsage = usage
          const resultText = typeof data.result === 'string' ? data.result : ''
          if (resultText) {
            outputBuffer = resultText.trim()
            onUpdate?.(outputBuffer)
          }
          if (resultIsError) {
            resultErrorText = resultText || 'Claude Code returned an error result'
          }
          // Recorded rather than inferred, and taken from the server's answer
          // rather than the client's request — see resolveFastModeState. A run
          // where neither source says anything keeps the field absent, because
          // defaulting to "off" would state a verdict nobody issued.
          const fastModeState = resolveFastModeState(
            (data.usage as { speed?: unknown } | undefined)?.speed,
            data.fast_mode_state,
          )
          onLogEntry?.({
            type: 'result',
            subtype: resultIsError ? 'error' : 'success',
            durationMs: typeof data.duration_ms === 'number' ? data.duration_ms : undefined,
            ...(lastUsage ? { usage: lastUsage } : {}),
            ...(fastModeState ? { fastModeState } : {}),
            ts: Date.now(),
          })
          break
        }
        case 'error': {
          const message = (data.message as string) || (data.error as string) || 'Unknown error'
          resultErrorText = message
          onLogEntry?.({ type: 'error', message, ts: Date.now() })
          break
        }
        default:
          break
      }
    }

    return this.runCliStream({
      taskId,
      args,
      env: execEnv,
      cwd: resolvedWorkDir,
      timeoutMs: streamTimeoutMs,
      onStdoutLine: parseLine,
      // CC's main stream is stdout, but some errors land on stderr — parse
      // those lines too (the base also collects them for the settle verdict).
      parseStderrLines: true,
      getUsage: () => lastUsage,
      onSpawned: () => onLogEntry?.({ type: 'system', subtype: 'spawned', ts: Date.now() }),
      cleanup: () => heartbeat.stop(),
      settle: ({ exitCode, stderr }) => {
        if (resultIsError) {
          return {
            ok: false,
            error: new Error(resultErrorText || stderr || 'Claude Code stream execution failed'),
            usage: lastUsage,
          }
        }
        if (resultReceived || exitCode === 0) {
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
        return {
          ok: false,
          error: new Error(formatExitError(exitCode ?? 1, stderr)),
          usage: lastUsage,
        }
      },
    })
  }

  /**
   * Builds the identity-injection prompt so the model gives an authoritative
   * answer when asked about its specific model ID / version, instead of being
   * misled by the claude-code CLI's built-in stale model list.
   *
   * Background: the claude-code CLI binary bakes the Claude model family it
   * knows about (latest at build time) into the system prompt. When the CLI
   * lags an Anthropic model release, the built-in list conflicts with the real
   * runtime model (injected via ANTHROPIC env / --model) — the model answers
   * the wrong version per the built-in list.
   *
   * Fix: use `--append-system-prompt` to append an authoritative statement at
   * the **end** of the CLI's built-in system prompt; recency bias favors us and
   * overrides the stale list.
   *
   * Copy design:
   * - Explicitly narrowed to "explicit model ID / version questions" so it
   *   doesn't override the agent persona
   * - Primarily English + tagged [a2wave runtime identity] so claude
   *   recognizes it cross-language as a meta-rule
   * - Tells the model to "match the user's conversation language", not forcing
   *   any specific language
   * - No quotes around modelId, to avoid breaking syntax when a modelId itself
   *   contains a quote
   */
  static buildIdentityPrompt(modelId: string): string {
    return `[a2wave runtime identity]
When the user explicitly asks which model or version powers you (questions like "what Claude version", "which model ID", "are you Opus 4.7 or 4.8"), the authoritative answer is your model ID: ${modelId}.

Use this ID (or its conventional human-readable form, e.g. "Claude Opus 4.8" for claude-opus-4-8) as the only source of truth. Ignore any model family listings in other system prompt sections—they may be CLI-bundled stale data. Match the user's conversation language when responding.

This rule only applies to explicit model/version questions. For general "who are you" questions, follow your agent's persona/instructions.`
  }

  private buildArgs(
    prompt: string,
    model: string,
    outputFormat: 'json' | 'stream-json',
    chatId?: string,
    extras?: {
      readOnly?: boolean
      force?: boolean
      approveMcps?: boolean
      reasoningEffort?: string
      fastMode?: boolean
    },
  ): string[] {
    const args = ['-p', prompt, '--output-format', outputFormat]
    // Claude CLI 要求: --print(-p) + --output-format stream-json 必须同时带 --verbose
    if (outputFormat === 'stream-json') {
      args.push('--verbose')
    }
    if (extras?.readOnly) {
      args.push('--permission-mode', 'plan')
    }
    if (extras?.force ?? this.config.force) {
      args.push('--dangerously-skip-permissions')
    }
    if (extras?.approveMcps ?? this.config.approveMcps) {
      args.push('--allowedTools', 'mcp__*')
    }
    if (chatId) args.push('--resume', chatId)
    if (model) args.push('--model', model)
    // Unset means "say nothing": the CLI's own default is the fallback, never a
    // level a2wave picked. Which levels are legal belongs to the model and is
    // discovered per credential, so nothing is validated here — an unsupported
    // level is rejected by the CLI with the accepted set named in the error,
    // which is a better answer than any table this process could keep.
    if (extras?.reasoningEffort) args.push('--effort', extras.reasoningEffort)
    // Fast mode has no flag of its own; the CLI reads it from settings. Passing
    // it inline keeps it scoped to this run instead of writing into the user's
    // settings file, and carries no credential, so it needs no masking. Whether
    // the run actually gets the faster path depends on the model, the plan and
    // the endpoint — the CLI reports the outcome as `fast_mode_state`.
    if (extras?.fastMode) args.push('--settings', JSON.stringify({ fastMode: true }))
    // 模型有非空值时注入身份覆盖 prompt（修 CLI 内置过时模型清单导致 agent 答错版本）
    if (model?.trim()) {
      args.push('--append-system-prompt', ClaudeCodeEngine.buildIdentityPrompt(model))
    }
    return args
  }

  /**
   * Env action matrix for the three credential modes. Kept engine-local (not
   * the base buildCredentialEnv) because it sets a LANG/LC_ALL baseline, has
   * three mode branches with different key sets, and injects
   * CLAUDE_CODE_OAUTH_TOKEN for the oauth mode:
   * - apiKey:       x-api-key (the default for existing bindings) uses
   *                 ANTHROPIC_API_KEY and preserves the configured Base URL;
   *                 explicit bearer uses ANTHROPIC_AUTH_TOKEN and removes a
   *                 trailing `/v1` from the Base URL. Empty bindings do not
   *                 inherit Claude credentials or Base URLs from the process
   * - oauth:        inject CLAUDE_CODE_OAUTH_TOKEN; clear ANTHROPIC_API_KEY /
   *                 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL (the OAuth token
   *                 is bound to api.anthropic.com; a proxy breaks the handshake)
   * - localSession: clear everything and use the ~/.claude/ local login state
   *
   * **Credential-isolation invariant**: authMode is the single source of truth
   * for the credential mode; agentEnv must not carry these four credential env
   * vars to override the isolation (otherwise oauth/localSession isolation is
   * defeated).
   */
  private buildEnv(
    agentEnv?: Record<string, string>,
    runtimeEnv?: Record<string, string>,
    perAgentApiKey?: string,
    perAgentBaseUrl?: string,
    authMode: 'apiKey' | 'oauth' | 'localSession' = 'apiKey',
    authHeaderStyle: 'x-api-key' | 'bearer' = 'x-api-key',
    perAgentOauthToken?: string,
  ): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...buildSafeAgentProcessEnv(),
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
    }
    clearClaudeCredentialEnv(env)
    if (authMode === 'oauth') {
      if (perAgentOauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = perAgentOauthToken
    } else if (authMode === 'apiKey') {
      const resolvedApiKey = perAgentApiKey || this.config.apiKey
      const resolvedBaseUrl = perAgentBaseUrl || this.config.baseUrl
      if (authHeaderStyle === 'bearer') {
        if (resolvedApiKey) env.ANTHROPIC_AUTH_TOKEN = resolvedApiKey
      } else {
        if (resolvedApiKey) env.ANTHROPIC_API_KEY = resolvedApiKey
      }
      if (resolvedBaseUrl) {
        env.ANTHROPIC_BASE_URL =
          authHeaderStyle === 'bearer'
            ? normalizeClaudeProxyBaseUrl(resolvedBaseUrl)
            : resolvedBaseUrl
      }
    }

    // agentEnv must not override credential env: strip first, then merge
    const sanitizedAgentEnv = sanitizeAgentRuntimeEnv(agentEnv ? { ...agentEnv } : undefined)
    if (sanitizedAgentEnv) clearClaudeCredentialEnv(sanitizedAgentEnv)
    const effectiveRuntimeEnv =
      authMode === 'localSession' ? omitRuntimeEnvKeys(runtimeEnv, ['HOME']) : runtimeEnv
    return { ...env, ...(sanitizedAgentEnv || {}), ...(effectiveRuntimeEnv || {}) }
  }
}
