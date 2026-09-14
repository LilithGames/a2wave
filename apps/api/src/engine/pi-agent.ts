/**
 * Pi CLI execution engine.
 *
 * Pi is a minimal, multi-provider coding agent. a2wave invokes its documented
 * JSON mode, discovers account-configured models with `--list-models`, resumes
 * persisted sessions (forking them when the worktree changes) and explicitly
 * mounts only the Skills selected on the Agent. API-key probes and runs use an
 * ephemeral models.json override to scope a key and optional proxy URL to Pi's
 * built-in OpenAI provider without mutating the deployment-level auth store. Pi
 * intentionally has no built-in MCP client, so this adapter does not
 * synthesize an MCP extension.
 */

import { type Dirent, rmSync } from 'node:fs'
import { type FileHandle, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { logger } from '../lib/logger.js'
import { BaseCliAgentEngine, type CliEngineBaseConfig } from './cli-engine-base.js'
import { formatExitError } from './cursor-agent.js'
import { toDisplayExecParams } from './exec-params.js'
import { createHeartbeatTracker } from './heartbeat.js'
import { runStatusProbe, truncateForRaw } from './login-status-helper.js'
import { createPiStreamParser } from './pi-stream-parser.js'
import type {
  ExecuteResult,
  ListModelsOptions,
  LoginStatus,
  ModelListResult,
  StreamExecuteRequest,
} from './types.js'

const ENGINE_TYPE = 'pi'
const PI_API_KEY_PROVIDER = 'openai'
const TOOL_HEARTBEAT_INTERVAL_MS = 20_000
const STDERR_SAMPLE_CHARS = 500
const SESSION_HEADER_READ_CHUNK_BYTES = 64 * 1024

/** Values forced by the platform rather than inherited from Agent env. */
const PROTECTED_PI_ENV_NAMES = [
  'A2WAVE_PI_PROVIDER_API_KEY',
  'PI_CODING_AGENT_DIR',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
] as const

const PI_API_KEY_AGENT_ENV_ONLY_NAMES = [
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

/**
 * Credential, routing and deployment-location variables that may be supplied
 * by the trusted service environment, but never by an Agent editor. Pi supports
 * many providers; a generic Agent env field must not be able to replace the
 * deployment account, relocate its state, or redirect a bearer token.
 */
const AGENT_ENV_ONLY_PI_NAMES = [
  // Deployment-controlled location overrides must survive from process.env,
  // while remaining unavailable to Agent-authored env or runtime isolation.
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_PACKAGE_DIR',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANT_LING_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'BASETEN_API_KEY',
  'DEEPSEEK_API_KEY',
  'NVIDIA_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_CLOUD_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'XAI_API_KEY',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'OPENROUTER_API_KEY',
  'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY',
  'ZAI_CODING_CN_API_KEY',
  'MISTRAL_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'MOONSHOT_API_KEY',
  'OPENCODE_API_KEY',
  'KIMI_API_KEY',
  'CLOUDFLARE_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_GATEWAY_ID',
  'QWEN_TOKEN_PLAN_API_KEY',
  'QWEN_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_API_KEY',
  'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  'RADIUS_API_KEY',
  'HF_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_REGION',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_ROLE_ARN',
  'AWS_ENDPOINT_URL_BEDROCK_RUNTIME',
  'AWS_BEDROCK_FORCE_CACHE',
  'AWS_BEDROCK_SKIP_AUTH',
  'AWS_BEDROCK_FORCE_HTTP1',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

const PI_API_KEY_AGENT_ENV_ONLY_SET = new Set<string>(PI_API_KEY_AGENT_ENV_ONLY_NAMES)
const PI_API_KEY_PROTECTED_ENV_NAMES = [
  ...PROTECTED_PI_ENV_NAMES,
  ...AGENT_ENV_ONLY_PI_NAMES.filter((name) => !PI_API_KEY_AGENT_ENV_ONLY_SET.has(name)),
] as const

async function createPiProviderOverride(baseUrl?: string): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), 'a2wave-pi-provider-'))
  try {
    await writeFile(
      join(configDir, 'models.json'),
      `${JSON.stringify(
        {
          providers: {
            [PI_API_KEY_PROVIDER]: {
              ...(baseUrl ? { baseUrl } : {}),
              apiKey: '$A2WAVE_PI_PROVIDER_API_KEY',
            },
          },
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
    return configDir
  } catch (error) {
    await rm(configDir, { recursive: true, force: true })
    throw error
  }
}

function truncateStderrTail(stderr: string, maxLen = STDERR_SAMPLE_CHARS): string {
  const trimmed = stderr.trim()
  return trimmed.length <= maxLen ? trimmed : `...${trimmed.slice(-maxLen)}`
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function stripAnsi(value: string): string {
  // ANSI CSI sequences (colors/styles) are possible when an operator forces
  // color output even though probes use pipes.
  const ansiCsiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g')
  return value.replace(ansiCsiPattern, '')
}

interface PiSessionLocation {
  path: string
  cwd: string
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

async function readPiSessionHeader(path: string): Promise<{ id: string; cwd: string } | undefined> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const chunks: Buffer[] = []
    let position = 0
    while (true) {
      const buffer = Buffer.alloc(SESSION_HEADER_READ_CHUNK_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break

      const slice = buffer.subarray(0, bytesRead)
      const lineEnd = slice.indexOf(10)
      chunks.push(lineEnd < 0 ? slice : slice.subarray(0, lineEnd))
      if (lineEnd >= 0 || bytesRead < buffer.length) break
      position += bytesRead
    }

    const line = Buffer.concat(chunks)
    if (line.length === 0) return undefined
    const parsed = JSON.parse(line.toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const header = parsed as Record<string, unknown>
    return header.type === 'session' &&
      typeof header.id === 'string' &&
      typeof header.cwd === 'string'
      ? { id: header.id, cwd: header.cwd }
      : undefined
  } catch {
    return undefined
  } finally {
    await handle?.close()
  }
}

/** Find the persisted Pi session independently of the current worktree cwd. */
async function findPiSession(
  sessionDir: string,
  sessionId: string,
): Promise<PiSessionLocation | undefined> {
  let entries: Dirent[]
  try {
    entries = await readdir(sessionDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }

  const expectedSuffix = `_${sessionId}.jsonl`
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(expectedSuffix))
    .sort((left, right) => right.name.localeCompare(left.name))
  for (const candidate of candidates) {
    const path = join(sessionDir, candidate.name)
    const header = await readPiSessionHeader(path)
    if (header?.id === sessionId) return { path, cwd: header.cwd }
  }
  return undefined
}

/** Parse Pi's fixed-width `--list-models` table into provider/model IDs. */
export function parsePiModelIds(stdout: string): string[] {
  const lines = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const headerIndex = lines.findIndex((line) => {
    const columns = line.split(/\s{2,}/)
    return columns[0]?.toLowerCase() === 'provider' && columns[1]?.toLowerCase() === 'model'
  })
  if (headerIndex < 0) return []

  const models = new Set<string>()
  for (const line of lines.slice(headerIndex + 1)) {
    const columns = line.split(/\s{2,}/)
    const provider = columns[0]?.trim()
    const model = columns[1]?.trim()
    if (!provider || !model || /\s/.test(provider) || /\s/.test(model)) continue
    models.add(`${provider}/${model}`)
  }
  return [...models]
}

export interface PiAgentEngineConfig extends CliEngineBaseConfig {
  /** Deployment-level Pi config/auth directory. Defaults to the host user's ~/.pi/agent. */
  agentDir?: string
}

export class PiAgentEngine extends BaseCliAgentEngine {
  readonly type = ENGINE_TYPE
  protected readonly cliName = 'pi'
  private readonly config: PiAgentEngineConfig
  private readonly agentDir: string

  constructor(config: PiAgentEngineConfig) {
    super(config)
    this.config = config
    this.agentDir = resolve(expandHome(config.agentDir?.trim() || join(homedir(), '.pi', 'agent')))
  }

  async checkLoginStatus(): Promise<LoginStatus> {
    const result = await runStatusProbe(this.config.path, ['--offline', '--list-models'], {
      logTag: 'pi',
      timeoutMs: 20_000,
      completeEnv: this.buildPiEnv(),
    })
    if (result.notFound) {
      return {
        installed: false,
        loggedIn: false,
        error: `pi not found in PATH (${this.config.path})`,
      }
    }
    if (result.timedOut) {
      return {
        installed: true,
        loggedIn: false,
        error: 'pi --list-models timed out',
        raw: truncateForRaw(result.stdout || result.stderr),
      }
    }

    const models = parsePiModelIds(result.stdout)
    const loggedIn = result.exitCode === 0 && models.length > 0
    return {
      installed: true,
      loggedIn,
      ...(loggedIn
        ? { detail: `${models.length} model(s) available`, method: 'Pi local credentials' }
        : {
            error:
              result.stderr.trim() ||
              'No configured Pi models (run `pi` on the host, then use `/login`)',
          }),
      raw: truncateForRaw(result.stdout || result.stderr),
    }
  }

  async listAvailableModels(options: ListModelsOptions): Promise<ModelListResult> {
    if (options.authMode === 'oauth') {
      return {
        models: [],
        error: 'Pi CLI does not support oauth mode',
        code: 'unsupported_mode',
      }
    }

    if (options.authMode === 'apiKey' && !options.apiKey?.trim()) {
      return { models: [], error: 'apiKey is required for apiKey mode', code: 'invalid_input' }
    }

    let ephemeralAgentDir: string | undefined
    let result: Awaited<ReturnType<typeof runStatusProbe>>
    try {
      if (options.authMode === 'apiKey') {
        ephemeralAgentDir = await createPiProviderOverride(options.baseUrl?.trim())
      }
      result = await runStatusProbe(
        this.config.path,
        [
          '--offline',
          '--list-models',
          ...(options.authMode === 'apiKey' ? [PI_API_KEY_PROVIDER] : []),
        ],
        {
          logTag: 'pi-models',
          timeoutMs: 20_000,
          completeEnv: this.buildPiEnv({
            authMode: options.authMode,
            agentDir: ephemeralAgentDir,
            providerApiKey: options.apiKey?.trim(),
          }),
        },
      )
    } catch (error) {
      return {
        models: [],
        error: error instanceof Error ? error.message : String(error),
        code: 'cli_failed',
      }
    } finally {
      if (ephemeralAgentDir) {
        try {
          await rm(ephemeralAgentDir, { recursive: true, force: true })
        } catch (error) {
          logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            '[pi] failed to remove model-probe provider config',
          )
        }
      }
    }
    if (result.notFound) return { models: [], error: 'pi not found in PATH', code: 'spawn_failed' }
    if (result.timedOut) {
      return { models: [], error: 'pi --list-models timed out', code: 'timeout' }
    }
    if (result.exitCode !== 0) {
      const stderr = truncateStderrTail(result.stderr)
      return {
        models: [],
        error: stderr || `pi exit ${result.exitCode}`,
        code: 'cli_failed',
        details: { exitCode: result.exitCode, stderr },
      }
    }

    const models = parsePiModelIds(result.stdout).filter(
      (model) => options.authMode !== 'apiKey' || model.startsWith(`${PI_API_KEY_PROVIDER}/`),
    )
    if (models.length === 0) {
      return {
        models: [],
        error:
          options.authMode === 'apiKey'
            ? 'Pi reported no built-in OpenAI models for this API-key binding'
            : 'Pi reported no configured models (run `pi` on the host, then use `/login`)',
        code: options.authMode === 'apiKey' ? 'parse_failed' : 'local_session_not_logged_in',
        details: { raw: truncateForRaw(result.stdout, 300) },
      }
    }
    logger.info({ count: models.length, sample: models.slice(0, 3) }, '[pi] listAvailableModels')
    return { models }
  }

  protected async executeStreamWithModel(
    request: StreamExecuteRequest,
    model: string,
  ): Promise<ExecuteResult> {
    const { agentConfig, chatId, onLogEntry, onUpdate, prompt, taskId, workDir } = request
    const resolvedWorkDir = workDir || this.config.defaultWorkDir
    const rawAuthMode =
      (agentConfig?.authMode as 'apiKey' | 'oauth' | 'localSession' | undefined) ?? 'localSession'
    if (rawAuthMode === 'oauth') {
      throw new Error('Pi CLI does not support oauth mode (use apiKey or localSession)')
    }
    const authMode: 'apiKey' | 'localSession' = rawAuthMode
    const providerApiKey = agentConfig?.providerApiKey as string | undefined
    const providerBaseUrl = agentConfig?.providerBaseUrl as string | undefined
    if (authMode === 'apiKey' && !providerApiKey?.trim()) {
      throw new Error('Pi apiKey mode requires providerApiKey')
    }
    if (
      authMode === 'apiKey' &&
      (!model.startsWith(`${PI_API_KEY_PROVIDER}/`) ||
        model.length === PI_API_KEY_PROVIDER.length + 1)
    ) {
      throw new Error('Pi apiKey mode requires an openai/<model> id returned by model discovery')
    }
    const sessionDir = join(request.runtimeContext?.home.dir || this.agentDir, '.pi', 'sessions')
    const persistedSession = chatId ? await findPiSession(sessionDir, chatId) : undefined
    if (chatId && !persistedSession) {
      // Pi documents `--session-id` as "use exact project session ID, creating
      // it if missing". Keep the platform chat id stable while allowing the CLI
      // to recover with an empty context after local session storage is lost.
      logger.warn(
        { taskId, chatId, sessionDir },
        '[pi] persisted session missing; starting a fresh session with the existing id',
      )
    }
    const forkSessionPath =
      persistedSession && !pathsEqual(persistedSession.cwd, resolvedWorkDir)
        ? persistedSession.path
        : undefined
    const args = this.buildArgs({
      prompt,
      model,
      workDir: resolvedWorkDir,
      sessionDir,
      chatId: forkSessionPath ? undefined : chatId,
      forkSessionPath,
      readOnly: Boolean(agentConfig?.readOnly),
    })
    const ephemeralAgentDir =
      authMode === 'apiKey' ? await createPiProviderOverride(providerBaseUrl) : undefined
    let ephemeralAgentDirCleaned = false
    const cleanupEphemeralAgentDir = () => {
      if (!ephemeralAgentDir || ephemeralAgentDirCleaned) return
      ephemeralAgentDirCleaned = true
      try {
        // Cleanup is a synchronous `.finally` callback shared by success,
        // process failure, and pre-spawn log-sink failure. rmSync guarantees the
        // credential-bearing override is gone before the execution promise
        // settles; the standalone model probe can await async rm directly.
        rmSync(ephemeralAgentDir, { recursive: true, force: true })
      } catch (error) {
        logger.warn(
          { taskId, err: error instanceof Error ? error.message : String(error) },
          '[pi] failed to remove ephemeral provider config',
        )
      }
    }
    const env = this.buildPiEnv({
      authMode,
      agentDir: ephemeralAgentDir,
      agentEnv: agentConfig?.agentEnv as Record<string, string> | undefined,
      providerApiKey,
      runtimeEnv: request.runtimeContext?.env,
    })
    const timeoutMs = (agentConfig?.timeoutMinutes ?? this.config.timeoutMinutes) * 60 * 1000
    const execParams: Record<string, unknown> = {
      cmd: this.config.path,
      // The prompt is the final positional argument and must never enter logs.
      args: args.slice(0, -1),
      cwd: resolvedWorkDir,
      authMode,
      proxyConfigured: authMode === 'apiKey' && Boolean(providerBaseUrl),
      timeout: timeoutMs,
      runtimeHome: request.runtimeContext?.home.dir,
      piAgentDir: ephemeralAgentDir ? '<ephemeral>' : this.agentDir,
      piSessionDir: sessionDir,
      workspaceDir: request.runtimeContext?.workspace.dir,
      workspaceType: request.runtimeContext?.workspace.type,
      artifactsDir: request.runtimeContext?.artifacts.dir,
    }
    logger.info({ taskId, ...execParams }, '[pi] execute (stream) params')
    try {
      onLogEntry?.({
        type: 'exec_params',
        engine: 'pi',
        params: toDisplayExecParams(execParams),
        ts: Date.now(),
      })
      onLogEntry?.({ type: 'system', subtype: 'preparing', ts: Date.now() })
    } catch (error) {
      cleanupEphemeralAgentDir()
      throw error
    }

    const heartbeat = createHeartbeatTracker({
      intervalMs: TOOL_HEARTBEAT_INTERVAL_MS,
      emit: (entry) => onLogEntry?.(entry),
    })
    const parser = createPiStreamParser({
      onUpdate,
      onLogEntry,
      heartbeat,
      // A fork emits a new session id; never fall back to the source id if its
      // session header is unexpectedly absent from the stream.
      ...(chatId && !forkSessionPath ? { initialSessionId: chatId } : {}),
    })

    return this.runCliStream({
      taskId,
      args,
      env,
      cwd: resolvedWorkDir,
      timeoutMs,
      onStdoutLine: parser.parseLine,
      parseStderrLines: false,
      onSpawned: () => onLogEntry?.({ type: 'system', subtype: 'spawned', ts: Date.now() }),
      cleanup: () => heartbeat.stop(),
      getUsage: () => parser.state.usage,
      settle: ({ exitCode, stderr }) => {
        const {
          lastErrorText,
          outputBuffer,
          resultErrorText,
          resultIsError,
          resultReceived,
          sessionId,
          usage,
        } = parser.state
        const stderrSample = truncateStderrTail(stderr)
        logger.info({ taskId, exitCode, resultIsError, resultReceived }, 'pi process exited')
        if (resultIsError) {
          return {
            ok: false,
            error: new Error(resultErrorText || stderrSample || 'Pi stream execution failed'),
            usage,
          }
        }
        if (exitCode !== 0) {
          return {
            ok: false,
            error: new Error(formatExitError(exitCode ?? 1, stderrSample)),
            usage,
          }
        }
        if (!resultReceived) {
          return {
            ok: false,
            error: new Error(
              `Pi exited before emitting agent_settled${stderrSample ? `: ${stderrSample}` : ''}`,
            ),
            usage,
          }
        }
        if (!outputBuffer.trim()) {
          return {
            ok: false,
            error: new Error(
              lastErrorText ||
                `Pi exited without producing any assistant output${stderrSample ? `: ${stderrSample}` : ''}`,
            ),
            usage,
          }
        }
        return {
          ok: true,
          result: {
            success: true,
            output: outputBuffer,
            chatId: sessionId,
            ...(usage ? { usage } : {}),
          },
        }
      },
    }).finally(cleanupEphemeralAgentDir)
  }

  private buildPiEnv(
    options: {
      authMode?: 'apiKey' | 'localSession'
      agentDir?: string
      agentEnv?: Record<string, string>
      providerApiKey?: string
      runtimeEnv?: Record<string, string>
    } = {},
  ): NodeJS.ProcessEnv {
    const authMode = options.authMode ?? 'localSession'
    return this.buildCredentialEnv({
      protectedNames:
        authMode === 'apiKey' ? PI_API_KEY_PROTECTED_ENV_NAMES : PROTECTED_PI_ENV_NAMES,
      agentEnvOnlyNames:
        authMode === 'apiKey' ? PI_API_KEY_AGENT_ENV_ONLY_NAMES : AGENT_ENV_ONLY_PI_NAMES,
      // Pi's own auth/config root is pinned by PI_CODING_AGENT_DIR, but
      // provider SDKs may also resolve credentials from the deployment user's
      // HOME (for example AWS shared profiles or Google ADC). Keep the same
      // deployment credential home used by model probes while the explicit
      // --session-dir continues to isolate Pi sessions per Agent.
      omitRuntimeKeys: authMode === 'localSession' ? ['HOME', 'XDG_CONFIG_HOME'] : undefined,
      inject: {
        A2WAVE_PI_PROVIDER_API_KEY: authMode === 'apiKey' ? options.providerApiKey : undefined,
        PI_CODING_AGENT_DIR: options.agentDir || this.agentDir,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        PI_TELEMETRY: '0',
      },
      agentEnv: options.agentEnv,
      runtimeEnv: options.runtimeEnv,
    })
  }

  private buildArgs(options: {
    prompt: string
    model: string
    workDir: string
    sessionDir: string
    chatId?: string
    forkSessionPath?: string
    readOnly: boolean
  }): string[] {
    const { chatId, forkSessionPath, model, prompt, readOnly, sessionDir, workDir } = options
    const args = [
      '--mode',
      'json',
      '--offline',
      '--no-extensions',
      '--no-prompt-templates',
      '--no-themes',
      '--no-skills',
      '--no-approve',
      '--skill',
      join(workDir, '.pi', 'skills'),
      '--session-dir',
      sessionDir,
    ]
    if (forkSessionPath) args.push('--fork', forkSessionPath)
    else if (chatId) args.push('--session-id', chatId)
    if (readOnly) args.push('--tools', 'read,grep,find,ls')
    if (model) args.push('--model', model)
    // `--` (Pi >= 0.84.3) keeps a prompt that begins with a dash from being
    // parsed as an option.
    args.push('--', prompt)
    return args
  }
}
