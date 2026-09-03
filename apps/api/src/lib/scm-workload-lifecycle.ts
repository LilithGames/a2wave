import { and, eq, inArray } from 'drizzle-orm'
import type { db } from '../db/client.js'
import { agents, runs, scmWorkloadLeases } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { hasLostHeartbeatOwnership } from './instance-heartbeat.js'
import { logger } from './logger.js'
import { retryUntilSuccess } from './retry-until-success.js'
import { withScmPathMutation } from './scm-path-plan.js'
import { filesystemPathsOverlap } from './scm-workspace-safety.js'

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
  /**
   * True when this instance can no longer renew its liveness heartbeat.
   * Optional because only admission consults it: releasing a lease while
   * fenced is not merely allowed but desirable — it hands capacity back.
   */
  hasLostOwnership?: () => boolean
}

const defaultDeps: ScmWorkloadLifecycleDeps = {
  withMutation: withScmPathMutation,
  hasLostOwnership: () => hasLostHeartbeatOwnership(),
}

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

function assertHeartbeatOwnership(hasLostOwnership: () => boolean): void {
  if (!hasLostOwnership()) return
  throw new ScmWorkloadAdmissionError(
    'This instance lost its liveness heartbeat lease and cannot own SCM workloads',
  )
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
  // Self-fenced: renewals have been failing long enough that peers are
  // entitled to reclaim this instance's checkouts. Taking on new SCM work now
  // would put two processes in the same worktree, so refuse at the door — the
  // caller surfaces this as a normal admission failure and the work retries
  // wherever liveness is intact.
  assertHeartbeatOwnership(deps.hasLostOwnership ?? hasLostHeartbeatOwnership)
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

/** Activate an existing reservation inside a caller-owned SCM mutation transaction. */
export async function activateScmWorkloadInMutation(
  tx: TransactionHandle,
  input: OwnedScmWorkload,
  hasLostOwnership: () => boolean = hasLostHeartbeatOwnership,
): Promise<boolean> {
  assertHeartbeatOwnership(hasLostOwnership)
  const lease = await loadLease(tx, input)
  if (!lease) return false
  if (lease.phase === 'active') {
    if (lease.ownerInstanceId !== input.ownerInstanceId) {
      throw new ScmWorkloadLeaseConflictError(
        `SCM workload "${lease.id}" is active on another process instance`,
      )
    }
    return true
  }
  await tx
    .update(scmWorkloadLeases)
    .set({ phase: 'active', ownerInstanceId: input.ownerInstanceId, updatedAt: new Date() })
    .where(eq(scmWorkloadLeases.id, lease.id))
    .returning({ id: scmWorkloadLeases.id })
  return true
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
    if (
      !(await activateScmWorkloadInMutation(
        tx,
        input,
        deps.hasLostOwnership ?? hasLostHeartbeatOwnership,
      ))
    ) {
      throw new ScmWorkloadLeaseConflictError(
        `SCM workload "${scmWorkloadLeaseId(input)}" has no durable reservation`,
      )
    }
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

const DEFAULT_RELEASE_RETRY_DELAY_MS = 1_000
const DEFAULT_MAX_RELEASE_RETRY_DELAY_MS = 30_000

export interface ScmWorkloadReleaseRetryDeps {
  release?: () => Promise<boolean>
  delay?: (delayMs: number) => Promise<void>
  retryDelayMs?: number
  maxRetryDelayMs?: number
}

/** Keep a failed owner release observable until it succeeds or shutdown times out. */
export async function retryScmWorkloadReleaseUntilSuccess(
  input: OwnedScmWorkload,
  deps: ScmWorkloadReleaseRetryDeps = {},
): Promise<void> {
  const release = deps.release ?? (() => releaseScmWorkload(input))
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RELEASE_RETRY_DELAY_MS
  const maxRetryDelayMs = Math.max(
    retryDelayMs,
    deps.maxRetryDelayMs ?? DEFAULT_MAX_RELEASE_RETRY_DELAY_MS,
  )
  const delay =
    deps.delay ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))

  await retryUntilSuccess(release, {
    initialDelayMs: retryDelayMs,
    maxDelayMs: maxRetryDelayMs,
    wait: delay,
    onFailure: (error, nextRetryDelayMs) => {
      logger.error(
        {
          error,
          workloadType: input.type,
          workloadId: input.workloadId,
          retryDelayMs: nextRetryDelayMs,
        },
        'Failed to release durable SCM workload lease; retrying',
      )
    },
  })
}

/**
 * Durable authority keyed by the source a lease pins.
 *
 * The agent-keyed lookup below protects Agent binding mutation, but a lease
 * names both sides of the relation — and source-side mutations (path PATCH,
 * source deletion, workspace removal) previously consulted only row state, so
 * they could move or vacate a checkout an admitted workload still had as cwd.
 * Any mutation of a source's paths must treat this as authoritative.
 */
export async function findDurableScmSourceWorkload(
  executor: Pick<typeof db, 'select'>,
  scmSourceId: string,
): Promise<{ type: ScmWorkloadType; id: string; agentId: string } | null> {
  const lease = (
    await executor
      .select({
        type: scmWorkloadLeases.workloadType,
        id: scmWorkloadLeases.workloadId,
        agentId: scmWorkloadLeases.agentId,
      })
      .from(scmWorkloadLeases)
      .where(eq(scmWorkloadLeases.scmSourceId, scmSourceId))
      .limit(1)
  )[0]
  return lease ?? null
}

/**
 * Work executing in a source's **shared checkout** (`localPath`) right now.
 *
 * Sync rewrites that directory — `p4 sync`, or `git checkout -f -B` — so running
 * one while a CLI has it as cwd destroys the agent's uncommitted edits. The
 * in-process `busyCheckouts` set does not see this: a run is not a sync, and it
 * may well be owned by another replica.
 *
 * Which workloads actually sit in the shared checkout is read off
 * `runs.workDir`, the same occupancy marker the workspace-delete route trusts.
 * Only a per-Agent or explicit **worktree** records it (see `resolveWorkDir`),
 * so a null value is exactly the shared-checkout case: a P4 Agent, or a git
 * Agent whose worktree creation degraded to `localPath`.
 *
 * An Evaluation records no workspace at all, so `sourceType` decides it:
 *
 * - **git** — the task owns an `eval-<taskId>` worktree.
 *   `prepareEvaluationWorkspace` resolves it through the *explicit* worktree
 *   path of `resolveWorkDir`, which throws rather than degrading to
 *   `localPath`, so a running git Evaluation is provably not in the shared
 *   checkout. Counting it there deferred every auto-sync tick for the whole
 *   replay — which can be many minutes — for no safety gain.
 * - **p4** — there is no isolation mechanism at all (a client spec binds one
 *   server-side `Root`), so the task is in the shared checkout by construction.
 *
 * Phase filtering happens in SQL. Reserved work is queued and owns no
 * directory, and an unfiltered scan had to be capped to keep a long tail of
 * rows from being walked — which is exactly how an active lease past the cap
 * went unseen and let a sync run under a live Agent CLI. Active leases are
 * bounded by total queue concurrency, so the filtered query needs no cap, and
 * their run rows are fetched in one batched select rather than one per lease.
 */
export async function findSharedCheckoutScmWorkload(
  executor: Pick<typeof db, 'select'>,
  scmSourceId: string,
  sharedLocalPath: string,
  sourceType: 'git' | 'p4',
): Promise<{ type: ScmWorkloadType; id: string } | null> {
  const leases = await executor
    .select({
      type: scmWorkloadLeases.workloadType,
      id: scmWorkloadLeases.workloadId,
    })
    .from(scmWorkloadLeases)
    .where(
      and(eq(scmWorkloadLeases.scmSourceId, scmSourceId), eq(scmWorkloadLeases.phase, 'active')),
    )

  const runLeaseIds: string[] = []
  for (const lease of leases) {
    if (lease.type !== 'run') {
      if (sourceType !== 'git') return { type: lease.type, id: lease.id }
      continue
    }
    runLeaseIds.push(lease.id)
  }
  if (runLeaseIds.length === 0) return null

  const runRows = await executor
    .select({ id: runs.id, workDir: runs.workDir })
    .from(runs)
    .where(inArray(runs.id, runLeaseIds))
  const workDirByRunId = new Map(runRows.map((row) => [row.id, row.workDir]))

  for (const id of runLeaseIds) {
    // A missing row is treated the same as a null workDir: the lease says the
    // workload was admitted, and nothing here proves it picked a worktree.
    const workDir = workDirByRunId.get(id) ?? null
    if (!workDir || filesystemPathsOverlap(workDir, sharedLocalPath)) {
      return { type: 'run', id }
    }
  }
  return null
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
