import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above module-scope consts, so the mutable holder has to
// be created inside the factory and read back through the mocked module.
vi.mock('../../env.js', () => ({ env: { SCM_STORAGE_ROOT: '/data/workspace' } }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { env as envMock } from '../../env.js'
import { reclaimManagedScmStorage } from '../scm-storage-reclaim.js'

/**
 * Deleting a managed source must reclaim the directory a2wave allocated for it.
 * The path is derived from the source id, so once the row is gone nothing can
 * name it again — repeated create/delete would fill the volume with orphans no
 * operator can find. Equally, it must never delete a path the OPERATOR chose.
 */
describe('reclaimManagedScmStorage', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    envMock.SCM_STORAGE_ROOT = '/data/workspace'
  })

  async function makeStorageRoot() {
    const root = await mkdtemp(join(tmpdir(), 'a2wave-reclaim-'))
    tempDirs.push(root)
    envMock.SCM_STORAGE_ROOT = root
    return root
  }

  it('removes the managed checkout allocated for the source', async () => {
    const root = await makeStorageRoot()
    const checkout = join(root, 'sources', 'aBcD')
    await mkdir(checkout, { recursive: true })
    await writeFile(join(checkout, 'file.txt'), 'cloned')

    const reclaimed = await reclaimManagedScmStorage({
      id: 'scm_aBcD',
      localPath: checkout,
      workspacesPath: null,
    })

    expect(reclaimed).toContain(checkout)
    expect(existsSync(checkout)).toBe(false)
  })

  it('removes the managed worktree root allocated for the source', async () => {
    const root = await makeStorageRoot()
    const worktrees = join(root, 'workspaces', 'aBcD')
    await mkdir(worktrees, { recursive: true })

    const reclaimed = await reclaimManagedScmStorage({
      id: 'scm_aBcD',
      localPath: join(root, 'sources', 'aBcD'),
      workspacesPath: worktrees,
    })

    expect(reclaimed).toContain(worktrees)
    expect(existsSync(worktrees)).toBe(false)
  })

  it('removes the legacy worktree root pinned during an upgrade', async () => {
    const root = await makeStorageRoot()
    const legacyWorktrees = join(root, 'legacy-home', '.a2wave', 'workspaces', 'aBcD')
    await mkdir(legacyWorktrees, { recursive: true })

    const reclaimed = await reclaimManagedScmStorage(
      {
        id: 'scm_aBcD',
        localPath: join(root, 'sources', 'aBcD'),
        workspacesPath: legacyWorktrees,
      },
      { legacyWorkspacesPath: () => legacyWorktrees },
    )

    expect(reclaimed).toContain(legacyWorktrees)
    expect(existsSync(legacyWorktrees)).toBe(false)
  })

  // The operator's own checkout is theirs. P4 sources always carry one, and a
  // git source may too — deleting the row must not delete their data.
  it('never removes an operator-chosen path outside the storage root', async () => {
    const root = await makeStorageRoot()
    const operatorPath = await mkdtemp(join(tmpdir(), 'a2wave-operator-'))
    tempDirs.push(operatorPath)
    await writeFile(join(operatorPath, 'keep.txt'), 'operator data')

    const reclaimed = await reclaimManagedScmStorage({
      id: 'scm_aBcD',
      localPath: operatorPath,
      workspacesPath: null,
    })

    expect(reclaimed).toEqual([])
    expect(existsSync(join(operatorPath, 'keep.txt'))).toBe(true)
    expect(root).toBeTruthy()
  })

  // Only the exact allocated name is reclaimed. A path merely inside the root
  // could be another source's checkout, or the shared root itself.
  it('never removes a path under the root that is not this source allocation', async () => {
    const root = await makeStorageRoot()
    const otherSource = join(root, 'sources', 'zZzZ')
    await mkdir(otherSource, { recursive: true })

    const reclaimed = await reclaimManagedScmStorage({
      id: 'scm_aBcD',
      localPath: otherSource,
      workspacesPath: null,
    })

    expect(reclaimed).toEqual([])
    expect(existsSync(otherSource)).toBe(true)
  })

  it('never removes the shared sources root itself', async () => {
    const root = await makeStorageRoot()
    const sharedRoot = join(root, 'sources')
    await mkdir(sharedRoot, { recursive: true })

    const reclaimed = await reclaimManagedScmStorage({
      id: 'scm_aBcD',
      localPath: sharedRoot,
      workspacesPath: null,
    })

    expect(reclaimed).toEqual([])
    expect(existsSync(sharedRoot)).toBe(true)
  })

  // A symlink at the allocated path would make rm -r follow it out of the tree.
  it('refuses to follow a symlink at the allocated path', async () => {
    const root = await makeStorageRoot()
    const outside = await mkdtemp(join(tmpdir(), 'a2wave-outside-'))
    tempDirs.push(outside)
    await writeFile(join(outside, 'keep.txt'), 'outside data')

    const checkout = join(root, 'sources', 'aBcD')
    await mkdir(join(root, 'sources'), { recursive: true })
    await symlink(outside, checkout)

    const reclaimed = await reclaimManagedScmStorage({
      id: 'scm_aBcD',
      localPath: checkout,
      workspacesPath: null,
    })

    expect(reclaimed).toEqual([])
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })

  it('is a no-op when the allocated directory was never created', async () => {
    const root = await makeStorageRoot()

    const reclaimed = await reclaimManagedScmStorage({
      id: 'scm_aBcD',
      localPath: join(root, 'sources', 'aBcD'),
      workspacesPath: null,
    })

    expect(reclaimed).toEqual([])
  })

  // Reclaim runs after the row is already gone, so a failure must not surface
  // as a delete failure — the source really was deleted.
  it('reports rather than throws when removal fails', async () => {
    const root = await makeStorageRoot()
    const checkout = join(root, 'sources', 'aBcD')
    await mkdir(checkout, { recursive: true })

    const reclaimed = await reclaimManagedScmStorage(
      { id: 'scm_aBcD', localPath: checkout, workspacesPath: null },
      {
        removeDir: async () => {
          throw new Error('EBUSY')
        },
      },
    )

    expect(reclaimed).toEqual([])
  })
})
