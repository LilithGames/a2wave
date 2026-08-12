import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { env } from '../env.js'
import { logger } from './logger.js'
import {
  SCM_RECLAIM_DIR,
  SCM_RECLAIM_MARKER,
  defaultScmLocalPath,
  defaultScmWorkspacesPath,
  scmReclaimRoot,
  scmSourceIdSuffix,
} from './scm-storage.js'
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
 * DELETE first commits a durable deletion reservation while the source row
 * continues to reserve its paths. Only after that commit does this module move
 * exact managed directories into an a2wave-owned reclaim root. Startup recovery
 * consults the durable row and resumes that same source; it never sweeps by
 * filename. The final row delete happens only after recursive removal succeeds.
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
 * The planner and runtime backstops reserve this root, while the marker proves
 * a2wave created it. A pre-existing non-empty operator directory is never
 * adopted, even if it happens to use the same name.
 */
export const RECLAIM_ISOLATION_DIR = SCM_RECLAIM_DIR

function isolationRoot(): string {
  return scmReclaimRoot()
}

async function ensureOwnedIsolationRoot(): Promise<boolean> {
  const root = isolationRoot()
  const marker = join(root, SCM_RECLAIM_MARKER)
  try {
    const existing = await readFile(marker, 'utf8')
    return existing === 'a2wave-scm-reclaim-v1\n'
  } catch {
    try {
      const entries = await readdir(root)
      if (entries.length > 0) {
        logger.error({ root }, 'Refusing to use unowned non-empty SCM reclaim root')
        return false
      }
    } catch {
      await mkdir(root, { recursive: true })
    }
    await writeFile(marker, 'a2wave-scm-reclaim-v1\n', { flag: 'wx' }).catch(() => {})
    return readFile(marker, 'utf8').then(
      (value) => value === 'a2wave-scm-reclaim-v1\n',
      () => false,
    )
  }
}

async function hasOwnedIsolationRoot(): Promise<boolean> {
  try {
    return (
      (await readFile(join(isolationRoot(), SCM_RECLAIM_MARKER), 'utf8')) ===
      'a2wave-scm-reclaim-v1\n'
    )
  } catch {
    return false
  }
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
 * Call this only after a durable deletion reservation commits. The source row
 * remains present while the rename and recursive removal run, so create/PATCH
 * continue to reject overlapping allocations. The deterministic destination
 * lets startup recovery rediscover a move interrupted by process exit.
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

    const isolatedPath = join(isolationRoot(), `${source.id}-${label}`)
    if (!(await isReclaimableDir(path))) {
      if ((await hasOwnedIsolationRoot()) && (await isReclaimableDir(isolatedPath))) {
        isolated.push({ originalPath: path, isolatedPath })
      }
      continue
    }

    if (!(await ensureOwnedIsolationRoot())) {
      throw new Error(`Refusing to use unowned SCM reclaim root: ${isolationRoot()}`)
    }
    try {
      if (await isReclaimableDir(isolatedPath)) {
        throw new Error(`Reclaim destination already exists: ${isolatedPath}`)
      }
      await rename(path, isolatedPath)
      isolated.push({ originalPath: path, isolatedPath })
    } catch (error) {
      logger.error({ path, error }, 'Failed to isolate managed SCM storage')
      // Keep the durable deletion reservation when the move fails. Finalizing
      // the row here would strand an allocated checkout with no row capable of
      // naming or retrying it; startup recovery can safely try again instead.
      throw error
    }
  }

  return {
    isolated,
    commit: async () => {
      const reclaimed: string[] = []
      for (const { originalPath, isolatedPath } of isolated) {
        await removeDir(isolatedPath)
        reclaimed.push(originalPath)
      }
      if (reclaimed.length > 0) {
        logger.info({ sourceId: source.id, reclaimed }, 'Reclaimed managed SCM storage')
      }
      return reclaimed
    },
  }
}
