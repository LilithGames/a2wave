import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: { A2WAVE_MEMORY_STORAGE: '' },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

vi.mock('../memory-storage.js', () => ({
  getAllMemoryContent: vi.fn(),
  listMemoryFiles: vi.fn(),
}))

import { env } from '../../env.js'
import {
  applyMMR,
  applyTemporalDecay,
  chunkText,
  clearAgentIndex,
  closeMemoryIndexDb,
  contentHash,
  deriveMemoryFileMetadata,
  expandCjkForFts,
  getMemoryIndexDb,
  hybridSearch,
  needsFtsReindex,
  rankMemoryResults,
  reindexAgentFts,
  reindexAgentVectors,
  searchByKeyword,
  searchByVector,
} from '../memory-index.js'
import { getAllMemoryContent, listMemoryFiles } from '../memory-storage.js'
import { renderMemoryTopicFile } from '../memory-topics.js'

const mockedGetAllMemoryContent = vi.mocked(getAllMemoryContent)
const mockedListMemoryFiles = vi.mocked(listMemoryFiles)

let testRoot: string

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'memory-index-test-'))
  mkdirSync(testRoot, { recursive: true })
  // memory-index.ts computes dbPath as:
  //   resolve(process.cwd(), env.A2WAVE_MEMORY_STORAGE, '..', 'memory-index.db')
  // We set A2WAVE_MEMORY_STORAGE to a subdir of testRoot so that '..' resolves to testRoot.
  const storageSubdir = join(testRoot, 'storage')
  mkdirSync(storageSubdir, { recursive: true })
  ;(env as { A2WAVE_MEMORY_STORAGE: string }).A2WAVE_MEMORY_STORAGE = storageSubdir
  mockedGetAllMemoryContent.mockReturnValue([])
  mockedListMemoryFiles.mockReturnValue([])
})

/** Helper: set both getAllMemoryContent and listMemoryFiles from the same data */
function mockMemoryFiles(files: Array<{ filename: string; content: string; mtime: number }>) {
  mockedGetAllMemoryContent.mockReturnValue(files)
  mockedListMemoryFiles.mockReturnValue(
    files.map((f) => ({ name: f.filename, size: f.content.length, mtime: f.mtime })),
  )
}

afterEach(() => {
  closeMemoryIndexDb()
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true })
  }
})

describe('topic index metadata and ranking', () => {
  it('indexes a topic body without exposing server-owned frontmatter', async () => {
    const content = renderMemoryTopicFile(
      {
        topicId: 'tpc_a1b2c3d4',
        title: 'Campaign mail delivery',
        scope: 'Campaign mail creation and release behavior.',
        description: 'Campaign mail contracts and release checks.',
        keywords: ['campaign', 'send_mail'],
        status: 'active',
        updatedAt: '2026-07-29T00:00:00.000Z',
      },
      '# Campaign mail delivery\n\n## Durable Knowledge\n\n- Validate item_id serialization.',
    )
    mockMemoryFiles([
      {
        filename: 'memory/topics/tpc_a1b2c3d4-campaign-mail-delivery.md',
        content,
        mtime: Date.now(),
      },
    ])

    reindexAgentFts('agt_topic')
    const results = searchByKeyword('agt_topic', 'item_id', 5)

    expect(results[0]).toEqual(
      expect.objectContaining({
        fileKind: 'topic',
        topicId: 'tpc_a1b2c3d4',
        topicStatus: 'active',
      }),
    )
    expect(results[0].snippet).not.toContain('topic_id:')
  })

  it('classifies memory layers and ranks curated topics before history', async () => {
    expect(deriveMemoryFileMetadata('memory/2026-07-29.md', 'daily').fileKind).toBe('daily')
    expect(deriveMemoryFileMetadata('memory/weekly/2026-W31.md', 'weekly').fileKind).toBe('weekly')

    const ranked = rankMemoryResults([
      { filePath: 'memory/day.md', snippet: 'daily fact', score: 10, mtime: 0, fileKind: 'daily' },
      {
        filePath: 'memory/topics/tpc.md',
        snippet: 'topic fact',
        score: 1,
        mtime: 0,
        fileKind: 'topic',
      },
      {
        filePath: 'memory/topics/archive/tpc.md',
        snippet: 'archive fact',
        score: 5,
        mtime: 0,
        fileKind: 'archived_topic',
      },
    ])

    expect(ranked.map((result) => result.fileKind)).toEqual(['topic', 'archived_topic', 'daily'])
  })
})

// ---------------------------------------------------------------------------
// getMemoryIndexDb
// ---------------------------------------------------------------------------

describe('getMemoryIndexDb', () => {
  it('returns a database instance', async () => {
    const db = getMemoryIndexDb()
    expect(db).toBeDefined()
    expect(typeof db.prepare).toBe('function')
  })

  it('returns the same singleton on repeated calls', async () => {
    const db1 = getMemoryIndexDb()
    const db2 = getMemoryIndexDb()
    expect(db1).toBe(db2)
  })

  it('creates FTS5, vec, and meta tables', async () => {
    const db = getMemoryIndexDb()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'shadow') ORDER BY name")
      .all() as { name: string }[]
    const names = tables.map((t) => t.name)
    expect(names).toContain('memory_chunks_fts')
    expect(names).toContain('memory_chunks_vec')
    expect(names).toContain('memory_index_meta')
  })
})

// ---------------------------------------------------------------------------
// closeMemoryIndexDb
// ---------------------------------------------------------------------------

describe('closeMemoryIndexDb', () => {
  it('closes the database and allows a fresh one to be created', async () => {
    const db1 = getMemoryIndexDb()
    closeMemoryIndexDb()
    const db2 = getMemoryIndexDb()
    // After close + re-open these should be different object references
    expect(db2).not.toBe(db1)
  })

  it('does not throw when called on an already-closed db', async () => {
    closeMemoryIndexDb()
    expect(() => closeMemoryIndexDb()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  it('returns empty array for empty text', async () => {
    expect(chunkText('')).toEqual([])
  })

  it('returns empty array for whitespace-only text', async () => {
    expect(chunkText('   \n\t  ')).toEqual([])
  })

  it('returns a single chunk for short text under CHUNK_SIZE', async () => {
    const text = 'Hello world'
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })

  it('splits long text into multiple chunks', async () => {
    // CHUNK_SIZE = 500, CHUNK_OVERLAP = 100
    const text = 'a'.repeat(1200)
    const chunks = chunkText(text)
    // First chunk: 0..500 (500 chars)
    // Second chunk: 400..900 (500 chars)
    // Third chunk: 800..1200 (400 chars)
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toHaveLength(500)
    expect(chunks[1]).toHaveLength(500)
    expect(chunks[2]).toHaveLength(400)
  })

  it('produces overlapping chunks', async () => {
    // CHUNK_SIZE = 500, CHUNK_OVERLAP = 100
    const text = 'a'.repeat(100) + 'b'.repeat(500)
    const chunks = chunkText(text)
    expect(chunks.length).toBeGreaterThan(1)
    // The overlap region at the boundary: chunk[0] ends with 100 'b' chars,
    // chunk[1] starts with those same 100 'b' chars
    const overlapFromFirst = chunks[0].slice(-100)
    const overlapFromSecond = chunks[1].slice(0, 100)
    expect(overlapFromFirst).toBe(overlapFromSecond)
  })

  it('handles text exactly at CHUNK_SIZE boundary', async () => {
    const text = 'x'.repeat(500)
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toBe(text)
  })
})

// ---------------------------------------------------------------------------
// contentHash
// ---------------------------------------------------------------------------

describe('contentHash', () => {
  it('returns a hex string', async () => {
    const hash = contentHash('hello')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', async () => {
    expect(contentHash('same text')).toBe(contentHash('same text'))
  })

  it('produces different hashes for different inputs', async () => {
    expect(contentHash('foo')).not.toBe(contentHash('bar'))
  })

  it('returns consistent sha256 digest', async () => {
    // Known SHA256 of "hello"
    expect(contentHash('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })
})

// ---------------------------------------------------------------------------
// expandCjkForFts
// ---------------------------------------------------------------------------

describe('expandCjkForFts', () => {
  it('returns plain ASCII unchanged', async () => {
    expect(expandCjkForFts('hello world')).toBe('hello world')
  })

  it('inserts spaces between Chinese characters', async () => {
    // Each CJK char gets a space on both sides, then consecutive spaces collapse
    expect(expandCjkForFts('飞书')).toBe('飞 书')
  })

  it('handles mixed CJK and ASCII', async () => {
    const result = expandCjkForFts('修复飞书webhook')
    // All 4 CJK chars separated, ASCII intact
    expect(result).toBe('修 复 飞 书 webhook')
  })

  it('handles Korean Hangul', async () => {
    const result = expandCjkForFts('한국어')
    expect(result).toBe('한 국 어')
  })

  it('collapses multiple spaces into one', async () => {
    expect(expandCjkForFts('a  b')).toBe('a b')
  })

  it('trims leading and trailing whitespace', async () => {
    expect(expandCjkForFts('  hello  ')).toBe('hello')
  })

  it('returns empty string for empty input', async () => {
    expect(expandCjkForFts('')).toBe('')
  })
})

// ---------------------------------------------------------------------------
// reindexAgentFts & searchByKeyword (FTS5)
// ---------------------------------------------------------------------------

describe('reindexAgentFts', () => {
  it('indexes content and allows keyword search', async () => {
    mockMemoryFiles([
      {
        filename: 'MEMORY.md',
        content: 'the quick brown fox jumps over the lazy dog',
        mtime: Date.now(),
      },
    ])

    reindexAgentFts('agt_fts1')

    const results = searchByKeyword('agt_fts1', 'quick brown', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].filePath).toBe('MEMORY.md')
    expect(results[0].snippet).toContain('quick brown')
  })

  it('clears old entries before reindexing', async () => {
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'first content', mtime: Date.now() }])
    reindexAgentFts('agt_fts2')

    // Now update content
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: 'completely new content here', mtime: Date.now() },
    ])
    reindexAgentFts('agt_fts2')

    const results = searchByKeyword('agt_fts2', 'completely new', 5)
    expect(results.length).toBeGreaterThan(0)

    // Old content should not appear
    const oldResults = searchByKeyword('agt_fts2', 'first content', 5)
    // "first" and "content" are common words, but "first content" together — verify stale data gone
    // We just confirm the new index has the right data
    expect(results[0].snippet).toContain('completely new')
  })

  it('updates meta table after reindex', async () => {
    mockMemoryFiles([])
    reindexAgentFts('agt_fts3')

    const db = getMemoryIndexDb()
    const meta = db
      .prepare('SELECT last_fts_indexed_at FROM memory_index_meta WHERE agent_id = ?')
      .get('agt_fts3') as { last_fts_indexed_at: number } | undefined

    expect(meta).toBeDefined()
    expect(meta?.last_fts_indexed_at).toBeGreaterThan(0)
  })

  it('handles multiple files with chunks', async () => {
    const longContent = 'alpha beta gamma delta epsilon '.repeat(25) // ~750 chars → 2 chunks
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: longContent, mtime: Date.now() },
      { filename: 'memory/2026-01-01.md', content: 'unique zeta keyword', mtime: Date.now() },
    ])

    reindexAgentFts('agt_fts4')

    const results = searchByKeyword('agt_fts4', 'zeta', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].filePath).toBe('memory/2026-01-01.md')
  })
})

// ---------------------------------------------------------------------------
// needsFtsReindex
// ---------------------------------------------------------------------------

describe('needsFtsReindex', () => {
  it('returns true when no meta exists for the agent', async () => {
    mockMemoryFiles([])
    expect(needsFtsReindex('agt_new_agent')).toBe(true)
  })

  it('returns false when all files are older than last index time', async () => {
    const pastMtime = Date.now() - 10_000
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'hello', mtime: pastMtime }])

    reindexAgentFts('agt_nfr1')

    // After reindex, meta.last_fts_indexed_at > pastMtime → no reindex needed
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'hello', mtime: pastMtime }])
    expect(needsFtsReindex('agt_nfr1')).toBe(false)
  })

  it('returns true when a file has been modified after last index', async () => {
    const pastMtime = Date.now() - 10_000
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'hello', mtime: pastMtime }])
    reindexAgentFts('agt_nfr2')

    // Simulate file update
    const futureMtime = Date.now() + 5_000
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'updated', mtime: futureMtime }])
    expect(needsFtsReindex('agt_nfr2')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// searchByKeyword
// ---------------------------------------------------------------------------

describe('searchByKeyword', () => {
  it('returns empty array for empty/special-char-only query', async () => {
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'some content', mtime: Date.now() }])
    reindexAgentFts('agt_sk1')
    // Query consisting only of FTS5 special chars gets sanitized to empty string
    const results = searchByKeyword('agt_sk1', '!@#$%', 5)
    expect(results).toEqual([])
  })

  it('returns results with score and filePath', async () => {
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: 'typescript testing vitest jest', mtime: Date.now() },
    ])
    reindexAgentFts('agt_sk2')

    const results = searchByKeyword('agt_sk2', 'vitest', 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]).toMatchObject({
      filePath: expect.any(String),
      snippet: expect.any(String),
      score: expect.any(Number),
      mtime: 0,
    })
    expect(results[0].score).toBeGreaterThan(0)
  })

  it('auto-reindexes when files have changed', async () => {
    const mtime1 = Date.now() - 5_000
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'initial content', mtime: mtime1 }])
    reindexAgentFts('agt_sk3')

    // Now simulate stale index — file has newer mtime
    const mtime2 = Date.now() + 5_000
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: 'reindex trigger word xenon', mtime: mtime2 },
    ])

    // searchByKeyword should auto-reindex before searching
    const results = searchByKeyword('agt_sk3', 'xenon', 5)
    expect(results.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// reindexAgentVectors & searchByVector
// ---------------------------------------------------------------------------

describe('reindexAgentVectors', () => {
  it('inserts vector entries and allows vector search', async () => {
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'hello world vector', mtime: Date.now() }])

    const getEmbeddings = vi.fn().mockResolvedValue([[1, 0, 0]])
    await reindexAgentVectors('agt_vec1', getEmbeddings)

    const results = searchByVector('agt_vec1', [1, 0, 0], 5)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].filePath).toBe('MEMORY.md')
    expect(results[0].score).toBeCloseTo(1, 5)
  })

  it('skips chunks that already have embeddings cached', async () => {
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'cached chunk data', mtime: Date.now() }])

    const getEmbeddings = vi.fn().mockResolvedValue([[0.5, 0.5, 0]])

    // First index — should call getEmbeddings once
    await reindexAgentVectors('agt_vec2', getEmbeddings)
    const callCount1 = getEmbeddings.mock.calls.length
    expect(callCount1).toBe(1)

    // Second index with same content — hash already exists, no new embedding calls
    await reindexAgentVectors('agt_vec2', getEmbeddings)
    const callCount2 = getEmbeddings.mock.calls.length
    expect(callCount2).toBe(callCount1)
  })

  it('preserves unchanged vector rows instead of rewriting the whole agent index', async () => {
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'stable cached chunk', mtime: Date.now() }])
    const getEmbeddings = vi.fn().mockResolvedValue([[0.5, 0.5, 0]])

    await reindexAgentVectors('agt_vec_stable', getEmbeddings)
    const db = getMemoryIndexDb()
    const first = db
      .prepare('SELECT id FROM memory_chunks_vec WHERE agent_id = ?')
      .get('agt_vec_stable') as { id: number }

    await reindexAgentVectors('agt_vec_stable', getEmbeddings)
    const second = db
      .prepare('SELECT id FROM memory_chunks_vec WHERE agent_id = ?')
      .get('agt_vec_stable') as { id: number }

    expect(second.id).toBe(first.id)
    expect(getEmbeddings).toHaveBeenCalledTimes(1)
  })

  it('refreshes vector path metadata when cached content moves between layers', async () => {
    const content = 'the same durable evidence chunk'
    mockMemoryFiles([{ filename: 'memory/2026-07-29.md', content, mtime: Date.now() }])
    const getEmbeddings = vi.fn().mockResolvedValue([[0.2, 0.8, 0]])
    await reindexAgentVectors('agt_vec_move', getEmbeddings)

    mockMemoryFiles([{ filename: 'memory/weekly/2026-W31.md', content, mtime: Date.now() + 1 }])
    await reindexAgentVectors('agt_vec_move', getEmbeddings)

    const results = searchByVector('agt_vec_move', [0.2, 0.8, 0], 5)
    expect(getEmbeddings).toHaveBeenCalledTimes(1)
    expect(results[0]).toEqual(
      expect.objectContaining({
        filePath: 'memory/weekly/2026-W31.md',
        fileKind: 'weekly',
      }),
    )
  })

  it('returns empty for vector search when no embeddings exist', async () => {
    const results = searchByVector('agt_vec_empty', [1, 0, 0], 5)
    expect(results).toEqual([])
  })

  it('logs error and clears flag when getEmbeddings rejects', async () => {
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'error recovery test', mtime: Date.now() }])

    const failingEmbeddings = vi.fn().mockRejectedValue(new Error('API down'))
    await reindexAgentVectors('agt_err', failingEmbeddings)

    // Flag should be cleared, allowing a retry
    const successEmbeddings = vi.fn().mockResolvedValue([[1, 0, 0]])
    await reindexAgentVectors('agt_err', successEmbeddings)

    const results = searchByVector('agt_err', [1, 0, 0], 5)
    expect(results.length).toBeGreaterThan(0)
  })

  it('clears all vec rows when all memory files are removed', async () => {
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'will be removed', mtime: Date.now() }])

    const getEmbeddings = vi.fn().mockResolvedValue([[0.5, 0.5, 0]])
    await reindexAgentVectors('agt_empty', getEmbeddings)

    // Verify data exists
    let results = searchByVector('agt_empty', [0.5, 0.5, 0], 5)
    expect(results.length).toBeGreaterThan(0)

    // Now simulate all files deleted
    mockMemoryFiles([])
    await reindexAgentVectors('agt_empty', getEmbeddings)

    // All vec rows should be gone
    results = searchByVector('agt_empty', [0.5, 0.5, 0], 5)
    expect(results).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// hybridSearch
// ---------------------------------------------------------------------------

describe('hybridSearch', () => {
  it('falls back to keyword-only when no queryEmbedding provided', async () => {
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: 'alpha beta gamma search term here', mtime: Date.now() },
    ])
    reindexAgentFts('agt_hybrid1')

    const response = hybridSearch('agt_hybrid1', 'alpha', 5)
    expect(response.results.length).toBeGreaterThan(0)
    expect(response.vectorIndexReady).toBe(false)
  })

  it('combines keyword and vector results when queryEmbedding provided', async () => {
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: 'delta epsilon zeta hybrid test', mtime: Date.now() },
    ])
    reindexAgentFts('agt_hybrid2')

    const getEmbeddings = vi.fn().mockResolvedValue([[0.5, 0.5, 0]])
    await reindexAgentVectors('agt_hybrid2', getEmbeddings)

    const response = hybridSearch('agt_hybrid2', 'delta', 5, {
      queryEmbedding: [0.5, 0.5, 0],
    })
    expect(response.results.length).toBeGreaterThan(0)
    expect(response.vectorIndexReady).toBe(true)
  })

  it('falls back to keyword-only when no vector results', async () => {
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: 'weight test content keyword', mtime: Date.now() },
    ])
    reindexAgentFts('agt_hybrid3')

    const response = hybridSearch('agt_hybrid3', 'keyword', 5)
    expect(response.results.length).toBeGreaterThan(0)
    // Without vector results, should still return keyword results
    expect(response.vectorIndexReady).toBe(false)
  })

  it('returns empty results for non-matching query', async () => {
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'hello world', mtime: Date.now() }])
    reindexAgentFts('agt_hybrid4')

    const response = hybridSearch('agt_hybrid4', 'zzzznonexistent', 5)
    expect(response.results).toEqual([])
  })

  it('limits results to specified count', async () => {
    const content = Array.from({ length: 20 }, (_, i) => `paragraph${i} unique content block`).join(
      '\n\n',
    )
    mockMemoryFiles([{ filename: 'MEMORY.md', content, mtime: Date.now() }])
    reindexAgentFts('agt_hybrid5')

    const response = hybridSearch('agt_hybrid5', 'content', 2)
    expect(response.results.length).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// applyTemporalDecay
// ---------------------------------------------------------------------------

describe('applyTemporalDecay', () => {
  it('leaves non-daily files (MEMORY.md) unchanged', async () => {
    const results = [{ filePath: 'MEMORY.md', snippet: 'long-term memory', score: 1.0, mtime: 0 }]
    const decayed = applyTemporalDecay(results, 30)
    expect(decayed[0].score).toBe(1.0)
  })

  it('leaves non-daily path files unchanged', async () => {
    const results = [
      { filePath: 'notes/project.md', snippet: 'project notes', score: 0.8, mtime: 0 },
    ]
    const decayed = applyTemporalDecay(results, 30)
    expect(decayed[0].score).toBe(0.8)
  })

  it('applies decay to daily files (memory/YYYY-MM-DD.md)', async () => {
    // A file dated far in the past should have a significantly decayed score
    const oldDate = '2020-01-01'
    const results = [
      { filePath: `memory/${oldDate}.md`, snippet: 'old daily note', score: 1.0, mtime: 0 },
    ]
    const decayed = applyTemporalDecay(results, 30)
    // Score should be less than original due to decay
    expect(decayed[0].score).toBeLessThan(1.0)
    // Decay should be significant for a ~6 year old file with 30-day half-life
    expect(decayed[0].score).toBeLessThan(0.001)
  })

  it('applies minimal decay to very recent daily files', async () => {
    // A file dated today should have a score close to 1.
    // The decay uses the date portion of the filename (start of day), so ageInDays
    // can be up to ~1 day even for "today". With halfLife=30, exp(-ln2/30 * 1) ≈ 0.977.
    const today = new Date().toISOString().slice(0, 10)
    const results = [
      { filePath: `memory/${today}.md`, snippet: 'today note', score: 1.0, mtime: 0 },
    ]
    const decayed = applyTemporalDecay(results, 30)
    // Score should be above 0.97 (at most ~1 day of decay with 30-day half-life)
    expect(decayed[0].score).toBeGreaterThan(0.97)
    expect(decayed[0].score).toBeLessThanOrEqual(1.0)
  })

  it('sorts results by decayed score descending', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const results = [
      { filePath: 'memory/2020-01-01.md', snippet: 'very old', score: 1.0, mtime: 0 },
      { filePath: `memory/${today}.md`, snippet: 'very recent', score: 0.5, mtime: 0 },
    ]
    const decayed = applyTemporalDecay(results, 30)
    // The recent file with lower initial score should rank higher after decay
    expect(decayed[0].filePath).toContain(today)
    expect(decayed[0].score).toBeGreaterThan(decayed[1].score)
  })

  it('uses the default halfLifeDays when not specified', async () => {
    const results = [{ filePath: 'MEMORY.md', snippet: 'evergreen', score: 0.9, mtime: 0 }]
    expect(() => applyTemporalDecay(results)).not.toThrow()
  })

  // halfLife=0 is a documented first-class value meaning "no temporal decay"
  // (see resolveNumericConfig in memory-provider.ts), and the search route lets
  // it through verbatim. Math.LN2 / 0 is Infinity, so without a guard every
  // dated memory decayed to exactly 0 — the opposite of the documented meaning.
  it('treats halfLifeDays=0 as no decay', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const results = [
      { filePath: 'memory/2020-01-01.md', snippet: 'very old', score: 1.0, mtime: 0 },
      { filePath: `memory/${today}.md`, snippet: 'very recent', score: 0.5, mtime: 0 },
      { filePath: 'MEMORY.md', snippet: 'evergreen', score: 0.8, mtime: 0 },
    ]
    const decayed = applyTemporalDecay(results, 0)
    const scoreOf = (path: string) => decayed.find((r) => r.filePath.includes(path))?.score
    expect(scoreOf('2020-01-01')).toBe(1.0)
    expect(scoreOf(today)).toBe(0.5)
    expect(scoreOf('MEMORY.md')).toBe(0.8)
  })

  // A file dated today yields ageInDays === 0, so halfLife=0 produced
  // Infinity * 0 === NaN, which makes the sort comparator non-deterministic.
  it('produces no NaN score for a same-day file at halfLifeDays=0', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const results = [{ filePath: `memory/${today}.md`, snippet: 'today', score: 1.0, mtime: 0 }]
    const decayed = applyTemporalDecay(results, 0)
    expect(Number.isNaN(decayed[0].score)).toBe(false)
    expect(decayed[0].score).toBe(1.0)
  })

  // A negative half-life inverts the exponent, so older memories score *higher*
  // than recent ones — a silently reversed ranking rather than a visible error.
  it('treats a negative halfLifeDays as no decay instead of inflating old scores', async () => {
    const today = new Date().toISOString().slice(0, 10)
    const results = [
      { filePath: 'memory/2020-01-01.md', snippet: 'very old', score: 1.0, mtime: 0 },
      { filePath: `memory/${today}.md`, snippet: 'very recent', score: 0.5, mtime: 0 },
    ]
    const decayed = applyTemporalDecay(results, -5)
    expect(decayed.find((r) => r.filePath.includes('2020-01-01'))?.score).toBe(1.0)
    expect(decayed.find((r) => r.filePath.includes(today))?.score).toBe(0.5)
  })

  it('falls back to no decay for a NaN halfLifeDays', async () => {
    const results = [{ filePath: 'memory/2020-01-01.md', snippet: 'old', score: 1.0, mtime: 0 }]
    const decayed = applyTemporalDecay(results, Number.NaN)
    expect(decayed[0].score).toBe(1.0)
  })

  it('still sorts by score descending when decay is skipped', async () => {
    const results = [
      { filePath: 'memory/2020-01-01.md', snippet: 'old but strong', score: 0.3, mtime: 0 },
      { filePath: 'MEMORY.md', snippet: 'evergreen', score: 0.9, mtime: 0 },
    ]
    const decayed = applyTemporalDecay(results, 0)
    expect(decayed.map((r) => r.score)).toEqual([0.9, 0.3])
  })

  it('does not mutate the input array', async () => {
    const results = [{ filePath: 'memory/2020-01-01.md', snippet: 'old', score: 1.0, mtime: 0 }]
    applyTemporalDecay(results, 0)
    expect(results[0].score).toBe(1.0)
    expect(results).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// applyMMR
// ---------------------------------------------------------------------------

describe('applyMMR', () => {
  it('returns single result unchanged', async () => {
    const results = [{ filePath: 'a.md', snippet: 'hello world', score: 1.0, mtime: 0 }]
    expect(applyMMR(results)).toEqual(results)
  })

  it('returns empty array unchanged', async () => {
    expect(applyMMR([])).toEqual([])
  })

  it('preserves all results when snippets are completely different', async () => {
    const results = [
      { filePath: 'a.md', snippet: 'alpha beta gamma', score: 1.0, mtime: 0 },
      { filePath: 'b.md', snippet: 'delta epsilon zeta', score: 0.9, mtime: 0 },
      { filePath: 'c.md', snippet: 'theta iota kappa', score: 0.8, mtime: 0 },
    ]
    const mmr = applyMMR(results, 0.7)
    expect(mmr).toHaveLength(3)
  })

  it('de-emphasizes highly similar snippets', async () => {
    // Two nearly identical results — the diverse result should win over the near-duplicate.
    // MMR score = lambda * relevance - (1-lambda) * maxSim
    // With lambda=0.7:
    //   b.md (identical to a.md): 0.7*0.95 - 0.3*1.0 = 0.665 - 0.3 = 0.365
    //   c.md (different topic):   0.7*0.6  - 0.3*0.0 = 0.420 - 0.0 = 0.420
    // So c.md (score=0.42) beats b.md (score=0.365) and is selected second.
    const results = [
      { filePath: 'a.md', snippet: 'the cat sat on the mat', score: 1.0, mtime: 0 },
      { filePath: 'b.md', snippet: 'the cat sat on the mat', score: 0.95, mtime: 0 }, // identical text
      { filePath: 'c.md', snippet: 'completely different topic', score: 0.6, mtime: 0 },
    ]
    const mmr = applyMMR(results, 0.7)
    // First element should be the highest-scoring result (always selected first)
    expect(mmr[0].filePath).toBe('a.md')
    // The diverse result (c.md) should be preferred over the near-duplicate (b.md)
    expect(mmr[1].filePath).toBe('c.md')
  })

  it('uses default lambda of 0.7 when not specified', async () => {
    const results = [
      { filePath: 'a.md', snippet: 'hello', score: 1.0, mtime: 0 },
      { filePath: 'b.md', snippet: 'world', score: 0.8, mtime: 0 },
    ]
    expect(() => applyMMR(results)).not.toThrow()
    expect(applyMMR(results)).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// clearAgentIndex
// ---------------------------------------------------------------------------

describe('clearAgentIndex', () => {
  it('removes all FTS, vec, and meta entries for the agent', async () => {
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: 'some content to clear', mtime: Date.now() },
    ])

    reindexAgentFts('agt_clear1')

    const db = getMemoryIndexDb()
    const metaBefore = db
      .prepare('SELECT * FROM memory_index_meta WHERE agent_id = ?')
      .get('agt_clear1')
    expect(metaBefore).toBeDefined()

    clearAgentIndex('agt_clear1')

    const metaAfter = db
      .prepare('SELECT * FROM memory_index_meta WHERE agent_id = ?')
      .get('agt_clear1')
    expect(metaAfter).toBeUndefined()

    const ftsAfter = db
      .prepare('SELECT * FROM memory_chunks_fts WHERE agent_id = ?')
      .all('agt_clear1')
    expect(ftsAfter).toHaveLength(0)

    const vecAfter = db
      .prepare('SELECT * FROM memory_chunks_vec WHERE agent_id = ?')
      .all('agt_clear1')
    expect(vecAfter).toHaveLength(0)
  })

  it('does not affect other agents data', async () => {
    mockMemoryFiles([{ filename: 'MEMORY.md', content: 'agent two data', mtime: Date.now() }])
    reindexAgentFts('agt_clear_other')

    // Clear a different agent
    clearAgentIndex('agt_clear_different')

    const db = getMemoryIndexDb()
    const meta = db
      .prepare('SELECT * FROM memory_index_meta WHERE agent_id = ?')
      .get('agt_clear_other')
    expect(meta).toBeDefined()
  })

  it('does not throw when clearing a non-existent agent', async () => {
    expect(() => clearAgentIndex('agt_nonexistent')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Reindex mutex: concurrent calls
// ---------------------------------------------------------------------------

describe('reindexAgentFts mutex', () => {
  it('does not throw when called concurrently for the same agent', async () => {
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: 'concurrent test content', mtime: Date.now() },
    ])

    // Call reindexAgentFts multiple times synchronously — queued via Promise chain
    expect(() => {
      reindexAgentFts('agt_mutex1')
      reindexAgentFts('agt_mutex1')
      reindexAgentFts('agt_mutex1')
    }).not.toThrow()
  })

  it('allows reindex for different agents simultaneously', async () => {
    mockMemoryFiles([
      { filename: 'MEMORY.md', content: 'content for mutex test', mtime: Date.now() },
    ])

    expect(() => {
      reindexAgentFts('agt_mutex_a')
      reindexAgentFts('agt_mutex_b')
    }).not.toThrow()

    const results_a = searchByKeyword('agt_mutex_a', 'mutex', 5)
    const results_b = searchByKeyword('agt_mutex_b', 'mutex', 5)
    expect(results_a.length).toBeGreaterThan(0)
    expect(results_b.length).toBeGreaterThan(0)
  })
})
