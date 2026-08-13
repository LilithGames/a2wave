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

import { processInstanceId } from '../process-instance.js'
import {
  WorkspaceRemovalBlockedError,
  clearWorkspaceRemovalsOnStartup,
  drainPendingWorkspaceRemovalReleases,
  removeOwnedSourceWorkspaceGuarded,
  removeSourceWorkspaceGuarded,
  retryPendingWorkspaceRemovalReleases,
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
  deleteFailures?: number
}) {
  let selectCall = 0
  const inserted: Row[] = []
  const deleted: string[] = []
  let deleteFailures = options.deleteFailures ?? 0
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
          if (deleteFailures > 0) {
            deleteFailures -= 1
            return Promise.reject(new Error('db unavailable'))
          }
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
      expect.objectContaining({ scmSourceId: 'scm_1', workspaceName: 'ws-a' }),
    ])
    // Keep stable target identity across migrated rows. This preserves legacy
    // row visibility but does not make mixed-version writers safe; the separate
    // token fences current-version delayed finalizers against ABA replacement.
    expect(inserted[0]?.id).toBe('scm_1:ws-a')
    expect(inserted[0]?.attemptToken).toEqual(expect.any(String))
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

    // The reservation spans the attempt and is released on this failure path.
    expect(deleted).toHaveLength(1)
  })

  it('retries a transient release failure with the same fenced attempt', async () => {
    const { tx, deleted } = protocolTx({
      selects: [...cleanDecisionSelects(), ...cleanDecisionSelects()],
      deleteFailures: 1,
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

    await expect(retryPendingWorkspaceRemovalReleases()).resolves.toEqual(['scm_1:ws-a'])
    expect(deleted).toHaveLength(1)
  })

  it('drains a transient fenced release failure before shutdown', async () => {
    const { tx, deleted } = protocolTx({
      selects: [...cleanDecisionSelects(), ...cleanDecisionSelects()],
      deleteFailures: 1,
    })
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))
    const removeWorkspace = vi.fn(
      async (_name: string, opts?: { beforeRemove?: () => Promise<void> }) => {
        await opts?.beforeRemove?.()
      },
    )

    await removeSourceWorkspaceGuarded({
      sourceId: 'scm_1',
      name: 'shutdown-ws',
      scm: scmOf(removeWorkspace),
    })

    await expect(drainPendingWorkspaceRemovalReleases()).resolves.toBeUndefined()
    expect(deleted).toHaveLength(1)
  })

  it('lets an active workload owned by this process remove only its own workspace', async () => {
    const ownedLease = {
      id: 'run:run_1',
      workloadType: 'run',
      workloadId: 'run_1',
      scmSourceId: 'scm_1',
      phase: 'active',
      ownerInstanceId: processInstanceId,
    }
    const { tx, inserted } = protocolTx({
      selects: [
        [ownedLease],
        [{ localPath: '/repo', workspacesPath: '/ws' }],
        [],
        [ownedLease],
        [ownedLease],
        [{ localPath: '/repo', workspacesPath: '/ws' }],
        [],
        [ownedLease],
      ],
    })
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))
    const removeWorkspace = vi.fn(
      async (_name: string, opts?: { beforeRemove?: () => Promise<void> }) => {
        await opts?.beforeRemove?.()
      },
    )

    await removeOwnedSourceWorkspaceGuarded({
      sourceId: 'scm_1',
      name: 'ws-a',
      scm: scmOf(removeWorkspace),
      workload: { type: 'run', workloadId: 'run_1', ownerInstanceId: processInstanceId },
    })

    expect(inserted).toHaveLength(1)
    expect(removeWorkspace).toHaveBeenCalled()
  })

  it('keeps one reservation across an owned cleanup retry', async () => {
    vi.useFakeTimers()
    try {
      const ownedLease = {
        id: 'run:run_1',
        workloadType: 'run',
        workloadId: 'run_1',
        scmSourceId: 'scm_1',
        phase: 'active',
        ownerInstanceId: processInstanceId,
      }
      const { tx, inserted, deleted } = protocolTx({
        selects: [
          [ownedLease],
          [{ localPath: '/repo', workspacesPath: '/ws' }],
          [],
          [ownedLease],
          [ownedLease],
          [{ localPath: '/repo', workspacesPath: '/ws' }],
          [],
          [ownedLease],
        ],
      })
      mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))
      const removeWorkspace = vi
        .fn()
        .mockRejectedValueOnce(new Error('worktree busy'))
        .mockImplementationOnce(
          async (_name: string, opts?: { beforeRemove?: () => Promise<void> }) => {
            await opts?.beforeRemove?.()
          },
        )

      const cleanup = removeOwnedSourceWorkspaceGuarded({
        sourceId: 'scm_1',
        name: 'ws-a',
        scm: scmOf(removeWorkspace),
        workload: { type: 'run', workloadId: 'run_1', ownerInstanceId: processInstanceId },
      })

      await vi.advanceTimersByTimeAsync(1_000)
      await cleanup
      expect(removeWorkspace).toHaveBeenCalledTimes(2)
      expect(inserted).toHaveLength(1)
      expect(deleted).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not allow another process instance to claim a workload cleanup exemption', async () => {
    const { tx, inserted } = protocolTx({ selects: [] })
    mockWithMutation.mockImplementation((fn: (tx: never) => Promise<unknown>) => fn(tx as never))

    await expect(
      removeOwnedSourceWorkspaceGuarded({
        sourceId: 'scm_1',
        name: 'ws-a',
        scm: scmOf(vi.fn()),
        workload: { type: 'run', workloadId: 'run_1', ownerInstanceId: 'another-instance' },
      }),
    ).rejects.toThrow(/another process instance/)
    expect(inserted).toEqual([])
  })
})

describe('reservation recovery', () => {
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
