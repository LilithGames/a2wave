import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { planWorkspacesPathBackfill } from '../backfill-workspaces-path.js'

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
