import { eq, sql } from 'drizzle-orm'
import { chatMessages, runSteps } from '../db/schema.js'
import { type TransactionHandle, withTransaction } from '../db/transaction.js'
import { completeExecutionLease } from '../engine/execution-lease-registry.js'
import { scheduleNext } from '../engine/task-queue.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { logger } from './logger.js'

type TransactionRunner = <T>(callback: (tx: TransactionHandle) => Promise<T>) => Promise<T>

interface PersistRunTurnDeps {
  transaction: TransactionRunner
}

interface PersistRunTurnInput {
  step: Omit<typeof runSteps.$inferInsert, 'order'> & { order?: number }
  message: typeof chatMessages.$inferInsert
}

const defaultPersistDeps: PersistRunTurnDeps = {
  transaction: withTransaction,
}

/** Persist one user turn atomically so history never contains a step without its message. */
export async function persistRunTurn(
  input: PersistRunTurnInput,
  deps: PersistRunTurnDeps = defaultPersistDeps,
): Promise<void> {
  await deps.transaction(async (tx) => {
    let order = input.step.order
    if (order === undefined) {
      const [lastStep] = await tx
        .select({ maxOrder: sql<number>`MAX(${runSteps.order})` })
        .from(runSteps)
        .where(eq(runSteps.runId, input.step.runId))
        .limit(1)
      order = (lastStep?.maxOrder ?? 0) + 1
    }

    await tx.insert(runSteps).values({ ...input.step, order })
    await tx.insert(chatMessages).values(input.message)
  })
}

export type RunStartupRecoveryPhase =
  | 'cleanup'
  | 'fail-steps'
  | 'settle-run'
  | 'release-lease'
  | 'schedule-next'

interface RecoverRunStartupInput {
  runId: string
  agentId: string
  cleanup?: () => Promise<unknown>
  settleRun: () => Promise<unknown>
}

interface RecoverRunStartupDeps {
  failRunSteps: (runId: string) => Promise<unknown>
  releaseLease: (runId: string) => unknown
  scheduleNext: (agentId: string) => Promise<unknown>
  reportError: (
    phase: RunStartupRecoveryPhase,
    error: unknown,
    context: { runId: string; agentId: string },
  ) => void
}

const defaultRecoveryDeps: RecoverRunStartupDeps = {
  failRunSteps: (runId) => taskQueueDb.failRunSteps(runId),
  releaseLease: completeExecutionLease,
  scheduleNext: async (agentId) => {
    await scheduleNext(taskQueueDb, agentId, (runId, scheduledAgentId) => {
      void import('./execute-chat-run.js').then(({ executeChatRun }) =>
        executeChatRun(scheduledAgentId, runId),
      )
    })
  },
  reportError: (phase, error, context) => {
    logger.error({ err: error, phase, ...context }, 'Run startup recovery phase failed')
  },
}

/**
 * Converge a run that failed after acquiring a concurrency slot.
 *
 * Every phase is best-effort and isolated: a cleanup or database failure must
 * never prevent releasing the in-memory lease or waking the persisted queue.
 */
export async function recoverRunStartup(
  input: RecoverRunStartupInput,
  deps: RecoverRunStartupDeps = defaultRecoveryDeps,
): Promise<void> {
  const context = { runId: input.runId, agentId: input.agentId }
  const runPhase = async (
    phase: RunStartupRecoveryPhase,
    action: () => Promise<unknown> | unknown,
  ) => {
    try {
      await action()
    } catch (error) {
      deps.reportError(phase, error, context)
    }
  }

  if (input.cleanup) await runPhase('cleanup', input.cleanup)
  await runPhase('fail-steps', () => deps.failRunSteps(input.runId))
  await runPhase('settle-run', input.settleRun)
  await runPhase('release-lease', () => deps.releaseLease(input.runId))
  await runPhase('schedule-next', () => deps.scheduleNext(input.agentId))
}
