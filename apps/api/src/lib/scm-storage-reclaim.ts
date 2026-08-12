import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { env } from '../env.js'
import { logger } from './logger.js'
import { defaultScmLocalPath, defaultScmWorkspacesPath, scmSourceIdSuffix } from './scm-storage.js'
import { filesystemPathsOverlap } from './scm-workspace-safety.js'

/**
 * Reclaim the directories a2wave itself allocated for a deleted SCM source.
 *
 * Managed storage derives the path from the source id, so once the row is gone
 * nothing can name that directory again: the UI cannot show it, the API cannot
 * list it, and repeated create/delete during setup silently fills the volume
 * with orphaned clones only shell access can find.
 *
 * The counterweight is that a source's path may equally be one the OPERATOR
 * chose (always so for P4, optionally for git). Deleting a row must never
 * delete their data. So reclaim is deliberately narrow: a path is removed only
 * when it is byte-for-byte the path this source id would have been allocated.
 * Anything else — an operator path, another source's checkout, a shared root,
 * or a symlink standing where the directory should be — is left untouched.
 *
 * Reclaim happens in two steps, because deleting in place was a race. The
 * recursive removal of a large checkout takes seconds to minutes, and it used
 * to run after the row and the path mutation lock were both released — so a
 * concurrent create could observe no peer, allocate the freed path, clone into
 * it, and have the still-pending delete remove the new source's checkout.
 *
 * `isolateManagedScmStorage` therefore runs inside the delete transaction while
 * the lock is held and only *renames* each directory into `.reclaiming/`. That
 * rename is the atomic hand-off: an allocator that arrives earlier is refused
 * by the row that still exists, and one that arrives later finds a free, empty
 * path. The slow recursive delete then runs afterwards against a parked copy no
 * live row can name, and a crash in between is swept at the next startup.
 */

export interface ReclaimableScmSource {
  id: string
  localPath: string
  workspacesPath: string | null
}

export interface ReclaimOptions {
  /** Seam for tests; defaults to a non-following recursive remove. */
  removeDir?: (path: string) => Promise<void>
  legacyWorkspacesPath?: (sourceId: string) => string
}

/** One directory a peer row occupies, as the overlap scan needs to see it. */
export interface ReclaimPeer {
  id: string
  name: string
  localPath: string
  workspacesPath: string | null
}

export interface IsolateOptions extends ReclaimOptions {
  /**
   * Rows that still exist. Supplied by the caller because it holds the path
   * mutation lock and has already read them inside the transaction — reading
   * them again here would reintroduce the very gap isolation closes.
   */
  peers?: ReadonlyArray<ReclaimPeer>
}

/**
 * Where vacated directories are parked between the rename and the delete.
 *
 * A source path is always `sources/<suffix>` or `workspaces/<suffix>`, so a
 * third sibling name is unreachable by construction: no id derives it, the
 * planner never allocates it, and an operator path pointing inside it would be
 * rejected as overlapping managed storage. That is what makes the parked copy
 * safe to delete at leisure — nothing live can come to occupy it.
 */
export const RECLAIM_ISOLATION_DIR = '.reclaiming'

function isolationRoot(): string {
  return join(env.SCM_STORAGE_ROOT, RECLAIM_ISOLATION_DIR)
}

export interface IsolatedScmPath {
  /** The path the row named, reported in the audit entry once deleted. */
  originalPath: string
  /** Where it now sits, awaiting deletion. */
  isolatedPath: string
}

export interface IsolatedScmStorage {
  isolated: IsolatedScmPath[]
  /** Delete the parked directories. @returns the original paths reclaimed. */
  commit: () => Promise<string[]>
}

function defaultLegacyWorkspacesPath(sourceId: string): string {
  return join(homedir(), '.a2wave', 'workspaces', scmSourceIdSuffix(sourceId))
}

function isSamePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

/**
 * True when the path is a real directory this reclaim may move. lstat does not
 * follow links, so a symlink planted at the allocated path is rejected rather
 * than renamed into the isolation area and recursively deleted through.
 */
async function isReclaimableDir(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path)
    if (!stats.isDirectory()) {
      logger.warn({ path }, 'Refusing to reclaim managed SCM path: not a regular directory')
      return false
    }
    return true
  } catch {
    // Never created, or already gone. Nothing to reclaim, and not an error.
    return false
  }
}

/**
 * The paths this source id would have been allocated, in the order they are
 * considered. Only an exact match qualifies: comparing against the derived path
 * rather than "is inside the storage root" is what keeps a mistyped localPath
 * pointing at a neighbour's checkout from deleting it.
 */
function allocatedCandidates(
  source: ReclaimableScmSource,
  legacyWorkspacesPath: (sourceId: string) => string,
): Array<{ path: string; label: string }> {
  const candidates = [
    { path: source.localPath, allocated: defaultScmLocalPath(source.id), label: 'localPath' },
    {
      path: source.workspacesPath,
      allocated: defaultScmWorkspacesPath(source.id),
      label: 'workspacesPath',
    },
    {
      path: source.workspacesPath,
      allocated: legacyWorkspacesPath(source.id),
      label: 'legacyWorkspacesPath',
    },
  ]
  return candidates
    .filter(({ path, allocated }) => Boolean(path) && isSamePath(path as string, allocated))
    .map(({ path, label }) => ({ path: path as string, label }))
}

/**
 * A surviving row occupying this path, or null. A legacy source may hold a
 * worktree root nested inside another source's checkout, so renaming blindly
 * would move a live peer's directory out from under it.
 */
function findOccupyingPeer(
  peers: ReadonlyArray<ReclaimPeer>,
  candidate: string,
  sourceId: string,
): ReclaimPeer | null {
  for (const peer of peers) {
    if (peer.id === sourceId) continue
    if (filesystemPathsOverlap(peer.localPath, candidate)) return peer
    if (peer.workspacesPath && filesystemPathsOverlap(peer.workspacesPath, candidate)) return peer
  }
  return null
}

/**
 * Vacate this source's allocated directories, without deleting anything yet.
 *
 * Call this while holding the path mutation lock, in the same transaction that
 * removes the row. The rename is the atomic step: after it returns, the
 * allocated name is free and holds nothing, so a create/PATCH that acquires the
 * lock next either found the row still present (and was refused) or finds a
 * genuinely empty path. Deleting in place instead left a window in which the
 * freed name could be re-allocated and then recursively deleted.
 */
export async function isolateManagedScmStorage(
  source: ReclaimableScmSource,
  options: IsolateOptions = {},
): Promise<IsolatedScmStorage> {
  const removeDir =
    options.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true }))
  const legacyWorkspacesPath = options.legacyWorkspacesPath ?? defaultLegacyWorkspacesPath
  const peers = options.peers ?? []

  const isolated: IsolatedScmPath[] = []
  for (const { path, label } of allocatedCandidates(source, legacyWorkspacesPath)) {
    const occupyingPeer = findOccupyingPeer(peers, path, source.id)
    if (occupyingPeer) {
      logger.warn(
        { sourceId: source.id, path, peerId: occupyingPeer.id },
        'Refusing to reclaim managed SCM path: still occupied by another source',
      )
      continue
    }

    if (!(await isReclaimableDir(path))) continue

    const isolatedPath = join(isolationRoot(), `${source.id}-${label}-${randomUUID()}`)
    try {
      await mkdir(isolationRoot(), { recursive: true })
      await rename(path, isolatedPath)
      isolated.push({ originalPath: path, isolatedPath })
    } catch (error) {
      // The row is going away regardless, so this cannot fail the request. The
      // directory stays where it is and is simply not reclaimed.
      logger.error({ path, error }, 'Failed to isolate managed SCM storage')
    }
  }

  return {
    isolated,
    commit: async () => {
      const reclaimed: string[] = []
      for (const { originalPath, isolatedPath } of isolated) {
        try {
          await removeDir(isolatedPath)
          reclaimed.push(originalPath)
        } catch (error) {
          // Already vacated and unreachable, so a failure here costs disk, not
          // correctness. The boot sweep retries it.
          logger.error({ isolatedPath, error }, 'Failed to delete isolated managed SCM storage')
        }
      }
      if (reclaimed.length > 0) {
        logger.info({ sourceId: source.id, reclaimed }, 'Reclaimed managed SCM storage')
      }
      return reclaimed
    },
  }
}

/**
 * Delete anything a crash stranded between the rename and the delete.
 *
 * Only the isolation area is swept, and every entry in it is by definition
 * already detached from a live row — so this needs no lock and can never race a
 * running allocation.
 */
export async function sweepIsolatedScmStorage(options: ReclaimOptions = {}): Promise<string[]> {
  const removeDir =
    options.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true }))

  let entries: string[]
  try {
    entries = await readdir(isolationRoot())
  } catch {
    return [] // Nothing was ever isolated.
  }

  const swept: string[] = []
  for (const entry of entries) {
    const path = join(isolationRoot(), entry)
    try {
      await removeDir(path)
      swept.push(path)
    } catch (error) {
      logger.error({ path, error }, 'Failed to sweep isolated managed SCM storage')
    }
  }

  if (swept.length > 0) {
    logger.info({ swept }, 'Swept SCM storage stranded by an earlier restart')
  }
  return swept
}
