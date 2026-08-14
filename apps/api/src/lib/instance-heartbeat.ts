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
/**
 * Stop this process one minute before peers may reclaim its marks.
 *
 * That margin is intentionally larger than the graceful-shutdown hard timeout:
 * an expired owner must have stopped every CLI before another replica is
 * allowed to reuse its checkout. Once crossed, ownership is irrecoverable for
 * this process lifetime; a later successful write cannot undo a peer's claim.
 */
export const INSTANCE_SELF_FENCE_AFTER_MS = INSTANCE_DEAD_AFTER_MS - 60_000
/**
 * Recovery stays disabled for this long after boot.
 *
 * The dangerous moment is the first minutes of an upgrade: the heartbeat table
 * is empty, so *every* pre-existing mark reads as owner-less and this replica
 * would reclaim checkouts belonging to peers that simply have not written their
 * first row yet. Waiting one staleness window means a genuinely live peer has
 * beaten by the time any decision is made — and a genuinely dead owner's marks
 * were not going anywhere anyway.
 */
export const RECOVERY_GRACE_AFTER_BOOT_MS = INSTANCE_DEAD_AFTER_MS
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
  /**
   * Elapsed milliseconds from a source that never steps — used **only** for
   * this process's own fail-stop deadline.
   *
   * The wall clock is wrong for that decision in the dangerous direction: an
   * NTP step backwards shrinks the measured gap, so an owner that has not
   * renewed in ten minutes reads as healthy and keeps writing to a checkout
   * its peers are already entitled to reclaim. A step forwards (or a container
   * suspend/resume) only trips a spurious, conservative fail-stop.
   *
   * The persisted `started_at` / `heartbeat_at` columns stay wall-clock: those
   * are compared *across* processes, where a monotonic reading is meaningless.
   */
  monotonicMs: () => number
}

const defaultDeps: InstanceHeartbeatDeps = {
  db,
  write: runExclusive,
  instanceId: processInstanceId,
  bootTime,
  now: () => new Date(),
  monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
}

export async function beatInstanceHeartbeat(
  deps: InstanceHeartbeatDeps = defaultDeps,
): Promise<Date> {
  const heartbeatAt = deps.now()
  await deps.write(() =>
    deps.db
      .insert(instanceHeartbeats)
      .values({ id: deps.instanceId, startedAt: deps.bootTime, heartbeatAt })
      .onConflictDoUpdate({
        target: instanceHeartbeats.id,
        set: { startedAt: deps.bootTime, heartbeatAt },
      })
      .returning({ id: instanceHeartbeats.id }),
  )
  return heartbeatAt
}

/**
 * Per-deps renewal state. Keyed by the deps object so tests get isolation and
 * production shares one entry via `defaultDeps`.
 */
interface RenewalState {
  inFlight: boolean
  lostOwnership: boolean
  onOwnershipLost?: () => void
  /**
   * Last successful renewal on the **monotonic** timeline, seeded when the loop
   * starts rather than from `bootTime`: liveness is about *renewal* health, and
   * a long-lived process that has beaten happily for hours must not read as
   * instantly fenced.
   */
  lastSuccessAt: number
}

const renewalStates = new WeakMap<InstanceHeartbeatDeps, RenewalState>()

function renewalState(deps: InstanceHeartbeatDeps): RenewalState {
  let state = renewalStates.get(deps)
  if (!state) {
    state = {
      inFlight: false,
      lostOwnership: false,
      lastSuccessAt: deps.monotonicMs(),
    }
    renewalStates.set(deps, state)
  }
  return state
}

function fenceIfExpired(deps: InstanceHeartbeatDeps, state: RenewalState): boolean {
  if (state.lostOwnership) return true
  if (deps.monotonicMs() - state.lastSuccessAt <= INSTANCE_SELF_FENCE_AFTER_MS) return false
  state.lostOwnership = true
  logger.error(
    { instanceId: deps.instanceId },
    'Instance heartbeat lease expired; stopping before peers may reclaim SCM workspaces',
  )
  try {
    state.onOwnershipLost?.()
  } catch (error) {
    logger.error({ error }, 'Instance heartbeat ownership-loss handler failed')
  }
  return true
}

/**
 * Has this process reached its fail-stop deadline?
 *
 * This deadline is deliberately earlier than the peer-death threshold. The
 * margin gives graceful shutdown time to terminate every CLI before another
 * replica may reclaim the checkout. Crossing it is irreversible for this
 * process lifetime; a later write cannot safely reacquire an ownership peers
 * may already be preparing to take.
 */
export function hasLostHeartbeatOwnership(deps: InstanceHeartbeatDeps = defaultDeps): boolean {
  const state = renewalStates.get(deps)
  if (!state) return false
  return fenceIfExpired(deps, state)
}

export interface StartInstanceHeartbeatOptions {
  /** Fail-stop hook; production begins graceful shutdown and terminates every CLI. */
  onOwnershipLost?: () => void
}

/**
 * Beat immediately and on the interval until stopped.
 *
 * Renewals are single-flight: a write that outlives its interval must not be
 * joined by a second one, since two concurrent upserts of the same row race to
 * set `heartbeat_at` and a slow one landing last would move liveness backwards.
 * A failed beat is retried by the next tick, and sustained failure trips
 * `hasLostHeartbeatOwnership`.
 */
export function startInstanceHeartbeat(
  deps: InstanceHeartbeatDeps = defaultDeps,
  options: StartInstanceHeartbeatOptions = {},
): () => void {
  // Seeded from the monotonic clock here: the caller has just awaited the boot
  // heartbeat, so "now" is the last known-good renewal.
  const state = renewalState(deps)
  state.onOwnershipLost = options.onOwnershipLost
  const beat = async () => {
    if (fenceIfExpired(deps, state)) return
    if (state.inFlight) return
    state.inFlight = true
    try {
      const startedAt = deps.monotonicMs()
      await beatInstanceHeartbeat(deps)
      // A write that returned after the lease deadline is too late. A peer may
      // already be preparing to reclaim, so never revive this process's epoch.
      if (fenceIfExpired(deps, state)) return
      // Credit the instant the write STARTED, not when it returned: a write
      // that took 30s only proves liveness as of when it was issued.
      state.lastSuccessAt = startedAt
    } catch (error) {
      logger.warn({ error }, 'Instance heartbeat write failed; next interval retries')
    } finally {
      state.inFlight = false
    }
  }
  void beat()
  const timer = setInterval(() => void beat(), INSTANCE_HEARTBEAT_INTERVAL_MS)
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

/**
 * Has this process been up long enough to judge anyone else's liveness?
 *
 * Recovery must stay off until every healthy peer has had a full staleness
 * window to write its first heartbeat — otherwise the empty table right after
 * an upgrade reads as "everyone is dead".
 */
export function canJudgePeerLiveness(deps: InstanceHeartbeatDeps = defaultDeps): boolean {
  // A self-fenced instance has no standing to judge anyone: peers already
  // consider it dead, so acting on its own stale view of the table would let
  // two processes reclaim the same resources.
  if (hasLostHeartbeatOwnership(deps)) return false
  return deps.now().getTime() - deps.bootTime.getTime() >= RECOVERY_GRACE_AFTER_BOOT_MS
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
