import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Protocol-level behavior of the guarded worktree removal: reservation
 * ordering, conflict handling, release-on-failure, and reservation recovery.
 * The occupancy decision itself is covered end-to-end by the route tests.
 */

const { mockWithMutation } = vi.hoisted(() => ({ mockWithMutation: vi.fn() }))
vi.mock('../scm-path-plan.js', () => ({ withScmPathMutation: mockWithMutation }))
vi.mock('../../db/client.js', () => ({ db: {} }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
  WorkspaceRemovalBlockedError,
  clearWorkspaceRemovalsOnStartup,
  removeSourceWorkspaceGuarded,
  sweepStaleWorkspaceRemovals,
} from '../scm-workspace-removal.js'

interface Row {
  [key: string]: unknown
}

/**
 * One executor for every query the protocol issues. Selects are sequenced;
 * inserts and deletes are recorded.
 */
function protocolTx(options: {
  selects: Row[][]
  insertedRows?: Row[]
  deleteError?: Error
}) {
  let selectCall = 0
  const inserted: Row[] = []
  const deleted: string[] = []
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() =>
        Object.assign(Promise.resolve(options.selects[selectCall] ?? []), {
          where: vi.fn(() => {
            const rows = options.selects[selectCall++] ?? []
            return Object.assign(Promise.resolve(rows), {
              limit: vi.fn(() => Promise.resolve(rows)),
            })
          }),
        }),
      ),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((value: Row) => {
        inserted.push(value)
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve(options.insertedRows ?? [{ id: value.id }])),
          })),
        }
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => {
          if (options.deleteError) return Promise.reject(options.deleteError)
          deleted.push('deleted')
          return Promise.resolve([{ id: 'released' }])
        }),
      })),
    })),
  }
  return { tx, inserted, deleted }
}

/** Row set for a clean occupancy decision: row matches, nothing occupies. */
function cleanDecisionSelects(): Row[][] {
  return [
    [{ localPath: '/repo', workspacesPath: '/ws' }], // source row
    [], // occupied runs
    [], // leases
  ]
}

const scmOf = (
  removeWorkspace: (
    name: string,
    options?: { beforeRemove?: () => Promise<void> },
  ) => Promise<void>,
) => ({
  localPath: '/repo',
  wsRoot: '/ws',
  removeWorkspace,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('removeSourceWorkspaceGuarded', () => {
  it('reserves before removing and releases after', async () => {
    const { tx, inserted, deleted } = protocolTx({
      selects: [...cleanDecisionSelects(), ...cleanDecisionSelects()],
    })
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))
    const order: string[] = []
    const removeWorkspace = vi.fn(
      async (_name: string, opts?: { beforeRemove?: () => Promise<void> }) => {
        await opts?.beforeRemove?.()
        order.push('removed')
      },
    )

    await removeSourceWorkspaceGuarded({
      sourceId: 'scm_1',
      name: 'ws-a',
      scm: scmOf(removeWorkspace),
    })

    expect(inserted).toEqual([
      expect.objectContaining({ id: 'scm_1:ws-a', scmSourceId: 'scm_1', workspaceName: 'ws-a' }),
    ])
    expect(order).toEqual(['removed'])
    expect(deleted).toHaveLength(1)
  })

  it('refuses without writing a reservation when the decision blocks', async () => {
    const { tx, inserted } = protocolTx({
      selects: [
        [{ localPath: '/repo', workspacesPath: '/ws' }],
        [{ id: 'run_busy' }], // occupied
      ],
    })
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))
    const removeWorkspace = vi.fn()

    await expect(
      removeSourceWorkspaceGuarded({
        sourceId: 'scm_1',
        name: 'ws-a',
        scm: scmOf(removeWorkspace),
      }),
    ).rejects.toBeInstanceOf(WorkspaceRemovalBlockedError)

    expect(inserted).toEqual([])
    expect(removeWorkspace).not.toHaveBeenCalled()
  })

  it('reports a concurrent removal when the reservation insert conflicts', async () => {
    const { tx } = protocolTx({ selects: cleanDecisionSelects(), insertedRows: [] })
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))
    const removeWorkspace = vi.fn()

    await expect(
      removeSourceWorkspaceGuarded({
        sourceId: 'scm_1',
        name: 'ws-a',
        scm: scmOf(removeWorkspace),
      }),
    ).rejects.toThrow(/already in progress/)

    expect(removeWorkspace).not.toHaveBeenCalled()
  })

  it('releases the reservation even when the removal itself fails', async () => {
    const { tx, deleted } = protocolTx({
      selects: [...cleanDecisionSelects(), ...cleanDecisionSelects()],
    })
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))
    const removeWorkspace = vi.fn().mockRejectedValue(new Error('EBUSY'))

    await expect(
      removeSourceWorkspaceGuarded({
        sourceId: 'scm_1',
        name: 'ws-a',
        scm: scmOf(removeWorkspace),
      }),
    ).rejects.toThrow('EBUSY')

    // The reservation only spans the attempt; a wedged row would block the
    // source's mutations until the age sweep.
    expect(deleted).toHaveLength(1)
  })

  it('degrades a failed release to the age sweep instead of masking the outcome', async () => {
    const { tx } = protocolTx({
      selects: [...cleanDecisionSelects(), ...cleanDecisionSelects()],
      deleteError: new Error('db unavailable'),
    })
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))
    const removeWorkspace = vi.fn(
      async (_name: string, opts?: { beforeRemove?: () => Promise<void> }) => {
        await opts?.beforeRemove?.()
      },
    )

    // The removal succeeded; a failed reservation release must not turn that
    // into a caller-visible error.
    await expect(
      removeSourceWorkspaceGuarded({
        sourceId: 'scm_1',
        name: 'ws-a',
        scm: scmOf(removeWorkspace),
      }),
    ).resolves.toBeUndefined()
  })
})

describe('reservation recovery', () => {
  it('sweeps only reservations older than the age bound', async () => {
    const deletedWhere: unknown[] = []
    const tx = {
      delete: vi.fn(() => ({
        where: vi.fn((where: unknown) => {
          deletedWhere.push(where)
          return { returning: vi.fn(() => Promise.resolve([{ id: 'scm_1:old' }])) }
        }),
      })),
    }
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))

    const purged = await sweepStaleWorkspaceRemovals(60_000, new Date('2026-08-13T12:00:00Z'))

    expect(purged).toEqual(['scm_1:old'])
    expect(deletedWhere).toHaveLength(1)
  })

  it('clears every reservation on single-process startup', async () => {
    const tx = {
      delete: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: 'a' }, { id: 'b' }])),
      })),
    }
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))

    await expect(clearWorkspaceRemovalsOnStartup()).resolves.toBe(2)
  })
})
