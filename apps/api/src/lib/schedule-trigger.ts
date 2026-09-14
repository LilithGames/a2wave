import { isSupportedScheduleCron } from '@a2wave/shared'
import { Cron } from 'croner'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, runs, users } from '../db/schema.js'
import { tryAcquireSlot } from '../engine/task-queue.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { executeChatRun } from './execute-chat-run.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import { registerPendingContext } from './pending-job-registry.js'
import { buildScheduleChannel } from './run-channel.js'

export type ScheduleConfig = {
  id?: string
  cron: string
  intent: string
  timezone?: string
}
export type ScheduleConfigInput = ScheduleConfig | ScheduleConfig[]

export const DEFAULT_SCHEDULE_TIMEZONE = 'Asia/Shanghai'

/**
 * The 5-field shape `isSupportedScheduleCron` enforces (croner itself would also
 * accept 6-field seconds). Checked here so a registration attempt parses the
 * expression exactly once instead of validating and then parsing again.
 */
const FIVE_FIELD_CRON = /^(\S+\s+){4}\S+$/

type AgentRow = typeof agents.$inferSelect

export function normalizeScheduleConfigs(
  config: ScheduleConfigInput | null | undefined,
): ScheduleConfig[] {
  if (!config) return []
  return Array.isArray(config) ? config : [config]
}

/**
 * Stable identifier of one schedule entry. Prefer the persisted per-schedule id
 * so audit logs stay stable when the array is edited; legacy configs without
 * ids fall back to the entry's position.
 */
export function resolveScheduleId(
  agentId: string,
  schedule: ScheduleConfig,
  index: number,
): string {
  return schedule.id ?? `${agentId}:${index}`
}

/** Why croner would refuse an entry: a malformed expression or an unknown IANA name. */
export type UnregistrableReason = 'cron' | 'timezone'

type CronRegistration =
  | { job: Cron; reason?: undefined }
  | { job?: undefined; reason: UnregistrableReason }

/**
 * Register a cron exactly as `start` does, parsing the expression once. The
 * reason is classified only on the failure path (a second parse without the
 * timezone tells a bad expression from a bad timezone), so the happy path stays
 * a single croner construction.
 */
function registerCron(cron: string, timezone: string, callback?: () => void): CronRegistration {
  if (!FIVE_FIELD_CRON.test(cron.trim())) return { reason: 'cron' }
  try {
    return { job: new Cron(cron, { timezone }, callback) }
  } catch {
    return { reason: isValidCron(cron) ? 'timezone' : 'cron' }
  }
}

/**
 * Next firing time as an ISO string, evaluated in the schedule's timezone.
 * Null when croner cannot register the expression (invalid cron or unknown
 * timezone) — the same entries `start` skips.
 */
export function computeNextRun(cron: string, timezone: string): string | null {
  const { job } = registerCron(cron, timezone)
  if (!job) return null
  // With no callback croner does not schedule at construction, so an unknown
  // timezone only surfaces here when the first firing time is computed.
  try {
    return job.nextRun()?.toISOString() ?? null
  } catch {
    return null
  }
}

/**
 * Human-readable reason an entry with `nextRun === null` will never fire, for
 * callers that must refuse it rather than fire what the registrar skips.
 */
export function describeUnregistrable(entry: Pick<ScheduleEntry, 'cron' | 'timezone'>): string {
  return isValidCron(entry.cron)
    ? `timezone "${entry.timezone}" is not a known IANA timezone`
    : `cron "${entry.cron}" is not a valid 5-field expression`
}

export interface ScheduleEntry {
  id: string
  index: number
  cron: string
  timezone: string
  intent: string
  nextRun: string | null
  /**
   * True when the entry carries a persisted `id`. A positional `<agentId>:<index>`
   * id silently re-targets a different entry once the array is edited, so only
   * stable entries can be rehearsed.
   */
  stable: boolean
}

/** The Agent's schedule config as a flat, addressable list. */
export function listSchedules(
  agentId: string,
  config: ScheduleConfigInput | null | undefined,
): ScheduleEntry[] {
  return normalizeScheduleConfigs(config).map((schedule, index) => {
    const timezone = schedule.timezone || DEFAULT_SCHEDULE_TIMEZONE
    return {
      id: resolveScheduleId(agentId, schedule, index),
      index,
      cron: schedule.cron,
      timezone,
      intent: schedule.intent,
      nextRun: computeNextRun(schedule.cron, timezone),
      stable: schedule.id != null,
    }
  })
}

export function renderIntent(template: string, timezone: string): string {
  const now = new Date()
  const dateStr = now.toLocaleDateString('sv-SE', { timeZone: timezone })
  const timeStr = now.toLocaleTimeString('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  return template
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{time\}\}/g, timeStr)
    .replace(/\{\{iso\}\}/g, now.toISOString())
}

export function isValidCron(expr: string): boolean {
  return isSupportedScheduleCron(expr)
}

class ScheduleTriggerManager {
  private jobs = new Map<string, Cron[]>()

  start(agentId: string, config: ScheduleConfigInput): void {
    this.stop(agentId)

    const jobs: Cron[] = []
    normalizeScheduleConfigs(config).forEach((schedule, index) => {
      const timezone = schedule.timezone || DEFAULT_SCHEDULE_TIMEZONE

      // croner throws synchronously on an unknown IANA timezone. Without this guard
      // the throw escaped `start`, which had already called `stop` — losing the
      // agent's *valid* schedules — and aborted `restoreAll` for every later agent.
      const { job, reason } = registerCron(schedule.cron, timezone, () => {
        this.triggerRun(agentId, schedule, index).catch((err) =>
          logger.error({ err, agentId, scheduleIndex: index }, 'Schedule trigger failed'),
        )
      })
      if (!job) {
        logger.warn(
          { agentId, cron: schedule.cron, timezone, scheduleIndex: index, reason },
          reason === 'cron'
            ? 'Invalid cron expression, skipping schedule registration'
            : 'Cron registration rejected (unknown timezone), skipping schedule registration',
        )
        return
      }

      jobs.push(job)
      logger.info(
        { agentId, cron: schedule.cron, timezone, scheduleIndex: index },
        'Schedule cron registered',
      )
    })

    if (jobs.length > 0) {
      this.jobs.set(agentId, jobs)
    }
  }

  stop(agentId: string): void {
    const jobs = this.jobs.get(agentId)
    if (!jobs) return
    for (const job of jobs) {
      job.stop()
    }
    this.jobs.delete(agentId)
    logger.info({ agentId }, 'Schedule cron stopped')
  }

  stopAll(): void {
    for (const agentId of [...this.jobs.keys()]) {
      this.stop(agentId)
    }
  }

  async restoreAll(): Promise<void> {
    const publishedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.publishStatus, 'published'))

    for (const agent of publishedAgents) {
      const channels = (agent.publishChannels as string[]) ?? []
      if (!channels.includes('schedule')) continue
      const config = agent.scheduleConfig as ScheduleConfigInput | null
      if (!config || normalizeScheduleConfigs(config).length === 0) continue
      // Per-agent isolation: one malformed config must not cost every agent behind
      // it in the list its schedules for the rest of the process lifetime.
      try {
        this.start(agent.id, config)
      } catch (err) {
        logger.error(
          { err, agentId: agent.id },
          'Schedule restoration failed for agent, continuing with the remaining agents',
        )
      }
    }
    logger.info(`Schedule triggers restored: ${this.jobs.size} active`)
  }

  getActiveAgentIds(): string[] {
    return [...this.jobs.keys()]
  }

  private async triggerRun(
    agentId: string,
    config: ScheduleConfig,
    scheduleIndex: number,
  ): Promise<void> {
    const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
    if (!agent || agent.publishStatus !== 'published') {
      this.stop(agentId)
      logger.info({ agentId }, 'Schedule trigger stopped: agent not published or deleted')
      return
    }
    if (agent.status === 'inactive') {
      logger.info({ agentId }, 'Schedule trigger skipped: agent inactive')
      return
    }

    await fireSchedule(agent, config, scheduleIndex)
  }
}

export interface FireScheduleResult {
  runId: string
  /** `queue_full` means the run row was created and immediately marked failed. */
  status: 'pending' | 'queued' | 'queue_full'
  /** The intent after `{{date}}` / `{{time}}` / `{{iso}}` rendering. */
  intent: string
}

/**
 * Create and dispatch the run a schedule entry produces when it fires.
 *
 * Shared by the cron callback and the manual "run this schedule now" route so a
 * rehearsal goes through exactly the same path — `triggerSource: 'schedule'`,
 * the schedule channel context, the run-as identity, and slot acquisition.
 * Callers decide whether the agent is eligible (published, schedule channel
 * enabled, active); this only fires.
 */
export async function fireSchedule(
  agent: AgentRow,
  config: ScheduleConfig,
  scheduleIndex: number,
): Promise<FireScheduleResult> {
  const agentId = agent.id
  const timezone = config.timezone || DEFAULT_SCHEDULE_TIMEZONE
  const intent = renderIntent(config.intent, timezone)
  const runId = createId('run')

  const scheduleUser = await resolveScheduleRunAsUser(agent)

  const scheduleResult = buildScheduleChannel({
    scheduleId: resolveScheduleId(agentId, config, scheduleIndex),
    cron: config.cron,
    user: scheduleUser,
  })

  // Assign userId so non-admin users can see schedule runs in their run list.
  // Attribute to the run-as user ONLY when their identity actually resolved
  // (scheduleUser != null); if resolution failed (inactive/unbound → anonymous run),
  // fall back to the agent owner so the run isn't misattributed to someone it never
  // ran as. Keeps "displayed owner" consistent with "actual run identity".
  const runUserId = (scheduleUser ? agent.scheduleRunAsUserId : agent.userId) ?? undefined

  await db.insert(runs).values({
    id: runId,
    intent,
    initiatorAgentId: agentId,
    userId: runUserId,
    status: 'pending',
    triggerSource: 'schedule',
    triggerUserName: scheduleResult.displayName, // owner name when scheduleRunAsOwner, else null
  })

  // Register the unified schedule channel context so executeChatRun (whether
  // dispatched immediately or after queueing) can attach it to the runSteps row.
  registerPendingContext(runId, { channel: scheduleResult.ctx })

  const slotResult = await tryAcquireSlot(taskQueueDb, agentId, runId, agent.maxConcurrency ?? 1)

  if (slotResult === 'queue_full') {
    await db
      .update(runs)
      .set({
        status: 'failed',
        result: { error: 'Agent queue is full at schedule trigger time' },
        updatedAt: new Date(),
      })
      .where(eq(runs.id, runId))
    logger.warn({ agentId, runId }, 'Schedule trigger: queue full, run marked failed')
    return { runId, status: 'queue_full', intent }
  }

  if (slotResult === 'queued') {
    logger.info({ agentId, runId }, 'Schedule trigger: run queued')
    return { runId, status: 'queued', intent }
  }

  executeChatRun(agentId, runId).catch((err) =>
    logger.error({ err, agentId, runId }, 'Schedule triggered run execution failed'),
  )
  logger.info({ agentId, runId }, 'Schedule trigger: run acquired and executing')
  return { runId, status: 'pending', intent }
}

type ScheduleRunAsUser = { email: string; name?: string; sourceId?: string }

/**
 * Resolve the authorized run-as identity when the agent opted into
 * scheduleRunAsOwner. The identity is the user who enabled it
 * (agents.scheduleRunAsUserId, pinned server-side at publish time), resolved
 * live here so disabling/unbinding that user takes effect immediately. If they
 * have no active bound SSO identity we return null and the run executes
 * without an attributed SSO identity.
 * The id is server-controlled: a client can flip the boolean but can't point it
 * at someone else (scheduleRunAsUserId is not writable via the agent input schemas).
 */
async function resolveScheduleRunAsUser(agent: AgentRow): Promise<ScheduleRunAsUser | null> {
  const channels = (agent.publishChannels as string[]) ?? []
  if (!agent.scheduleRunAsOwner || !channels.includes('schedule') || !agent.scheduleRunAsUserId) {
    return null
  }
  const runAsUser = (
    await db.select().from(users).where(eq(users.id, agent.scheduleRunAsUserId)).limit(1)
  )[0]
  // Require a *bound* SSO identity (idaasSub), not just any email — otherwise a
  // legacy/partial row with an email but no binding would attribute the run to an
  // idaas-sourced identity that was never actually bound.
  if (runAsUser?.isActive && runAsUser.email && runAsUser.idaasSub) {
    return {
      email: runAsUser.email,
      name: runAsUser.displayName ?? undefined,
      sourceId: runAsUser.idaasSub,
    }
  }
  logger.warn(
    { agentId: agent.id, runAsUserId: agent.scheduleRunAsUserId },
    'scheduleRunAsOwner set but run-as user has no active bound SSO identity — schedule run will be anonymous',
  )
  return null
}

export const scheduleTriggerManager = new ScheduleTriggerManager()
