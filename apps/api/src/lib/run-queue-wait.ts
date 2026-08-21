import { eq } from 'drizzle-orm'
import { runs } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'

/** The subset of the executor surface this helper needs — `db` or a tx both satisfy it. */
type QueueWaitExecutor = Pick<TransactionHandle, 'select' | 'update'>

/**
 * Consume the run's queue-entry mark (`runs.queuedAt`) into a step wait.
 *
 * Called inside the same transaction that inserts the turn's run_step, so the
 * mark is read and cleared atomically with the step that records it — a
 * crash between the two cannot double-count one wait into two turns.
 *
 * Returns milliseconds waited; 0 when the turn was dispatched immediately
 * (no mark — admission clears it on an immediate acquire), when the run row
 * is gone, or when clock skew would produce a negative value.
 */
export async function consumeRunQueueWait(
  executor: QueueWaitExecutor,
  runId: string,
  now: Date = new Date(),
): Promise<number> {
  const [row] = await executor
    .select({ queuedAt: runs.queuedAt })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
  if (!row?.queuedAt) return 0
  await executor.update(runs).set({ queuedAt: null }).where(eq(runs.id, runId))
  return Math.max(0, now.getTime() - row.queuedAt.getTime())
}
