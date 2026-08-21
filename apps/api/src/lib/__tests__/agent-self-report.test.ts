import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { agents } from '../../db/schema.js'
import { buildAgentSelfReport, formatAgentSelfReport } from '../agent-self-report.js'

const mockCollectChecks = vi.hoisted(() => vi.fn())
vi.mock('../agent-execution-diagnose.js', () => ({
  collectAgentExecutionChecks: (agent: unknown) => mockCollectChecks(agent),
}))

const mockCountByStatus = vi.hoisted(() => vi.fn())
const mockGetMaxConcurrency = vi.hoisted(() => vi.fn())
vi.mock('../../engine/task-queue-db.js', () => ({
  taskQueueDb: {
    countRunsByStatus: (agentId: string, status: string) => mockCountByStatus(agentId, status),
    getAgentMaxConcurrency: (agentId: string) => mockGetMaxConcurrency(agentId),
  },
}))

const mockCountLeases = vi.hoisted(() => vi.fn())
vi.mock('../../engine/execution-lease-registry.js', () => ({
  countActiveExecutionLeases: (agentId: string) => mockCountLeases(agentId),
}))

const mockBuildAgentConfig = vi.hoisted(() => vi.fn())
vi.mock('../agent-helpers.js', () => ({
  buildAgentConfig: (agent: unknown) => mockBuildAgentConfig(agent),
}))

type AgentRow = typeof agents.$inferSelect

function makeAgent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    id: 'agt_1',
    name: 'Reviewer',
    description: 'Reviews merge requests',
    icon: '🤖',
    status: 'active',
    publishStatus: 'published',
    publishChannels: ['api', 'feishu'],
    maxConcurrency: 2,
    commandReplyLanguage: 'auto',
    ...overrides,
  } as AgentRow
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCollectChecks.mockResolvedValue([])
  mockCountByStatus.mockResolvedValue(0)
  mockGetMaxConcurrency.mockResolvedValue(2)
  mockCountLeases.mockReturnValue(0)
  mockBuildAgentConfig.mockResolvedValue({ model: 'claude-opus-5' })
})

describe('buildAgentSelfReport — meta', () => {
  it('surfaces identity, lifecycle and bound channels', async () => {
    const report = await buildAgentSelfReport(makeAgent())

    expect(report.meta).toMatchObject({
      id: 'agt_1',
      name: 'Reviewer',
      icon: '🤖',
      status: 'active',
      publishStatus: 'published',
      channels: ['api', 'feishu'],
      model: 'claude-opus-5',
    })
  })

  it('reports the model as null when the provider chain cannot be resolved', async () => {
    mockBuildAgentConfig.mockRejectedValue(new Error('provider missing'))

    const report = await buildAgentSelfReport(makeAgent())

    expect(report.meta.model).toBeNull()
  })
})

describe('buildAgentSelfReport — queue', () => {
  it('counts running and queued runs against the agent concurrency limit', async () => {
    // Slots exhausted, queue below the cap: new work is accepted but waits.
    mockCountByStatus.mockImplementation(async (_id: string, status: string) =>
      status === 'running' ? 2 : 3,
    )

    const report = await buildAgentSelfReport(makeAgent())

    expect(report.queue).toMatchObject({
      running: 2,
      queued: 3,
      maxConcurrency: 2,
      queueLimit: 50,
      capacity: 'busy',
    })
  })

  it('stays idle while a slot is free even if rows are still awaiting promotion', async () => {
    // The promoter drains these on the next tick; reporting 'busy' here would
    // contradict tryAcquireSlot, which admits immediately.
    mockCountByStatus.mockImplementation(async (_id: string, status: string) =>
      status === 'running' ? 1 : 3,
    )

    const report = await buildAgentSelfReport(makeAgent())

    expect(report.queue.capacity).toBe('idle')
  })

  it('is idle when a concurrency slot is free', async () => {
    mockCountByStatus.mockResolvedValue(0)

    const report = await buildAgentSelfReport(makeAgent())

    expect(report.queue.capacity).toBe('idle')
  })

  it('is full once the queue reaches MAX_QUEUE_LENGTH', async () => {
    mockCountByStatus.mockImplementation(async (_id: string, status: string) =>
      status === 'running' ? 2 : 50,
    )

    const report = await buildAgentSelfReport(makeAgent())

    expect(report.queue.capacity).toBe('full')
  })

  it('takes the in-process lease count when it exceeds the database count', async () => {
    // Mirrors the scheduler's own max(): a peer replica may hold a lease whose
    // run row is not yet 'running', and reporting idle there contradicts admission.
    mockCountByStatus.mockResolvedValue(0)
    mockCountLeases.mockReturnValue(2)

    const report = await buildAgentSelfReport(makeAgent())

    expect(report.queue.running).toBe(2)
    expect(report.queue.capacity).toBe('busy')
  })

  it('falls back to the agent row when the queue has no concurrency record', async () => {
    mockGetMaxConcurrency.mockResolvedValue(undefined)

    const report = await buildAgentSelfReport(makeAgent({ maxConcurrency: 4 }))

    expect(report.queue.maxConcurrency).toBe(4)
  })
})

describe('buildAgentSelfReport — health', () => {
  it('is ok when no check is an error', async () => {
    mockCollectChecks.mockResolvedValue([
      { id: 'provider_bound_ok', severity: 'info', message: 'Provider bound' },
      { id: 'provider_no_model_selected', severity: 'warn', message: 'No model' },
    ])

    const report = await buildAgentSelfReport(makeAgent())

    expect(report.health.ok).toBe(true)
    expect(report.health.checks).toHaveLength(2)
  })

  it('is not ok when any check is an error, and sorts errors first', async () => {
    mockCollectChecks.mockResolvedValue([
      { id: 'provider_bound_ok', severity: 'info', message: 'Provider bound' },
      { id: 'provider_cli_not_installed', severity: 'error', message: 'CLI missing' },
    ])

    const report = await buildAgentSelfReport(makeAgent())

    expect(report.health.ok).toBe(false)
    expect(report.health.checks[0]?.severity).toBe('error')
  })
})

describe('formatAgentSelfReport', () => {
  it('renders English when the resolved language is en', async () => {
    const report = await buildAgentSelfReport(makeAgent())
    const text = formatAgentSelfReport(report, 'en')

    expect(text).toContain('Reviewer')
    expect(text).toMatch(/Queue/i)
    expect(text).not.toMatch(/[一-龥]/)
  })

  it('renders Chinese when the resolved language is zh', async () => {
    const report = await buildAgentSelfReport(makeAgent())
    const text = formatAgentSelfReport(report, 'zh')

    expect(text).toMatch(/[一-龥]/)
    expect(text).toContain('Reviewer')
  })

  it('reports every error check so a failing agent is never rendered as healthy', async () => {
    mockCollectChecks.mockResolvedValue([
      { id: 'provider_cli_not_installed', severity: 'error', message: 'CLI missing' },
    ])

    const report = await buildAgentSelfReport(makeAgent())

    expect(formatAgentSelfReport(report, 'en')).toContain('CLI missing')
  })
})
