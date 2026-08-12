import { isAbsolute, join, resolve, sep } from 'node:path'
import { env } from '../env.js'
import { defaultWorkspacesPath } from './git-workspace.js'
import { defaultScmLocalPath } from './scm-storage.js'
import { validateScmWorkspacesRoot } from './scm-workspace-safety.js'

/**
 * The single place that decides where an SCM source's checkout and worktree
 * root live, and whether those paths are safe.
 *
 * It exists because create and PATCH used to validate independently: create
 * grew an overlap check that PATCH never got, PATCH grew a stored-root backstop
 * that create never got, and localPath was only ever compared for exact string
 * equality against other rows — so one source's checkout could be created
 * nested inside another's, and the next `git checkout -f` force-discarded it.
 * Both routes now resolve their paths here, so a rule added once applies to
 * every write path.
 */

/** One existing row, reduced to the fields path planning actually needs. */
export interface ScmPathPeer {
  id: string
  name: string
  localPath: string
  workspacesPath: string | null
}

export interface ScmPathPlanInput {
  sourceId: string
  type: string
  /** Absent means "allocate the managed default" (git only). */
  localPath?: string | null
  /** Absent means "allocate the managed default". */
  workspacesPath?: string | null
  existingSources: ReadonlyArray<ScmPathPeer>
  /** The row being updated, excluded from conflict checks against itself. */
  excludeId?: string
  /** Admins may place a worktree root outside the configured allowed roots. */
  isAdmin: boolean
}

export type ScmPathPlan =
  | { ok: true; localPath: string; workspacesPath: string }
  | { ok: false; status: 400 | 409; error: string }

/** Equal, or one is an ancestor of the other. Case-insensitive for macOS/Windows. */
export function pathsOverlap(a: string, b: string): boolean {
  const na = resolve(a).toLowerCase()
  const nb = resolve(b).toLowerCase()
  if (na === nb) return true
  return na.startsWith(nb + sep) || nb.startsWith(na + sep)
}

/**
 * The effective worktree root of a row, matching what the runtime resolves
 * (see scm-source.ts). NULL rows fall back to the default, so a new source
 * cannot be aimed at a migrated row's implicit root to dodge the overlap check.
 */
function effectiveWorkspacesPath(peer: ScmPathPeer): string {
  return peer.workspacesPath ?? defaultWorkspacesPath(peer.id)
}

/**
 * Every directory an existing source occupies. Both of a peer's paths are
 * compared against both of the candidate's — the asymmetry that let a checkout
 * be nested inside another source's worktree root is exactly what this closes.
 */
function findPeerConflict(
  peers: ReadonlyArray<ScmPathPeer>,
  candidate: string,
  excludeId?: string,
): ScmPathPeer | null {
  for (const peer of peers) {
    if (excludeId && peer.id === excludeId) continue
    if (pathsOverlap(peer.localPath, candidate)) return peer
    if (pathsOverlap(effectiveWorkspacesPath(peer), candidate)) return peer
  }
  return null
}

/** Roots a2wave allocates from; a checkout may live under one but never BE one. */
function getSharedStorageRoots(): string[] {
  return [join(env.SCM_STORAGE_ROOT, 'sources'), join(env.SCM_STORAGE_ROOT, 'workspaces')]
}

export function resolveScmPathPlan(input: ScmPathPlanInput): ScmPathPlan {
  const { sourceId, type, existingSources, excludeId, isAdmin } = input

  // P4 syncs into the directory its client Root already covers, and a2wave
  // never edits a client spec — so it cannot be given an allocated path.
  if (type === 'p4' && !input.localPath) {
    return {
      ok: false,
      status: 400,
      error: 'P4 sources require a localPath covered by the client Root or AltRoots',
    }
  }

  const localPath = input.localPath ?? defaultScmLocalPath(sourceId)
  if (!isAbsolute(localPath)) {
    return { ok: false, status: 400, error: 'localPath must be an absolute path' }
  }

  // Claiming a shared root as a checkout would put every other source's data
  // inside this one's working tree, where the next sync force-discards it.
  for (const sharedRoot of getSharedStorageRoots()) {
    if (resolve(localPath).toLowerCase() === resolve(sharedRoot).toLowerCase()) {
      return {
        ok: false,
        status: 400,
        error: `localPath must not be the shared storage root "${sharedRoot}"`,
      }
    }
  }

  const workspacesPath = input.workspacesPath ?? defaultWorkspacesPath(sourceId)
  if (!isAbsolute(workspacesPath)) {
    return { ok: false, status: 400, error: 'workspacesPath must be an absolute path' }
  }

  if (pathsOverlap(workspacesPath, localPath)) {
    return { ok: false, status: 400, error: 'workspacesPath must not overlap with localPath' }
  }

  // Peer conflicts are reported before the generic root rules: a path that
  // collides with a real source should name that source, not return the
  // catch-all "overlaps managed SCM checkout storage" the operator cannot act on.
  const localConflict = findPeerConflict(existingSources, localPath, excludeId)
  if (localConflict) {
    return {
      ok: false,
      status: 409,
      error: `Path "${localPath}" overlaps with source "${localConflict.name}"`,
    }
  }

  const workspacesConflict = findPeerConflict(existingSources, workspacesPath, excludeId)
  if (workspacesConflict) {
    return {
      ok: false,
      status: 409,
      error: `Workspaces path "${workspacesPath}" overlaps with source "${workspacesConflict.name}"`,
    }
  }

  const workspacesRootError = validateScmWorkspacesRoot(workspacesPath, undefined, {
    allowOutsideConfiguredRoots: isAdmin,
  })
  if (workspacesRootError) {
    return { ok: false, status: 400, error: workspacesRootError }
  }

  return { ok: true, localPath, workspacesPath }
}
