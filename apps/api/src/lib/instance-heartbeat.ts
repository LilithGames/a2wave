import { and, eq, lt, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { instanceHeartbeats } from '../db/schema.js'
import { runExclusive } from '../db/transaction.js'
import { logger } from './logger.js'
import { processInstanceId } from './process-instance.js'

/**
 * Process liveness for cross-replica SCM recovery.
 *
 * Durable SCM marks (workload leases, workspace-removal reservations) cannot
 * expire by age: a multi-repository Git operation can outlive any per-command
 * timeout, so "old" never proves "abandoned". A stopped heartbeat does. Every
 * process upserts its row before serving and renews it on an interval; a mark
 * whose owner has no row, stopped beating, or restarted since the mark was
 * written is provably abandoned and safe for any surviving replica to recover.
 *
 * Clock skew: staleness compares a peer's timestamp with the local clock, so
 * the dead-after threshold is deliberately generous (10 missed beats) and
 * deployments are expected to run NTP. The boot-instant comparison is between
 * two writes of the same instance name, which share a clock in every supported
 * topology.
 */

export const INSTANCE_HEARTBEAT_INTERVAL_MS = 30_000
/** ~10 missed beats; generous to GC pauses, event-loop stalls, and clock skew. */
export const INSTANCE_DEAD_AFTER_MS = 5 * 60_000
/** Rows this stale are kept only as tombstones; prune to keep the table bounded. */
const PRUNE_AFTER_MS = 24 * 60 * 60_000

/** This process's boot instant; a reused instance id must not inherit its previous life's. */
const bootTime = new Date()

export interface InstanceLiveness {
  startedAt: Date
  heartbeatAt: Date
}

export type InstanceLivenessMap = Map<string, InstanceLiveness>

export interface InstanceHeartbeatDeps {
  db: Pick<typeof db, 'insert' | 'delete'>
  /** Bare-write guard (`runExclusive`): must not join a stranger's transaction. */
  write: <T>(fn: () => Promise<T>) => Promise<T>
  instanceId: string
  bootTime: Date
  now: () => Date
}

const defaultDeps: InstanceHeartbeatDeps = {
  db,
  write: runExclusive,
  instanceId: processInstanceId,
  bootTime,
  now: () => new Date(),
}

export async function beatInstanceHeartbeat(
  deps: InstanceHeartbeatDeps = defaultDeps,
): Promise<void> {
  await deps.write(() =>
    deps.db
      .insert(instanceHeartbeats)
      .values({ id: deps.instanceId, startedAt: deps.bootTime, heartbeatAt: deps.now() })
      .onConflictDoUpdate({
        target: instanceHeartbeats.id,
        set: { startedAt: deps.bootTime, heartbeatAt: deps.now() },
      })
      .returning({ id: instanceHeartbeats.id }),
  )
}

/** Beat immediately and on the interval until stopped. A failed beat is retried by the next tick. */
export function startInstanceHeartbeat(deps: InstanceHeartbeatDeps = defaultDeps): () => void {
  const beat = () =>
    beatInstanceHeartbeat(deps).catch((error) =>
      logger.warn({ error }, 'Instance heartbeat write failed; next interval retries'),
    )
  void beat()
  const timer = setInterval(beat, INSTANCE_HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Remove the own row at the very end of graceful shutdown, after every drain. */
export async function deleteInstanceHeartbeat(
  deps: InstanceHeartbeatDeps = defaultDeps,
): Promise<void> {
  await deps.write(() =>
    deps.db
      .delete(instanceHeartbeats)
      .where(eq(instanceHeartbeats.id, deps.instanceId))
      .returning({ id: instanceHeartbeats.id }),
  )
}

/** Drop tombstones of long-dead instances. Correctness never depends on a row's presence. */
export async function pruneDeadInstanceHeartbeats(
  deps: InstanceHeartbeatDeps = defaultDeps,
): Promise<void> {
  const cutoff = new Date(deps.now().getTime() - PRUNE_AFTER_MS)
  await deps.write(() =>
    deps.db
      .delete(instanceHeartbeats)
      .where(
        and(lt(instanceHeartbeats.heartbeatAt, cutoff), ne(instanceHeartbeats.id, deps.instanceId)),
      )
      .returning({ id: instanceHeartbeats.id }),
  )
}

export async function loadInstanceLiveness(
  executor: Pick<typeof db, 'select'>,
): Promise<InstanceLivenessMap> {
  const rows = await executor.select().from(instanceHeartbeats)
  const map: InstanceLivenessMap = new Map()
  for (const row of rows) {
    map.set(row.id, { startedAt: row.startedAt, heartbeatAt: row.heartbeatAt })
  }
  return map
}

/**
 * Is the owner of a durable mark provably gone?
 *
 * Dead when it never wrote a heartbeat row, stopped beating past the
 * threshold, or booted after the mark was written (a reused instance id whose
 * previous life wrote the mark). `markWrittenAt` is the mark's own write
 * instant: a lease's activation time or a reservation's creation time.
 */
export function isInstanceOwnerDead(
  liveness: InstanceLivenessMap,
  ownerInstanceId: string,
  markWrittenAt: Date,
  now: Date,
): boolean {
  const owner = liveness.get(ownerInstanceId)
  if (!owner) return true
  if (now.getTime() - owner.heartbeatAt.getTime() > INSTANCE_DEAD_AFTER_MS) return true
  return markWrittenAt.getTime() < owner.startedAt.getTime()
}
