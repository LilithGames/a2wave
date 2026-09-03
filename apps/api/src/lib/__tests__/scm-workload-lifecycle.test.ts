import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { scmWorkloadLeases } from '../../db/schema.js'
import {
  activateScmWorkload,
  findDurableAgentScmWorkload,
  findDurableScmSourceWorkload,
  findSharedCheckoutScmWorkload,
  releaseRecoveredScmWorkload,
  releaseReservedScmWorkload,
  releaseScmWorkload,
  retryScmWorkloadReleaseUntilSuccess,
  ScmWorkloadAdmissionError,
  ScmWorkloadLeaseConflictError,
  withScmWorkloadAdmission,
} from '../scm-workload-lifecycle.js'

interface Row {
  [key: string]: unknown
}

/**
 * A drizzle select result: awaitable on its own, and still `.limit()`-able.
 *
 * Queries that filter fully in SQL await the `where()` builder directly, while
 * single-row lookups keep chaining `.limit(1)`; one helper has to serve both.
 */
function selectResult(rows: Row[]) {
  const result = Promise.resolve(rows) as Promise<Row[]> & { limit: () => Promise<Row[]> }
  result.limit = () => Promise.resolve(rows)
  return result
}

function query(rows: Row[]) {
  // One `where` mock per query, hoisted so a test can inspect the predicate the
  // builder was actually handed — a fresh mock per `from()` call would record
  // nothing.
  const where = vi.fn(() => selectResult(rows))
  return { where, builder: { from: () => ({ where }) } }
}

function mutationTx(selectResults: Row[][]) {
  const select = vi.fn()
  for (const rows of selectResults) select.mockReturnValueOnce(query(rows).builder)
  // Anything the case did not seed reads as "no row". Activation now also
  // looks the source up to see whether a sync claim is committed on it, and a
  // case that says nothing about the source means there is none.
  select.mockReturnValue(query([]).builder)

  const inserted: Row[] = []
  const updated: Row[] = []
  const deleted: unknown[] = []
  const insert = vi.fn(() => ({
    values: (value: Row) => {
      inserted.push(value)
      return { returning: () => Promise.resolve([{ id: value.id }]) }
    },
  }))
  const update = vi.fn(() => ({
    set: (value: Row) => {
      updated.push(value)
      return { where: () => ({ returning: () => Promise.resolve([{ id: 'lease' }]) }) }
    },
  }))
  const deleteFn = vi.fn((table: unknown) => ({
    where: () => {
      deleted.push(table)
      return { returning: () => Promise.resolve([{ id: 'lease' }]) }
    },
  }))

  return { tx: { select, insert, update, delete: deleteFn }, inserted, updated, deleted }
}

const withMutation = async <T>(fn: (tx: never) => Promise<T>, tx: unknown): Promise<T> =>
  fn(tx as never)

describe('SCM workload lifecycle', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reloads the current SCM binding inside the mutation transaction and reserves it atomically', async () => {
    const { tx, inserted } = mutationTx([
      [{ workspaceType: 'scm', scmSourceId: 'scm_current' }],
      [],
    ])
    const writeState = vi.fn(async (_tx, admission) => admission)

    const result = await withScmWorkloadAdmission(
      { type: 'run', workloadId: 'run_1', agentId: 'agt_executor' },
      writeState,
      { withMutation: (fn) => withMutation(fn, tx) },
    )

    expect(inserted).toEqual([
      expect.objectContaining({
        id: 'run:run_1',
        workloadType: 'run',
        workloadId: 'run_1',
        agentId: 'agt_executor',
        scmSourceId: 'scm_current',
        phase: 'reserved',
      }),
    ])
    expect(writeState).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        workspaceType: 'scm',
        scmSourceId: 'scm_current',
        leaseId: 'run:run_1',
        alreadyReserved: false,
      }),
    )
    expect(result.scmSourceId).toBe('scm_current')
  })

  it('writes workload state in the same transaction even for a temporary workspace', async () => {
    const { tx, inserted } = mutationTx([[{ workspaceType: 'temp', scmSourceId: null }], []])
    const writeState = vi.fn(async () => 'written')

    await expect(
      withScmWorkloadAdmission(
        { type: 'evaluation', workloadId: 'evt_1', agentId: 'agt_1' },
        writeState,
        { withMutation: (fn) => withMutation(fn, tx) },
      ),
    ).resolves.toBe('written')

    expect(inserted).toEqual([])
    expect(writeState).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ workspaceType: 'temp', scmSourceId: null, leaseId: null }),
    )
  })

  it('rejects a missing Agent and a corrupt SCM binding before writing state', async () => {
    const missing = mutationTx([[]])
    await expect(
      withScmWorkloadAdmission(
        { type: 'run', workloadId: 'run_1', agentId: 'agt_missing' },
        async () => undefined,
        { withMutation: (fn) => withMutation(fn, missing.tx) },
      ),
    ).rejects.toBeInstanceOf(ScmWorkloadAdmissionError)

    const corrupt = mutationTx([[{ workspaceType: 'scm', scmSourceId: null }], []])
    await expect(
      withScmWorkloadAdmission(
        { type: 'run', workloadId: 'run_1', agentId: 'agt_corrupt' },
        async () => undefined,
        { withMutation: (fn) => withMutation(fn, corrupt.tx) },
      ),
    ).rejects.toThrow('SCM workspace without a source binding')
  })

  it('rejects a stale reservation after the Agent has switched to a temporary workspace', async () => {
    const stale = mutationTx([
      [{ workspaceType: 'temp', scmSourceId: null }],
      [
        {
          id: 'run:run_1',
          workloadType: 'run',
          workloadId: 'run_1',
          agentId: 'agt_1',
          scmSourceId: 'scm_1',
          phase: 'reserved',
          ownerInstanceId: null,
        },
      ],
    ])

    await expect(
      withScmWorkloadAdmission(
        { type: 'run', workloadId: 'run_1', agentId: 'agt_1' },
        async () => undefined,
        { withMutation: (fn) => withMutation(fn, stale.tx) },
      ),
    ).rejects.toBeInstanceOf(ScmWorkloadLeaseConflictError)
  })

  it('keeps an idempotent reservation but rejects actual-Agent or source drift', async () => {
    const matching = {
      id: 'run:run_1',
      workloadType: 'run',
      workloadId: 'run_1',
      agentId: 'agt_executor',
      scmSourceId: 'scm_1',
      phase: 'reserved',
      ownerInstanceId: null,
    }
    const first = mutationTx([[{ workspaceType: 'scm', scmSourceId: 'scm_1' }], [matching]])

    await withScmWorkloadAdmission(
      { type: 'run', workloadId: 'run_1', agentId: 'agt_executor' },
      async (_tx, admission) => {
        expect(admission.alreadyReserved).toBe(true)
      },
      { withMutation: (fn) => withMutation(fn, first.tx) },
    )
    expect(first.inserted).toEqual([])

    const drifted = mutationTx([[{ workspaceType: 'scm', scmSourceId: 'scm_2' }], [matching]])
    await expect(
      withScmWorkloadAdmission(
        { type: 'run', workloadId: 'run_1', agentId: 'agt_executor' },
        async () => undefined,
        { withMutation: (fn) => withMutation(fn, drifted.tx) },
      ),
    ).rejects.toBeInstanceOf(ScmWorkloadLeaseConflictError)
  })

  it('stores the process owner on activation and only that owner may release an active lease', async () => {
    const reserved = {
      id: 'run:run_1',
      workloadType: 'run',
      workloadId: 'run_1',
      agentId: 'agt_1',
      scmSourceId: 'scm_1',
      phase: 'reserved',
      ownerInstanceId: null,
    }
    const activation = mutationTx([[reserved]])
    await activateScmWorkload(
      { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-a' },
      { withMutation: (fn) => withMutation(fn, activation.tx) },
    )
    expect(activation.updated).toEqual([
      expect.objectContaining({ phase: 'active', ownerInstanceId: 'instance-a' }),
    ])

    const active = { ...reserved, phase: 'active', ownerInstanceId: 'instance-a' }
    const wrongOwner = mutationTx([[active]])
    await expect(
      releaseScmWorkload(
        { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-b' },
        { withMutation: (fn) => withMutation(fn, wrongOwner.tx) },
      ),
    ).rejects.toBeInstanceOf(ScmWorkloadLeaseConflictError)
    expect(wrongOwner.deleted).toEqual([])

    const rightOwner = mutationTx([[active]])
    await releaseScmWorkload(
      { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-a' },
      { withMutation: (fn) => withMutation(fn, rightOwner.tx) },
    )
    expect(rightOwner.deleted).toHaveLength(1)
  })

  it('refuses to activate queued SCM work after this instance self-fences', async () => {
    const activation = mutationTx([
      [
        {
          id: 'run:run_queued',
          workloadType: 'run',
          workloadId: 'run_queued',
          agentId: 'agt_1',
          scmSourceId: 'scm_1',
          phase: 'reserved',
          ownerInstanceId: null,
        },
      ],
    ])

    await expect(
      activateScmWorkload(
        { type: 'run', workloadId: 'run_queued', ownerInstanceId: 'instance-a' },
        {
          withMutation: (fn) => withMutation(fn, activation.tx),
          hasLostOwnership: () => true,
        },
      ),
    ).rejects.toBeInstanceOf(ScmWorkloadAdmissionError)
    expect(activation.updated).toEqual([])
  })

  it('makes activation idempotent for its owner and rejects a missing or foreign lease', async () => {
    const active = {
      id: 'run:run_1',
      workloadType: 'run',
      workloadId: 'run_1',
      agentId: 'agt_1',
      scmSourceId: 'scm_1',
      phase: 'active',
      ownerInstanceId: 'instance-a',
    }
    const sameOwner = mutationTx([[active]])
    await activateScmWorkload(
      { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-a' },
      { withMutation: (fn) => withMutation(fn, sameOwner.tx) },
    )
    expect(sameOwner.updated).toEqual([])

    const foreignOwner = mutationTx([[active]])
    await expect(
      activateScmWorkload(
        { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-b' },
        { withMutation: (fn) => withMutation(fn, foreignOwner.tx) },
      ),
    ).rejects.toBeInstanceOf(ScmWorkloadLeaseConflictError)

    const missing = mutationTx([[]])
    await expect(
      activateScmWorkload(
        { type: 'run', workloadId: 'run_missing', ownerInstanceId: 'instance-a' },
        { withMutation: (fn) => withMutation(fn, missing.tx) },
      ),
    ).rejects.toThrow('has no durable reservation')
  })

  it('releases an unclaimed reservation and treats a missing lease as idempotently released', async () => {
    const reserved = mutationTx([
      [
        {
          id: 'evaluation:evt_1',
          workloadType: 'evaluation',
          workloadId: 'evt_1',
          agentId: 'agt_1',
          scmSourceId: 'scm_1',
          phase: 'reserved',
          ownerInstanceId: null,
        },
      ],
    ])
    await expect(
      releaseScmWorkload(
        { type: 'evaluation', workloadId: 'evt_1', ownerInstanceId: 'instance-a' },
        { withMutation: (fn) => withMutation(fn, reserved.tx) },
      ),
    ).resolves.toBe(true)

    const missing = mutationTx([[]])
    await expect(
      releaseScmWorkload(
        { type: 'evaluation', workloadId: 'evt_missing', ownerInstanceId: 'instance-a' },
        { withMutation: (fn) => withMutation(fn, missing.tx) },
      ),
    ).resolves.toBe(false)
  })

  it('releases only a reservation and leaves an activated workload untouched', async () => {
    const reserved = mutationTx([])
    await expect(
      releaseReservedScmWorkload(
        { type: 'run', workloadId: 'run_queued' },
        { withMutation: (fn) => withMutation(fn, reserved.tx) },
      ),
    ).resolves.toBe(true)
    expect(reserved.deleted).toHaveLength(1)

    const active = mutationTx([])
    active.tx.delete = vi.fn(() => ({
      where: () => ({ returning: () => Promise.resolve([]) }),
    }))
    await expect(
      releaseReservedScmWorkload(
        { type: 'run', workloadId: 'run_active' },
        { withMutation: (fn) => withMutation(fn, active.tx) },
      ),
    ).resolves.toBe(false)
  })

  it('releases an active lease only through the explicit proven-dead recovery path', async () => {
    const recovered = mutationTx([])

    await expect(
      releaseRecoveredScmWorkload(
        { type: 'run', workloadId: 'run_interrupted' },
        { withMutation: (fn) => withMutation(fn, recovered.tx) },
      ),
    ).resolves.toBe(true)

    expect(recovered.deleted).toHaveLength(1)
  })

  it('retains a failed durable release and retries it before lifecycle drain can finish', async () => {
    const release = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(true)
    const delay = vi.fn(async () => undefined)

    await retryScmWorkloadReleaseUntilSuccess(
      { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-a' },
      { release, delay, retryDelayMs: 25 },
    )

    expect(release).toHaveBeenCalledTimes(2)
    expect(delay).toHaveBeenCalledWith(25)
  })

  it('backs off repeated durable release failures and caps the delay', async () => {
    const release = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('database unavailable 1'))
      .mockRejectedValueOnce(new Error('database unavailable 2'))
      .mockRejectedValueOnce(new Error('database unavailable 3'))
      .mockResolvedValueOnce(true)
    const delay = vi.fn(async () => undefined)

    await retryScmWorkloadReleaseUntilSuccess(
      { type: 'run', workloadId: 'run_backoff', ownerInstanceId: 'instance-a' },
      { release, delay, retryDelayMs: 25, maxRetryDelayMs: 60 },
    )

    expect(delay.mock.calls).toEqual([[25], [50], [60]])
  })

  it('treats the durable row as active after the Run status is already terminal', async () => {
    const { tx } = mutationTx([
      [
        {
          type: 'run',
          id: 'run_cancelled',
        },
      ],
    ])

    await expect(findDurableAgentScmWorkload(tx as never, 'agt_1')).resolves.toEqual({
      type: 'run',
      id: 'run_cancelled',
    })
  })

  // The agent-keyed lookup protects binding mutation; source mutation (path
  // PATCH, deletion, workspace removal) needs the same authority keyed by the
  // source the lease pins — a lease names both sides of the relation.
  it('finds a durable workload by the source it pins', async () => {
    const { tx } = mutationTx([
      [
        {
          type: 'evaluation',
          id: 'evt_active',
          agentId: 'agt_executor',
        },
      ],
    ])

    await expect(findDurableScmSourceWorkload(tx as never, 'scm_src')).resolves.toEqual({
      type: 'evaluation',
      id: 'evt_active',
      agentId: 'agt_executor',
    })
  })

  it('returns null when no lease pins the source', async () => {
    const { tx } = mutationTx([[]])

    await expect(findDurableScmSourceWorkload(tx as never, 'scm_src')).resolves.toBeNull()
  })
})

describe('activation versus a committed sync claim', () => {
  const reserved = {
    id: 'run:run_1',
    workloadType: 'run',
    workloadId: 'run_1',
    agentId: 'agt_1',
    scmSourceId: 'scm_1',
    phase: 'reserved',
    ownerInstanceId: null,
  }

  beforeEach(() => vi.clearAllMocks())

  // The window this closes: sync reads occupancy and finds nothing, then a
  // lease activates, then `p4 sync` / `git checkout -f -B` rewrites the
  // checkout under the live CLI. Sync now commits its `syncing` claim in the
  // same SCM-mutation critical section it reads occupancy in, so the two sides
  // are ordered by that lock: whichever takes it second loses. This is that
  // second case — activation observing the claim.
  it('refuses to activate a shared-checkout workload while the source holds a sync claim', async () => {
    const activation = mutationTx([
      [reserved],
      [{ localPath: '/srv/scm/sources/scm_1', type: 'p4', syncStatus: 'syncing' }],
      [{ workDir: null }],
    ])

    await expect(
      activateScmWorkload(
        { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-a' },
        { withMutation: (fn) => withMutation(fn, activation.tx) },
      ),
    ).rejects.toBeInstanceOf(ScmWorkloadLeaseConflictError)
    expect(activation.updated).toEqual([])
  })

  it('activates normally when the source is idle', async () => {
    const activation = mutationTx([
      [reserved],
      [{ localPath: '/srv/scm/sources/scm_1', type: 'p4', syncStatus: 'idle' }],
    ])

    await activateScmWorkload(
      { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-a' },
      { withMutation: (fn) => withMutation(fn, activation.tx) },
    )
    expect(activation.updated).toEqual([
      expect.objectContaining({ phase: 'active', ownerInstanceId: 'instance-a' }),
    ])
  })

  // Symmetry with the sync-side gate: it only defers for workloads that sit in
  // the shared checkout, so activation may only refuse for exactly those. A run
  // that already recorded a per-Agent worktree is not one of them.
  it('activates a run that recorded a worktree outside the shared checkout', async () => {
    const activation = mutationTx([
      [reserved],
      [{ localPath: '/srv/scm/sources/scm_1', type: 'git', syncStatus: 'syncing' }],
      [{ workDir: '/srv/scm/workspaces/scm_1/agt_1' }],
    ])

    await activateScmWorkload(
      { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-a' },
      { withMutation: (fn) => withMutation(fn, activation.tx) },
    )
    expect(activation.updated).toHaveLength(1)
  })

  it('activates a git evaluation during a sync, which owns an eval-<taskId> worktree', async () => {
    const activation = mutationTx([
      [
        {
          ...reserved,
          id: 'evaluation:evt_1',
          workloadType: 'evaluation',
          workloadId: 'evt_1',
        },
      ],
      [{ localPath: '/srv/scm/sources/scm_1', type: 'git', syncStatus: 'syncing' }],
    ])

    await activateScmWorkload(
      { type: 'evaluation', workloadId: 'evt_1', ownerInstanceId: 'instance-a' },
      { withMutation: (fn) => withMutation(fn, activation.tx) },
    )
    expect(activation.updated).toHaveLength(1)
  })

  it('refuses a p4 evaluation during a sync, whose checkout is shared by construction', async () => {
    const activation = mutationTx([
      [
        {
          ...reserved,
          id: 'evaluation:evt_1',
          workloadType: 'evaluation',
          workloadId: 'evt_1',
        },
      ],
      [{ localPath: '/srv/scm/sources/scm_1', type: 'p4', syncStatus: 'syncing' }],
    ])

    await expect(
      activateScmWorkload(
        { type: 'evaluation', workloadId: 'evt_1', ownerInstanceId: 'instance-a' },
        { withMutation: (fn) => withMutation(fn, activation.tx) },
      ),
    ).rejects.toBeInstanceOf(ScmWorkloadLeaseConflictError)
    expect(activation.updated).toEqual([])
  })

  // Re-activation by the owner is the process re-entering its own lease; the
  // checkout is already claimed by it, so a sync claim is not its problem.
  it('stays idempotent for an already-active lease of the same owner', async () => {
    const activation = mutationTx([
      [{ ...reserved, phase: 'active', ownerInstanceId: 'instance-a' }],
    ])

    await activateScmWorkload(
      { type: 'run', workloadId: 'run_1', ownerInstanceId: 'instance-a' },
      { withMutation: (fn) => withMutation(fn, activation.tx) },
    )
    expect(activation.updated).toEqual([])
  })
})

describe('findSharedCheckoutScmWorkload', () => {
  const SHARED = '/srv/scm/sources/src_1'

  function executor(leases: Row[], runRows: Row[] = []) {
    const leaseQuery = query(leases)
    const select = vi.fn()
    select.mockReturnValueOnce(leaseQuery.builder)
    select.mockReturnValueOnce(query(runRows).builder)
    return { executor: { select } as never, select, leaseWhere: leaseQuery.where }
  }

  it('returns null when no lease pins the source', async () => {
    await expect(
      findSharedCheckoutScmWorkload(executor([]).executor, 'src_1', SHARED, 'git'),
    ).resolves.toBeNull()
  })

  // Reserved work is queued and owns no directory, and an unbounded scan of
  // released rows is what let an active lease hide past the old row cap — so
  // the phase filter belongs in SQL, not in a post-filter loop.
  it('filters leases to the active phase in SQL', async () => {
    const { executor: exec, leaseWhere } = executor([])

    await findSharedCheckoutScmWorkload(exec, 'src_1', SHARED, 'git')

    expect(leaseWhere).toHaveBeenCalledWith(
      and(eq(scmWorkloadLeases.scmSourceId, 'src_1'), eq(scmWorkloadLeases.phase, 'active')),
    )
  })

  it('ignores a run executing in its own per-agent worktree', async () => {
    const leases = [{ type: 'run', id: 'run_1' }]
    const runRows = [{ id: 'run_1', workDir: '/srv/scm/workspaces/src_1/agent-abc' }]

    await expect(
      findSharedCheckoutScmWorkload(executor(leases, runRows).executor, 'src_1', SHARED, 'git'),
    ).resolves.toBeNull()
  })

  it('reports a run executing in the shared checkout', async () => {
    const leases = [{ type: 'run', id: 'run_1' }]
    const runRows = [{ id: 'run_1', workDir: SHARED }]

    await expect(
      findSharedCheckoutScmWorkload(executor(leases, runRows).executor, 'src_1', SHARED, 'git'),
    ).resolves.toEqual({ type: 'run', id: 'run_1' })
  })

  // P4 Agents and git worktree-creation fallbacks both execute in `localPath`,
  // and neither records runs.workDir — an unrecorded workDir is exactly the
  // shared-checkout case, so it must be treated as occupancy.
  it('reports an active run that recorded no workDir', async () => {
    const leases = [{ type: 'run', id: 'run_1' }]

    await expect(
      findSharedCheckoutScmWorkload(
        executor(leases, [{ id: 'run_1', workDir: null }]).executor,
        'src_1',
        SHARED,
        'git',
      ),
    ).resolves.toEqual({ type: 'run', id: 'run_1' })
  })

  // A git evaluation runs in `eval-<taskId>`: prepareEvaluationWorkspace resolves
  // that worktree explicitly and resolveWorkDir *throws* rather than degrading to
  // localPath, so the task never reaches the shared checkout. Counting it there
  // deferred every sync tick for the whole replay for no safety gain.
  it('ignores an evaluation on a git source, which owns an eval-<taskId> worktree', async () => {
    const leases = [{ type: 'evaluation', id: 'evt_1' }]

    await expect(
      findSharedCheckoutScmWorkload(executor(leases).executor, 'src_1', SHARED, 'git'),
    ).resolves.toBeNull()
  })

  // P4 has no isolation mechanism — the client spec binds one server-side Root —
  // so an evaluation there is in the shared checkout by construction.
  it('reports an evaluation on a p4 source, whose checkout is shared by construction', async () => {
    const leases = [{ type: 'evaluation', id: 'evt_1' }]

    await expect(
      findSharedCheckoutScmWorkload(executor(leases).executor, 'src_1', SHARED, 'p4'),
    ).resolves.toEqual({ type: 'evaluation', id: 'evt_1' })
  })

  // The old scan stopped at 100 rows, so an active lease sitting behind a long
  // tail of leases was simply not seen and the sync ran under a live Agent CLI.
  it('detects an active lease beyond the old 100-row scan cap', async () => {
    const leases = Array.from({ length: 151 }, (_, i) => ({ type: 'run', id: `run_${i}` }))
    const runRows = leases.map((lease, i) => ({
      id: lease.id,
      workDir: i === 150 ? SHARED : `/srv/scm/workspaces/src_1/agent-${i}`,
    }))

    await expect(
      findSharedCheckoutScmWorkload(executor(leases, runRows).executor, 'src_1', SHARED, 'git'),
    ).resolves.toEqual({ type: 'run', id: 'run_150' })
  })

  // One lookup per lease made the occupancy gate O(N) round trips on the hot
  // auto-sync path; the run rows are fetched in a single batched select.
  it('batches every run lookup into one select', async () => {
    const leases = Array.from({ length: 30 }, (_, i) => ({ type: 'run', id: `run_${i}` }))
    const runRows = leases.map((lease) => ({
      id: lease.id,
      workDir: `/srv/scm/workspaces/src_1/agent-${lease.id}`,
    }))
    const { executor: exec, select } = executor(leases, runRows)

    await findSharedCheckoutScmWorkload(exec, 'src_1', SHARED, 'git')

    expect(select).toHaveBeenCalledTimes(2)
  })

  it('skips the run lookup entirely when no run lease is active', async () => {
    const { executor: exec, select } = executor([{ type: 'evaluation', id: 'evt_1' }])

    await findSharedCheckoutScmWorkload(exec, 'src_1', SHARED, 'git')

    expect(select).toHaveBeenCalledTimes(1)
  })
})

describe('withScmWorkloadAdmission — self-fencing', () => {
  // The owner must reach the same verdict its peers will. Once renewals have
  // failed past the threshold, peers may reclaim this instance's checkouts, so
  // taking on new SCM work would put two processes in one worktree.
  it('refuses admission while this instance cannot renew its heartbeat', async () => {
    const withMutation = vi.fn()

    await expect(
      withScmWorkloadAdmission(
        { type: 'run', workloadId: 'run_1', agentId: 'agt_1' },
        async () => 'never',
        { withMutation: withMutation as never, hasLostOwnership: () => true },
      ),
    ).rejects.toBeInstanceOf(ScmWorkloadAdmissionError)

    // Refused at the door: no transaction, so no lease row can be written.
    expect(withMutation).not.toHaveBeenCalled()
  })
})
