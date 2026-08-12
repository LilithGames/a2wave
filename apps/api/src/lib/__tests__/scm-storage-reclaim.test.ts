import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted above module-scope consts, so the mutable holder has to
// be created inside the factory and read back through the mocked module.
// The peer-overlap check pulls in scm-workspace-safety, which reads these env
// entries at module scope and imports the DB client purely for its async
// stored-row validator — neither is reachable from the pure path comparators
// used here, so the client is stubbed rather than opened.
vi.mock('../../env.js', () => ({
  env: {
    SCM_STORAGE_ROOT: '/data/workspace',
    DATABASE_URL: '/tmp/a2wave-reclaim-test.db',
    A2WAVE_SKILLS_STORAGE: '/tmp/a2wave-reclaim-skills',
    A2WAVE_KB_STORAGE: '/tmp/a2wave-reclaim-kb',
    A2WAVE_MEMORY_STORAGE: '/tmp/a2wave-reclaim-memory',
    LOG_FILE_PATH: '/tmp/a2wave-reclaim.log',
    SCM_WORKSPACES_ALLOWED_ROOTS: '',
  },
}))
vi.mock('../../db/client.js', () => ({ db: {} }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { env as envMock } from '../../env.js'
import { RECLAIM_ISOLATION_DIR, isolateManagedScmStorage } from '../scm-storage-reclaim.js'

/**
 * Deleting a managed source must reclaim the directory a2wave allocated for it.
 * The path is derived from the source id, so once the row is gone nothing can
 * name it again — repeated create/delete would fill the volume with orphans no
 * operator can find. Equally, it must never delete a path the OPERATOR chose.
 *
 * Reclaiming in place, after the row and the lock were both gone, was a race:
 * between the commit and the `rm -r`, a concurrent create/PATCH
 * sees no peer row for the deleted source and may legally allocate a path
 * overlapping the directory still queued for deletion — whose recursive removal
 * then takes the new source's checkout with it.
 *
 * Isolation splits reclaim in two. Under the path-mutation lock, the directory
 * is renamed into a sibling area no allocation can ever name; the actual delete
 * happens afterwards, against a path no live row can point at. A concurrent
 * allocator therefore either runs before the rename (and is refused by the peer
 * row that still exists) or after it (and finds a free, genuinely empty path).
 */
describe('isolateManagedScmStorage', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    envMock.SCM_STORAGE_ROOT = '/data/workspace'
  })

  async function makeStorageRoot() {
    const root = await mkdtemp(join(tmpdir(), 'a2wave-isolate-'))
    tempDirs.push(root)
    envMock.SCM_STORAGE_ROOT = root
    return root
  }

  it('vacates the allocated path before returning, so a concurrent allocator finds it free', async () => {
    const root = await makeStorageRoot()
    const checkout = join(root, 'sources', 'aBcD')
    await mkdir(checkout, { recursive: true })
    await writeFile(join(checkout, 'file.txt'), 'cloned')

    const isolated = await isolateManagedScmStorage({
      id: 'scm_aBcD',
      localPath: checkout,
      workspacesPath: null,
    })

    expect(isolated.isolated).toHaveLength(1)
    // The original name is free the moment isolation returns — this is what the
    // in-place delete could not promise.
    expect(existsSync(checkout)).toBe(false)
    // ...and the content is still parked, not yet deleted.
    expect(existsSync(join(isolated.isolated[0].isolatedPath, 'file.txt'))).toBe(true)

    const reclaimed = await isolated.commit()
    expect(reclaimed).toEqual([checkout])
    expect(existsSync(isolated.isolated[0].isolatedPath)).toBe(false)
  })

  it('parks the directory where no source allocation can ever name it', async () => {
    const root = await makeStorageRoot()
    const checkout = join(root, 'sources', 'aBcD')
    await mkdir(checkout, { recursive: true })

    const isolated = await isolateManagedScmStorage({
      id: 'scm_aBcD',
      localPath: checkout,
      workspacesPath: null,
    })

    // `sources/<suffix>` and `workspaces/<suffix>` are the only shapes an id can
    // derive, so a sibling reserved directory is unreachable by construction.
    const parked = isolated.isolated[0].isolatedPath
    expect(parked.startsWith(join(root, RECLAIM_ISOLATION_DIR))).toBe(true)
    expect(parked.startsWith(join(root, 'sources'))).toBe(false)
    expect(parked.startsWith(join(root, 'workspaces'))).toBe(false)
    await isolated.commit()
  })

  // The exact reported race: the row is deleted, a new source claims the freed
  // path, and the queued recursive delete must not follow it.
  it('never deletes a path a peer reclaimed after the row was removed', async () => {
    const root = await makeStorageRoot()
    const checkout = join(root, 'sources', 'aBcD')
    await mkdir(checkout, { recursive: true })

    const isolated = await isolateManagedScmStorage({
      id: 'scm_aBcD',
      localPath: checkout,
      workspacesPath: null,
    })

    // A concurrent create allocates the now-free path and clones into it.
    await mkdir(checkout, { recursive: true })
    await writeFile(join(checkout, 'new-source.txt'), 'freshly cloned')

    await isolated.commit()

    expect(existsSync(join(checkout, 'new-source.txt'))).toBe(true)
  })

  // Legacy rows can hold a worktree root nested under another source's path.
  // Isolation must refuse those rather than rename a live peer's directory out
  // from under it.
  it('refuses to isolate a path overlapping a surviving peer', async () => {
    const root = await makeStorageRoot()
    const peerCheckout = join(root, 'sources', 'aBcD')
    const nestedWorktrees = join(peerCheckout, 'nested-worktrees')
    await mkdir(nestedWorktrees, { recursive: true })
    await writeFile(join(peerCheckout, 'peer.txt'), 'peer data')

    const isolated = await isolateManagedScmStorage(
      { id: 'scm_zZzZ', localPath: join(root, 'sources', 'zZzZ'), workspacesPath: nestedWorktrees },
      {
        legacyWorkspacesPath: () => nestedWorktrees,
        peers: [{ id: 'scm_aBcD', name: 'peer', localPath: peerCheckout, workspacesPath: null }],
      },
    )

    expect(isolated.isolated).toEqual([])
    await isolated.commit()
    expect(existsSync(join(peerCheckout, 'peer.txt'))).toBe(true)
    expect(existsSync(nestedWorktrees)).toBe(true)
  })

  it('leaves an operator-chosen path untouched', async () => {
    await makeStorageRoot()
    const operatorPath = await mkdtemp(join(tmpdir(), 'a2wave-operator-'))
    tempDirs.push(operatorPath)
    await writeFile(join(operatorPath, 'keep.txt'), 'operator data')

    const isolated = await isolateManagedScmStorage({
      id: 'scm_aBcD',
      localPath: operatorPath,
      workspacesPath: null,
    })

    expect(isolated.isolated).toEqual([])
    expect(await isolated.commit()).toEqual([])
    expect(existsSync(join(operatorPath, 'keep.txt'))).toBe(true)
  })

  it('refuses to follow a symlink standing at the allocated path', async () => {
    const root = await makeStorageRoot()
    const outside = await mkdtemp(join(tmpdir(), 'a2wave-outside-'))
    tempDirs.push(outside)
    await writeFile(join(outside, 'keep.txt'), 'outside data')

    const checkout = join(root, 'sources', 'aBcD')
    await mkdir(join(root, 'sources'), { recursive: true })
    await symlink(outside, checkout)

    const isolated = await isolateManagedScmStorage({
      id: 'scm_aBcD',
      localPath: checkout,
      workspacesPath: null,
    })

    expect(isolated.isolated).toEqual([])
    await isolated.commit()
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })

  // A crash between the rename and the delete must not strand the volume: the
  // isolation area is swept at boot, and nothing outside it is ever touched.
  it('sweeps directories stranded by an earlier crash', async () => {
    const root = await makeStorageRoot()
    const stranded = join(root, RECLAIM_ISOLATION_DIR, 'scm_aBcD-localPath-abc123')
    await mkdir(stranded, { recursive: true })
    const liveCheckout = join(root, 'sources', 'zZzZ')
    await mkdir(liveCheckout, { recursive: true })

    const { sweepIsolatedScmStorage } = await import('../scm-storage-reclaim.js')
    const swept = await sweepIsolatedScmStorage()

    expect(swept).toEqual([stranded])
    expect(existsSync(stranded)).toBe(false)
    expect(existsSync(liveCheckout)).toBe(true)
    // The isolation root itself survives, ready for the next reclaim.
    expect(await readdir(join(root, RECLAIM_ISOLATION_DIR))).toEqual([])
  })

  it('is a no-op when the allocated directory was never created', async () => {
    const root = await makeStorageRoot()

    const isolated = await isolateManagedScmStorage({
      id: 'scm_aBcD',
      localPath: join(root, 'sources', 'aBcD'),
      workspacesPath: null,
    })

    expect(isolated.isolated).toEqual([])
    expect(await isolated.commit()).toEqual([])
  })
})
