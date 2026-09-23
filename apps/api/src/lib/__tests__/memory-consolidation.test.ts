import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: { A2WAVE_MEMORY_STORAGE: '' },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const mockReindexAgentFts = vi.fn()
const mockReindexAgentVectors = vi.fn().mockResolvedValue(undefined)
vi.mock('../memory-index.js', () => ({
  reindexAgentFts: (...args: unknown[]) => mockReindexAgentFts(...args),
  reindexAgentVectors: (...args: unknown[]) => mockReindexAgentVectors(...args),
}))

const mockIsEmbeddingAvailable = vi.fn().mockReturnValue(false)
const mockGetEmbeddings = vi.fn().mockResolvedValue([])
vi.mock('../embedding-service.js', () => ({
  isEmbeddingAvailable: (...args: unknown[]) => mockIsEmbeddingAvailable(...args),
  getEmbeddings: (...args: unknown[]) => mockGetEmbeddings(...args),
}))

const mockBuildAgentConfig = vi.fn(
  (agent: { id: string; type?: string; config?: Record<string, unknown> }) => ({
    ...agent.config,
    agentId: agent.id,
    engineType: 'cursor',
    model: 'provider-model',
  }),
)
vi.mock('../agent-helpers.js', () => ({
  buildAgentConfig: (agent: { id: string; type?: string; config?: Record<string, unknown> }) =>
    mockBuildAgentConfig(agent),
}))

const mockExecuteWithRetry = vi.fn()
vi.mock('../execute-with-retry.js', () => ({
  executeWithRetry: (...args: unknown[]) => mockExecuteWithRetry(...args),
}))

import { env } from '../../env.js'
import { consolidateMemory } from '../memory-consolidation.js'
import { listMemoryFiles, readMemoryFile, writeMemoryFile } from '../memory-storage.js'

let testRoot: string
const agentId = 'agt_cons'
const provider = {
  agent: {
    id: agentId,
    type: 'cursor',
    name: 'Consolidation Agent',
    config: {},
  } as never,
}

function setupTestDir() {
  testRoot = join(
    tmpdir(),
    `consolidation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(testRoot, { recursive: true })
  ;(env as { A2WAVE_MEMORY_STORAGE: string }).A2WAVE_MEMORY_STORAGE = testRoot
}

function mockProviderSuccess(summary: string) {
  mockExecuteWithRetry.mockResolvedValue({
    result: { success: true, output: summary, durationMs: 1 },
    retries: [],
    logs: [],
  })
}

function mockProviderFailure(error: unknown = 'provider failed') {
  mockExecuteWithRetry.mockResolvedValue({
    result: { success: false, output: '', error, durationMs: 1 },
    retries: [],
    logs: [],
  })
}

describe('memory-consolidation', () => {
  beforeEach(() => {
    setupTestDir()
    vi.clearAllMocks()
    mockProviderSuccess('# Weekly')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    if (existsSync(testRoot)) {
      rmSync(testRoot, { recursive: true })
    }
  })

  it('returns null when fewer than 7 old files', async () => {
    for (let i = 1; i <= 5; i++) {
      writeMemoryFile(agentId, `memory/2025-01-${String(i).padStart(2, '0')}.md`, `day${i}`)
    }

    const result = await consolidateMemory(agentId, provider, { maxAgeDays: 0 })
    expect(result).toBeNull()
  })

  it('consolidates old daily files into weekly summaries', async () => {
    for (let i = 1; i <= 14; i++) {
      writeMemoryFile(
        agentId,
        `memory/2025-01-${String(i).padStart(2, '0')}.md`,
        `Work log day ${i}`,
      )
    }

    mockProviderSuccess('# Week 2025-W01\n- Summary of week 1')

    const result = await consolidateMemory(agentId, provider, { maxAgeDays: 0 })

    expect(result).not.toBeNull()
    expect(result?.consolidatedCount).toBeGreaterThan(0)

    const files = listMemoryFiles(agentId)
    const weeklyFiles = files.filter((f) => f.name.startsWith('memory/weekly/'))
    expect(weeklyFiles.length).toBeGreaterThan(0)
  })

  it('deletes original files after consolidation', async () => {
    vi.stubEnv('TZ', 'America/New_York')
    for (let i = 6; i <= 12; i++) {
      writeMemoryFile(agentId, `memory/2025-01-${String(i).padStart(2, '0')}.md`, `day ${i}`)
    }

    mockProviderSuccess('# Week summary')

    await consolidateMemory(agentId, provider, { maxAgeDays: 0 })

    const files = listMemoryFiles(agentId)
    const dailyFiles = files.filter((f) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(f.name))
    expect(dailyFiles.length).toBe(0)
  })

  it('triggers reindex after consolidation', async () => {
    for (let i = 1; i <= 7; i++) {
      writeMemoryFile(agentId, `memory/2025-01-${String(i).padStart(2, '0')}.md`, `day${i}`)
    }

    mockProviderSuccess('# Weekly')

    await consolidateMemory(agentId, provider, { maxAgeDays: 0 })

    expect(mockReindexAgentFts).toHaveBeenCalledWith(agentId)
  })

  it('handles provider failure gracefully', async () => {
    for (let i = 1; i <= 7; i++) {
      writeMemoryFile(agentId, `memory/2025-01-${String(i).padStart(2, '0')}.md`, `day${i}`)
    }

    mockProviderFailure(500)

    const result = await consolidateMemory(agentId, provider, { maxAgeDays: 0 })

    expect(result).toEqual({ consolidatedCount: 0 })
    const files = listMemoryFiles(agentId)
    const dailyFiles = files.filter((f) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(f.name))
    expect(dailyFiles.length).toBe(7)
  })

  it('respects maxAgeDays threshold', async () => {
    const today = new Date()
    for (let i = 0; i < 10; i++) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const dateStr = date.toISOString().slice(0, 10)
      writeMemoryFile(agentId, `memory/${dateStr}.md`, `day ${i}`)
    }

    mockProviderSuccess('# Weekly')

    const result = await consolidateMemory(agentId, provider, { maxAgeDays: 365 })
    expect(result).toBeNull()
  })

  it('preserves MEMORY.md during consolidation', async () => {
    writeMemoryFile(agentId, 'MEMORY.md', 'Long-term memory content')
    for (let i = 1; i <= 7; i++) {
      writeMemoryFile(agentId, `memory/2025-01-${String(i).padStart(2, '0')}.md`, `day${i}`)
    }

    mockProviderSuccess('# Week summary')

    await consolidateMemory(agentId, provider, { maxAgeDays: 0 })

    expect(readMemoryFile(agentId, 'MEMORY.md')).toBe('Long-term memory content')
  })
})
