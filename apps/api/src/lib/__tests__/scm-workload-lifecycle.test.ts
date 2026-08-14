import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ScmWorkloadAdmissionError,
  ScmWorkloadLeaseConflictError,
  activateScmWorkload,
  findDurableAgentScmWorkload,
  findDurableScmSourceWorkload,
  releaseRecoveredScmWorkload,
  releaseReservedScmWorkload,
  releaseScmWorkload,
  retryScmWorkloadReleaseUntilSuccess,
  withScmWorkloadAdmission,
} from '../scm-workload-lifecycle.js'

interface Row {
  [key: string]: unknown
}

function query(rows: Row[]) {
  return {
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(rows) }),
    }),
  }
}

function mutationTx(selectResults: Row[][]) {
  const select = vi.fn()
  for (const rows of selectResults) select.mockReturnValueOnce(query(rows))

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
