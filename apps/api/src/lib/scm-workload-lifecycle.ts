import { and, eq } from 'drizzle-orm'
import type { db } from '../db/client.js'
import { agents, scmWorkloadLeases } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { withScmPathMutation } from './scm-path-plan.js'

export type ScmWorkloadType = 'run' | 'evaluation'

export interface ScmWorkloadIdentity {
  type: ScmWorkloadType
  workloadId: string
}

export interface ScmWorkloadAdmissionInput extends ScmWorkloadIdentity {
  /** The Agent that will actually execute, not necessarily the Run initiator. */
  agentId: string
}

export type ScmWorkloadAdmission =
  | {
      workspaceType: 'temp'
      scmSourceId: null
      leaseId: null
      alreadyReserved: false
    }
  | {
      workspaceType: 'scm'
      scmSourceId: string
      leaseId: string
      alreadyReserved: boolean
    }

type MutationRunner = <T>(mutation: (tx: TransactionHandle) => Promise<T>) => Promise<T>

export interface ScmWorkloadLifecycleDeps {
  withMutation: MutationRunner
}

const defaultDeps: ScmWorkloadLifecycleDeps = { withMutation: withScmPathMutation }

type LeaseRow = typeof scmWorkloadLeases.$inferSelect

export class ScmWorkloadLeaseConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScmWorkloadLeaseConflictError'
  }
}

export class ScmWorkloadAdmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScmWorkloadAdmissionError'
  }
}

export function scmWorkloadLeaseId(identity: ScmWorkloadIdentity): string {
  return `${identity.type}:${identity.workloadId}`
}

async function loadLease(
  executor: Pick<typeof db, 'select'>,
  identity: ScmWorkloadIdentity,
): Promise<LeaseRow | null> {
  return (
    ((
      await executor
        .select()
        .from(scmWorkloadLeases)
        .where(
          and(
            eq(scmWorkloadLeases.workloadType, identity.type),
            eq(scmWorkloadLeases.workloadId, identity.workloadId),
          ),
        )
        .limit(1)
    )[0] as LeaseRow | undefined) ?? null
  )
}

function assertMatchingReservation(
  lease: LeaseRow,
  input: ScmWorkloadAdmissionInput,
  scmSourceId: string,
): void {
  if (lease.agentId !== input.agentId || lease.scmSourceId !== scmSourceId) {
    throw new ScmWorkloadLeaseConflictError(
      `SCM workload "${lease.id}" is already reserved for a different Agent or source`,
    )
  }
}

/**
 * Admit work against the Agent binding read inside the global SCM mutation
 * transaction. The callback persists the Run/Evaluation state in that same
 * transaction, so no replica can release the binding between the state write,
 * lease reservation, and binding snapshot.
 */
export async function withScmWorkloadAdmission<T>(
  input: ScmWorkloadAdmissionInput,
  writeWorkloadState: (tx: TransactionHandle, admission: ScmWorkloadAdmission) => Promise<T>,
  deps: ScmWorkloadLifecycleDeps = defaultDeps,
): Promise<T> {
  return deps.withMutation(async (tx) => {
    const agent = (
      await tx
        .select({ workspaceType: agents.workspaceType, scmSourceId: agents.scmSourceId })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1)
    )[0]
    if (!agent) {
      throw new ScmWorkloadAdmissionError(`Agent "${input.agentId}" not found`)
    }

    const existing = await loadLease(tx, input)
    if (agent.workspaceType !== 'scm') {
      if (existing) {
        throw new ScmWorkloadLeaseConflictError(
          `SCM workload "${existing.id}" remains reserved after the Agent binding changed`,
        )
      }
      return writeWorkloadState(tx, {
        workspaceType: 'temp',
        scmSourceId: null,
        leaseId: null,
        alreadyReserved: false,
      })
    }

    if (!agent.scmSourceId) {
      throw new ScmWorkloadAdmissionError(
        `Agent "${input.agentId}" has an SCM workspace without a source binding`,
      )
    }

    const leaseId = scmWorkloadLeaseId(input)
    if (existing) {
      assertMatchingReservation(existing, input, agent.scmSourceId)
    } else {
      await tx
        .insert(scmWorkloadLeases)
        .values({
          id: leaseId,
          workloadType: input.type,
          workloadId: input.workloadId,
          agentId: input.agentId,
          scmSourceId: agent.scmSourceId,
          phase: 'reserved',
        })
        .returning({ id: scmWorkloadLeases.id })
    }

    return writeWorkloadState(tx, {
      workspaceType: 'scm',
      scmSourceId: agent.scmSourceId,
      leaseId,
      alreadyReserved: Boolean(existing),
    })
  })
}

export interface OwnedScmWorkload extends ScmWorkloadIdentity {
  ownerInstanceId: string
}

export async function releaseReservedScmWorkloadInMutation(
  tx: TransactionHandle,
  input: ScmWorkloadIdentity,
): Promise<boolean> {
  const deleted = await tx
    .delete(scmWorkloadLeases)
    .where(
      and(
        eq(scmWorkloadLeases.id, scmWorkloadLeaseId(input)),
        eq(scmWorkloadLeases.phase, 'reserved'),
      ),
    )
    .returning({ id: scmWorkloadLeases.id })
  return deleted.length > 0
}

/**
 * Drop a workload that never started. The phase predicate is the safety
 * boundary: if another worker activated the reservation first, its checkout
 * remains protected until that worker explicitly releases it after exit.
 */
export async function releaseReservedScmWorkload(
  input: ScmWorkloadIdentity,
  deps: ScmWorkloadLifecycleDeps = defaultDeps,
): Promise<boolean> {
  return deps.withMutation((tx) => releaseReservedScmWorkloadInMutation(tx, input))
}

/**
 * Release a lease after single-process startup recovery has proved its previous
 * execution owner is dead. PostgreSQL recovery must never call this: a peer may
 * still own the checkout even when the current replica cannot observe it.
 */
export async function releaseRecoveredScmWorkload(
  input: ScmWorkloadIdentity,
  deps: ScmWorkloadLifecycleDeps = defaultDeps,
): Promise<boolean> {
  return deps.withMutation(async (tx) => {
    const deleted = await tx
      .delete(scmWorkloadLeases)
      .where(eq(scmWorkloadLeases.id, scmWorkloadLeaseId(input)))
      .returning({ id: scmWorkloadLeases.id })
    return deleted.length > 0
  })
}

/** Claim a reserved workload immediately before its local process starts. */
export async function activateScmWorkload(
  input: OwnedScmWorkload,
  deps: ScmWorkloadLifecycleDeps = defaultDeps,
): Promise<void> {
  await deps.withMutation(async (tx) => {
    const lease = await loadLease(tx, input)
    if (!lease) {
      throw new ScmWorkloadLeaseConflictError(
        `SCM workload "${scmWorkloadLeaseId(input)}" has no durable reservation`,
      )
    }
    if (lease.phase === 'active') {
      if (lease.ownerInstanceId !== input.ownerInstanceId) {
        throw new ScmWorkloadLeaseConflictError(
          `SCM workload "${lease.id}" is active on another process instance`,
        )
      }
      return
    }
    await tx
      .update(scmWorkloadLeases)
      .set({ phase: 'active', ownerInstanceId: input.ownerInstanceId, updatedAt: new Date() })
      .where(eq(scmWorkloadLeases.id, lease.id))
      .returning({ id: scmWorkloadLeases.id })
  })
}

/**
 * Release only after process exit and workspace cleanup. Merely marking the
 * Run/Evaluation cancelled is intentionally insufficient.
 */
export async function releaseScmWorkload(
  input: OwnedScmWorkload,
  deps: ScmWorkloadLifecycleDeps = defaultDeps,
): Promise<boolean> {
  return deps.withMutation(async (tx) => {
    const lease = await loadLease(tx, input)
    if (!lease) return false
    if (lease.phase === 'active' && lease.ownerInstanceId !== input.ownerInstanceId) {
      throw new ScmWorkloadLeaseConflictError(
        `SCM workload "${lease.id}" is owned by another process instance`,
      )
    }
    const deleted = await tx
      .delete(scmWorkloadLeases)
      .where(eq(scmWorkloadLeases.id, lease.id))
      .returning({ id: scmWorkloadLeases.id })
    return deleted.length > 0
  })
}

/** Durable authority used by Agent binding changes and source deletion. */
export async function findDurableAgentScmWorkload(
  executor: Pick<typeof db, 'select'>,
  agentId: string,
): Promise<{ type: ScmWorkloadType; id: string } | null> {
  const lease = (
    await executor
      .select({ type: scmWorkloadLeases.workloadType, id: scmWorkloadLeases.workloadId })
      .from(scmWorkloadLeases)
      .where(eq(scmWorkloadLeases.agentId, agentId))
      .limit(1)
  )[0]
  return lease ?? null
}
