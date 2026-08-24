import { Hono } from 'hono'
/**
 * Unit tests for routes/memories.ts
 * Uses Hono's built-in test helper (app.request) — no HTTP server needed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { asyncQuery } from '../../test/async-query.js'

// ── DB mock ─────────────────────────────────────────────────────────────────

let mockAgentExists = true

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(() =>
      asyncQuery({
        from: vi.fn(() => ({
          where: vi.fn(() =>
            asyncQuery({
              get: vi.fn(() => (mockAgentExists ? { id: 'agt_test' } : null)),
            }),
          ),
        })),
      }),
    ),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: {
    id: 'id',
  },
}))

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'eq' })),
}))

// ── Agent access mock ──────────────────────────────────────────────────────

const mockRequireAgentRead = vi.fn()
const mockRequireAgentWrite = vi.fn()

vi.mock('../../lib/agent-access.js', () => ({
  requireAgentRead: (...args: unknown[]) => mockRequireAgentRead(...args),
  requireAgentWrite: (...args: unknown[]) => mockRequireAgentWrite(...args),
}))

const mockLogAudit = vi.fn()
vi.mock('../../lib/audit.js', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}))

vi.mock('../../lib/errors.js', async () => {
  class AppError extends Error {
    constructor(
      public readonly statusCode: number,
      message: string,
      public readonly code?: string,
    ) {
      super(message)
      this.name = this.constructor.name
    }
  }
  class NotFoundError extends AppError {
    constructor(resource: string) {
      super(404, `${resource} not found`, 'NOT_FOUND')
    }
  }
  class ForbiddenError extends AppError {
    constructor(message = 'Forbidden') {
      super(403, message, 'FORBIDDEN')
    }
  }
  return { AppError, NotFoundError, ForbiddenError }
})

// ── Memory storage mock ──────────────────────────────────────────────────────

type MemoryFile = { name: string; size: number; mtime: number }
type SearchResult = { filePath: string; snippet: string; score: number; mtime: number }
type MemoryStats = {
  fileCount: number
  totalSize: number
  dailyFileCount: number
  oldestFile: string | null
  newestFile: string | null
}

const mockListMemoryFiles = vi.fn()
const mockReadMemoryFile = vi.fn()
const mockWriteMemoryFile = vi.fn()
const mockDeleteMemoryFile = vi.fn()
const mockGetMemoryStats = vi.fn()
const mockEnforceCapacity = vi.fn()
const mockCheckSizeLimit = vi.fn()
const mockQueueAgentWrite = vi.fn()

vi.mock('../../lib/memory-storage.js', () => ({
  listMemoryFiles: (...args: unknown[]) => mockListMemoryFiles(...args),
  readMemoryFile: (...args: unknown[]) => mockReadMemoryFile(...args),
  writeMemoryFile: (...args: unknown[]) => mockWriteMemoryFile(...args),
  deleteMemoryFile: (...args: unknown[]) => mockDeleteMemoryFile(...args),
  getMemoryStats: (...args: unknown[]) => mockGetMemoryStats(...args),
  enforceCapacity: (...args: unknown[]) => mockEnforceCapacity(...args),
  checkSizeLimit: (...args: unknown[]) => mockCheckSizeLimit(...args),
  queueAgentWrite: (...args: unknown[]) => mockQueueAgentWrite(...args),
}))

// ── Topic hierarchy mock ────────────────────────────────────────────────────

const mockListMemoryTopics = vi.fn()
const mockReadMemoryTopic = vi.fn()
const mockApplyInsightToTopics = vi.fn()
const mockReplaceTopicBody = vi.fn()
const mockArchiveMemoryTopic = vi.fn()
const mockReactivateMemoryTopic = vi.fn()
const mockMergeMemoryTopics = vi.fn()
const mockSplitMemoryTopic = vi.fn()
const mockDetectMemoryHierarchyMode = vi.fn()
const mockIsMemoryTopicPath = vi.fn()
const mockReplaceAgentSummary = vi.fn()
const mockReplaceManagedTopicFile = vi.fn()
const mockDeleteMemoryTopicFile = vi.fn()

vi.mock('../../lib/memory-topics.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/memory-topics.js')>()
  return {
    ...actual,
    listMemoryTopics: (...args: unknown[]) => mockListMemoryTopics(...args),
    readMemoryTopic: (...args: unknown[]) => mockReadMemoryTopic(...args),
    applyInsightToTopics: (...args: unknown[]) => mockApplyInsightToTopics(...args),
    replaceTopicBody: (...args: unknown[]) => mockReplaceTopicBody(...args),
    archiveMemoryTopic: (...args: unknown[]) => mockArchiveMemoryTopic(...args),
    reactivateMemoryTopic: (...args: unknown[]) => mockReactivateMemoryTopic(...args),
    mergeMemoryTopics: (...args: unknown[]) => mockMergeMemoryTopics(...args),
    splitMemoryTopic: (...args: unknown[]) => mockSplitMemoryTopic(...args),
    detectMemoryHierarchyMode: (...args: unknown[]) => mockDetectMemoryHierarchyMode(...args),
    isMemoryTopicPath: (...args: unknown[]) => mockIsMemoryTopicPath(...args),
    replaceAgentSummaryFromMainContent: (...args: unknown[]) => mockReplaceAgentSummary(...args),
    replaceManagedTopicFile: (...args: unknown[]) => mockReplaceManagedTopicFile(...args),
    deleteMemoryTopicFile: (...args: unknown[]) => mockDeleteMemoryTopicFile(...args),
  }
})

const mockProposeLegacyTopicization = vi.fn()
const mockCommitLegacyTopicization = vi.fn()
vi.mock('../../lib/memory-topic-migration.js', () => ({
  proposeLegacyTopicization: (...args: unknown[]) => mockProposeLegacyTopicization(...args),
  commitLegacyTopicization: (...args: unknown[]) => mockCommitLegacyTopicization(...args),
}))

// ── Memory index mock ────────────────────────────────────────────────────────

const mockSearchByKeyword = vi.fn()
const mockSearchByVector = vi.fn()
const mockHybridSearch = vi.fn()
const mockApplyTemporalDecay = vi.fn()
const mockApplyMMR = vi.fn()
const mockRankMemoryResults = vi.fn()
const mockReindexAgentFts = vi.fn()
const mockClearAgentIndex = vi.fn()
const mockReindexAgentVectors = vi.fn()

vi.mock('../../lib/memory-index.js', () => ({
  searchByKeyword: (...args: unknown[]) => mockSearchByKeyword(...args),
  searchByVector: (...args: unknown[]) => mockSearchByVector(...args),
  hybridSearch: (...args: unknown[]) => mockHybridSearch(...args),
  applyTemporalDecay: (...args: unknown[]) => mockApplyTemporalDecay(...args),
  applyMMR: (...args: unknown[]) => mockApplyMMR(...args),
  rankMemoryResults: (...args: unknown[]) => mockRankMemoryResults(...args),
  reindexAgentFts: (...args: unknown[]) => mockReindexAgentFts(...args),
  clearAgentIndex: (...args: unknown[]) => mockClearAgentIndex(...args),
  reindexAgentVectors: (...args: unknown[]) => mockReindexAgentVectors(...args),
}))

// ── Embedding service mock ───────────────────────────────────────────────────

let mockEmbeddingAvailable = false
const mockGetEmbeddings = vi.fn()
const mockIsEmbeddingAvailable = vi.fn()

vi.mock('../../lib/embedding-service.js', () => ({
  getEmbeddings: (...args: unknown[]) => mockGetEmbeddings(...args),
  isEmbeddingAvailable: (...args: unknown[]) => mockIsEmbeddingAvailable(...args),
}))

const mockConsolidateMemory = vi.fn()
vi.mock('../../lib/memory-consolidation.js', () => ({
  consolidateMemory: (...args: unknown[]) => mockConsolidateMemory(...args),
}))

function makeNotFoundError(resource: string) {
  const err = new Error(`${resource} not found`) as Error & { statusCode: number; code: string }
  err.statusCode = 404
  err.code = 'NOT_FOUND'
  return err
}

// ── Build test app ───────────────────────────────────────────────────────────

async function buildTestApp() {
  const { default: memoriesRoutes } = await import('../../routes/memories.js')

  const app = new Hono()
  app.route('/api/memories', memoriesRoutes)

  app.onError((err, c) => {
    const statusCode = (err as { statusCode?: number }).statusCode
    if (statusCode) {
      return c.json({ error: err.message }, statusCode as never)
    }
    return c.json({ error: err.message ?? 'Internal Server Error' }, 500)
  })

  return app
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/memories/:agentId', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockEmbeddingAvailable = false
    mockRequireAgentRead.mockImplementation(() => ({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    }))
    mockRequireAgentWrite.mockImplementation(() => ({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    }))
    mockListMemoryFiles.mockReturnValue([])
    mockReadMemoryFile.mockReturnValue('file content')
    mockCheckSizeLimit.mockReturnValue(true)
    mockQueueAgentWrite.mockImplementation(async (_id: unknown, fn: () => void | Promise<void>) => {
      await fn()
    })
    mockHybridSearch.mockReturnValue({ results: [], vectorIndexReady: false })
    mockSearchByKeyword.mockReturnValue([])
    mockSearchByVector.mockReturnValue([])
    mockApplyTemporalDecay.mockImplementation((r: unknown) => r)
    mockApplyMMR.mockImplementation((r: unknown) => r)
    mockGetMemoryStats.mockReturnValue({
      fileCount: 0,
      totalSize: 0,
      dailyFileCount: 0,
      oldestFile: null,
      newestFile: null,
    })
    mockGetEmbeddings.mockResolvedValue([[0.1, 0.2, 0.3]])
    mockIsEmbeddingAvailable.mockReturnValue(mockEmbeddingAvailable)
    mockConsolidateMemory.mockResolvedValue(null)
    mockReindexAgentVectors.mockResolvedValue(undefined)
  })

  it('returns 404 for invalid agentId', async () => {
    mockRequireAgentRead.mockImplementation(() => {
      throw makeNotFoundError('Agent')
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_ghost')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Agent not found')
  })

  it('returns empty list when no memory files', async () => {
    mockListMemoryFiles.mockReturnValue([])
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toEqual([])
  })

  it('returns list of memory files', async () => {
    const files = [
      { name: 'notes.md', size: 512, mtime: 1704067200000 },
      { name: 'context.md', size: 1024, mtime: 1704153600000 },
    ]
    mockListMemoryFiles.mockReturnValue(files)
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: typeof files }
    expect(body.data).toHaveLength(2)
    expect(body.data[0].name).toBe('notes.md')
  })
})

describe('GET /api/memories/:agentId/files/*', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockEmbeddingAvailable = false
    mockRequireAgentRead.mockImplementation(() => ({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    }))
    mockReadMemoryFile.mockReturnValue('file content')
  })

  it('returns 404 for invalid agentId', async () => {
    mockRequireAgentRead.mockImplementation(() => {
      throw makeNotFoundError('Agent')
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_ghost/files/notes.md')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Agent not found')
  })

  it('returns file content for existing file', async () => {
    mockReadMemoryFile.mockReturnValue('# My Notes\nSome content here.')
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/files/notes.md')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { filename: string; content: string } }
    expect(body.data.filename).toBe('notes.md')
    expect(body.data.content).toBe('# My Notes\nSome content here.')
  })

  it('returns 404 when file does not exist', async () => {
    mockReadMemoryFile.mockImplementation(() => {
      throw new Error('File not found')
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/files/missing.md')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('File not found')
  })
})

describe('PUT /api/memories/:agentId/files/*', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockEmbeddingAvailable = false
    mockRequireAgentWrite.mockImplementation(() => ({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    }))
    mockQueueAgentWrite.mockImplementation(async (_id: unknown, fn: () => void | Promise<void>) => {
      await fn()
    })
    mockCheckSizeLimit.mockReturnValue(true)
    mockWriteMemoryFile.mockReturnValue(undefined)
    mockReindexAgentVectors.mockResolvedValue(undefined)
  })

  it('returns 404 for invalid agentId', async () => {
    mockRequireAgentWrite.mockImplementation(() => {
      throw makeNotFoundError('Agent')
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_ghost/files/notes.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Agent not found')
  })

  it('writes file and returns filename and size', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Hello, memory!' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { filename: string; size: number } }
    expect(body.data.filename).toBe('notes.md')
    expect(typeof body.data.size).toBe('number')
    expect(mockWriteMemoryFile).toHaveBeenCalledWith('agt_test', 'notes.md', 'Hello, memory!')
  })

  it('returns 413 when size limit is exceeded', async () => {
    mockCheckSizeLimit.mockReturnValue(false)
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/files/big.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x'.repeat(1000) }),
    })
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('Memory storage limit exceeded')
  })

  it('calls reindexAgentFts after writing', async () => {
    const app = await buildTestApp()
    await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'some content' }),
    })
    expect(mockReindexAgentFts).toHaveBeenCalledWith('agt_test')
  })

  it('triggers vector reindex when embedding is available', async () => {
    mockEmbeddingAvailable = true
    mockIsEmbeddingAvailable.mockReturnValue(true)
    const app = await buildTestApp()
    await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'some content' }),
    })
    expect(mockReindexAgentVectors).toHaveBeenCalled()
  })
})

describe('DELETE /api/memories/:agentId/files/*', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockEmbeddingAvailable = false
    mockRequireAgentWrite.mockImplementation(() => ({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    }))
    mockQueueAgentWrite.mockImplementation(async (_id: unknown, fn: () => void | Promise<void>) => {
      await fn()
    })
    mockDeleteMemoryFile.mockReturnValue(undefined)
  })

  it('returns 404 for invalid agentId', async () => {
    mockRequireAgentWrite.mockImplementation(() => {
      throw makeNotFoundError('Agent')
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_ghost/files/notes.md', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Agent not found')
  })

  it('deletes file and returns deleted filename', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { deleted: string } }
    expect(body.data.deleted).toBe('notes.md')
    expect(mockDeleteMemoryFile).toHaveBeenCalledWith('agt_test', 'notes.md')
  })

  it('returns 404 when file does not exist', async () => {
    mockDeleteMemoryFile.mockImplementation(() => {
      throw new Error('File not found')
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/files/missing.md', {
      method: 'DELETE',
    })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('File not found')
  })

  it('calls reindexAgentFts after deleting', async () => {
    const app = await buildTestApp()
    await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'DELETE',
    })
    expect(mockReindexAgentFts).toHaveBeenCalledWith('agt_test')
  })

  it('triggers vector reindex when embedding is available', async () => {
    mockEmbeddingAvailable = true
    mockIsEmbeddingAvailable.mockReturnValue(true)
    mockReindexAgentVectors.mockResolvedValue(undefined)
    const app = await buildTestApp()
    await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'DELETE',
    })
    expect(mockReindexAgentVectors).toHaveBeenCalled()
  })
})

describe('GET /api/memories/:agentId/search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockEmbeddingAvailable = false
    mockRequireAgentRead.mockImplementation(() => ({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    }))
    mockSearchByKeyword.mockReturnValue([])
    mockHybridSearch.mockReturnValue({ results: [], vectorIndexReady: false })
    mockApplyTemporalDecay.mockImplementation((results: unknown) => results)
    mockApplyMMR.mockImplementation((results: unknown) => results)
    mockRankMemoryResults.mockImplementation((results: unknown) => results)
  })

  it('returns 404 for invalid agentId', async () => {
    mockRequireAgentRead.mockImplementation(() => {
      throw makeNotFoundError('Agent')
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_ghost/search?q=hello')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Agent not found')
  })

  it('returns 400 when q parameter is missing', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/search')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('q parameter is required')
  })

  it('returns 400 for unknown search mode', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/search?q=note&mode=semantic')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('mode must be one of: keyword, vector, hybrid')
    expect(mockHybridSearch).not.toHaveBeenCalled()
  })

  it('searches with keyword mode and returns results', async () => {
    const results = [
      { filePath: 'notes.md', snippet: 'some note', score: 1.5, mtime: 1704067200000 },
    ]
    mockSearchByKeyword.mockReturnValue(results)
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/search?q=note&mode=keyword')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { results: typeof results; vectorIndexReady: boolean }
    }
    expect(body.data.results).toHaveLength(1)
    expect(body.data.results[0].filePath).toBe('notes.md')
    expect(mockSearchByKeyword).toHaveBeenCalledWith('agt_test', 'note', expect.any(Number))
  })

  it('searches with hybrid mode by default', async () => {
    const results = [
      { filePath: 'context.md', snippet: 'relevant context', score: 0.9, mtime: 1704153600000 },
    ]
    mockHybridSearch.mockReturnValue({ results, vectorIndexReady: false })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/search?q=context')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { results: typeof results; vectorIndexReady: boolean }
    }
    expect(body.data.results).toHaveLength(1)
    expect(mockHybridSearch).toHaveBeenCalled()
  })

  it('returns 400 for vector mode when embedding is not configured', async () => {
    mockEmbeddingAvailable = false
    mockIsEmbeddingAvailable.mockReturnValue(false)
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/search?q=test&mode=vector')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Embedding not configured')
  })

  it('respects the limit parameter', async () => {
    const manyResults = Array.from({ length: 20 }, (_, i) => ({
      filePath: `file${i}.md`,
      snippet: `content ${i}`,
      score: 1,
      mtime: 1704067200000,
    }))
    mockSearchByKeyword.mockReturnValue(manyResults)
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/search?q=test&mode=keyword&limit=3')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { results: unknown[] } }
    expect(body.data.results.length).toBeLessThanOrEqual(3)
  })
})

describe('GET /api/memories/:agentId/stats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockEmbeddingAvailable = false
    mockRequireAgentRead.mockImplementation(() => ({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    }))
    mockGetMemoryStats.mockReturnValue({
      fileCount: 0,
      totalSize: 0,
      dailyFileCount: 0,
      oldestFile: null,
      newestFile: null,
    })
  })

  it('returns 404 for invalid agentId', async () => {
    mockRequireAgentRead.mockImplementation(() => {
      throw makeNotFoundError('Agent')
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_ghost/stats')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Agent not found')
  })

  it('returns stats data for valid agent', async () => {
    const stats = {
      fileCount: 5,
      totalSize: 10240,
      dailyFileCount: 3,
      oldestFile: 'old.md',
      newestFile: 'new.md',
    }
    mockGetMemoryStats.mockReturnValue(stats)
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/stats')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: typeof stats }
    expect(body.data.fileCount).toBe(5)
    expect(body.data.totalSize).toBe(10240)
    expect(body.data.dailyFileCount).toBe(3)
    expect(mockGetMemoryStats).toHaveBeenCalledWith('agt_test')
  })
})

describe('POST /api/memories/:agentId/reindex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockEmbeddingAvailable = false
    mockRequireAgentWrite.mockImplementation(() => ({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    }))
    mockReindexAgentVectors.mockResolvedValue(undefined)
  })

  it('returns 404 for invalid agentId', async () => {
    mockRequireAgentWrite.mockImplementation(() => {
      throw makeNotFoundError('Agent')
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_ghost/reindex', { method: 'POST' })
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('Agent not found')
  })

  it('triggers reindex and returns success', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/reindex', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { reindexed: boolean } }
    expect(body.data.reindexed).toBe(true)
    expect(mockClearAgentIndex).toHaveBeenCalledWith('agt_test')
    expect(mockReindexAgentFts).toHaveBeenCalledWith('agt_test')
  })

  it('also reindexes vectors when embedding is available', async () => {
    mockEmbeddingAvailable = true
    mockIsEmbeddingAvailable.mockReturnValue(true)
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/reindex', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(mockReindexAgentVectors).toHaveBeenCalled()
  })
})

describe('POST /api/memories/:agentId/consolidate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockEmbeddingAvailable = false
    mockIsEmbeddingAvailable.mockReturnValue(false)
    mockConsolidateMemory.mockResolvedValue({ consolidatedCount: 2 })
    mockRequireAgentWrite.mockImplementation(() => ({
      agent: {
        id: 'agt_test',
        type: 'cursor',
        config: { memoryEnabled: true },
        memoryProviderApiKey: null,
      },
      permission: 'owner',
    }))
  })

  it('does not require legacy memoryProviderApiKey', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/consolidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeDays: 7 }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { consolidatedCount: number } }
    expect(body.data.consolidatedCount).toBe(2)
    expect(mockConsolidateMemory).toHaveBeenCalledWith(
      'agt_test',
      {
        agent: expect.objectContaining({
          id: 'agt_test',
          memoryProviderApiKey: null,
        }),
      },
      { maxAgeDays: 7 },
    )
  })

  // A negative window puts the cutoff in the future, so every daily log — today's
  // included — reads as older than it and is summarised away and deleted. The body
  // was previously taken by cast, which performs no checking at all.
  it('rejects a non-positive maxAgeDays instead of inverting the cutoff', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/consolidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxAgeDays: -1 }),
    })

    expect(res.status).toBe(400)
    expect(mockConsolidateMemory).not.toHaveBeenCalled()
  })

  it('returns zero count when provider consolidation has nothing to do', async () => {
    mockConsolidateMemory.mockResolvedValue(null)

    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/consolidate', { method: 'POST' })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { consolidatedCount: number } }
    expect(body.data.consolidatedCount).toBe(0)
  })
})

describe('Topic hierarchy routes', () => {
  const topic = {
    topicId: 'tpc_a1b2c3d4',
    title: 'Campaign mail delivery',
    scope: 'Campaign mail creation and release behavior.',
    description: 'Campaign mail contracts and release checks.',
    keywords: ['campaign', 'send_mail'],
    status: 'active',
    updatedAt: '2026-07-29T00:00:00.000Z',
    path: 'memory/topics/tpc_a1b2c3d4-campaign-mail-delivery.md',
    body: '# Campaign mail delivery\n\n## Durable Knowledge\n\n- Keep V3 compatibility.',
    size: 300,
    tokenCount: 80,
    needsReorganization: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockRequireAgentRead.mockReturnValue({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    })
    mockRequireAgentWrite.mockReturnValue({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    })
    mockListMemoryTopics.mockReturnValue({
      mode: 'topic_v2',
      topics: [topic],
      invalidFiles: [],
    })
    mockReadMemoryTopic.mockReturnValue(topic)
    mockApplyInsightToTopics.mockReturnValue({
      topic,
      created: true,
      warning: null,
      retainedInHistory: false,
    })
    mockDetectMemoryHierarchyMode.mockReturnValue('topic_v2')
    mockQueueAgentWrite.mockImplementation(async (_id: unknown, fn: () => void | Promise<void>) => {
      await fn()
    })
    mockIsEmbeddingAvailable.mockReturnValue(false)
  })

  it('lists topic metadata without returning topic bodies', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/topics')

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      data: { mode: string; topics: Array<Record<string, unknown>> }
    }
    expect(json.data.mode).toBe('topic_v2')
    expect(json.data.topics[0].topicId).toBe(topic.topicId)
    expect(json.data.topics[0].body).toBeUndefined()
  })

  it('reads one active topic by stable ID', async () => {
    const app = await buildTestApp()
    const res = await app.request(`/api/memories/agt_test/topics/${topic.topicId}`)

    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { content: string } }
    expect(json.data.content).toContain('Keep V3 compatibility.')
    expect(mockReadMemoryTopic).toHaveBeenCalledWith('agt_test', topic.topicId)
  })

  it('recalls the single best active topic in one bounded request', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/topics/recall?q=campaign%20mail')

    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      data: { topicId: string; content: string; budget: null }
    }
    expect(json.data).toMatchObject({
      topicId: topic.topicId,
      content: expect.stringContaining('Keep V3 compatibility.'),
      budget: null,
    })
    expect(mockListMemoryTopics).toHaveBeenCalledWith('agt_test', 'active')
    expect(mockSearchByKeyword).not.toHaveBeenCalled()
    expect(mockReadMemoryTopic).toHaveBeenCalledTimes(1)
    expect(mockReadMemoryTopic).toHaveBeenCalledWith('agt_test', topic.topicId)
  })

  it('returns no topic without disclosing history when bounded recall has no active match', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/topics/recall?q=unmatched')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: null })
    expect(mockSearchByKeyword).not.toHaveBeenCalled()
    expect(mockReadMemoryTopic).not.toHaveBeenCalled()
  })

  it('routes an explicit remember request through the server-owned topic writer', async () => {
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/topics/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: topic.title,
        scope: topic.scope,
        description: topic.description,
        keywords: topic.keywords,
        section: 'Durable Knowledge',
        items: ['Keep V3 compatibility.'],
      }),
    })

    expect(res.status).toBe(200)
    expect(mockApplyInsightToTopics).toHaveBeenCalledWith(
      'agt_test',
      expect.objectContaining({ title: topic.title }),
      { allowSingleNewTopicItem: true },
    )
    expect(mockReindexAgentFts).toHaveBeenCalledWith('agt_test')
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'memory.update',
        resource: 'memory',
        resourceId: 'agt_test',
        details: expect.objectContaining({ operation: 'remember' }),
      }),
    )
  })

  it('keeps one-call remember fail-closed for legacy single-file memory', async () => {
    mockDetectMemoryHierarchyMode.mockReturnValue('legacy_single_file')
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/topics/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: topic.title,
        scope: topic.scope,
        description: topic.description,
        keywords: topic.keywords,
        section: 'Durable Knowledge',
        items: ['Keep V3 compatibility.'],
      }),
    })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'LEGACY_SINGLE_FILE' })
    expect(mockApplyInsightToTopics).not.toHaveBeenCalled()
  })

  it('reports history-only retention when a topic write reaches its hard limit', async () => {
    mockApplyInsightToTopics.mockReturnValue({
      topic,
      created: false,
      warning: 'needs_reorganization',
      retainedInHistory: true,
      reason: 'topic_hard_limit',
    })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/topics/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: topic.title,
        scope: topic.scope,
        description: topic.description,
        keywords: topic.keywords,
        items: ['New durable fact.'],
      }),
    })

    expect(res.status).toBe(409)
    const json = (await res.json()) as { code: string }
    expect(json.code).toBe('topic_hard_limit')
    expect(mockReindexAgentFts).not.toHaveBeenCalled()
  })

  it('archives a topic through the editor-only reorganize route', async () => {
    mockArchiveMemoryTopic.mockReturnValue({ ...topic, status: 'archived' })
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/topics/reorganize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'archive', topicId: topic.topicId }),
    })

    expect(res.status).toBe(200)
    expect(mockArchiveMemoryTopic).toHaveBeenCalledWith('agt_test', topic.topicId)
  })

  it('splits a topic only through an explicit coverage plan', async () => {
    const replacements = [
      {
        title: 'Mail adapter contract',
        scope: 'Mail adapter selection.',
        description: 'Mail adapter contract.',
        keywords: ['mail', 'adapter'],
        sections: [
          {
            section: 'Durable Knowledge',
            items: [{ sourceHash: 'hash-a', content: '- Keep V3 compatibility.' }],
          },
        ],
      },
      {
        title: 'Mail release checks',
        scope: 'Mail release validation.',
        description: 'Mail release checks.',
        keywords: ['mail', 'release'],
        sections: [
          {
            section: 'Workflows',
            items: [{ sourceHash: 'hash-b', content: '- Run focused tests.' }],
          },
        ],
      },
    ]
    mockSplitMemoryTopic.mockReturnValue([{ ...topic, topicId: 'tpc_11111111' }])
    const app = await buildTestApp()
    const res = await app.request('/api/memories/agt_test/topics/reorganize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'split', topicId: topic.topicId, replacements }),
    })

    expect(res.status).toBe(200)
    expect(mockSplitMemoryTopic).toHaveBeenCalledWith('agt_test', topic.topicId, replacements)
    expect(mockReindexAgentFts).toHaveBeenCalledWith('agt_test')
  })

  it('previews and commits legacy topicization through a two-step editor flow', async () => {
    const preview = {
      proposalId: 'mtp_test',
      sourceBlockCount: 2,
      topics: [{ topicId: topic.topicId, title: topic.title, sourceBlockCount: 2 }],
      summary: [],
      manifest: [],
    }
    mockProposeLegacyTopicization.mockResolvedValue(preview)
    mockCommitLegacyTopicization.mockReturnValue(preview)
    const app = await buildTestApp()

    const previewRes = await app.request('/api/memories/agt_test/topics/reorganize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'topicize-preview' }),
    })
    expect(previewRes.status).toBe(200)
    expect(mockProposeLegacyTopicization).toHaveBeenCalledWith(
      'agt_test',
      expect.objectContaining({ agent: expect.objectContaining({ id: 'agt_test' }) }),
    )

    const commitRes = await app.request('/api/memories/agt_test/topics/reorganize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'topicize-commit', proposalId: 'mtp_test' }),
    })
    expect(commitRes.status).toBe(200)
    expect(mockCommitLegacyTopicization).toHaveBeenCalledWith('agt_test', 'mtp_test')
  })
})

// ── Auth coverage: agent token ────────────────────────────────────────────────

describe('Auth: agent token routes', () => {
  function buildTokenApp(agentTokenId: string, agentMemoryToken?: string) {
    return buildTestApp().then((app) => {
      const tokenApp = new Hono()
      tokenApp.use('*', async (c, next) => {
        c.set('agentTokenId' as never, agentTokenId as never)
        if (agentMemoryToken) {
          c.set('agentMemoryToken' as never, agentMemoryToken as never)
        }
        await next()
      })
      tokenApp.route('/', app)
      return tokenApp
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockListMemoryFiles.mockReturnValue([])
    mockCheckSizeLimit.mockReturnValue(true)
    mockQueueAgentWrite.mockImplementation(async (_id: unknown, fn: () => void | Promise<void>) => {
      await fn()
    })
    const tokenTopic = {
      topicId: 'tpc_a1b2c3d4',
      title: 'Test topic',
      scope: 'Test scope.',
      description: 'Test topic.',
      keywords: ['test'],
      status: 'active',
      updatedAt: '2026-07-29T00:00:00.000Z',
      path: 'memory/topics/tpc_a1b2c3d4-test-topic.md',
      body: '# Test topic\n\n- Fact.',
      size: 40,
      tokenCount: 1000,
      needsReorganization: false,
    }
    mockReadMemoryTopic.mockReturnValue(tokenTopic)
    mockListMemoryTopics.mockReturnValue({
      mode: 'topic_v2',
      topics: [tokenTopic],
      invalidFiles: [],
    })
  })

  it('allows read when agentTokenId matches route agentId', async () => {
    const app = await buildTokenApp('agt_test')
    const res = await app.request('/api/memories/agt_test')
    expect(res.status).toBe(200)
    expect(mockRequireAgentRead).not.toHaveBeenCalled()
  })

  it('returns 403 when agentTokenId does not match route agentId', async () => {
    const app = await buildTokenApp('agt_other')
    const res = await app.request('/api/memories/agt_test')
    expect(res.status).toBe(403)
  })

  it('allows write when agentTokenId matches route agentId', async () => {
    mockWriteMemoryFile.mockReturnValue(undefined)
    const app = await buildTokenApp('agt_test')
    const res = await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(200)
    expect(mockRequireAgentWrite).not.toHaveBeenCalled()
  })

  it('returns 403 on write when agentTokenId does not match route agentId', async () => {
    const app = await buildTokenApp('agt_other')
    const res = await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello' }),
    })
    expect(res.status).toBe(403)
  })

  // A read-only question mints a read-only runtime token, but requireMemoryWrite
  // short-circuits on the token path without consulting viewer/editor. These two
  // routes are destructive and irreversible — consolidation deletes daily logs —
  // so, like topics/reorganize, they must refuse a runtime token outright rather
  // than let an Agent subprocess rewrite its own memory.
  it('refuses a runtime token on the destructive consolidate route', async () => {
    const { registerAgentToken } = await import('../../lib/agent-memory-token.js')
    const token = registerAgentToken('agt_test', {})
    const app = await buildTokenApp('agt_test', token)

    const res = await app.request('/api/memories/agt_test/consolidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(403)
    expect(mockConsolidateMemory).not.toHaveBeenCalled()
  })

  it('refuses a runtime token on the destructive reindex route', async () => {
    const { registerAgentToken } = await import('../../lib/agent-memory-token.js')
    const token = registerAgentToken('agt_test', {})
    const app = await buildTokenApp('agt_test', token)

    const res = await app.request('/api/memories/agt_test/reindex', { method: 'POST' })

    expect(res.status).toBe(403)
    expect(mockClearAgentIndex).not.toHaveBeenCalled()
  })

  it('enforces runtime topic-read budgets', async () => {
    const { registerAgentToken } = await import('../../lib/agent-memory-token.js')
    const token = registerAgentToken('agt_test', { maxTopicReads: 2, maxTopicTokens: 2500 })
    const app = await buildTokenApp('agt_test', token)

    expect((await app.request('/api/memories/agt_test/topics/tpc_a1b2c3d4')).status).toBe(200)
    expect((await app.request('/api/memories/agt_test/topics/tpc_a1b2c3d4')).status).toBe(200)
    const denied = await app.request('/api/memories/agt_test/topics/tpc_a1b2c3d4')
    expect(denied.status).toBe(429)
  })

  it('charges one-call recall against the same runtime topic-read budget', async () => {
    const { registerAgentToken } = await import('../../lib/agent-memory-token.js')
    const token = registerAgentToken('agt_test', { maxTopicReads: 1, maxTopicTokens: 1500 })
    const app = await buildTokenApp('agt_test', token)

    expect((await app.request('/api/memories/agt_test/topics/recall?q=test')).status).toBe(200)
    expect((await app.request('/api/memories/agt_test/topics/recall?q=test')).status).toBe(429)
  })

  it('blocks raw runtime reads of managed topics so they cannot bypass disclosure budgets', async () => {
    const { registerAgentToken } = await import('../../lib/agent-memory-token.js')
    const token = registerAgentToken('agt_test')
    const app = await buildTokenApp('agt_test', token)

    const active = await app.request(
      '/api/memories/agt_test/files/memory/topics/tpc_a1b2c3d4-test-topic.md',
    )
    expect(active.status).toBe(403)
    expect(await active.json()).toMatchObject({ code: 'TOPIC_READ_REQUIRES_BUDGET' })

    const archived = await app.request(
      '/api/memories/agt_test/files/memory/topics/archive/tpc_a1b2c3d4-test-topic.md',
    )
    expect(archived.status).toBe(403)
    expect(mockReadMemoryFile).not.toHaveBeenCalled()
  })

  it('treats raw runtime history reads as search actions', async () => {
    mockReadMemoryFile.mockReturnValue('historical evidence')
    const { registerAgentToken } = await import('../../lib/agent-memory-token.js')
    const searchToken = registerAgentToken('agt_test', { allowedActions: ['search'] })
    const searchApp = await buildTokenApp('agt_test', searchToken)
    expect(
      (await searchApp.request('/api/memories/agt_test/files/memory/2026-07-29.md')).status,
    ).toBe(200)

    const listToken = registerAgentToken('agt_test', { allowedActions: ['topics:list'] })
    const listApp = await buildTokenApp('agt_test', listToken)
    expect(
      (await listApp.request('/api/memories/agt_test/files/memory/2026-07-29.md')).status,
    ).toBe(403)
  })

  it('enforces runtime allowed actions', async () => {
    const { registerAgentToken } = await import('../../lib/agent-memory-token.js')
    const token = registerAgentToken('agt_test', { allowedActions: ['search'] })
    const app = await buildTokenApp('agt_test', token)

    const res = await app.request('/api/memories/agt_test/topics')
    expect(res.status).toBe(403)
  })

  it('rejects every write path for a read-only runtime token', async () => {
    const { registerAgentToken } = await import('../../lib/agent-memory-token.js')
    const token = registerAgentToken('agt_test', {
      allowedActions: ['topics:list', 'topics:read', 'search'],
    })
    const app = await buildTokenApp('agt_test', token)

    const remember = await app.request('/api/memories/agt_test/topics/remember', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Denied topic',
        scope: 'Denied runtime write.',
        description: 'Denied runtime write.',
        keywords: ['denied'],
        items: ['This must not be written.'],
      }),
    })
    const replaceFile = await app.request('/api/memories/agt_test/files/MEMORY.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Denied replacement.' }),
    })
    const deleteFile = await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'DELETE',
    })

    expect(remember.status).toBe(403)
    expect(replaceFile.status).toBe(403)
    expect(deleteFile.status).toBe(403)
    expect(mockApplyInsightToTopics).not.toHaveBeenCalled()
    expect(mockWriteMemoryFile).not.toHaveBeenCalled()
    expect(mockDeleteMemoryFile).not.toHaveBeenCalled()
  })

  it('keeps archived topic snippets available as bounded L2 runtime evidence', async () => {
    mockSearchByKeyword.mockReturnValue([
      {
        filePath: 'memory/topics/archive/tpc_a1b2c3d4-test-topic.md',
        snippet: 'Archived evidence.',
        score: 1,
        mtime: 0,
        fileKind: 'archived_topic',
        topicId: 'tpc_a1b2c3d4',
        topicStatus: 'archived',
      },
    ])
    mockApplyTemporalDecay.mockImplementation((results: unknown) => results)
    mockApplyMMR.mockImplementation((results: unknown) => results)
    mockRankMemoryResults.mockImplementation((results: unknown) => results)
    mockRequireAgentRead.mockReturnValue({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    })
    const { registerAgentToken } = await import('../../lib/agent-memory-token.js')
    const token = registerAgentToken('agt_test', { allowedActions: ['search'] })
    const app = await buildTokenApp('agt_test', token)

    const response = await app.request(
      '/api/memories/agt_test/search?q=archived&mode=keyword&limit=5',
    )
    const payload = (await response.json()) as { data: { results: Array<{ fileKind: string }> } }

    expect(response.status).toBe(200)
    expect(payload.data.results).toEqual([
      expect.objectContaining({ fileKind: 'archived_topic', topicStatus: 'archived' }),
    ])
  })
})

// ── Auth coverage: simulate JWT-authenticated user ──────────────────────────

describe('Auth: JWT-authenticated user routes', () => {
  function buildAuthApp() {
    return buildTestApp().then((app) => {
      // Wrap with middleware that sets userId (simulates JWT auth)
      const authApp = new Hono()
      authApp.use('*', async (c, next) => {
        c.set('userId' as never, 'usr_test' as never)
        await next()
      })
      authApp.route('/', app)
      return authApp
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentExists = true
    mockEmbeddingAvailable = false
    mockRequireAgentRead.mockReturnValue({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    })
    mockRequireAgentWrite.mockReturnValue({
      agent: { id: 'agt_test', config: {} },
      permission: 'owner',
    })
    mockListMemoryFiles.mockReturnValue([])
    mockCheckSizeLimit.mockReturnValue(true)
    mockQueueAgentWrite.mockImplementation(async (_id: unknown, fn: () => void | Promise<void>) => {
      await fn()
    })
  })

  it('delegates to requireAgentRead when userId is present', async () => {
    const app = await buildAuthApp()
    const res = await app.request('/api/memories/agt_test')
    expect(res.status).toBe(200)
    expect(mockRequireAgentRead).toHaveBeenCalledWith(expect.anything(), 'agt_test')
  })

  it('returns 403 when requireAgentRead throws ForbiddenError', async () => {
    const { ForbiddenError } = await import('../../lib/errors.js')
    mockRequireAgentRead.mockImplementation(() => {
      throw new ForbiddenError()
    })
    const app = await buildAuthApp()
    const res = await app.request('/api/memories/agt_test')
    expect(res.status).toBe(403)
  })

  it('returns 404 when requireAgentRead throws NotFoundError', async () => {
    const { NotFoundError } = await import('../../lib/errors.js')
    mockRequireAgentRead.mockImplementation(() => {
      throw new NotFoundError('Agent')
    })
    const app = await buildAuthApp()
    const res = await app.request('/api/memories/agt_test')
    expect(res.status).toBe(404)
  })

  it('delegates to requireAgentWrite for write operations when userId is present', async () => {
    mockWriteMemoryFile.mockReturnValue(undefined)
    const app = await buildAuthApp()
    const res = await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    })
    expect(res.status).toBe(200)
    expect(mockRequireAgentWrite).toHaveBeenCalledWith(expect.anything(), 'agt_test')
  })

  it('returns 403 when requireAgentWrite throws ForbiddenError on write', async () => {
    const { ForbiddenError } = await import('../../lib/errors.js')
    mockRequireAgentWrite.mockImplementation(() => {
      throw new ForbiddenError()
    })
    const app = await buildAuthApp()
    const res = await app.request('/api/memories/agt_test/files/notes.md', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    })
    expect(res.status).toBe(403)
  })
})
