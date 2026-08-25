/**
 * Automatic job-level retry.
 *
 * Fires after a run reaches a terminal state and, when the Agent opted in,
 * replays it exactly as the manual "rerun" button would: a brand-new `runs` row
 * carrying the original intent, trigger provenance and attachments, admitted
 * through the normal queue. The failed run keeps its `failed` status, so each
 * attempt stays a separate, auditable record in the run list.
 *
 * Narrower than the button on two points, because this fires unattended — see
 * `shouldRetryJob` for why `cancelled` and permanent errors are excluded.
 *
 * Never throws: it runs inside run finalization, and a retry that cannot be
 * scheduled must not corrupt the outcome of the run that just finished.
 */
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, runs } from '../db/schema.js'
import { tryAcquireSlot } from '../engine/task-queue.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { logBackgroundAudit } from './audit.js'
import { executeChatRun } from './execute-chat-run.js'
import { createId } from './id.js'
import { nextJobRetryAttempt, shouldRetryJob } from './job-retry-policy.js'
import { logger } from './logger.js'
import { registerPendingContext } from './pending-job-registry.js'
import { filterReplayableAttachments, loadRerunSource } from './rerun-builder.js'

export interface MaybeScheduleJobRetryParams {
  /** The run that just reached a terminal state. */
  run: typeof runs.$inferSelect
  /** Its terminal status. */
  status: string
  /** Engine error, when one was recorded. */
  error: string | undefined
  /** The Agent's configured budget (already clamped by buildAgentConfig). */
  maxJobRetries: number
}

export interface JobRetryOutcome {
  scheduled: boolean
}

const NOT_SCHEDULED: JobRetryOutcome = { scheduled: false }

export async function maybeScheduleJobRetry(
  params: MaybeScheduleJobRetryParams,
): Promise<JobRetryOutcome> {
  const { run, status, error, maxJobRetries } = params

  // The chain counter lives on the run being retried and is carried forward by
  // every replay; reading it per-run is what terminates the chain.
  const attempt = run.executionMetadata?.jobRetryAttempt ?? 0
  const decision = shouldRetryJob({ status, error, maxJobRetries, attempt })
  if (!decision.retry) {
    if (decision.reason && decision.reason !== 'disabled' && decision.reason !== 'not_failed') {
      logger.info(
        { runId: run.id, reason: decision.reason, attempt, maxJobRetries },
        'Job auto-retry skipped',
      )
    }
    return NOT_SCHEDULED
  }

  try {
    return await scheduleJobRetry(run, attempt)
  } catch (err) {
    // Swallowed by contract: this runs inside run finalization. Logged rather
    // than rethrown so a broken retry path is still diagnosable.
    logger.error(
      { runId: run.id, err: err instanceof Error ? err.message : String(err) },
      'Job auto-retry failed to schedule',
    )
    return NOT_SCHEDULED
  }
}

async function scheduleJobRetry(
  originalRun: typeof runs.$inferSelect,
  attempt: number,
): Promise<JobRetryOutcome> {
  const source = await loadRerunSource(originalRun)
  const agentId = source.agentId
  if (!agentId) {
    logger.warn({ runId: originalRun.id }, 'Job auto-retry skipped: no agent to execute against')
    return NOT_SCHEDULED
  }

  // Re-read the Agent rather than trusting the finished run's snapshot: an owner
  // who disabled or deleted the Agent between the failure and this retry has
  // withdrawn consent for exactly this replay.
  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
  if (!agent) {
    logger.warn(
      { runId: originalRun.id, agentId },
      'Job auto-retry skipped: agent no longer exists',
    )
    return NOT_SCHEDULED
  }
  if (agent.status !== 'active') {
    logger.info(
      { runId: originalRun.id, agentId, agentStatus: agent.status },
      'Job auto-retry skipped: agent is not active',
    )
    return NOT_SCHEDULED
  }

  const { resolveRerunConsumerId } = await import('../routes/runs.js')
  const attachments = filterReplayableAttachments(source.rawAttachments, originalRun.id)
  const consumerId = resolveRerunConsumerId(originalRun, agentId, source.originalContext)
  // A token ref consumed under the wrong identity fails authorization silently;
  // dropping it keeps the replay honest (matching the manual rerun path).
  const usableAttachments =
    attachments.some((a) => a.token) && !consumerId
      ? attachments.filter((a) => !a.token)
      : attachments

  const nextAttempt = nextJobRetryAttempt(attempt)
  // Point every link at the ORIGINAL run, so the whole chain is queryable by one id.
  const chainOrigin = originalRun.executionMetadata?.jobRetryOf ?? originalRun.id

  const newRunId = createId('run')
  await db
    .insert(runs)
    .values({
      id: newRunId,
      intent: originalRun.intent,
      initiatorAgentId: agentId,
      // Carry provenance forward so the replay answers into the original channel
      // and still counts toward askerCount / topAskers.
      triggerSource: originalRun.triggerSource,
      triggerUserName: originalRun.triggerUserName,
      triggerAgentName: originalRun.triggerAgentName,
      userId: originalRun.userId,
      executionMetadata: {
        ...(originalRun.executionMetadata?.runtimeAdminRequesterUserId
          ? {
              runtimeAdminRequesterUserId:
                originalRun.executionMetadata.runtimeAdminRequesterUserId,
            }
          : {}),
        ...(usableAttachments.length > 0
          ? {
              attachments: usableAttachments as never,
              ...(consumerId ? { attachmentConsumerId: consumerId } : {}),
            }
          : {}),
        jobRetryOf: chainOrigin,
        jobRetryAttempt: nextAttempt,
      },
    })
    .returning()

  const slotResult = await tryAcquireSlot(taskQueueDb, agentId, newRunId, agent.maxConcurrency ?? 1)
  if (slotResult === 'queue_full') {
    // Same rollback ordering the manual rerun uses: drop the row before auditing,
    // so no entry claims a retry that never happened.
    await db.delete(runs).where(eq(runs.id, newRunId))
    logger.warn(
      { runId: originalRun.id, agentId, attempt: nextAttempt },
      'Job auto-retry skipped: queue is full',
    )
    return NOT_SCHEDULED
  }

  // Iron Rule 5: background work that writes no Run of its own still needs a
  // trail. Identity comes from the row that scheduled the work, not a session.
  void logBackgroundAudit({
    userId: originalRun.userId ?? undefined,
    action: 'run.auto_retry',
    resource: 'run',
    resourceId: newRunId,
    details: {
      originalRunId: originalRun.id,
      chainOriginRunId: chainOrigin,
      attempt: nextAttempt,
    },
  })

  logger.info(
    { originalRunId: originalRun.id, newRunId, agentId, attempt: nextAttempt, slotResult },
    'Job auto-retry scheduled',
  )

  if (slotResult === 'queued') {
    if (source.originalContext) registerPendingContext(newRunId, source.originalContext)
    return { scheduled: true }
  }

  void executeChatRun(agentId, newRunId, source.originalContext)
  return { scheduled: true }
}
