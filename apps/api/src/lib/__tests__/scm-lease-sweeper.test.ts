import { describe, expect, it, vi } from 'vitest'
import { sweepOrphanedScmWorkloadLeases } from '../scm-lease-sweeper.js'

interface Row {
  [key: string]: unknown
}

/**
 * The sweep runs three query shapes: the full lease scan (plain
 * `select().from()`), per-lease workload status lookups
 * (`.where().limit(1)`), and the guarded delete. One executor models all
 * three, sequenced per call.
 */
function sweepTx(leases: Row[], statusRows: Row[][]) {
  let statusCall = 0
  const deleted: string[] = []
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() =>
        Object.assign(Promise.resolve(leases), {
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(statusRows[statusCall++] ?? [])),
          })),
        }),
      ),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => {
          deleted.push('deleted')
          return Promise.resolve([{ id: 'lease' }])
        }),
      })),
    })),
  }
  return { tx, deleted }
}

function deps(
  tx: unknown,
  overrides: Partial<{
    isWorkloadLocallyActive: (identity: { type: string; workloadId: string }) => boolean
    ownerInstanceId: string
  }> = {},
) {
  return {
    withMutation: (fn: (tx: never) => Promise<unknown>) => fn(tx as never),
    isWorkloadLocallyActive: overrides.isWorkloadLocallyActive ?? (() => false),
    ownerInstanceId: overrides.ownerInstanceId ?? 'instance-a',
  } as never
}

describe('sweepOrphanedScmWorkloadLeases', () => {
  // The failure mode this heals: releaseScmWorkload threw after process exit
  // and cleanup, the error was logged, and nothing ever retried — leaving the
  // Agent's binding and the source permanently locked by a lease whose
  // workload finished long ago.
  it('releases an active lease this instance owns once its run is terminal and locally idle', async () => {
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_done',
          workloadType: 'run',
          workloadId: 'run_done',
          agentId: 'agt_1',
          phase: 'active',
          ownerInstanceId: 'instance-a',
        },
      ],
      [[{ status: 'completed' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(deps(tx))

    expect(released).toEqual([{ type: 'run', workloadId: 'run_done', agentId: 'agt_1' }])
    expect(deleted).toHaveLength(1)
  })

  it('never touches an active lease owned by another instance', async () => {
    // PostgreSQL rule: without a positively identified dead owner, a visible
    // stuck lease is safer than reclaiming a checkout beneath a healthy peer.
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_peer',
          workloadType: 'run',
          workloadId: 'run_peer',
          phase: 'active',
          ownerInstanceId: 'instance-b',
        },
      ],
      [[{ status: 'completed' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(deps(tx))

    expect(released).toEqual([])
    expect(deleted).toHaveLength(0)
  })

  it('keeps a lease whose workload has not reached a terminal status', async () => {
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_live',
          workloadType: 'run',
          workloadId: 'run_live',
          phase: 'active',
          ownerInstanceId: 'instance-a',
        },
      ],
      [[{ status: 'running' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(deps(tx))

    expect(released).toEqual([])
    expect(deleted).toHaveLength(0)
  })

  it('keeps a lease while its owner is still cleaning up locally', async () => {
    // Terminal status does not prove process exit — that is the entire reason
    // the lease outlives the status. Local activity is the tiebreaker.
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_cleanup',
          workloadType: 'run',
          workloadId: 'run_cleanup',
          phase: 'active',
          ownerInstanceId: 'instance-a',
        },
      ],
      [[{ status: 'cancelled' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(
      deps(tx, { isWorkloadLocallyActive: () => true }),
    )

    expect(released).toEqual([])
    expect(deleted).toHaveLength(0)
  })

  it('releases a reserved lease whose evaluation is already terminal', async () => {
    // Reserved means no process ever started, so this is safe on any replica:
    // a cancelled-while-queued workload can never activate its reservation.
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'evaluation:evt_gone',
          workloadType: 'evaluation',
          workloadId: 'evt_gone',
          agentId: 'agt_1',
          phase: 'reserved',
          ownerInstanceId: null,
        },
      ],
      [[{ status: 'cancelled' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(deps(tx))

    expect(released).toEqual([{ type: 'evaluation', workloadId: 'evt_gone', agentId: 'agt_1' }])
    expect(deleted).toHaveLength(1)
  })

  it('keeps a reserved lease for a workload still waiting in the queue', async () => {
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_queued',
          workloadType: 'run',
          workloadId: 'run_queued',
          phase: 'reserved',
          ownerInstanceId: null,
        },
      ],
      [[{ status: 'queued' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(deps(tx))

    expect(released).toEqual([])
    expect(deleted).toHaveLength(0)
  })

  it('releases the lease of a workload whose row was deleted entirely', async () => {
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_erased',
          workloadType: 'run',
          workloadId: 'run_erased',
          agentId: 'agt_1',
          phase: 'active',
          ownerInstanceId: 'instance-a',
        },
      ],
      [[]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(deps(tx))

    expect(released).toEqual([{ type: 'run', workloadId: 'run_erased', agentId: 'agt_1' }])
    expect(deleted).toHaveLength(1)
  })
})
