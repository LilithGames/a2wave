import type { AuthHeaderStyle } from '@a2wave/shared'

/**
 * Agent execution engine abstraction layer
 *
 * Every Agent type (cursor / llm / script) implements the unified AgentEngine interface.
 * This keeps the upper orchestration logic decoupled from the underlying execution details.
 */

/** Engine execution request (base fields) */
export type RuntimeWorkspaceType = 'temp' | 'configured' | 'scm-local' | 'scm-worktree'
export type RuntimeCleanupPolicy = 'never' | 'after-run' | 'ttl'

export interface RuntimeWorkspace {
  dir: string
  type: RuntimeWorkspaceType
  cleanup: RuntimeCleanupPolicy
  sourceId?: string
  worktreeName?: string
}

export interface RuntimeHome {
  dir: string
  cacheDir: string
  configDir: string
  tmpDir: string
  claudeDir: string
  codexHomeDir: string
}

export interface RuntimeArtifacts {
  dir: string
}

export interface AgentRuntimeContext {
  agentId: string
  runId: string
  workspace: RuntimeWorkspace
  home: RuntimeHome
  artifacts: RuntimeArtifacts
  env: Record<string, string>
}

export interface ExecuteRequest {
  /** Unique task identifier */
  taskId: string
  /** Working directory (sandbox path) */
  workDir: string
  /** User prompt / instruction */
  prompt: string
  /** Name of the model to use */
  model?: string
  /** Fallback model list */
  fallbackModels?: string[]
  /** Existing session ID (used to continue an earlier context) */
  chatId?: string
  /** Extra context (for the {{context}} template variable, rendered as a JSON string) */
  context?: Record<string, unknown>
  /** Branch name (used for log tagging) */
  branch?: string
  /** Full Agent config (passed through so engines can read advanced options like readOnly / sandbox) */
  agentConfig?: import('../lib/agent-helpers.js').AgentConfig
  /** Runtime context the platform prepared for this execution (HOME/cache/tmp, etc.); not user config */
  runtimeContext?: AgentRuntimeContext
}

/** Token usage for one engine execution. Omitted fields were not reported. */
export interface TokenUsage {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** Engine execution result */
export interface ExecuteResult {
  /** Whether the execution succeeded */
  success: boolean
  /** Execution output text */
  output: string
  /** Session ID (can be used to continue later) */
  chatId?: string
  /** Execution duration (milliseconds) */
  durationMs: number
  /** Error message */
  error?: string
  /** Token usage reported by this execution, when available. */
  usage?: TokenUsage
}

/** Stream callback: fired whenever new content arrives */
export type StreamCallback = (content: string) => void

/** Stream log entry — records key events during execution */
export type StreamLogEntry =
  | {
      type: 'system'
      subtype: string
      model?: string
      providerName?: string
      nextProviderName?: string
      metadata?: Record<string, unknown>
      ts: number
    }
  | { type: 'assistant'; text: string; ts: number }
  | {
      type: 'tool_call'
      subtype: 'started' | 'completed' | 'failed'
      callId: string
      toolName: string
      input?: Record<string, unknown>
      error?: string
      metadata?: Record<string, unknown>
      ts: number
    }
  | { type: 'tool_heartbeat'; callId: string; toolName: string; elapsedMs: number; ts: number }
  | { type: 'result'; subtype: string; durationMs?: number; usage?: TokenUsage; ts: number }
  | { type: 'error'; message: string; ts: number }
  | { type: 'retry'; attempt: number; nextAttemptIn: number; ts: number }
  | { type: 'exec_params'; engine: string; params: Record<string, unknown>; ts: number }

/** Log callback: fired whenever a new stream log entry is produced */
export type StreamLogCallback = (entry: StreamLogEntry) => void

/** Execution request (extends the base request with optional streaming callbacks) */
export interface StreamExecuteRequest extends ExecuteRequest {
  /** Stream callback (optional: when omitted, intermediate output is not pushed) */
  onUpdate?: StreamCallback
  /** Log callback: structured logs emitted during execution */
  onLogEntry?: StreamLogCallback
  /** Update interval (seconds) */
  updateIntervalSeconds?: number
}

/**
 * AgentEngine — the Agent execution engine interface
 *
 * Each Agent type maps to one Engine implementation:
 * - CursorAgentEngine: invokes the cursor-agent CLI
 * - LlmEngine: calls the LLM API directly (future)
 * - ScriptEngine: runs a custom script (future)
 */
/**
 * Result of checking the engine's local login state.
 *
 * Gives the UI visible feedback under the "local session" auth mode: whether the CLI is
 * installed, whether the host user has already logged in, and the login method/identity.
 * `raw` preserves the original output for troubleshooting and should not be shown directly
 * to end users.
 */
export interface LoginStatus {
  /** Whether the CLI is installed (locatable via `which` / `--version` runs) */
  installed: boolean
  /** Whether the user is logged in (determined by the CLI's status subcommand) */
  loggedIn: boolean
  /** Human-readable summary (e.g. "Logged in: ChatGPT" / "Logged in as alice@example.com") */
  detail?: string
  /** Login method (ChatGPT / api-key / subscription / ...) */
  method?: string
  /** Raw CLI stdout, truncated, for diagnostics */
  raw?: string
  /** Failure reason (installed=false, or spawn/timeout) */
  error?: string
  /** Detected CLI version (filled by the route layer via getVersion) */
  version?: string
  /** Minimum version required by the preset (from PRESET_PROVIDERS.minVersion) */
  minVersion?: string
  /** Whether version >= minVersion; omitted when no minVersion or the version is unparsable */
  versionOk?: boolean
}

/**
 * Inputs for the Agent config page's "dynamically fetch the available model list" feature.
 *
 * Each engine × authMode combination takes a different path:
 * - claude-code + apiKey   → HTTP probe `${baseUrl}/v1/models` + `x-api-key`
 * - claude-code + oauth    → HTTP probe `https://api.anthropic.com/v1/models` + `x-api-key: <token>`
 *                            (verified in practice: an OAuth token works directly as an API key
 *                            via `x-api-key`)
 * - cursor      + apiKey   → spawn `cursor-agent --list-models` + env `CURSOR_API_KEY`
 * - cursor      + localSession → spawn `cursor-agent --list-models`, reading the container's
 *                            login state
 * - codex       + *        → spawn `codex debug models`, no credentials (the CLI has a hardcoded
 *                            catalog)
 * - pi          + apiKey   → spawn `pi --offline --list-models openai` against an ephemeral
 *                            OpenAI-compatible provider override
 * - pi          + localSession → spawn `pi --offline --list-models` against deployment auth
 * - claude-code + localSession → not called; the frontend uses policy=static
 */
export interface ListModelsOptions {
  authMode: 'apiKey' | 'oauth' | 'localSession'
  /** Claude API-key transport; omitted legacy values preserve x-api-key behavior. */
  authHeaderStyle?: AuthHeaderStyle
  /** API Key entered by the user in apiKey mode; delivery is engine-specific. */
  apiKey?: string
  /** OAuth token entered by the user in oauth mode (only Claude Code has this mode) */
  oauthToken?: string
  /** Optional API base URL or proxy endpoint entered in apiKey mode. */
  baseUrl?: string
}

/**
 * Model listing result. On success it carries `models`; on failure `error` + `code` and
 * optionally `details`.
 */
export interface ModelListResult {
  /** Available model ids retrieved (populated on success, empty array on failure) */
  models: string[]
  /** Failure signal — a non-empty value in either field means failure */
  error?: string
  /** Failure code: 'unsupported_mode' / 'http_error' / 'no_account_models' / 'cli_failed' / 'timeout' / 'spawn_failed' / 'parse_failed' */
  code?: string
  /** Diagnostic info (HTTP body excerpt / stderr excerpt / status code) */
  details?: Record<string, unknown>
}

export interface AgentEngine {
  /** Engine type identifier */
  readonly type: string

  /** Run a task (always uses the stream-json format, pushing intermediate output and logs via optional callbacks) */
  executeStream(request: StreamExecuteRequest): Promise<ExecuteResult>

  /** Check whether the engine is available (e.g. whether the CLI is installed) */
  healthCheck(): Promise<boolean>

  /** Terminate the process for a given taskId (optional implementation) */
  kill?(taskId: string): boolean

  /** Check whether the host has completed a local login (used by authMode=localSession). Optional. */
  checkLoginStatus?(): Promise<LoginStatus>

  /**
   * Probe the installed CLI version (raw `--version` output; null when not
   * installed or the probe fails). The route layer compares it against the
   * preset minVersion to warn about missing subcommands on old builds. Optional.
   */
  getVersion?(): Promise<string | null>

  /**
   * List the model ids available for the current (authMode, credentials) combination.
   *
   * Powers the Agent config page's "dynamically fetch the model list" feature. Optional —
   * engines that do not implement it are rejected at the route layer with `unsupported_mode`.
   *
   * Implementation contract: always resolve, never throw; on failure return
   * `{ models: [], error, code }`.
   */
  listAvailableModels?(options: ListModelsOptions): Promise<ModelListResult>
}
