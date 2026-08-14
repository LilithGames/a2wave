import { describe, expect, it, vi } from 'vitest'
import type { InstanceLivenessMap } from '../instance-heartbeat.js'
import {
  failScmWorkloadsOfDeadInstances,
  sweepOrphanedScmWorkloadLeases,
} from '../scm-lease-sweeper.js'

const NOW = new Date('2026-08-14T10:00:00Z')
const RECENT = new Date('2026-08-14T09:59:00Z')
const LONG_AGO = new Date('2026-08-14T08:00:00Z')

/** instance-b: booted long ago, still beating — a healthy peer. */
function alivePeerLiveness(): InstanceLivenessMap {
  return new Map([['instance-b', { startedAt: LONG_AGO, heartbeatAt: RECENT }]])
}

/** instance-b: stopped beating far past the threshold — provably dead. */
function deadPeerLiveness(): InstanceLivenessMap {
  return new Map([['instance-b', { startedAt: LONG_AGO, heartbeatAt: LONG_AGO }]])
}

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
    loadLiveness: () => Promise<InstanceLivenessMap>
    canJudgePeers: () => boolean
  }> = {},
) {
  return {
    withMutation: (fn: (tx: never) => Promise<unknown>) => fn(tx as never),
    isWorkloadLocallyActive: overrides.isWorkloadLocallyActive ?? (() => false),
    ownerInstanceId: overrides.ownerInstanceId ?? 'instance-a',
    loadLiveness: overrides.loadLiveness ?? (async () => alivePeerLiveness()),
    canJudgePeers: overrides.canJudgePeers ?? (() => true),
    now: () => NOW,
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

  it('never touches an active lease owned by another live instance', async () => {
    // Without a positively identified dead owner, a visible stuck lease is
    // safer than reclaiming a checkout beneath a healthy peer. The heartbeat
    // is that positive identification — a beating peer is off limits.
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_peer',
          workloadType: 'run',
          workloadId: 'run_peer',
          phase: 'active',
          ownerInstanceId: 'instance-b',
          updatedAt: RECENT,
        },
      ],
      [[{ status: 'completed' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(deps(tx))

    expect(released).toEqual([])
    expect(deleted).toHaveLength(0)
  })

  it('releases a terminal-workload lease whose owner stopped beating', async () => {
    // The dead-owner case the operator-recovery runbook used to cover: the
    // owning replica crashed after its run went terminal but before cleanup
    // released the lease. A stopped heartbeat proves the owner is gone.
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_orphan',
          workloadType: 'run',
          workloadId: 'run_orphan',
          agentId: 'agt_1',
          phase: 'active',
          ownerInstanceId: 'instance-b',
          updatedAt: RECENT,
        },
      ],
      [[{ status: 'failed' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(
      deps(tx, { loadLiveness: async () => deadPeerLiveness() }),
    )

    expect(released).toEqual([{ type: 'run', workloadId: 'run_orphan', agentId: 'agt_1' }])
    expect(deleted).toHaveLength(1)
  })

  it('releases a lease activated by a previous life of a reused instance id', async () => {
    // Instance ids are reused across container restarts: the reused id beats
    // again, but a lease activated BEFORE the owner's current boot belongs to
    // its dead previous life.
    const rebornPeer: InstanceLivenessMap = new Map([
      ['instance-b', { startedAt: RECENT, heartbeatAt: NOW }],
    ])
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_prev_life',
          workloadType: 'run',
          workloadId: 'run_prev_life',
          agentId: 'agt_1',
          phase: 'active',
          ownerInstanceId: 'instance-b',
          updatedAt: LONG_AGO,
        },
      ],
      [[{ status: 'failed' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(
      deps(tx, { loadLiveness: async () => rebornPeer }),
    )

    expect(released).toEqual([{ type: 'run', workloadId: 'run_prev_life', agentId: 'agt_1' }])
    expect(deleted).toHaveLength(1)
  })

  it('reads liveness inside the mutation, not from an outer snapshot', async () => {
    // check-then-act on liveness: a snapshot taken before the lock is a
    // verdict about the past. If the owner resumes beating before the delete
    // lands, the sweep would reclaim a lease whose owner is demonstrably
    // alive. Reading under the same lock makes verdict and delete atomic.
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_peer',
          workloadType: 'run',
          workloadId: 'run_peer',
          agentId: 'agt_1',
          phase: 'active',
          ownerInstanceId: 'instance-b',
          updatedAt: RECENT,
        },
      ],
      [[{ status: 'failed' }]],
    )
    const loadLiveness = vi.fn(async () => deadPeerLiveness())

    await sweepOrphanedScmWorkloadLeases(deps(tx, { loadLiveness }))

    // The executor it was handed must be the transaction, not a bare db.
    expect(loadLiveness).toHaveBeenCalledWith(tx)
    expect(deleted).toHaveLength(1)
  })

  it('leaves peer leases alone during the post-boot grace window', async () => {
    // Right after an upgrade the heartbeat table is empty, so every peer reads
    // as dead. Reclaiming then would pull checkouts out from under replicas
    // that simply have not written their first row yet.
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_peer',
          workloadType: 'run',
          workloadId: 'run_peer',
          agentId: 'agt_1',
          phase: 'active',
          ownerInstanceId: 'instance-b',
          updatedAt: RECENT,
        },
      ],
      [[{ status: 'failed' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(
      deps(tx, { canJudgePeers: () => false, loadLiveness: async () => new Map() }),
    )

    expect(released).toEqual([])
    expect(deleted).toHaveLength(0)
  })

  it('still releases its OWN leases during the grace window', async () => {
    // No heartbeat is needed to know this process is alive, so its own
    // bookkeeping must not stall for five minutes after every restart.
    const { tx, deleted } = sweepTx(
      [
        {
          id: 'run:run_mine',
          workloadType: 'run',
          workloadId: 'run_mine',
          agentId: 'agt_1',
          phase: 'active',
          ownerInstanceId: 'instance-a',
        },
      ],
      [[{ status: 'completed' }]],
    )

    const released = await sweepOrphanedScmWorkloadLeases(
      deps(tx, { canJudgePeers: () => false, loadLiveness: async () => new Map() }),
    )

    expect(released).toEqual([{ type: 'run', workloadId: 'run_mine', agentId: 'agt_1' }])
    expect(deleted).toHaveLength(1)
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

function reaperDeps(
  leases: Row[],
  statusRows: Row[][],
  overrides: Partial<{
    loadLiveness: () => Promise<InstanceLivenessMap>
    canJudgePeers: () => boolean
    isWorkloadLocallyActive: (identity: { type: string; workloadId: string }) => boolean
    claimRun: (runId: string) => Promise<boolean>
    claimEvaluation: (taskId: string) => Promise<boolean>
  }> = {},
) {
  let statusCall = 0
  const failRun = vi.fn(async () => {})
  const failEvaluation = vi.fn(async () => {})
  const claimRun = overrides.claimRun ?? vi.fn(async () => true)
  const claimEvaluation = overrides.claimEvaluation ?? vi.fn(async () => true)
  const dbMock = {
    select: vi.fn(() => ({
      from: vi.fn(() =>
        Object.assign(Promise.resolve(leases), {
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(statusRows[statusCall++] ?? [])),
          })),
        }),
      ),
    })),
  }
  return {
    failRun,
    failEvaluation,
    claimRun,
    claimEvaluation,
    deps: {
      db: dbMock,
      loadLiveness: overrides.loadLiveness ?? (async () => deadPeerLiveness()),
      canJudgePeers: overrides.canJudgePeers ?? (() => true),
      isWorkloadLocallyActive: overrides.isWorkloadLocallyActive ?? (() => false),
      claimRun,
      claimEvaluation,
      failRun,
      failEvaluation,
      now: () => NOW,
    } as never,
  }
}

describe('failScmWorkloadsOfDeadInstances', () => {
  const activePeerLease = (over: Row = {}): Row => ({
    id: 'run:run_stuck',
    workloadType: 'run',
    workloadId: 'run_stuck',
    agentId: 'agt_1',
    phase: 'active',
    ownerInstanceId: 'instance-b',
    updatedAt: RECENT,
    ...over,
  })

  it('fails a non-terminal run whose owning instance stopped beating', async () => {
    // The gap terminal-only sweeping cannot close: a crashed replica leaves
    // its run 'running' forever, so the lease never becomes sweepable and the
    // Agent binding and source stay pinned until an operator intervenes.
    const { deps, failRun } = reaperDeps([activePeerLease()], [[{ status: 'running' }]])

    const reaped = await failScmWorkloadsOfDeadInstances(deps)

    expect(failRun).toHaveBeenCalledWith('run_stuck')
    expect(reaped).toEqual([{ type: 'run', workloadId: 'run_stuck', agentId: 'agt_1' }])
  })

  it('fails a non-terminal evaluation of a dead instance', async () => {
    const { deps, failEvaluation } = reaperDeps(
      [
        activePeerLease({
          id: 'evaluation:evt_stuck',
          workloadType: 'evaluation',
          workloadId: 'evt_stuck',
        }),
      ],
      [[{ status: 'running' }]],
    )

    const reaped = await failScmWorkloadsOfDeadInstances(deps)

    expect(failEvaluation).toHaveBeenCalledWith('evt_stuck')
    expect(reaped).toEqual([{ type: 'evaluation', workloadId: 'evt_stuck', agentId: 'agt_1' }])
  })

  it('leaves workloads of a live owner alone', async () => {
    const { deps, failRun } = reaperDeps([activePeerLease()], [[{ status: 'running' }]], {
      loadLiveness: async () => alivePeerLiveness(),
    })

    expect(await failScmWorkloadsOfDeadInstances(deps)).toEqual([])
    expect(failRun).not.toHaveBeenCalled()
  })

  it('cancels the reap when the owner resumes beating before the write', async () => {
    // The liveness snapshot is taken before the per-workload status queries,
    // so a peer recovering in that window would otherwise have its live
    // workload failed — the exact outcome the heartbeat exists to prevent.
    let call = 0
    const { deps, failRun } = reaperDeps([activePeerLease()], [[{ status: 'running' }]], {
      loadLiveness: async () => (call++ === 0 ? deadPeerLiveness() : alivePeerLiveness()),
    })

    expect(await failScmWorkloadsOfDeadInstances(deps)).toEqual([])
    expect(failRun).not.toHaveBeenCalled()
  })

  it('never fails a workload that is still active in this process', async () => {
    // Local activity always wins — the local registry is fresher than any
    // heartbeat, and a dead-looking owner cannot include ourselves.
    const { deps, failRun } = reaperDeps([activePeerLease()], [[{ status: 'running' }]], {
      isWorkloadLocallyActive: () => true,
    })

    expect(await failScmWorkloadsOfDeadInstances(deps)).toEqual([])
    expect(failRun).not.toHaveBeenCalled()
  })

  it('skips terminal workloads — releasing their lease is the sweep pass job', async () => {
    const { deps, failRun } = reaperDeps([activePeerLease()], [[{ status: 'failed' }]])

    expect(await failScmWorkloadsOfDeadInstances(deps)).toEqual([])
    expect(failRun).not.toHaveBeenCalled()
  })

  it('does not reap a workload that reached a terminal state concurrently', async () => {
    // check-then-act: the status read says 'running', but the owner (or a
    // cancel request) settles the row before the write lands. Without a
    // predicated claim this would overwrite a real completion with a
    // synthetic failure.
    const { deps, failRun, claimRun } = reaperDeps([activePeerLease()], [[{ status: 'running' }]], {
      claimRun: vi.fn(async () => false),
    })

    expect(await failScmWorkloadsOfDeadInstances(deps)).toEqual([])
    // The claim must actually be attempted, or this test would pass for the
    // wrong reason — e.g. the reap never reaching the write at all.
    expect(claimRun).toHaveBeenCalledWith('run_stuck')
    expect(failRun).not.toHaveBeenCalled()
  })

  it('claims before writing the terminal state', async () => {
    const { deps, failRun, claimRun } = reaperDeps([activePeerLease()], [[{ status: 'running' }]])

    await failScmWorkloadsOfDeadInstances(deps)

    expect(claimRun).toHaveBeenCalledWith('run_stuck')
    expect(failRun).toHaveBeenCalledWith('run_stuck')
  })

  it('does not reap an evaluation another writer settled first', async () => {
    const { deps, failEvaluation, claimEvaluation } = reaperDeps(
      [
        activePeerLease({
          id: 'evaluation:evt_stuck',
          workloadType: 'evaluation',
          workloadId: 'evt_stuck',
        }),
      ],
      [[{ status: 'running' }]],
      { claimEvaluation: vi.fn(async () => false) },
    )

    expect(await failScmWorkloadsOfDeadInstances(deps)).toEqual([])
    expect(claimEvaluation).toHaveBeenCalledWith('evt_stuck')
    expect(failEvaluation).not.toHaveBeenCalled()
  })

  it('ignores reserved leases — queued work has no owning process to die', async () => {
    const { deps, failRun } = reaperDeps(
      [activePeerLease({ phase: 'reserved', ownerInstanceId: null })],
      [[{ status: 'queued' }]],
    )

    expect(await failScmWorkloadsOfDeadInstances(deps)).toEqual([])
    expect(failRun).not.toHaveBeenCalled()
  })
})
