import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: vi.fn().mockResolvedValue([{ id: 'scm_aBcD' }]),
}
const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockResolvedValue([{ id: 'scm_aBcD', workspacesPath: null }]),
}

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() => selectChain),
    update: vi.fn(() => updateChain),
  },
}))

vi.mock('../../db/schema.js', () => ({
  scmSources: { id: 'id', workspacesPath: 'workspaces_path' },
}))

const runExclusive = vi.fn(async (fn: () => Promise<unknown>) => await fn())
vi.mock('../../db/transaction.js', () => ({
  runExclusive: (fn: () => Promise<unknown>) => runExclusive(fn),
}))

import { backfillWorkspacesPaths, planWorkspacesPathBackfill } from '../backfill-workspaces-path.js'

/**
 * NULL workspacesPath rows resolve their worktree root at call time, preferring
 * the legacy ~/.a2wave/workspaces directory when it still exists on disk. That
 * makes the effective root change mid-process the moment the legacy directory
 * is removed (`docker compose down -v`, an image rebuild, or cleanup of the
 * empty root), so uniqueness and overlap checks start comparing against a path
 * the runtime no longer uses.
 *
 * Pinning each row's root once removes the ambiguity: after the back-fill the
 * column is authoritative and nothing depends on what happens to exist.
 */
describe('planWorkspacesPathBackfill', () => {
  it('pins a legacy root that still exists on disk', () => {
    const plan = planWorkspacesPathBackfill([{ id: 'scm_aBcD', workspacesPath: null }], {
      legacyRootFor: () => '/home/appuser/.a2wave/workspaces/aBcD',
      managedRootFor: () => '/data/workspace/workspaces/aBcD',
      pathExists: () => true,
    })

    expect(plan).toEqual([
      { id: 'scm_aBcD', workspacesPath: '/home/appuser/.a2wave/workspaces/aBcD' },
    ])
  })

  it('pins the managed root when no legacy directory exists', () => {
    const plan = planWorkspacesPathBackfill([{ id: 'scm_aBcD', workspacesPath: null }], {
      legacyRootFor: () => '/home/appuser/.a2wave/workspaces/aBcD',
      managedRootFor: () => '/data/workspace/workspaces/aBcD',
      pathExists: () => false,
    })

    expect(plan).toEqual([{ id: 'scm_aBcD', workspacesPath: '/data/workspace/workspaces/aBcD' }])
  })

  it('leaves rows that already carry an explicit path untouched', () => {
    const plan = planWorkspacesPathBackfill(
      [{ id: 'scm_aBcD', workspacesPath: '/srv/custom/worktrees' }],
      { legacyRootFor: () => '/legacy', managedRootFor: () => '/managed', pathExists: () => true },
    )

    expect(plan).toEqual([])
  })

  it('plans nothing when there are no NULL rows', () => {
    expect(
      planWorkspacesPathBackfill([], {
        legacyRootFor: () => '/legacy',
        managedRootFor: () => '/managed',
        pathExists: () => true,
      }),
    ).toEqual([])
  })

  it('decides per row rather than once for the whole table', () => {
    const plan = planWorkspacesPathBackfill(
      [
        { id: 'scm_legacy', workspacesPath: null },
        { id: 'scm_fresh', workspacesPath: null },
      ],
      {
        legacyRootFor: (id) => `/legacy/${id}`,
        managedRootFor: (id) => `/managed/${id}`,
        pathExists: (path) => path === '/legacy/scm_legacy',
      },
    )

    expect(plan).toEqual([
      { id: 'scm_legacy', workspacesPath: '/legacy/scm_legacy' },
      { id: 'scm_fresh', workspacesPath: '/managed/scm_fresh' },
    ])
  })
})

/**
 * The planner above is pure; this covers the part that actually touches the
 * database — and the part that was wrong.
 *
 * The back-fill runs at boot AFTER the HTTP port is already listening, so a
 * request can be mid-transaction while it writes. On SQLite that is not a
 * theoretical race: one shared better-sqlite3 connection means a bare
 * `db.update(...)` issued while another request holds a `BEGIN` joins that
 * transaction and is erased if it rolls back — after the back-fill already
 * counted the row as pinned. `runExclusive` is the repo-wide rule for exactly
 * this (see apps/api/CLAUDE.md and db/transaction.ts).
 */
describe('backfillWorkspacesPaths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    selectChain.from.mockReturnThis()
    selectChain.where.mockResolvedValue([{ id: 'scm_aBcD', workspacesPath: null }])
    updateChain.set.mockReturnThis()
    updateChain.where.mockReturnThis()
    updateChain.returning.mockResolvedValue([{ id: 'scm_aBcD' }])
  })

  it('serialises each row update through runExclusive', async () => {
    const count = await backfillWorkspacesPaths()

    expect(count).toBe(1)
    expect(runExclusive).toHaveBeenCalledTimes(1)
  })

  it('issues the update inside the runExclusive callback, not outside it', async () => {
    const order: string[] = []
    runExclusive.mockImplementationOnce(async (fn: () => Promise<unknown>) => {
      order.push('enter-exclusive')
      const result = await fn()
      order.push('exit-exclusive')
      return result
    })
    updateChain.returning.mockImplementationOnce(async () => {
      order.push('update')
      return [{ id: 'scm_aBcD' }]
    })

    await backfillWorkspacesPaths()

    expect(order).toEqual(['enter-exclusive', 'update', 'exit-exclusive'])
  })

  it('does not take the lock when there is nothing to pin', async () => {
    selectChain.where.mockResolvedValue([])

    expect(await backfillWorkspacesPaths()).toBe(0)
    expect(runExclusive).not.toHaveBeenCalled()
  })
})
