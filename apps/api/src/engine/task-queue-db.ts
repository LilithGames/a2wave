import { and, asc, count, eq, isNotNull, lt, notExists } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, runSteps, runs, scmWorkloadLeases } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { processInstanceId } from '../lib/process-instance.js'
import type { FailureReason } from '../lib/run-failure-reasons.js'
import {
  activateScmWorkload,
  releaseReservedScmWorkload,
  withScmWorkloadAdmission,
} from '../lib/scm-workload-lifecycle.js'
import type { RunRow, TaskQueueDb } from './task-queue.js'
import { MAX_QUEUE_LENGTH } from './task-queue.js'

const VALID_RUN_STATUSES = [
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
type RunStatus = (typeof VALID_RUN_STATUSES)[number]

class RunQueueFullError extends Error {}

function parseRunStatus(s: string): RunStatus | null {
  if (VALID_RUN_STATUSES.includes(s as RunStatus)) return s as RunStatus
  return null
}

export const taskQueueDb: TaskQueueDb = {
  async countRunsByStatus(agentId: string, status: string): Promise<number> {
    const runStatus = parseRunStatus(status)
    if (runStatus === null) return 0
    const [row] = await db
      .select({ count: count() })
      .from(runs)
      .where(and(eq(runs.initiatorAgentId, agentId), eq(runs.status, runStatus)))
      .limit(1)
    return row?.count ?? 0
  },

  async getRunStatus(runId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
    return row?.status
  },

  async getAgentMaxConcurrency(agentId: string): Promise<number | undefined> {
    const [agent] = await db
      .select({ maxConcurrency: agents.maxConcurrency })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
    return agent?.maxConcurrency
  },

  async updateRunStatus(runId: string, status: string): Promise<void> {
    const runStatus = parseRunStatus(status)
    if (runStatus === null) return
    await db
      .update(runs)
      .set({ status: runStatus, updatedAt: new Date() })
      .where(eq(runs.id, runId))
  },

  async admitRun(agentId: string, runId: string, maxConcurrency: number) {
    try {
      return await withScmWorkloadAdmission(
        { type: 'run', workloadId: runId, agentId },
        async (tx, admission) => {
          const executor = tx as TransactionHandle
          const running =
            (
              await executor
                .select({ value: count() })
                .from(runs)
                .where(and(eq(runs.initiatorAgentId, agentId), eq(runs.status, 'running')))
                .limit(1)
            )[0]?.value ?? 0
          let slot: 'acquired' | 'queued' = 'acquired'
          if (running >= maxConcurrency) {
            const queued =
              (
                await executor
                  .select({ value: count() })
                  .from(runs)
                  .where(and(eq(runs.initiatorAgentId, agentId), eq(runs.status, 'queued')))
                  .limit(1)
              )[0]?.value ?? 0
            if (queued >= MAX_QUEUE_LENGTH) throw new RunQueueFullError()
            slot = 'queued'
          }
          const updated = await executor
            .update(runs)
            .set({ status: slot === 'acquired' ? 'running' : 'queued', updatedAt: new Date() })
            .where(eq(runs.id, runId))
            .returning({ id: runs.id })
          if (updated.length === 0) {
            throw new Error(`Run "${runId}" disappeared before queue admission`)
          }
          return { slot, hasScmLease: admission.leaseId !== null }
        },
      )
    } catch (error) {
      if (error instanceof RunQueueFullError) {
        return { slot: 'queue_full' as const, hasScmLease: false }
      }
      throw error
    }
  },

  async activateRun(runId: string): Promise<void> {
    const reserved = (
      await db
        .select({ id: scmWorkloadLeases.id })
        .from(scmWorkloadLeases)
        .where(eq(scmWorkloadLeases.id, `run:${runId}`))
        .limit(1)
    )[0]
    if (!reserved) return
    await activateScmWorkload({
      type: 'run',
      workloadId: runId,
      ownerInstanceId: processInstanceId,
    })
  },

  async releaseReservedRun(runId: string): Promise<boolean> {
    return releaseReservedScmWorkload({ type: 'run', workloadId: runId })
  },

  async tryTransitionRunStatus(runId: string, from: string, to: string): Promise<boolean> {
    const fromStatus = parseRunStatus(from)
    const toStatus = parseRunStatus(to)
    if (fromStatus === null || toStatus === null) return false
    // `.returning()` rather than a driver row count: better-sqlite3 reports
    // `changes` and node-postgres `rowCount`, so the returned rows are the one
    // form that means the same thing on both backends.
    const changed = await db
      .update(runs)
      .set({ status: toStatus, updatedAt: new Date() })
      .where(and(eq(runs.id, runId), eq(runs.status, fromStatus)))
      .returning({ id: runs.id })
    return changed.length > 0
  },

  async failRunSteps(runId: string): Promise<void> {
    await db
      .update(runSteps)
      .set({ status: 'failed' })
      .where(and(eq(runSteps.runId, runId), eq(runSteps.status, 'running')))
  },

  async failRunWithError(runId: string, reason: string): Promise<void> {
    await db
      .update(runSteps)
      .set({ status: 'failed', output: { error: reason } })
      .where(and(eq(runSteps.runId, runId), eq(runSteps.status, 'running')))
    await db
      .update(runs)
      .set({ result: { error: reason }, updatedAt: new Date() })
      .where(eq(runs.id, runId))
  },

  async failRunWithStructuredReason(runId: string, reason: FailureReason): Promise<void> {
    const error = reason
    await db
      .update(runSteps)
      .set({ status: 'failed', output: { error } })
      .where(and(eq(runSteps.runId, runId), eq(runSteps.status, 'running')))
    await db
      .update(runs)
      .set({ result: { error }, updatedAt: new Date() })
      .where(eq(runs.id, runId))
  },

  async getOldestQueuedRun(
    agentId: string,
  ): Promise<{ id: string; initiatorAgentId: string } | undefined> {
    const [run] = await db
      .select({ id: runs.id, initiatorAgentId: runs.initiatorAgentId })
      .from(runs)
      .where(and(eq(runs.initiatorAgentId, agentId), eq(runs.status, 'queued')))
      .orderBy(asc(runs.createdAt))
      .limit(1)
    if (!run?.initiatorAgentId) return undefined
    return { id: run.id, initiatorAgentId: run.initiatorAgentId }
  },

  async getRunsByStatus(agentId: string, status: string): Promise<RunRow[]> {
    const runStatus = parseRunStatus(status)
    if (runStatus === null) return []
    const rows = await db
      .select({
        id: runs.id,
        triggerSource: runs.triggerSource,
        triggerSessionId: runs.triggerSessionId,
      })
      .from(runs)
      .where(and(eq(runs.initiatorAgentId, agentId), eq(runs.status, runStatus)))
    return rows.map((r) => ({
      id: r.id,
      triggerSource: r.triggerSource ?? null,
      triggerSessionId: r.triggerSessionId ?? null,
    }))
  },

  async getOrphanedPendingRuns(agentId: string, cutoffMs: number): Promise<RunRow[]> {
    const cutoff = new Date(cutoffMs)
    const rows = await db
      .select({
        id: runs.id,
        triggerSource: runs.triggerSource,
        triggerSessionId: runs.triggerSessionId,
      })
      .from(runs)
      .where(
        and(
          eq(runs.initiatorAgentId, agentId),
          eq(runs.status, 'pending'),
          lt(runs.createdAt, cutoff),
        ),
      )
    return rows.map((r) => ({
      id: r.id,
      triggerSource: r.triggerSource ?? null,
      triggerSessionId: r.triggerSessionId ?? null,
    }))
  },

  async getDanglingPendingRuns(cutoffMs: number): Promise<RunRow[]> {
    const cutoff = new Date(cutoffMs)
    // Sweep only rows pointing to a deleted agent. We need BOTH conditions:
    //   - isNotNull: SQLite `agents.id = NULL` is unknown → NOT EXISTS would be true
    //     for NULL-agent rows otherwise, sweeping legitimate "pending unassigned"
    //     runs created via POST /runs (executed later via POST /runs/:id/execute).
    //   - notExists: live DB lookup so agents created during recovery aren't missed.
    const agentDeleted = and(
      isNotNull(runs.initiatorAgentId),
      notExists(
        db.select({ id: agents.id }).from(agents).where(eq(agents.id, runs.initiatorAgentId)),
      ),
    )
    const rows = await db
      .select({
        id: runs.id,
        triggerSource: runs.triggerSource,
        triggerSessionId: runs.triggerSessionId,
      })
      .from(runs)
      .where(and(eq(runs.status, 'pending'), lt(runs.createdAt, cutoff), agentDeleted))
    return rows.map((r) => ({
      id: r.id,
      triggerSource: r.triggerSource ?? null,
      triggerSessionId: r.triggerSessionId ?? null,
    }))
  },

  async getDanglingQueuedRuns(): Promise<RunRow[]> {
    // Same isNotNull + NOT EXISTS pair as getDanglingPendingRuns. NULL-agent queued
    // isn't reachable via tryAcquireSlot (which requires agentId), but if present
    // (manual DB edit) leave it alone.
    const agentDeleted = and(
      isNotNull(runs.initiatorAgentId),
      notExists(
        db.select({ id: agents.id }).from(agents).where(eq(agents.id, runs.initiatorAgentId)),
      ),
    )
    const rows = await db
      .select({
        id: runs.id,
        triggerSource: runs.triggerSource,
        triggerSessionId: runs.triggerSessionId,
      })
      .from(runs)
      .where(and(eq(runs.status, 'queued'), agentDeleted))
    return rows.map((r) => ({
      id: r.id,
      triggerSource: r.triggerSource ?? null,
      triggerSessionId: r.triggerSessionId ?? null,
    }))
  },
}
