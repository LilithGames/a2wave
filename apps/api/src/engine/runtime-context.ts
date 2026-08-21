import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { logger } from '../lib/logger.js'
import type {
  AgentRuntimeContext,
  ExecuteRequest,
  RuntimeCleanupPolicy,
  RuntimeWorkspaceType,
} from './types.js'

const DEFAULT_AGENT_HOMES_DIR = 'data/agent-homes'

interface RuntimeContextOptions {
  defaultWorkDir?: string
}

const RUNTIME_ENV_RESERVED_KEYS = new Set([
  'HOME',
  'TMPDIR',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'CODEX_HOME',
  'A2WAVE_AGENT_HOME',
  'A2WAVE_AGENT_ID',
  'A2WAVE_RUN_ID',
  'A2WAVE_WORKSPACE_DIR',
  'A2WAVE_ARTIFACTS_DIR',
])

/**
 * Service-process variables that are safe and necessary for an Agent CLI.
 *
 * Agent processes used to inherit the complete API environment. That exposed
 * unrelated platform credentials such as AUTH_SECRET, SCM_* passwords and SSO
 * client secrets to every Agent. Keep this list deliberately small: executable
 * discovery, OS/home semantics, locale, proxy/CA configuration, and the known
 * local-session credential-store locations supported by built-in Providers.
 * Provider credentials themselves are injected explicitly by each engine after
 * this base environment is built.
 */
const SAFE_AGENT_PROCESS_ENV_NAMES = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TEMPDIR',
  'LANG',
  'LANGUAGE',
  'TZ',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'KIMI_CODE_HOME',
  'COPILOT_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
])

/**
 * Env names that let a child process load attacker-controlled code (dynamic
 * loaders, the Node option string, shell startup files) before the agent CLI's
 * own logic runs. Agent-supplied env must never set these — an editor could
 * otherwise reach host code execution (e.g. NODE_OPTIONS=--require=/tmp/x.js or
 * GIT_SSH_COMMAND). Stripped here in the single chokepoint every engine funnels
 * agent env through; cli-engine-base re-exports this for its credential matrix.
 */
export const PROCESS_INJECTION_ENV_NAMES: readonly string[] = [
  'PATH',
  'NODE_OPTIONS',
  // Note: the LD_* / DYLD_* dynamic-loader family and the GIT_CONFIG_* config
  // channel are handled by PROCESS_INJECTION_PREFIX_RES below (whole-prefix), so
  // they are intentionally NOT enumerated here — EXCEPT bare `GIT_CONFIG` (no
  // trailing underscore, so the /^GIT_CONFIG_/ prefix misses it), which `git
  // config` reads as a config file path (core.pager / alias.* → command exec).
  'GIT_CONFIG',
  'GIT_SSH_COMMAND',
  // Older git SSH override (points at an arbitrary executable), sibling of GIT_SSH_COMMAND.
  'GIT_SSH',
  // git env vars that point directly at an executable git will spawn — each is a
  // standalone command-execution vector even without config injection. Agents
  // routinely run git, so any of these in agent-supplied env is host RCE.
  'GIT_EXTERNAL_DIFF', // run per-file on `git diff`
  'GIT_PROXY_COMMAND', // run for network fetch over git:// transport
  'GIT_PAGER', // run to page any git output
  'GIT_EDITOR', // run by commit/rebase/tag
  'GIT_SEQUENCE_EDITOR', // run by `git rebase -i`
  'GIT_ASKPASS', // run to obtain credentials
  'GIT_MERGE_TOOL', // run by `git mergetool`
  // Redirects git's helper-executable lookup to an attacker dir: `git <anything>`
  // then runs git-<anything> from there (e.g. GIT_EXEC_PATH=/evil; git foo).
  'GIT_EXEC_PATH',
  // ssh's own askpass hook — sibling of GIT_ASKPASS, run by any git/ssh op that
  // needs a passphrase; points at an arbitrary executable.
  'SSH_ASKPASS',
  'BASH_ENV',
  // Shell-startup / pager hooks in the same class as BASH_ENV (sourced before the
  // interactive/RC shell an agent might spawn, or run as a pager).
  'ENV',
  'PAGER',
]

const PROCESS_INJECTION_ENV_NAME_SET = new Set<string>(PROCESS_INJECTION_ENV_NAMES)

/**
 * Prefix families that are process-injection channels as a WHOLE, matched by
 * pattern so no present-or-future member slips through an exact-name list. These
 * classes have no legitimate use in agent-supplied env, so blanket-stripping the
 * prefix is the safe default (defense in depth over precision):
 *   - LD_* / DYLD_*      dynamic-loader knobs (LD_PRELOAD, LD_AUDIT, LD_LIBRARY_PATH, …)
 *   - GIT_CONFIG_*       every git-env config channel (GLOBAL/SYSTEM/PARAMETERS/COUNT/KEY_n/VALUE_n)
 *   - npm_config_*       npm maps env `npm_config_<key>` onto any npm config
 *                        (e.g. script-shell → arbitrary shell for `npm run`).
 * Anchored at the start of the name so a var that merely CONTAINS the token
 * (MY_LD_PRELOAD, MY_GIT_CONFIG_KEY_0) is untouched.
 */
const PROCESS_INJECTION_PREFIX_RES: readonly RegExp[] = [/^LD_/, /^DYLD_/, /^GIT_CONFIG_/]

/**
 * npm normalizes a config env name to lowercase with `-`/`_` interchangeable
 * (`NPM_CONFIG_SCRIPT-SHELL` === `npm_config_script_shell`), so match after the
 * same normalization rather than by exact/case-sensitive name.
 */
function isNpmConfigEnvName(key: string): boolean {
  return key.toLowerCase().replace(/-/g, '_').startsWith('npm_config_')
}

export function isProcessInjectionEnvName(key: string): boolean {
  if (PROCESS_INJECTION_ENV_NAME_SET.has(key)) return true
  if (isNpmConfigEnvName(key)) return true
  return PROCESS_INJECTION_PREFIX_RES.some((re) => re.test(key))
}

export function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_')
  return sanitized || 'default'
}

function resolveAgentHomesRoot(): string {
  return resolve(process.cwd(), process.env.A2WAVE_AGENT_HOMES_DIR || DEFAULT_AGENT_HOMES_DIR)
}

export function resolveAgentRuntimeHomeDir(agentId = 'default'): string {
  return resolve(resolveAgentHomesRoot(), sanitizePathSegment(agentId))
}

export function resolveAgentRuntimeTmpDir(agentId = 'default'): string {
  return resolve(resolveAgentRuntimeHomeDir(agentId), 'tmp')
}

export function extractRunId(taskId: string): string {
  return taskId.match(/(?:^|\/)(run_[^/]+)/)?.[1] ?? taskId
}

/**
 * Where a single execution drops the files it wants collected.
 *
 * Deliberately a per-execution directory *under* the workspace's `artifacts/`,
 * not `artifacts/` itself: a workspace is shared. Runs of one Agent share their
 * per-Agent worktree by design (resolvePerAgentWorkspace does not serialise
 * them), and on a shared SCM checkout every Agent bound to the source shares
 * it too. One flat drop-box therefore holds files from several live runs at
 * once with nothing to say whose is whose — the collector used to guess from
 * mtime, and handed one conversation's report to another conversation's user.
 * A per-execution directory makes that ownership structural instead of inferred.
 *
 * Keyed by the *task id*, not the run id, because the engine is the side that
 * has to tell the Agent where to write and the engine only ever sees the task
 * id. For every channel that builds its task id with `buildTaskId` the two are
 * the same thing; A2A hands the engine the caller's protocol task id as-is, and
 * the collector must follow the engine there rather than look where the run id
 * would have put it. Deriving both sides from one function is what makes it
 * impossible for them to disagree.
 *
 * The segment is sanitised because `extractRunId` falls back to the raw task
 * id when it carries no run id, and a task id contains separators.
 */
export function artifactsDirForTask(workspaceDir: string, taskId: string): string {
  return join(workspaceDir, 'artifacts', sanitizePathSegment(extractRunId(taskId)))
}

function inferWorkspaceType(request: ExecuteRequest): RuntimeWorkspaceType {
  const workspaceType = request.agentConfig?.workspaceType
  if (workspaceType === 'scm') return 'scm-local'
  return request.agentConfig?.workDir ? 'configured' : 'temp'
}

function inferCleanupPolicy(type: RuntimeWorkspaceType): RuntimeCleanupPolicy {
  return type === 'scm-local' || type === 'configured' ? 'never' : 'ttl'
}

export function sanitizeAgentRuntimeEnv(
  env?: Record<string, string>,
): Record<string, string> | undefined {
  if (!env) return undefined
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => !RUNTIME_ENV_RESERVED_KEYS.has(key) && !isProcessInjectionEnvName(key),
    ),
  )
}

/**
 * Build the inherited portion of an Agent subprocess environment from an
 * explicit allowlist. `additionalNames` is reserved for engine-declared local
 * credential-store locations; it must never be populated from Agent input.
 */
export function buildSafeAgentProcessEnv(
  source: NodeJS.ProcessEnv = process.env,
  additionalNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const allowed = new Set([...SAFE_AGENT_PROCESS_ENV_NAMES, ...additionalNames])
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (allowed.has(key) || key.startsWith('LC_'))) {
      result[key] = value
    }
  }
  return result
}

export function omitRuntimeEnvKeys(
  env: Record<string, string> | undefined,
  keys: string[],
): Record<string, string> | undefined {
  if (!env) return undefined
  const result = { ...env }
  for (const key of keys) {
    delete result[key]
  }
  return result
}

function resolveWorkspaceDir(request: ExecuteRequest, options: RuntimeContextOptions): string {
  const requestedWorkDir = (request.workDir ?? '').trim()
  const defaultWorkDir = options.defaultWorkDir?.trim() ?? ''
  const workDir = requestedWorkDir || defaultWorkDir
  if (!workDir) {
    throw new Error('Runtime context requires a workDir or engine defaultWorkDir')
  }
  return resolve(workDir)
}

export function prepareRuntimeContext(
  request: ExecuteRequest,
  options: RuntimeContextOptions = {},
): AgentRuntimeContext {
  const agentId = (request.agentConfig?.agentId as string | undefined) || 'default'
  const agentHomeDir = resolveAgentRuntimeHomeDir(agentId)
  const cacheDir = resolve(agentHomeDir, '.cache')
  const configDir = resolve(agentHomeDir, '.config')
  const tmpDir = resolveAgentRuntimeTmpDir(agentId)
  const claudeDir = resolve(agentHomeDir, '.claude')
  const codexHomeDir = resolve(agentHomeDir, '.codex')
  const runId = extractRunId(request.taskId)
  const workspaceDir = resolveWorkspaceDir(request, options)
  const workspaceType = inferWorkspaceType(request)
  const artifactsDir = artifactsDirForTask(workspaceDir, request.taskId)

  for (const dir of [agentHomeDir, cacheDir, configDir, tmpDir, claudeDir, codexHomeDir]) {
    mkdirSync(dir, { recursive: true })
  }
  // The artifacts directory is removed when the execution settles, so unlike
  // the old flat `artifacts/` on a warm workspace it never pre-exists; an
  // Agent doing `cp report.md "$A2WAVE_ARTIFACTS_DIR/"` would fail on every
  // run. Best effort only: a read-only workspace must not fail the run here.
  try {
    mkdirSync(artifactsDir, { recursive: true })
  } catch (err) {
    logger.warn({ err, artifactsDir }, 'Could not create the artifacts directory for this run')
  }

  return {
    agentId,
    runId,
    workspace: {
      dir: workspaceDir,
      type: workspaceType,
      cleanup: inferCleanupPolicy(workspaceType),
      sourceId: request.agentConfig?.scmSourceId ?? undefined,
    },
    home: {
      dir: agentHomeDir,
      cacheDir,
      configDir,
      tmpDir,
      claudeDir,
      codexHomeDir,
    },
    artifacts: {
      dir: artifactsDir,
    },
    env: {
      HOME: agentHomeDir,
      A2WAVE_AGENT_HOME: agentHomeDir,
      A2WAVE_AGENT_ID: agentId,
      A2WAVE_RUN_ID: runId,
      A2WAVE_WORKSPACE_DIR: workspaceDir,
      A2WAVE_ARTIFACTS_DIR: artifactsDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_CONFIG_HOME: configDir,
      TMPDIR: tmpDir,
      CODEX_HOME: codexHomeDir,
    },
  }
}
