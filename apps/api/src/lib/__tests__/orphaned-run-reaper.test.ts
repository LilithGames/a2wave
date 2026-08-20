import { describe, expect, it, vi } from 'vitest'
import type { InstanceLivenessMap } from '../instance-heartbeat.js'
import { type OrphanedRunCandidate, reapOrphanedRuns } from '../orphaned-run-reaper.js'

const NOW = new Date('2026-08-20T10:00:00Z')
const RECENT = new Date('2026-08-20T09:59:00Z')
const LONG_AGO = new Date('2026-08-20T08:00:00Z')

/** instance-b booted long ago and is still beating — a healthy peer. */
function alivePeerLiveness(): InstanceLivenessMap {
  return new Map([['instance-b', { startedAt: LONG_AGO, heartbeatAt: RECENT }]])
}

/** instance-b stopped beating far past the threshold — provably dead. */
function deadPeerLiveness(): InstanceLivenessMap {
  return new Map([['instance-b', { startedAt: LONG_AGO, heartbeatAt: LONG_AGO }]])
}

function candidate(overrides: Partial<OrphanedRunCandidate> = {}): OrphanedRunCandidate {
  return {
    id: 'run_1',
    agentId: 'agt_1',
    ownerInstanceId: 'instance-b',
    startedAt: LONG_AGO,
    ...overrides,
  }
}

function deps(overrides: Partial<Parameters<typeof reapOrphanedRuns>[0]> = {}) {
  return {
    listCandidates: vi.fn(async () => [candidate()]),
    loadLiveness: vi.fn(async (): Promise<InstanceLivenessMap> => deadPeerLiveness()),
    canJudgePeers: () => true,
    isRunLocallyActive: () => false,
    claimRun: vi.fn(async () => true),
    afterRunSettled: vi.fn(async () => {}),
    markForResume: vi.fn(async () => {}),
    requeueRun: vi.fn(async () => true),
    now: () => NOW,
    ...overrides,
  }
}

describe('reapOrphanedRuns', () => {
  it('fails a run whose owning instance stopped beating', async () => {
    const d = deps()
    const reaped = await reapOrphanedRuns(d)

    expect(reaped).toEqual([{ runId: 'run_1', agentId: 'agt_1', resumed: false }])
    expect(d.claimRun).toHaveBeenCalledWith('run_1')
    expect(d.afterRunSettled).toHaveBeenCalledWith('run_1')
  })

  it('leaves a run whose owner is still beating', async () => {
    const d = deps({ loadLiveness: vi.fn(async () => alivePeerLiveness()) })

    expect(await reapOrphanedRuns(d)).toEqual([])
    expect(d.claimRun).not.toHaveBeenCalled()
  })

  it('reaps nothing during the post-boot grace window', async () => {
    // The heartbeat table is empty right after an upgrade, so every peer that
    // has not yet written its first row would read as dead.
    const d = deps({ canJudgePeers: () => false, loadLiveness: vi.fn(async () => new Map()) })

    expect(await reapOrphanedRuns(d)).toEqual([])
    expect(d.listCandidates).not.toHaveBeenCalled()
  })

  it('leaves a run this process is still executing', async () => {
    // An in-process run is alive by definition, whatever the table says.
    const d = deps({ isRunLocallyActive: () => true })

    expect(await reapOrphanedRuns(d)).toEqual([])
    expect(d.claimRun).not.toHaveBeenCalled()
  })

  it('reaps a run whose owner never wrote a heartbeat row', async () => {
    const d = deps({ loadLiveness: vi.fn(async () => new Map()) })

    expect(await reapOrphanedRuns(d)).toEqual([
      { runId: 'run_1', agentId: 'agt_1', resumed: false },
    ])
  })

  it('reaps a run whose owner rebooted after the run started', async () => {
    // A reused instance id: the current life booted after this run began, so
    // the process that claimed the run is gone even though the id still beats.
    const d = deps({
      loadLiveness: vi.fn(
        async () => new Map([['instance-b', { startedAt: NOW, heartbeatAt: NOW }]]),
      ),
    })

    expect(await reapOrphanedRuns(d)).toEqual([
      { runId: 'run_1', agentId: 'agt_1', resumed: false },
    ])
  })

  it('skips a run with no owner recorded', async () => {
    // Legacy rows predating owner tracking carry no ownership claim, so
    // liveness says nothing about them and age alone must never reap.
    const d = deps({ listCandidates: vi.fn(async () => [candidate({ ownerInstanceId: null })]) })

    expect(await reapOrphanedRuns(d)).toEqual([])
    expect(d.claimRun).not.toHaveBeenCalled()
  })

  it('re-checks liveness immediately before settling', async () => {
    // The owner may resume beating between the scan and the write; acting on
    // the stale snapshot would fail a run that is demonstrably alive.
    const loadLiveness = vi
      .fn(async (): Promise<InstanceLivenessMap> => alivePeerLiveness())
      .mockResolvedValueOnce(deadPeerLiveness())
      .mockResolvedValueOnce(alivePeerLiveness())
    const d = deps({ loadLiveness })

    expect(await reapOrphanedRuns(d)).toEqual([])
    expect(d.claimRun).not.toHaveBeenCalled()
  })

  it('does not report a run another replica settled first', async () => {
    // claimRun is a status CAS: losing it means someone else already settled.
    const d = deps({ claimRun: vi.fn(async () => false) })

    expect(await reapOrphanedRuns(d)).toEqual([])
    expect(d.afterRunSettled).not.toHaveBeenCalled()
  })

  it('keeps reaping after one run fails to settle', async () => {
    const d = deps({
      listCandidates: vi.fn(async () => [
        candidate({ id: 'run_1' }),
        candidate({ id: 'run_2', agentId: 'agt_2' }),
      ]),
      claimRun: vi.fn(async (runId: string) => {
        if (runId === 'run_1') throw new Error('write failed')
        return true
      }),
    })

    expect(await reapOrphanedRuns(d)).toEqual([
      { runId: 'run_2', agentId: 'agt_2', resumed: false },
    ])
  })
})

describe('reapOrphanedRuns — startedAt is a lower bound on activity', () => {
  it('does not reap a live owner even when the run was claimed before its boot', async () => {
    // `startedAt` comes from runs.updatedAt, which advances on every write
    // during execution rather than pinning the claim instant. That only ever
    // moves the timestamp FORWARD, so the reboot comparison
    // (markWrittenAt < owner.startedAt) can fire less often, never more —
    // a live owner can never be reaped because of it.
    const d = deps({
      listCandidates: vi.fn(async () => [candidate({ startedAt: NOW })]),
      loadLiveness: vi.fn(
        async () => new Map([['instance-b', { startedAt: LONG_AGO, heartbeatAt: RECENT }]]),
      ),
    })

    expect(await reapOrphanedRuns(d)).toEqual([])
    expect(d.claimRun).not.toHaveBeenCalled()
  })
})

describe('reapOrphanedRuns — resuming instead of failing', () => {
  it('requeues a resumable run instead of settling it as failed', async () => {
    // The whole point of the pass changing: a run that recorded the session it
    // was already in continues from there, so a container restart does not
    // throw away a review that is already half-written.
    const d = deps({ canResume: vi.fn(async () => true) })

    const reaped = await reapOrphanedRuns(d)

    expect(d.requeueRun).toHaveBeenCalledWith('run_1')
    expect(d.claimRun).not.toHaveBeenCalled()
    // Still reported: the caller nudges the Agent's queue either way, and a
    // requeued run needs that nudge to be picked up.
    expect(reaped).toEqual([{ runId: 'run_1', agentId: 'agt_1', resumed: true }])
  })

  it('marks the interruption before requeuing so the resumed process can read it', async () => {
    // requeueForResume clears `result`, and execution runs in another process,
    // so the code has to be durable in metadata before it is erased.
    const calls: string[] = []
    const d = deps({
      canResume: vi.fn(async () => true),
      markForResume: vi.fn(async () => {
        calls.push('mark')
      }),
      requeueRun: vi.fn(async () => {
        calls.push('requeue')
        return true
      }),
    })

    await reapOrphanedRuns(d)

    expect(d.markForResume).toHaveBeenCalledWith('run_1', 'INSTANCE_STOPPED_DURING_EXEC')
    expect(calls).toEqual(['mark', 'requeue'])
  })

  it('does not sync external state to failed when the run is resumed', async () => {
    // afterRunSettled marks an A2A task failed. A resumed run is not failed,
    // and telling its caller otherwise would end a task that is still working.
    const d = deps({ canResume: vi.fn(async () => true) })

    await reapOrphanedRuns(d)

    expect(d.afterRunSettled).not.toHaveBeenCalled()
  })

  it('fails a run that cannot be resumed', async () => {
    const d = deps({ canResume: vi.fn(async () => false) })

    const reaped = await reapOrphanedRuns(d)

    expect(d.claimRun).toHaveBeenCalledWith('run_1')
    expect(d.requeueRun).not.toHaveBeenCalled()
    expect(reaped).toEqual([{ runId: 'run_1', agentId: 'agt_1', resumed: false }])
  })

  it('falls back to failing when the resume check throws', async () => {
    // A resume decision that fails must not strand the row as 'running';
    // failing is the safe default, exactly as startup recovery treats it.
    const d = deps({
      canResume: vi.fn(async () => {
        throw new Error('metadata read failed')
      }),
    })

    const reaped = await reapOrphanedRuns(d)

    expect(d.claimRun).toHaveBeenCalledWith('run_1')
    expect(reaped).toEqual([{ runId: 'run_1', agentId: 'agt_1', resumed: false }])
  })

  it('fails the run when the requeue itself fails', async () => {
    // Losing the requeue must not leave the row 'running' forever; the pass
    // still owes the caller a settled row.
    const d = deps({
      canResume: vi.fn(async () => true),
      requeueRun: vi.fn(async () => {
        throw new Error('requeue failed')
      }),
    })

    const reaped = await reapOrphanedRuns(d)

    expect(d.claimRun).toHaveBeenCalledWith('run_1')
    expect(reaped).toEqual([{ runId: 'run_1', agentId: 'agt_1', resumed: false }])
  })

  it('keeps failing runs when no resume check is wired in', async () => {
    // Back-compat: the reaper must behave exactly as before for any caller
    // that does not opt into resuming.
    const d = deps()

    expect(await reapOrphanedRuns(d)).toEqual([
      { runId: 'run_1', agentId: 'agt_1', resumed: false },
    ])
    expect(d.claimRun).toHaveBeenCalledWith('run_1')
  })
})

describe('reapOrphanedRuns — the requeue is a CAS, not a promise', () => {
  it('falls back to failing when the requeue loses the status race', async () => {
    // requeueForResume matches on status='running'. If another replica settled
    // the row first the UPDATE matches nothing and returns normally — so a
    // resumed:true verdict here would be a lie, and worse, it would skip the
    // fail path and leave the row exactly as this pass found it.
    const d = deps({
      canResume: vi.fn(async () => true),
      requeueRun: vi.fn(async () => false),
    })

    const reaped = await reapOrphanedRuns(d)

    expect(d.claimRun).toHaveBeenCalledWith('run_1')
    expect(reaped).toEqual([{ runId: 'run_1', agentId: 'agt_1', resumed: false }])
  })

  it('reports a resume whose requeue won the race', async () => {
    const d = deps({ canResume: vi.fn(async () => true), requeueRun: vi.fn(async () => true) })

    expect(await reapOrphanedRuns(d)).toEqual([{ runId: 'run_1', agentId: 'agt_1', resumed: true }])
    expect(d.claimRun).not.toHaveBeenCalled()
  })
})
