import { lstat, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { logger } from './logger.js'
import { defaultScmLocalPath, defaultScmWorkspacesPath } from './scm-storage.js'

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
 */

export interface ReclaimableScmSource {
  id: string
  localPath: string
  workspacesPath: string | null
}

export interface ReclaimOptions {
  /** Seam for tests; defaults to a non-following recursive remove. */
  removeDir?: (path: string) => Promise<void>
}

function isSamePath(a: string, b: string): boolean {
  return resolve(a) === resolve(b)
}

/**
 * Remove one path, but only after confirming it is a real directory. lstat does
 * not follow links, so a symlink planted at the allocated path is rejected
 * rather than followed out of the storage tree.
 */
async function removeAllocatedDir(
  path: string,
  removeDir: (path: string) => Promise<void>,
): Promise<boolean> {
  try {
    const stats = await lstat(path)
    if (!stats.isDirectory()) {
      logger.warn({ path }, 'Refusing to reclaim managed SCM path: not a regular directory')
      return false
    }
  } catch {
    // Never created, or already gone. Nothing to reclaim, and not an error.
    return false
  }

  try {
    await removeDir(path)
    return true
  } catch (error) {
    // The row is already deleted, so this cannot fail the request. Surfacing it
    // in logs is the only useful action left.
    logger.error({ path, error }, 'Failed to reclaim managed SCM storage')
    return false
  }
}

/** @returns the paths actually removed, for the audit entry and logs. */
export async function reclaimManagedScmStorage(
  source: ReclaimableScmSource,
  options: ReclaimOptions = {},
): Promise<string[]> {
  const removeDir =
    options.removeDir ?? ((path: string) => rm(path, { recursive: true, force: true }))

  // Only the exact allocation for THIS source id qualifies. Comparing against
  // the derived path rather than "is inside the storage root" is what keeps a
  // mistyped localPath pointing at a neighbour's checkout from deleting it.
  const candidates = [
    { path: source.localPath, allocated: defaultScmLocalPath(source.id) },
    { path: source.workspacesPath, allocated: defaultScmWorkspacesPath(source.id) },
  ]

  const reclaimed: string[] = []
  for (const { path, allocated } of candidates) {
    if (!path || !isSamePath(path, allocated)) continue
    if (await removeAllocatedDir(path, removeDir)) reclaimed.push(path)
  }

  if (reclaimed.length > 0) {
    logger.info({ sourceId: source.id, reclaimed }, 'Reclaimed managed SCM storage')
  }
  return reclaimed
}
