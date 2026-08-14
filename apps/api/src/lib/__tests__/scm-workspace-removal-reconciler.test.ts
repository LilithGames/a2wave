import { describe, expect, it, vi } from 'vitest'
import type { InstanceLivenessMap } from '../instance-heartbeat.js'
import { reconcileAbandonedWorkspaceRemovals } from '../scm-workspace-removal-reconciler.js'

const NOW = new Date('2026-08-14T10:00:00Z')
const RECENT = new Date('2026-08-14T09:59:00Z')
const LONG_AGO = new Date('2026-08-14T08:00:00Z')

function alivePeer(): InstanceLivenessMap {
  return new Map([['instance-b', { startedAt: LONG_AGO, heartbeatAt: RECENT }]])
}

function deadPeer(): InstanceLivenessMap {
  return new Map([['instance-b', { startedAt: LONG_AGO, heartbeatAt: LONG_AGO }]])
}

interface Reservation {
  id: string
  scmSourceId: string
  workspaceName: string
  ownerInstanceId: string | null
  attemptToken: string
  attemptStartedAt: Date
}

function reservation(over: Partial<Reservation> = {}): Reservation {
  return {
    id: 'scm_1:wt-a',
    scmSourceId: 'scm_1',
    workspaceName: 'wt-a',
    ownerInstanceId: null,
    attemptToken: 'token-1',
    attemptStartedAt: RECENT,
    ...over,
  }
}

function makeDeps(
  reservations: Reservation[],
  overrides: Partial<{
    loadLiveness: () => Promise<InstanceLivenessMap>
    adopt: (id: string, expectedToken: string, token: string) => Promise<boolean>
    findBlocker: () => Promise<string | null>
    removeWorkspace: (sourceId: string, name: string) => Promise<void>
    release: (id: string, token: string) => Promise<void>
  }> = {},
) {
  const removed: string[] = []
  const released: string[] = []
  const adopted: string[] = []
  const deps = {
    listAbandonedCandidates: async () => reservations,
    loadLiveness: overrides.loadLiveness ?? (async () => deadPeer()),
    adopt:
      overrides.adopt ??
      (async (id: string) => {
        adopted.push(id)
        return true
      }),
    findBlocker: overrides.findBlocker ?? (async () => null),
    removeWorkspace:
      overrides.removeWorkspace ??
      (async (sourceId: string, name: string) => {
        removed.push(`${sourceId}:${name}`)
      }),
    release:
      overrides.release ??
      (async (id: string) => {
        released.push(id)
      }),
    newToken: () => 'token-next',
    now: () => NOW,
  } as never
  return { deps, removed, released, adopted }
}

describe('reconcileAbandonedWorkspaceRemovals', () => {
  it('adopts a handed-off reservation, completes the removal, and releases it', async () => {
    // The convergence path that replaces the owner's unbounded retry loop: an
    // exhausted owner NULLs its ownership, and any surviving replica finishes
    // the job on a later tick.
    const { deps, removed, released, adopted } = makeDeps([reservation()])

    const result = await reconcileAbandonedWorkspaceRemovals(deps)

    expect(adopted).toEqual(['scm_1:wt-a'])
    expect(removed).toEqual(['scm_1:wt-a'])
    expect(released).toEqual(['scm_1:wt-a'])
    expect(result).toEqual([{ reservationId: 'scm_1:wt-a', outcome: 'removed' }])
  })

  it('adopts a reservation whose owner stopped beating', async () => {
    const { deps, removed } = makeDeps([reservation({ ownerInstanceId: 'instance-b' })])

    await reconcileAbandonedWorkspaceRemovals(deps)

    expect(removed).toEqual(['scm_1:wt-a'])
  })

  it('leaves a reservation whose owner is still beating', async () => {
    // A live owner is mid-removal; adopting would run a second concurrent
    // filesystem removal against the same worktree.
    const { deps, removed, adopted } = makeDeps([reservation({ ownerInstanceId: 'instance-b' })], {
      loadLiveness: async () => alivePeer(),
    })

    expect(await reconcileAbandonedWorkspaceRemovals(deps)).toEqual([])
    expect(adopted).toEqual([])
    expect(removed).toEqual([])
  })

  it('ignores a reservation whose attempt started after its owner booted', async () => {
    // Reused instance id, current life: the beating owner really is the one
    // that wrote this attempt.
    const { deps, removed } = makeDeps(
      [reservation({ ownerInstanceId: 'instance-b', attemptStartedAt: NOW })],
      { loadLiveness: async () => alivePeer() },
    )

    expect(await reconcileAbandonedWorkspaceRemovals(deps)).toEqual([])
    expect(removed).toEqual([])
  })

  it('releases without removing when the worktree became occupied again', async () => {
    // The reservation exists to block others; once a legitimate occupant
    // appeared, the removal is obsolete and holding the row would block that
    // occupant's source forever.
    const { deps, removed, released } = makeDeps([reservation()], {
      findBlocker: async () => 'Workspace is occupied by a running or pending run',
    })

    const result = await reconcileAbandonedWorkspaceRemovals(deps)

    expect(removed).toEqual([])
    expect(released).toEqual(['scm_1:wt-a'])
    expect(result).toEqual([{ reservationId: 'scm_1:wt-a', outcome: 'obsolete' }])
  })

  it('keeps the reservation when the filesystem removal fails again', async () => {
    // Failure must not release: the row is what keeps every counter-party off
    // this worktree. The next tick retries — that IS the retry loop.
    const { deps, released } = makeDeps([reservation()], {
      removeWorkspace: async () => {
        throw new Error('EBUSY')
      },
    })

    const result = await reconcileAbandonedWorkspaceRemovals(deps)

    expect(released).toEqual([])
    expect(result).toEqual([{ reservationId: 'scm_1:wt-a', outcome: 'retry' }])
  })

  it('skips a reservation another replica adopted first', async () => {
    // The token compare-and-set is the cross-replica arbiter: two reconcilers
    // racing on the same row, only one wins and the loser must not touch the
    // filesystem.
    const { deps, removed } = makeDeps([reservation()], { adopt: async () => false })

    expect(await reconcileAbandonedWorkspaceRemovals(deps)).toEqual([])
    expect(removed).toEqual([])
  })

  it('continues past a reservation that throws during adoption', async () => {
    const { deps, removed } = makeDeps(
      [reservation(), reservation({ id: 'scm_1:wt-b', workspaceName: 'wt-b' })],
      {
        adopt: async (id: string) => {
          if (id === 'scm_1:wt-a') throw new Error('db blip')
          return true
        },
      },
    )

    await reconcileAbandonedWorkspaceRemovals(deps)

    expect(removed).toEqual(['scm_1:wt-b'])
  })

  it('releases a reservation whose source row is gone', async () => {
    // A deleted source takes its worktrees with it (source DELETE reclaims the
    // whole managed tree), so nothing is left to remove and the row is pure
    // residue.
    const { deps, removed, released } = makeDeps([reservation()], {
      removeWorkspace: vi.fn(),
      findBlocker: async () => 'SCM source is no longer available',
    })

    const result = await reconcileAbandonedWorkspaceRemovals(deps)

    expect(removed).toEqual([])
    expect(released).toEqual(['scm_1:wt-a'])
    expect(result).toEqual([{ reservationId: 'scm_1:wt-a', outcome: 'obsolete' }])
  })
})
