import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
/**
 * Evaluation routes — evaluation sets and their cases, scoped to one Agent.
 *
 * Visibility follows the Agent itself: requireAgentRead for reads,
 * requireAgentWrite (owner|editor) for mutations. Every set/case lookup is
 * additionally constrained by agentId so a set id from another Agent cannot be
 * reached by guessing the path.
 */
import {
  REVIEWABLE_RESULT_STATUSES,
  type RunChannelContext,
  createEvaluationCaseInput,
  createEvaluationSetInput,
  createEvaluationTaskInput,
  reviewEvaluationResultInput,
  updateEvaluationCaseInput,
  updateEvaluationSetInput,
} from '@a2wave/shared'
import { and, asc, count, desc, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import {
  agents as agentsTable,
  evaluationCases,
  evaluationResults,
  evaluationSets,
  evaluationTasks,
  scmSources,
  scmWorkloadLeases,
  users,
} from '../db/schema.js'
import { runExclusive } from '../db/transaction.js'
import { evaluationQueueDb } from '../engine/evaluation-queue-db.js'
import { EVALUATION_MAX_QUEUE_LENGTH, scheduleNextEvaluation } from '../engine/evaluation-queue.js'
import { requireAgentRead, requireAgentWrite } from '../lib/agent-access.js'
import { buildAgentConfig, resolveWorkDir } from '../lib/agent-helpers.js'
import { logAudit, logBackgroundAudit } from '../lib/audit.js'
import { NotFoundError } from '../lib/errors.js'
import { replayCase, summarizeResults } from '../lib/evaluation-runner.js'
import {
  applyEvaluationSnapshot,
  buildStoredEvaluationSnapshot,
} from '../lib/evaluation-snapshot.js'
import { createId } from '../lib/id.js'
import { hasLostHeartbeatOwnership } from '../lib/instance-heartbeat.js'
import { logger } from '../lib/logger.js'
import { getCurrentUserId } from '../lib/owner-filter.js'
import { processInstanceId } from '../lib/process-instance.js'
import { buildDebugChannel } from '../lib/run-channel.js'
import { withScmPathMutation } from '../lib/scm-path-plan.js'
import { createScmSource } from '../lib/scm-source.js'
import { registerScmEvaluationWorkload } from '../lib/scm-workload-guard.js'
import {
  activateScmWorkload,
  releaseReservedScmWorkloadInMutation,
  retryScmWorkloadReleaseUntilSuccess,
  withScmWorkloadAdmission,
} from '../lib/scm-workload-lifecycle.js'
import { withAgentScmWorkloadLock } from '../lib/scm-workload-lock.js'
import { removeOwnedSourceWorkspaceGuarded } from '../lib/scm-workspace-removal.js'
import { cleanupWorkspaceOrHandOff } from '../lib/workspace-cleanup-retry.js'

const app = new Hono()
const activeEvaluationExecutions = new Set<Promise<void>>()

class EvaluationQueueFullError extends Error {}
class EvaluationWorkspaceChangedError extends Error {}

/** Loads a set, enforcing that it really belongs to the agent in the path. */
async function loadSetOrThrow(agentId: string, setId: string) {
  const row = (
    await db
      .select()
      .from(evaluationSets)
      .where(and(eq(evaluationSets.id, setId), eq(evaluationSets.agentId, agentId)))
      .limit(1)
  )[0]
  if (!row) throw new NotFoundError('Evaluation set')
  return row
}

async function loadCaseOrThrow(setId: string, caseId: string) {
  const row = (
    await db
      .select()
      .from(evaluationCases)
      .where(and(eq(evaluationCases.id, caseId), eq(evaluationCases.setId, setId)))
      .limit(1)
  )[0]
  if (!row) throw new NotFoundError('Evaluation case')
  return row
}

// ------------------------------------------------------------
// Evaluation Sets
// ------------------------------------------------------------

/** GET /:agentId/evaluation-sets */
app.get('/:agentId/evaluation-sets', async (c) => {
  const { agentId } = c.req.param()
  await requireAgentRead(c, agentId)

  const data = await db
    .select()
    .from(evaluationSets)
    .where(eq(evaluationSets.agentId, agentId))
    .orderBy(asc(evaluationSets.createdAt))

  return c.json({ data })
})

/** POST /:agentId/evaluation-sets */
app.post('/:agentId/evaluation-sets', async (c) => {
  const { agentId } = c.req.param()
  await requireAgentWrite(c, agentId)

  const parsed = createEvaluationSetInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const id = createId('evs')
  const data = (
    await db
      .insert(evaluationSets)
      .values({
        id,
        agentId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        userId: getCurrentUserId(c),
      })
      .returning()
  )[0]

  logAudit(c, { action: 'evaluation_set.create', resource: 'evaluation_set', resourceId: id })
  return c.json({ data }, 201)
})

/** PATCH /:agentId/evaluation-sets/:setId */
app.patch('/:agentId/evaluation-sets/:setId', async (c) => {
  const { agentId, setId } = c.req.param()
  await requireAgentWrite(c, agentId)
  await loadSetOrThrow(agentId, setId)

  const parsed = updateEvaluationSetInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const data = (
    await db
      .update(evaluationSets)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(evaluationSets.id, setId))
      .returning()
  )[0]

  logAudit(c, { action: 'evaluation_set.update', resource: 'evaluation_set', resourceId: setId })
  return c.json({ data })
})

/** DELETE /:agentId/evaluation-sets/:setId — cases cascade. */
app.delete('/:agentId/evaluation-sets/:setId', async (c) => {
  const { agentId, setId } = c.req.param()
  await requireAgentWrite(c, agentId)
  await loadSetOrThrow(agentId, setId)

  const data = (await db.delete(evaluationSets).where(eq(evaluationSets.id, setId)).returning())[0]

  logAudit(c, { action: 'evaluation_set.delete', resource: 'evaluation_set', resourceId: setId })
  return c.json({ data })
})

// ------------------------------------------------------------
// Evaluation Cases
// ------------------------------------------------------------

/** GET /:agentId/evaluation-sets/:setId/cases */
app.get('/:agentId/evaluation-sets/:setId/cases', async (c) => {
  const { agentId, setId } = c.req.param()
  await requireAgentRead(c, agentId)
  await loadSetOrThrow(agentId, setId)

  const data = await db
    .select()
    .from(evaluationCases)
    .where(eq(evaluationCases.setId, setId))
    .orderBy(asc(evaluationCases.sortOrder), asc(evaluationCases.createdAt))

  return c.json({ data })
})

/** POST /:agentId/evaluation-sets/:setId/cases */
app.post('/:agentId/evaluation-sets/:setId/cases', async (c) => {
  const { agentId, setId } = c.req.param()
  await requireAgentWrite(c, agentId)
  await loadSetOrThrow(agentId, setId)

  const parsed = createEvaluationCaseInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const id = createId('evc')
  const data = (
    await db
      .insert(evaluationCases)
      .values({
        id,
        setId,
        name: parsed.data.name,
        turns: parsed.data.turns,
        sortOrder: parsed.data.sortOrder,
      })
      .returning()
  )[0]

  logAudit(c, { action: 'evaluation_case.create', resource: 'evaluation_case', resourceId: id })
  return c.json({ data }, 201)
})

/** PATCH /:agentId/evaluation-sets/:setId/cases/:caseId */
app.patch('/:agentId/evaluation-sets/:setId/cases/:caseId', async (c) => {
  const { agentId, setId, caseId } = c.req.param()
  await requireAgentWrite(c, agentId)
  await loadSetOrThrow(agentId, setId)
  await loadCaseOrThrow(setId, caseId)

  const parsed = updateEvaluationCaseInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const data = (
    await db
      .update(evaluationCases)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(evaluationCases.id, caseId))
      .returning()
  )[0]

  logAudit(c, { action: 'evaluation_case.update', resource: 'evaluation_case', resourceId: caseId })
  return c.json({ data })
})

/** DELETE /:agentId/evaluation-sets/:setId/cases/:caseId */
app.delete('/:agentId/evaluation-sets/:setId/cases/:caseId', async (c) => {
  const { agentId, setId, caseId } = c.req.param()
  await requireAgentWrite(c, agentId)
  await loadSetOrThrow(agentId, setId)
  await loadCaseOrThrow(setId, caseId)

  const data = (
    await db.delete(evaluationCases).where(eq(evaluationCases.id, caseId)).returning()
  )[0]

  logAudit(c, { action: 'evaluation_case.delete', resource: 'evaluation_case', resourceId: caseId })
  return c.json({ data })
})

// ------------------------------------------------------------
// Evaluation Tasks
// ------------------------------------------------------------

/**
 * Whether the running loop should stop, read fresh from the DB.
 *
 * Deliberately not an in-memory flag: a task can sit queued for minutes before
 * it ever runs, and the process can restart underneath it. Both cases lose an
 * in-memory mark, leaving the user's cancel silently ineffective.
 *
 * A vanished row counts as a stop too. DELETE on a running task removes it
 * without any other way to reach the loop, and a loop that kept going would
 * carry on invoking the Agent for a task nobody can see any more — on top of
 * the replacement the delete already promoted into its slot.
 */
async function shouldStopTask(taskId: string): Promise<boolean> {
  // Losing the liveness lease stops the loop too. A replay can span many cases
  // and thus many minutes, so an admission-time check alone would let a fenced
  // instance keep spawning CLIs against a worktree peers may already have
  // reclaimed. This is the per-iteration floor the fail-stop promise needs.
  if (hasLostHeartbeatOwnership()) return true
  const row = (
    await db
      .select({ cancelRequestedAt: evaluationTasks.cancelRequestedAt })
      .from(evaluationTasks)
      .where(eq(evaluationTasks.id, taskId))
      .limit(1)
  )[0]
  if (!row) return true
  return row.cancelRequestedAt != null
}

async function taskExists(taskId: string): Promise<boolean> {
  return (
    (
      await db
        .select({ id: evaluationTasks.id })
        .from(evaluationTasks)
        .where(eq(evaluationTasks.id, taskId))
        .limit(1)
    )[0] != null
  )
}

/** True only when the task still exists and the user asked to cancel it. */
async function isCancelRequested(taskId: string): Promise<boolean> {
  const row = (
    await db
      .select({ cancelRequestedAt: evaluationTasks.cancelRequestedAt })
      .from(evaluationTasks)
      .where(eq(evaluationTasks.id, taskId))
      .limit(1)
  )[0]
  return row?.cancelRequestedAt != null
}

async function loadTaskOrThrow(agentId: string, taskId: string) {
  const row = (
    await db
      .select()
      .from(evaluationTasks)
      .where(and(eq(evaluationTasks.id, taskId), eq(evaluationTasks.agentId, agentId)))
      .limit(1)
  )[0]
  if (!row) throw new NotFoundError('Evaluation task')
  return row
}

/**
 * Settles result rows the runner never got to.
 *
 * Every terminal path of a task must call this. A row left at `pending` has no
 * loop behind it any more, but the detail page cannot tell that apart from one
 * still waiting its turn, so it renders "waiting" forever under a task badge
 * that already says cancelled or failed.
 */
async function settleUnfinishedResults(
  taskId: string,
  status: 'cancelled' | 'failed',
  error?: string,
): Promise<void> {
  // runExclusive, not a bare write: this runs detached from any request, so a
  // write absorbed into a stranger's SQLite transaction and rolled back with it
  // would never be retried — the cases would spin forever in the UI.
  await runExclusive(async () => {
    await db
      .update(evaluationResults)
      .set({ status, error: error ?? null, updatedAt: new Date() })
      .where(
        and(
          eq(evaluationResults.taskId, taskId),
          inArray(evaluationResults.status, ['pending', 'running']),
        ),
      )
  })
}

/** Recomputes and persists the task summary from its current result rows. */
async function refreshTaskSummary(taskId: string): Promise<void> {
  const rows = await db
    .select({ review: evaluationResults.review, status: evaluationResults.status })
    .from(evaluationResults)
    .where(eq(evaluationResults.taskId, taskId))

  await runExclusive(async () => {
    await db
      .update(evaluationTasks)
      .set({ summary: summarizeResults(rows), updatedAt: new Date() })
      .where(eq(evaluationTasks.id, taskId))
  })
}

/**
 * Rebuilds the caller identity a run needs, from the task's stored userId.
 *
 * A gateway-enabled Agent signs a per-run JWT on behalf of its caller and fails
 * fast with GATEWAY_NO_USER_IDENTITY when no channel context is present. The
 * interactive chat path builds this from the live session; an evaluation runs
 * long after that session is gone, so it is reconstructed from the user the
 * task recorded at creation. `debug` is the same channel type the chat debug
 * path uses — an evaluation is that same "a2wave user drives the Agent" shape.
 */
async function buildEvaluationChannel(
  userId: string | null,
): Promise<RunChannelContext | undefined> {
  if (!userId) return undefined

  const user = (
    await db
      .select({ email: users.email, displayName: users.displayName, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0]
  if (!user) return undefined

  return buildDebugChannel({
    triggeredByUserId: userId,
    userEmail: user.email ?? undefined,
    userName: user.displayName ?? user.username,
  }).ctx
}

/** How a task's workspace has to be released once the replay is over. */
type EvaluationWorkspace =
  | { workDir: string; cleanup: 'none' }
  | { workDir: string; cleanup: 'remove-dir' }
  | { workDir: string; cleanup: 'remove-worktree'; sourceId: string; worktreeName: string }

/** Worktree name for a task; matches WORKTREE_NAME_REGEX via the `evt_` id. */
function evaluationWorktreeName(taskId: string): string {
  return `eval-${taskId}`
}

/**
 * Resolves the workspace a task executes in.
 *
 * A plain `resolveWorkDir(agent)` hands every task the Agent's one directory,
 * so anything else running there — another evaluation, an interactive chat run
 * — syncs conflicting .mcp.json and skills into the same cwd mid-replay. An
 * evaluation measured under those conditions is not measuring the Agent.
 *
 * The isolation available depends on the workspace kind:
 *
 * - **Local**: a per-task subdirectory.
 * - **Git SCM**: a per-task worktree. An SCM Agent needs real source rather
 *   than an empty scratch dir, and a worktree is the one mechanism that gives
 *   it that without sharing a tree others can mutate.
 * - **P4 SCM**: nothing. A P4 client spec is server-side state bound to one
 *   Root, so a second checkout means a new client and a full re-sync; changing
 *   cwd alone would not even redirect where `p4 sync` writes. These tasks run
 *   in the shared checkout and the UI warns before one is created.
 */
async function prepareEvaluationWorkspace(
  agent: typeof agentsTable.$inferSelect,
  taskId: string,
): Promise<EvaluationWorkspace> {
  if (agent.workspaceType === 'scm') {
    const source = agent.scmSourceId
      ? (await db.select().from(scmSources).where(eq(scmSources.id, agent.scmSourceId)).limit(1))[0]
      : undefined

    // Only git implements worktrees; createScmSource returns null for p4.
    if (source && (await createScmSource(source))) {
      const worktreeName = evaluationWorktreeName(taskId)
      return {
        // ephemeral: the worktree exists for this replay only, and the cleanup
        // in `finally` removes it — the TTL sweeper is just the backstop.
        workDir: await resolveWorkDir(agent, { name: worktreeName, cleanup: 'ephemeral' }),
        cleanup: 'remove-worktree',
        sourceId: source.id,
        worktreeName,
      }
    }

    return { workDir: await resolveWorkDir(agent), cleanup: 'none' }
  }

  const workDir = join(await resolveWorkDir(agent), 'evaluations', taskId)
  await mkdir(workDir, { recursive: true })
  return { workDir, cleanup: 'remove-dir' }
}

/**
 * Runs every case of a task sequentially.
 *
 * Fire-and-forget: the caller returns 201 immediately and the UI polls. All
 * errors are swallowed here — an unhandled rejection would leave the task stuck
 * in `running` forever with no way for the user to tell why. Whatever happens,
 * the slot is handed back to the queue in `finally`.
 */
async function executeTask(taskId: string, agentId: string): Promise<void> {
  // Set once the workspace is resolved, so the cleanup in `finally` releases
  // exactly what this task took and never a shared checkout.
  let workspace: EvaluationWorkspace | undefined

  // Accumulated during the loop so the audit entry in `finally` can report the
  // work actually performed, including on the paths that threw.
  const execution: EvaluationExecutionTally = {
    startedAt: Date.now(),
    casesRun: 0,
    turnsReplayed: 0,
  }
  const releaseWorkload = await withAgentScmWorkloadLock(agentId, async () =>
    registerScmEvaluationWorkload(taskId, agentId),
  )
  let hasDurableLease = false

  try {
    hasDurableLease = Boolean(
      (
        await db
          .select({ id: scmWorkloadLeases.id })
          .from(scmWorkloadLeases)
          .where(eq(scmWorkloadLeases.id, `evaluation:${taskId}`))
          .limit(1)
      )[0],
    )
    if (hasDurableLease) {
      await activateScmWorkload({
        type: 'evaluation',
        workloadId: taskId,
        ownerInstanceId: processInstanceId,
      })
    }
    const agent = (
      await db.select().from(agentsTable).where(eq(agentsTable.id, agentId)).limit(1)
    )[0]
    if (!agent) throw new Error(`Agent ${agentId} not found`)

    // Deleted between promotion and start — nothing left to run or report on.
    const task = (
      await db.select().from(evaluationTasks).where(eq(evaluationTasks.id, taskId)).limit(1)
    )[0]
    if (!task) return

    // A task cancelled while queued must not start: the queue promoted it to
    // `running`, but the user's intent predates that promotion.
    if (await isCancelRequested(taskId)) {
      // Terminal writes in this detached loop go through runExclusive: nothing
      // retries them, so joining a stranger's rolled-back SQLite transaction
      // would wedge the task in `running` permanently.
      await runExclusive(async () => {
        await db
          .update(evaluationTasks)
          .set({ status: 'cancelled', finishedAt: new Date(), updatedAt: new Date() })
          .where(eq(evaluationTasks.id, taskId))
      })
      await settleUnfinishedResults(taskId, 'cancelled')
      await refreshTaskSummary(taskId)
      return
    }

    const agentConfig = applyEvaluationSnapshot(
      await buildAgentConfig(agent, { runtimeAdminRequesterUserId: task.userId ?? undefined }),
      task.configSnapshot,
      agent,
    )
    const channel = await buildEvaluationChannel(task.userId)
    workspace = await prepareEvaluationWorkspace(agent, taskId)
    const workDir = workspace.workDir

    await runExclusive(async () => {
      await db
        .update(evaluationTasks)
        .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
        .where(eq(evaluationTasks.id, taskId))
    })

    const results = await db
      .select()
      .from(evaluationResults)
      .where(eq(evaluationResults.taskId, taskId))
      .orderBy(asc(evaluationResults.sortOrder))

    for (const row of results) {
      if (await shouldStopTask(taskId)) break

      await runExclusive(async () => {
        await db
          .update(evaluationResults)
          .set({ status: 'running', updatedAt: new Date() })
          .where(eq(evaluationResults.id, row.id))
      })

      const replay = await replayCase({
        taskId,
        caseId: row.id,
        turns: row.turnsSnapshot ?? [],
        agentConfig: await agentConfig,
        workDir,
        channel: channel,
        isCancelled: () => shouldStopTask(taskId),
      })

      execution.casesRun += 1
      execution.turnsReplayed += replay.actualTurns.length

      await runExclusive(async () => {
        await db
          .update(evaluationResults)
          .set({
            status: replay.status,
            actualTurns: replay.actualTurns,
            error: replay.error,
            durationMs: replay.durationMs,
            updatedAt: new Date(),
          })
          .where(eq(evaluationResults.id, row.id))
      })
    }

    // Deleted mid-run: the row and its results are already gone, and writing a
    // terminal status now would only be a no-op UPDATE on a missing row.
    if (!(await taskExists(taskId))) return

    const cancelled = await isCancelRequested(taskId)
    await runExclusive(async () => {
      await db
        .update(evaluationTasks)
        .set({
          status: cancelled ? 'cancelled' : 'completed',
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationTasks.id, taskId))
    })

    // The loop breaks on cancel with cases still untouched behind it.
    if (cancelled) await settleUnfinishedResults(taskId, 'cancelled')

    await refreshTaskSummary(taskId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err, taskId, agentId }, 'Evaluation task failed')
    await runExclusive(async () => {
      await db
        .update(evaluationTasks)
        .set({
          status: 'failed',
          error: message,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(evaluationTasks.id, taskId))
    })
    await settleUnfinishedResults(taskId, 'failed', message)
    await refreshTaskSummary(taskId)
  } finally {
    try {
      await auditEvaluationExecution(taskId, agentId, execution)
      await cleanupWorkspaceOrHandOff(() => discardEvaluationWorkspace(workspace, taskId), {
        context: { type: 'evaluation', taskId, agentId },
      })
    } finally {
      releaseWorkload()
      if (hasDurableLease) {
        await retryScmWorkloadReleaseUntilSuccess({
          type: 'evaluation',
          workloadId: taskId,
          ownerInstanceId: processInstanceId,
        })
      }
      await scheduleNextEvaluation(evaluationQueueDb, agentId, runEvaluationTask)
    }
  }
}

interface EvaluationExecutionTally {
  startedAt: number
  casesRun: number
  /**
   * Turns replayed, not worker processes started.
   *
   * `executeWithRetry` can start several workers for one turn (retries,
   * provider fallback), so this undercounts actual Agent invocations and must
   * not be presented as a billing figure.
   */
  turnsReplayed: number
}

/**
 * Records what a task's execution actually consumed.
 *
 * Evaluation runs make real, billable Agent calls but deliberately write no
 * `runs` row — that table is a live state machine driving concurrency and
 * recovery, and evaluation has its own queue precisely so the two cannot starve
 * each other. Without an entry here the only trace of a fifty-case task would
 * be the CRUD record of creating it, which is not enough to answer "who ran
 * this, on which configuration, and how much work did it do" (Iron Rule 5).
 *
 * The volume figures are `casesRun` and `turnsReplayed` — units of evaluation
 * work, not of billing. One turn can start several workers via retry or
 * provider fallback, so a true invocation count would have to come from the
 * worker layer.
 *
 * Written on every terminal path, failures included: an execution that replayed
 * two hundred turns before dying is exactly the one an auditor needs.
 */
async function auditEvaluationExecution(
  taskId: string,
  agentId: string,
  tally: EvaluationExecutionTally,
): Promise<void> {
  try {
    const task = (
      await db.select().from(evaluationTasks).where(eq(evaluationTasks.id, taskId)).limit(1)
    )[0]

    logBackgroundAudit({
      action: 'evaluation_task.execute',
      resource: 'evaluation_task',
      resourceId: taskId,
      // The task row is gone if it was deleted mid-run; the spend still happened
      // and still has to be accounted for.
      userId: task?.userId ?? undefined,
      details: {
        agentId,
        status: task?.status ?? 'deleted',
        casesRun: tally.casesRun,
        turnsReplayed: tally.turnsReplayed,
        durationMs: Date.now() - tally.startedAt,
        // The frozen config these calls actually ran on — never credentials.
        providerId: task?.configSnapshot?.providerId ?? null,
        providerName: task?.configSnapshot?.providerName ?? null,
        model: task?.configSnapshot?.model ?? null,
      },
    })
  } catch (err) {
    // Never let bookkeeping fail a task that already did its work.
    logger.warn({ err, taskId, agentId }, 'Failed to write evaluation execution audit')
  }
}

/**
 * Releases whatever workspace this task took, the way that kind has to be
 * released.
 *
 * Takes the resolved descriptor rather than re-deriving it: `resolveWorkDir`
 * reads the Agent row, so an Agent edited mid-run would resolve to a different
 * base and leave the real directory behind while deleting under one this task
 * never used. A shared checkout (`none`) is what every other run depends on and
 * must never be removed.
 */
async function discardEvaluationWorkspace(
  workspace: EvaluationWorkspace | undefined,
  taskId: string,
): Promise<void> {
  if (!workspace || workspace.cleanup === 'none') return

  if (workspace.cleanup === 'remove-worktree') {
    const source = (
      await db.select().from(scmSources).where(eq(scmSources.id, workspace.sourceId)).limit(1)
    )[0]
    // `rm -rf` would leave the parent repo holding a stale admin entry that
    // blocks the next checkout of that branch until `git worktree prune`.
    const scm = source ? await createScmSource(source) : null
    if (scm) {
      await removeOwnedSourceWorkspaceGuarded({
        sourceId: workspace.sourceId,
        name: workspace.worktreeName,
        scm,
        workload: {
          type: 'evaluation',
          workloadId: taskId,
          ownerInstanceId: processInstanceId,
        },
      })
    }
    return
  }

  await rm(workspace.workDir, { recursive: true, force: true })
}

/**
 * Re-entry point for the scheduler, also used by startup recovery to resume
 * tasks that were still queued when the process went down.
 */
export function runEvaluationTask(taskId: string, agentId: string): void {
  const execution = executeTask(taskId, agentId)
    .catch((error) => logger.error({ error, taskId, agentId }, 'Evaluation lifecycle failed'))
    .finally(() => activeEvaluationExecutions.delete(execution))
  activeEvaluationExecutions.add(execution)
}

/** Wait for process exit, audit, workspace cleanup, and durable lease release. */
export async function drainActiveEvaluationTasks(): Promise<void> {
  while (activeEvaluationExecutions.size > 0) {
    await Promise.all([...activeEvaluationExecutions])
  }
}

/** GET /:agentId/evaluation-tasks */
app.get('/:agentId/evaluation-tasks', async (c) => {
  const { agentId } = c.req.param()
  await requireAgentRead(c, agentId)

  const data = await db
    .select()
    .from(evaluationTasks)
    .where(eq(evaluationTasks.agentId, agentId))
    .orderBy(desc(evaluationTasks.createdAt))

  return c.json({ data })
})

/** POST /:agentId/evaluation-tasks — snapshots config, then runs in background. */
app.post('/:agentId/evaluation-tasks', async (c) => {
  const { agentId } = c.req.param()
  const { agent } = await requireAgentWrite(c, agentId)

  const parsed = createEvaluationTaskInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const set = await loadSetOrThrow(agentId, parsed.data.setId)
  const cases = await db
    .select()
    .from(evaluationCases)
    .where(eq(evaluationCases.setId, set.id))
    .orderBy(asc(evaluationCases.sortOrder), asc(evaluationCases.createdAt))

  if (cases.length === 0) {
    // An error *code*, not a sentence: the web client renders it through
    // i18n (apiError.<CODE>), so a hardcoded English string would surface
    // untranslated in a Chinese UI.
    return c.json({ error: 'EVALUATION_SET_EMPTY' }, 400)
  }

  const taskId = createId('evt')
  const configSnapshot = await buildStoredEvaluationSnapshot(agent)
  let task: typeof evaluationTasks.$inferSelect | null
  try {
    task = await withAgentScmWorkloadLock(agentId, () =>
      withScmWorkloadAdmission(
        { type: 'evaluation', workloadId: taskId, agentId },
        async (tx, admission) => {
          const snapshotWorkspaceType = agent.workspaceType ?? 'temp'
          const snapshotSourceId = snapshotWorkspaceType === 'scm' ? agent.scmSourceId : null
          if (
            admission.workspaceType !== snapshotWorkspaceType ||
            admission.scmSourceId !== snapshotSourceId
          ) {
            throw new EvaluationWorkspaceChangedError()
          }

          // The same cross-dialect mutation transaction serializes the count,
          // task state and SCM reservation across replicas. A process-local
          // queue lock cannot protect P4's shared checkout in PostgreSQL.
          const running =
            (
              await tx
                .select({ value: count() })
                .from(evaluationTasks)
                .where(
                  and(eq(evaluationTasks.agentId, agentId), eq(evaluationTasks.status, 'running')),
                )
                .limit(1)
            )[0]?.value ?? 0
          const status = running === 0 ? 'running' : 'queued'
          if (status === 'queued') {
            const queued =
              (
                await tx
                  .select({ value: count() })
                  .from(evaluationTasks)
                  .where(
                    and(eq(evaluationTasks.agentId, agentId), eq(evaluationTasks.status, 'queued')),
                  )
                  .limit(1)
              )[0]?.value ?? 0
            if (queued >= EVALUATION_MAX_QUEUE_LENGTH) throw new EvaluationQueueFullError()
          }

          const insertedTask = (
            await tx
              .insert(evaluationTasks)
              .values({
                id: taskId,
                agentId,
                setId: set.id,
                // Denormalized so the task stays readable after the set is deleted.
                setName: set.name,
                name: parsed.data.name ?? null,
                status,
                configSnapshot,
                userId: getCurrentUserId(c),
              })
              .returning()
          )[0]

          await tx.insert(evaluationResults).values(
            cases.map((evalCase, index) => ({
              id: createId('evr'),
              taskId,
              caseId: evalCase.id,
              caseName: evalCase.name,
              turnsSnapshot: evalCase.turns,
              status: 'pending' as const,
              sortOrder: index,
            })),
          )

          return insertedTask
        },
      ),
    )
  } catch (error) {
    if (error instanceof EvaluationQueueFullError) {
      return c.json({ error: 'EVALUATION_QUEUE_FULL' }, 429)
    }
    if (error instanceof EvaluationWorkspaceChangedError) {
      return c.json({ error: 'Agent workspace changed; retry the evaluation' }, 409)
    }
    throw error
  }

  // Audited only once the task is certain to survive: the queue-full path above
  // rolls the row back, and an audit entry for an id that was never persisted
  // leaves an auditor reconciling create events against phantom rows.
  logAudit(c, { action: 'evaluation_task.create', resource: 'evaluation_task', resourceId: taskId })

  if (task.status === 'running') runEvaluationTask(taskId, agentId)

  // Re-read so the client sees the scheduled status rather than the stale
  // `pending` captured at insert time.
  return c.json({ data: await loadTaskOrThrow(agentId, taskId) }, 201)
})

/** GET /:agentId/evaluation-tasks/:taskId — task plus its result rows. */
app.get('/:agentId/evaluation-tasks/:taskId', async (c) => {
  const { agentId, taskId } = c.req.param()
  await requireAgentRead(c, agentId)
  const task = await loadTaskOrThrow(agentId, taskId)

  const results = await db
    .select()
    .from(evaluationResults)
    .where(eq(evaluationResults.taskId, taskId))
    .orderBy(asc(evaluationResults.sortOrder))

  return c.json({ data: { ...task, results } })
})

/** PATCH /:agentId/evaluation-tasks/:taskId/results/:resultId — manual verdict. */
app.patch('/:agentId/evaluation-tasks/:taskId/results/:resultId', async (c) => {
  const { agentId, taskId, resultId } = c.req.param()
  await requireAgentWrite(c, agentId)
  await loadTaskOrThrow(agentId, taskId)

  const existing = (
    await db
      .select()
      .from(evaluationResults)
      .where(and(eq(evaluationResults.id, resultId), eq(evaluationResults.taskId, taskId)))
      .limit(1)
  )[0]
  if (!existing) throw new NotFoundError('Evaluation result')

  // There is nothing to judge until the case has produced an answer, and a
  // verdict recorded early would still count toward the pass rate afterwards.
  if (!REVIEWABLE_RESULT_STATUSES.includes(existing.status)) {
    return c.json({ error: 'EVALUATION_RESULT_NOT_REVIEWABLE' }, 409)
  }

  const parsed = reviewEvaluationResultInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  // Reviewer identity comes from the session, never from the request body.
  const data = (
    await db
      .update(evaluationResults)
      .set({
        review: {
          verdict: parsed.data.verdict,
          note: parsed.data.note ?? null,
          reviewedBy: getCurrentUserId(c) ?? '',
          reviewedAt: new Date().toISOString(),
        },
        updatedAt: new Date(),
      })
      .where(eq(evaluationResults.id, resultId))
      .returning()
  )[0]

  await refreshTaskSummary(taskId)

  logAudit(c, {
    action: 'evaluation_result.review',
    resource: 'evaluation_result',
    resourceId: resultId,
  })
  return c.json({ data })
})

/** POST /:agentId/evaluation-tasks/:taskId/cancel — takes effect between cases. */
app.post('/:agentId/evaluation-tasks/:taskId/cancel', async (c) => {
  const { agentId, taskId } = c.req.param()
  await requireAgentWrite(c, agentId)
  await loadTaskOrThrow(agentId, taskId)

  const now = new Date()
  const cancelledStatus = await withScmPathMutation(async (tx) => {
    const current = (
      await tx
        .select({ status: evaluationTasks.status })
        .from(evaluationTasks)
        .where(and(eq(evaluationTasks.id, taskId), eq(evaluationTasks.agentId, agentId)))
        .limit(1)
    )[0]
    if (!current || !['pending', 'queued', 'running'].includes(current.status)) return null

    const settlesImmediately = current.status === 'queued' || current.status === 'pending'
    await tx
      .update(evaluationTasks)
      .set({
        cancelRequestedAt: now,
        updatedAt: now,
        ...(settlesImmediately ? { status: 'cancelled' as const, finishedAt: now } : {}),
      })
      .where(eq(evaluationTasks.id, taskId))
    if (settlesImmediately) {
      await releaseReservedScmWorkloadInMutation(tx, {
        type: 'evaluation',
        workloadId: taskId,
      })
    }
    return current.status
  })

  if (!cancelledStatus) {
    return c.json({ error: 'EVALUATION_TASK_NOT_RUNNING' }, 409)
  }

  // A queued task has no loop running to notice the flag, so it is settled here
  // and its slot offered to whatever is behind it. A running one is left to its
  // own loop, which checks between cases and finishes the case in flight.
  if (cancelledStatus === 'queued' || cancelledStatus === 'pending') {
    await settleUnfinishedResults(taskId, 'cancelled')
    await refreshTaskSummary(taskId)
    await scheduleNextEvaluation(evaluationQueueDb, agentId, runEvaluationTask)
  }

  logAudit(c, { action: 'evaluation_task.cancel', resource: 'evaluation_task', resourceId: taskId })
  return c.json({ data: { id: taskId, cancelling: true } })
})

/** DELETE /:agentId/evaluation-tasks/:taskId — results cascade. */
app.delete('/:agentId/evaluation-tasks/:taskId', async (c) => {
  const { agentId, taskId } = c.req.param()
  await requireAgentWrite(c, agentId)
  await loadTaskOrThrow(agentId, taskId)

  // A running task cannot be deleted outright. Slots are counted from rows with
  // status `running`, so removing the row frees the slot while the subprocess it
  // stands for is still alive — the next submission then starts immediately and
  // the agent runs over its configured concurrency. Cancel first: that settles
  // the row only once the loop has actually stopped.
  const deletion = await withScmPathMutation(async (tx) => {
    const current = (
      await tx
        .select()
        .from(evaluationTasks)
        .where(and(eq(evaluationTasks.id, taskId), eq(evaluationTasks.agentId, agentId)))
        .limit(1)
    )[0]
    if (!current || current.status === 'running') return { task: current, data: undefined }
    const data = (
      await tx.delete(evaluationTasks).where(eq(evaluationTasks.id, taskId)).returning()
    )[0]
    await releaseReservedScmWorkloadInMutation(tx, {
      type: 'evaluation',
      workloadId: taskId,
    })
    return { task: current, data }
  })

  if (!deletion.task || deletion.task.status === 'running') {
    return c.json({ error: 'EVALUATION_TASK_RUNNING' }, 409)
  }

  // A queued task never started, so its place in line is free immediately.
  if (deletion.task.status === 'queued') {
    await scheduleNextEvaluation(evaluationQueueDb, agentId, runEvaluationTask)
  }

  logAudit(c, { action: 'evaluation_task.delete', resource: 'evaluation_task', resourceId: taskId })
  return c.json({ data: deletion.data })
})

export default app
