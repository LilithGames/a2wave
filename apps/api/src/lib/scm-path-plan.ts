import { isAbsolute, join } from 'node:path'
import { db } from '../db/client.js'
import { scmSources } from '../db/schema.js'
import { env } from '../env.js'
import { defaultWorkspacesPath } from './git-workspace.js'
import { defaultScmLocalPath } from './scm-storage.js'
import {
  isSameOrDescendantForCollision,
  pathsOverlap,
  validateScmWorkspacesRoot,
} from './scm-workspace-safety.js'

export { pathsOverlap }

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

/**
 * Every existing source, as the planner needs to see it. Lives here rather than
 * in a route so that non-HTTP write paths — env bootstrap in particular — check
 * against the same peers the routes do.
 */
export async function selectScmPathPeers(): Promise<ScmPathPeer[]> {
  return db
    .select({
      id: scmSources.id,
      name: scmSources.name,
      localPath: scmSources.localPath,
      workspacesPath: scmSources.workspacesPath,
    })
    .from(scmSources)
}

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
  /** Decides the case rule for path comparison; injectable for tests. */
  platform?: NodeJS.Platform
}

export type ScmPathPlan =
  | { ok: true; localPath: string; workspacesPath: string }
  | { ok: false; status: 400 | 409; error: string }

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
  platform: NodeJS.Platform,
  excludeId?: string,
): ScmPathPeer | null {
  for (const peer of peers) {
    if (excludeId && peer.id === excludeId) continue
    if (pathsOverlap(peer.localPath, candidate, platform)) return peer
    if (pathsOverlap(effectiveWorkspacesPath(peer), candidate, platform)) return peer
  }
  return null
}

/**
 * Exact same directory, under the *collision* case rule.
 *
 * Deliberately not `isSameOrDescendant`: that is the containment comparator and
 * folds case only on win32, so on a default macOS volume
 * `/data/workspace/SOURCES` compared unequal to the protected `sources` root it
 * actually names — letting a checkout claim the shared root and make every other
 * source's data a child of its own working tree.
 */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  return (
    isSameOrDescendantForCollision(a, b, platform) && isSameOrDescendantForCollision(b, a, platform)
  )
}

/** Roots a2wave allocates from; a checkout may live under one but never BE one. */
function getSharedStorageRoots(): string[] {
  return [join(env.SCM_STORAGE_ROOT, 'sources'), join(env.SCM_STORAGE_ROOT, 'workspaces')]
}

export function resolveScmPathPlan(input: ScmPathPlanInput): ScmPathPlan {
  const { sourceId, type, existingSources, excludeId, isAdmin } = input
  const platform = input.platform ?? process.platform

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
  // Equality, not containment: a managed checkout legitimately lives *under*
  // `sources/`, so only claiming the root itself is the error.
  for (const sharedRoot of getSharedStorageRoots()) {
    if (samePath(localPath, sharedRoot, platform)) {
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

  if (pathsOverlap(workspacesPath, localPath, platform)) {
    return { ok: false, status: 400, error: 'workspacesPath must not overlap with localPath' }
  }

  // Peer conflicts are reported before the generic root rules: a path that
  // collides with a real source should name that source, not return the
  // catch-all "overlaps managed SCM checkout storage" the operator cannot act on.
  const localConflict = findPeerConflict(existingSources, localPath, platform, excludeId)
  if (localConflict) {
    return {
      ok: false,
      status: 409,
      error: `Path "${localPath}" overlaps with source "${localConflict.name}"`,
    }
  }

  const workspacesConflict = findPeerConflict(existingSources, workspacesPath, platform, excludeId)
  if (workspacesConflict) {
    return {
      ok: false,
      status: 409,
      error: `Workspaces path "${workspacesPath}" overlaps with source "${workspacesConflict.name}"`,
    }
  }

  const workspacesRootError = validateScmWorkspacesRoot(workspacesPath, undefined, {
    allowOutsideConfiguredRoots: isAdmin,
    platform,
  })
  if (workspacesRootError) {
    return { ok: false, status: 400, error: workspacesRootError }
  }

  return { ok: true, localPath, workspacesPath }
}
