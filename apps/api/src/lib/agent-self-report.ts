/**
 * The single per-Agent answer to "what is this Agent doing right now?".
 *
 * Composed rather than newly measured: health reuses the diagnose checks and the
 * queue figures come from the scheduler's own DB adapter, so a report can never
 * disagree with the admission decision it describes. Before this existed the
 * answer required fanning out over `/agents/:id`, `/diagnose`, `/stats`,
 * `/chat-connections` and `/provider-clis`, and live queue depth was on none of
 * them.
 *
 * Probing and rendering are split the way `cli/commands/status.ts` splits them:
 * `buildAgentSelfReport` answers as data so the HTTP endpoint and the chat
 * command cannot report different facts, and `formatAgentSelfReport` is the only
 * place that turns it into prose.
 */
import type { CommandReplyLanguage } from '@a2wave/shared'
import type { agents } from '../db/schema.js'
import { countActiveExecutionLeases } from '../engine/execution-lease-registry.js'
import { MAX_QUEUE_LENGTH } from '../engine/task-queue.js'
import { taskQueueDb } from '../engine/task-queue-db.js'
import { collectAgentExecutionChecks } from './agent-execution-diagnose.js'
import { buildAgentConfig } from './agent-helpers.js'
import type { DiagnoseCheck, DiagnoseSeverity } from './feishu-diagnose.js'

type AgentRow = typeof agents.$inferSelect

/** `busy` still accepts work; `full` rejects it. */
export type AgentQueueCapacity = 'idle' | 'busy' | 'full'

export interface AgentSelfReport {
  meta: {
    id: string
    name: string
    icon: string
    description: string | null
    status: string
    publishStatus: string
    channels: string[]
    model: string | null
  }
  health: { ok: boolean; checks: DiagnoseCheck[] }
  queue: {
    running: number
    queued: number
    maxConcurrency: number
    queueLimit: number
    capacity: AgentQueueCapacity
  }
  checkedAt: string
}

const SEVERITY_ORDER: Record<DiagnoseSeverity, number> = { error: 0, warn: 1, info: 2 }

/**
 * Mirror `tryAcquireSlot`'s occupancy rule exactly. Taking only the DB count
 * would report "idle" during the window where a peer replica holds a lease but
 * its run row is not yet `running` — a self-report that contradicts the very
 * admission decision the user is asking about.
 */
async function countRunning(agentId: string): Promise<number> {
  const inDb = await taskQueueDb.countRunsByStatus(agentId, 'running')
  return Math.max(inDb, countActiveExecutionLeases(agentId))
}

function classifyCapacity(
  running: number,
  queued: number,
  maxConcurrency: number,
): AgentQueueCapacity {
  if (running < maxConcurrency) return 'idle'
  return queued >= MAX_QUEUE_LENGTH ? 'full' : 'busy'
}

export async function buildAgentSelfReport(agent: AgentRow): Promise<AgentSelfReport> {
  const [checks, running, queued, queueMaxConcurrency, model] = await Promise.all([
    collectAgentExecutionChecks(agent),
    countRunning(agent.id),
    taskQueueDb.countRunsByStatus(agent.id, 'queued'),
    taskQueueDb.getAgentMaxConcurrency(agent.id),
    resolveModel(agent),
  ])

  const sortedChecks = [...checks].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  )
  // The row is the fallback rather than the source: the queue adapter reads the
  // same column, so they only diverge if the agent was deleted mid-report.
  const maxConcurrency = queueMaxConcurrency ?? agent.maxConcurrency

  return {
    meta: {
      id: agent.id,
      name: agent.name,
      icon: agent.icon,
      description: agent.description ?? null,
      status: agent.status,
      publishStatus: agent.publishStatus,
      channels: (agent.publishChannels as string[] | null | undefined) ?? [],
      model,
    },
    health: { ok: !sortedChecks.some((c) => c.severity === 'error'), checks: sortedChecks },
    queue: {
      running,
      queued,
      maxConcurrency,
      queueLimit: MAX_QUEUE_LENGTH,
      capacity: classifyCapacity(running, queued, maxConcurrency),
    },
    checkedAt: new Date().toISOString(),
  }
}

/** A broken provider chain is a health check, not a reason to fail the report. */
async function resolveModel(agent: AgentRow): Promise<string | null> {
  try {
    const config = await buildAgentConfig(agent)
    const model = (config as { model?: unknown }).model
    return typeof model === 'string' && model ? model : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Copy = {
  status: string
  channels: string
  model: string
  queue: string
  running: string
  queued: string
  health: string
  healthy: string
  unhealthy: string
  none: string
  capacity: Record<AgentQueueCapacity, string>
}

const COPY: Record<Exclude<CommandReplyLanguage, 'auto'>, Copy> = {
  en: {
    status: 'Status',
    channels: 'Channels',
    model: 'Model',
    queue: 'Queue',
    running: 'running',
    queued: 'queued',
    health: 'Health',
    healthy: 'healthy',
    unhealthy: 'not runnable',
    none: 'none',
    capacity: { idle: 'idle', busy: 'busy', full: 'queue full' },
  },
  zh: {
    status: '状态',
    channels: '渠道',
    model: '模型',
    queue: '队列',
    running: '执行中',
    queued: '排队中',
    health: '健康',
    healthy: '正常',
    unhealthy: '不可执行',
    none: '无',
    capacity: { idle: '空闲', busy: '繁忙', full: '队列已满' },
  },
}

/**
 * Render the report for a channel reply.
 *
 * Every `error` check is listed verbatim: a status command that summarised an
 * unrunnable Agent as one bad line would be exactly the surface an operator
 * cannot act on.
 */
export function formatAgentSelfReport(
  report: AgentSelfReport,
  language: Exclude<CommandReplyLanguage, 'auto'>,
): string {
  const t = COPY[language]
  const { meta, health, queue } = report

  const lines = [
    `${meta.icon} ${meta.name}`,
    `${t.status}: ${meta.status} / ${meta.publishStatus}`,
    `${t.model}: ${meta.model ?? t.none}`,
    `${t.channels}: ${meta.channels.length > 0 ? meta.channels.join(', ') : t.none}`,
    `${t.queue}: ${t.capacity[queue.capacity]} — ${queue.running}/${queue.maxConcurrency} ${t.running}, ${queue.queued} ${t.queued}`,
    `${t.health}: ${health.ok ? t.healthy : t.unhealthy}`,
  ]

  for (const check of health.checks) {
    if (check.severity === 'error') lines.push(`✗ ${check.message}`)
  }

  // Blank line between fields, not a bare newline: chat surfaces render replies
  // as Markdown, where a lone newline is a SOFT break that collapsed the whole
  // report onto one line. The usual fix -- two trailing spaces -- cannot be used
  // here, because prepareNativeChatText strips `[ \t]+\n` before Slack, Discord,
  // Telegram and QQ ever see the text, so the hard breaks would vanish silently
  // on four channels. A blank line survives every sanitizer on the way out.
  return lines.join('\n\n')
}
