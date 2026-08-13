import { homedir } from 'node:os'
import { join } from 'node:path'
import { env } from '../env.js'

export const SCM_RECLAIM_DIR = '.a2wave-scm-reclaim-v1'
export const SCM_RECLAIM_MARKER = '.a2wave-owned-reclaim-root'

export function scmReclaimRoot(): string {
  return join(env.SCM_STORAGE_ROOT, SCM_RECLAIM_DIR)
}

/** Same-filesystem parking root for worktrees created by pre-managed releases. */
export function legacyScmReclaimRoot(): string {
  return join(homedir(), '.a2wave', 'workspaces', SCM_RECLAIM_DIR)
}

/** Preserve the entire createId random segment, including embedded underscores. */
export function scmSourceIdSuffix(sourceId: string): string {
  const underscore = sourceId.indexOf('_')
  const suffix = underscore >= 0 ? sourceId.slice(underscore + 1) : sourceId
  return suffix || sourceId
}

export function defaultScmLocalPath(sourceId: string): string {
  return join(env.SCM_STORAGE_ROOT, 'sources', scmSourceIdSuffix(sourceId))
}

export function defaultScmWorkspacesPath(sourceId: string): string {
  return join(env.SCM_STORAGE_ROOT, 'workspaces', scmSourceIdSuffix(sourceId))
}
