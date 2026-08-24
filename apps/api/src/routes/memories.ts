/**
 * Memory API 路由
 * 前缀: /api/memories/:agentId
 * 双重认证：JWT（Web UI）或 localhost 来源（Agent 子进程）
 */
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { requireAgentRead, requireAgentWrite } from '../lib/agent-access.js'
import {
  agentTokenAllows,
  consumeAgentTopicRead,
  getRuntimeMemoryTokenClaims,
  type RuntimeMemoryAction,
} from '../lib/agent-memory-token.js'
import { logAudit } from '../lib/audit.js'
import { getEmbeddings, isEmbeddingAvailable } from '../lib/embedding-service.js'
import { ForbiddenError, NotFoundError } from '../lib/errors.js'
import { consolidateMemory } from '../lib/memory-consolidation.js'
import {
  applyMMR,
  applyTemporalDecay,
  clearAgentIndex,
  hybridSearch,
  rankMemoryResults,
  reindexAgentFts,
  reindexAgentVectors,
  searchByKeyword,
  searchByVector,
} from '../lib/memory-index.js'
import { isConfigDisabled, resolveNumericConfig } from '../lib/memory-provider.js'
import {
  checkSizeLimit,
  deleteMemoryFile,
  enforceCapacity,
  getMemoryStats,
  listMemoryFiles,
  queueAgentWrite,
  readMemoryFile,
  writeMemoryFile,
} from '../lib/memory-storage.js'
import {
  commitLegacyTopicization,
  proposeLegacyTopicization,
} from '../lib/memory-topic-migration.js'
import {
  ACTIVE_TOPIC_DIR,
  applyInsightToTopics,
  archiveMemoryTopic,
  deleteMemoryTopicFile,
  detectMemoryHierarchyMode,
  isMemoryTopicPath,
  listMemoryTopics,
  MEMORY_MAIN_FILE,
  MemoryTopicError,
  type MemoryTopicSection,
  type MemoryTopicSplitReplacement,
  mergeMemoryTopics,
  reactivateMemoryTopic,
  readMemoryTopic,
  replaceAgentSummaryFromMainContent,
  replaceManagedTopicFile,
  replaceTopicBody,
  selectMemoryTopicForRecall,
  splitMemoryTopic,
} from '../lib/memory-topics.js'

const app = new Hono()
const MEMORY_SEARCH_MODES = new Set(['keyword', 'vector', 'hybrid'])

function runtimeToken(c: Context): string | null {
  return (c.get('agentMemoryToken' as never) as string | undefined) ?? null
}

function runtimeAuditContext(c: Context): { runtime: boolean; runStepId?: string } {
  const token = runtimeToken(c)
  if (!token) return { runtime: false }
  const claims = getRuntimeMemoryTokenClaims(token)
  return { runtime: true, ...(claims?.runStepId ? { runStepId: claims.runStepId } : {}) }
}

function requireRuntimeAction(c: Context, action: RuntimeMemoryAction): void {
  const token = runtimeToken(c)
  if (token && !agentTokenAllows(token, action)) {
    throw new ForbiddenError(`Memory token does not allow ${action}`)
  }
}

function topicErrorResponse(c: Context, err: unknown) {
  if (!(err instanceof MemoryTopicError)) return null
  const status =
    err.code === 'TOPIC_NOT_FOUND'
      ? 404
      : err.code.endsWith('_LIMIT') || err.code === 'TOPIC_HARD_LIMIT'
        ? 409
        : 400
  return c.json({ error: err.message, code: err.code }, status)
}

async function requireMemoryRead(c: Context, agentId: string) {
  const tokenAgentId = c.get('agentTokenId' as never) as string | undefined
  if (tokenAgentId !== undefined) {
    if (tokenAgentId !== agentId) throw new ForbiddenError('Token does not match agent')
    const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
    if (!agent) throw new NotFoundError('Agent')
    return agent
  }
  return (await requireAgentRead(c, agentId)).agent
}

async function requireMemoryWrite(c: Context, agentId: string) {
  const tokenAgentId = c.get('agentTokenId' as never) as string | undefined
  if (tokenAgentId !== undefined) {
    if (tokenAgentId !== agentId) throw new ForbiddenError('Token does not match agent')
    const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
    if (!agent) throw new NotFoundError('Agent')
    return agent
  }
  return (await requireAgentWrite(c, agentId)).agent
}

function serveMemoryTopic(c: Context, agentId: string, topicId: string) {
  try {
    const topic = readMemoryTopic(agentId, topicId)
    const token = runtimeToken(c)
    const budget = token ? consumeAgentTopicRead(token, topic.tokenCount) : null
    if (budget && !budget.ok) {
      return c.json(
        {
          error: 'Topic disclosure budget exceeded',
          code: 'TOPIC_READ_BUDGET_EXCEEDED',
          meta: budget,
        },
        429,
      )
    }
    return c.json({ data: { ...topic, content: topic.body, budget } })
  } catch (err) {
    return topicErrorResponse(c, err) ?? c.json({ error: 'Failed to read topic' }, 400)
  }
}

function getMemoryFilePath(c: Context, agentId: string): string {
  const prefix = `/api/memories/${agentId}/files/`
  return c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : ''
}

/** GET /memories/:agentId — 列出记忆文件 */
app.get('/:agentId', async (c) => {
  const { agentId } = c.req.param()
  await requireMemoryRead(c, agentId)
  const files = listMemoryFiles(agentId)
  return c.json({ data: files })
})

/** GET /memories/:agentId/topics — list bounded topic metadata */
app.get('/:agentId/topics', async (c) => {
  const { agentId } = c.req.param()
  await requireMemoryRead(c, agentId)
  requireRuntimeAction(c, 'topics:list')
  const token = runtimeToken(c)
  const requestedStatus = c.req.query('status')
  const status = token
    ? 'active'
    : requestedStatus === 'archived' || requestedStatus === 'all'
      ? requestedStatus
      : 'active'
  const result = listMemoryTopics(agentId, status)
  return c.json({
    data: {
      mode: result.mode,
      invalidFiles: result.invalidFiles,
      topics: result.topics.map(({ body: _body, ...topic }) => topic),
    },
  })
})

/** GET /memories/:agentId/topics/recall — select and read one active topic */
app.get('/:agentId/topics/recall', async (c) => {
  const { agentId } = c.req.param()
  await requireMemoryRead(c, agentId)
  requireRuntimeAction(c, 'topics:read')
  const query = c.req.query('q')?.trim()
  if (!query) return c.json({ error: 'q parameter is required' }, 400)
  if (query.length > 240) return c.json({ error: 'q parameter is too long' }, 400)

  const match = selectMemoryTopicForRecall(query, listMemoryTopics(agentId, 'active').topics)
  if (!match) return c.json({ data: null })
  return serveMemoryTopic(c, agentId, match.topicId)
})

/** GET /memories/:agentId/topics/:topicId — read one active topic by stable ID */
app.get('/:agentId/topics/:topicId', async (c) => {
  const { agentId, topicId } = c.req.param()
  await requireMemoryRead(c, agentId)
  requireRuntimeAction(c, 'topics:read')
  return serveMemoryTopic(c, agentId, topicId)
})

/** POST /memories/:agentId/topics/remember — server-routed explicit memory write */
app.post('/:agentId/topics/remember', async (c) => {
  const { agentId } = c.req.param()
  await requireMemoryWrite(c, agentId)
  requireRuntimeAction(c, 'explicit:write')
  const body = await c.req.json<{
    action?: 'remember' | 'replace'
    topicId?: string
    title?: string
    scope?: string
    description?: string
    keywords?: string[]
    section?: string
    items?: string[]
    content?: string
  }>()
  if (body.action !== 'replace' && detectMemoryHierarchyMode(agentId) === 'legacy_single_file') {
    return c.json(
      {
        error: 'Legacy single-file memory requires the compatibility write flow',
        code: 'LEGACY_SINGLE_FILE',
      },
      409,
    )
  }

  const writeResult: { value?: ReturnType<typeof applyInsightToTopics> } = {}
  try {
    await queueAgentWrite(
      agentId,
      () => {
        if (body.action === 'replace') {
          if (!body.topicId || typeof body.content !== 'string') {
            throw new MemoryTopicError(
              'INVALID_TOPIC_WRITE',
              'topicId and content are required for replace',
            )
          }
          writeResult.value = replaceTopicBody(agentId, body.topicId, body.content)
          return
        }
        writeResult.value = applyInsightToTopics(
          agentId,
          {
            ...(body.topicId ? { topicId: body.topicId } : {}),
            title: body.title ?? '',
            scope: body.scope ?? '',
            description: body.description ?? '',
            keywords: body.keywords ?? [],
            section: (body.section ?? 'Durable Knowledge') as MemoryTopicSection,
            items: body.items ?? [],
          },
          { allowSingleNewTopicItem: true },
        )
      },
      { operation: 'explicit-topic-write' },
    )
  } catch (err) {
    return topicErrorResponse(c, err) ?? c.json({ error: 'Failed to write topic' }, 400)
  }

  const result = writeResult.value
  if (!result) return c.json({ error: 'Topic write produced no result' }, 500)
  if (result.retainedInHistory) {
    return c.json(
      {
        error: 'Topic write was not promoted; the source remains in Run history',
        code: result.reason,
        data: result,
      },
      409,
    )
  }

  logAudit(c, {
    action: 'memory.update',
    resource: 'memory',
    resourceId: agentId,
    details: {
      operation: body.action === 'replace' ? 'replace' : 'remember',
      topicId: result.topic?.topicId,
      created: result.created,
      ...runtimeAuditContext(c),
    },
  })
  reindexAgentFts(agentId)
  if (await isEmbeddingAvailable(agentId)) {
    void reindexAgentVectors(agentId, (texts) => getEmbeddings(texts, agentId))
  }
  return c.json({ data: result })
})

/** POST /memories/:agentId/topics/reorganize — editor-only lifecycle operation */
app.post('/:agentId/topics/reorganize', async (c) => {
  const { agentId } = c.req.param()
  const agent = await requireMemoryWrite(c, agentId)
  if (runtimeToken(c)) throw new ForbiddenError('Runtime tokens cannot reorganize topics')
  const body = await c.req.json<{
    action: 'archive' | 'reactivate' | 'merge' | 'split' | 'topicize-preview' | 'topicize-commit'
    topicId?: string
    sourceTopicIds?: string[]
    targetTopicId?: string
    replacements?: MemoryTopicSplitReplacement[]
    proposalId?: string
  }>()

  if (body.action === 'topicize-preview') {
    try {
      const preview = await proposeLegacyTopicization(agentId, { agent: await agent })
      return c.json({ data: preview })
    } catch (err) {
      return topicErrorResponse(c, err) ?? c.json({ error: 'Failed to preview topicization' }, 400)
    }
  }

  if (body.action === 'topicize-commit') {
    if (!body.proposalId) {
      return c.json({ error: 'proposalId is required', code: 'INVALID_TOPICIZATION_COMMIT' }, 400)
    }
    const commitResult: { value?: ReturnType<typeof commitLegacyTopicization> } = {}
    try {
      await queueAgentWrite(
        agentId,
        () => {
          commitResult.value = commitLegacyTopicization(agentId, body.proposalId as string)
        },
        { operation: 'topicize-legacy-memory' },
      )
    } catch (err) {
      return topicErrorResponse(c, err) ?? c.json({ error: 'Failed to commit topicization' }, 400)
    }
    if (await isEmbeddingAvailable(agentId)) {
      void reindexAgentVectors(agentId, (texts) => getEmbeddings(texts, agentId))
    }
    logAudit(c, {
      action: 'memory.update',
      resource: 'memory',
      resourceId: agentId,
      details: { operation: 'topicize-commit' },
    })
    return c.json({ data: commitResult.value })
  }

  let topic: ReturnType<typeof readMemoryTopic> | null = null
  let topics: ReturnType<typeof splitMemoryTopic> | null = null
  try {
    await queueAgentWrite(
      agentId,
      () => {
        if (body.action === 'archive' && body.topicId) {
          topic = archiveMemoryTopic(agentId, body.topicId)
        } else if (body.action === 'reactivate' && body.topicId) {
          topic = reactivateMemoryTopic(agentId, body.topicId)
        } else if (body.action === 'merge' && body.targetTopicId) {
          topic = mergeMemoryTopics(agentId, body.sourceTopicIds ?? [], body.targetTopicId)
        } else if (body.action === 'split' && body.topicId) {
          topics = splitMemoryTopic(agentId, body.topicId, body.replacements ?? [])
        } else {
          throw new MemoryTopicError('INVALID_REORGANIZE_ACTION', 'Invalid reorganize request')
        }
      },
      { operation: `topic-${body.action}` },
    )
  } catch (err) {
    return topicErrorResponse(c, err) ?? c.json({ error: 'Failed to reorganize topics' }, 400)
  }

  logAudit(c, {
    action: 'memory.update',
    resource: 'memory',
    resourceId: agentId,
    details: {
      operation: body.action,
      ...(body.topicId ? { topicId: body.topicId } : {}),
      ...(body.targetTopicId ? { targetTopicId: body.targetTopicId } : {}),
      ...(body.sourceTopicIds ? { sourceTopicCount: body.sourceTopicIds.length } : {}),
    },
  })
  reindexAgentFts(agentId)
  if (await isEmbeddingAvailable(agentId)) {
    void reindexAgentVectors(agentId, (texts) => getEmbeddings(texts, agentId))
  }
  return c.json({ data: { topic, topics } })
})

/** GET /memories/:agentId/files/* — 读取文件内容 */
app.get('/:agentId/files/*', async (c) => {
  const { agentId } = c.req.param()
  await requireMemoryRead(c, agentId)
  const filename = getMemoryFilePath(c, agentId)
  const token = runtimeToken(c)
  if (token) {
    if (filename.startsWith(`${ACTIVE_TOPIC_DIR}/`)) {
      return c.json(
        {
          error: 'Runtime topic reads must use the bounded topic endpoint',
          code: 'TOPIC_READ_REQUIRES_BUDGET',
        },
        403,
      )
    }
    requireRuntimeAction(c, 'search')
  }
  try {
    const content = readMemoryFile(agentId, filename)
    return c.json({ data: { filename, content } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (message === 'File not found') return c.json({ error: message }, 404)
    return c.json({ error: message }, 400)
  }
})

/** PUT /memories/:agentId/files/* — 写入/更新文件 */
app.put('/:agentId/files/*', async (c) => {
  const { agentId } = c.req.param()
  await requireMemoryWrite(c, agentId)
  requireRuntimeAction(c, 'explicit:write')
  const filename = getMemoryFilePath(c, agentId)
  const body = await c.req.json<{ content: string; append?: boolean }>()
  if (typeof body.content !== 'string') {
    return c.json({ error: 'content is required' }, 400)
  }

  let finalSize = 0
  let writeError: string | null = null
  let contentChanged = false

  await queueAgentWrite(
    agentId,
    () => {
      // Server-side append: read existing + concatenate inside the lock (atomic)
      let finalContent = body.content
      if (body.append) {
        try {
          const existing = readMemoryFile(agentId, filename)
          finalContent = existing ? `${existing}\n\n${body.content}` : body.content
        } catch {
          // File doesn't exist yet, write as-is
        }
      }

      const hierarchyMode = detectMemoryHierarchyMode(agentId)
      if (hierarchyMode === 'topic_v2' && filename === MEMORY_MAIN_FILE) {
        if (body.append) {
          writeError = 'Managed MEMORY.md does not support append writes'
          return
        }
        try {
          const previous = readMemoryFile(agentId, MEMORY_MAIN_FILE)
          const rendered = replaceAgentSummaryFromMainContent(agentId, finalContent)
          finalSize = Buffer.byteLength(rendered, 'utf8')
          contentChanged = previous !== rendered
        } catch (err) {
          writeError = err instanceof Error ? err.message : 'Invalid MEMORY.md content'
        }
        return
      }

      if (isMemoryTopicPath(filename)) {
        if (body.append) {
          writeError = 'Managed topic files do not support append writes'
          return
        }
        try {
          const previous = readMemoryFile(agentId, filename)
          const topicResult = replaceManagedTopicFile(agentId, filename, finalContent)
          if (topicResult.retainedInHistory) {
            writeError = 'Topic write would exceed the hard limit'
            return
          }
          const updated = readMemoryFile(agentId, filename)
          finalSize = Buffer.byteLength(updated, 'utf8')
          contentChanged = previous !== updated
        } catch (err) {
          writeError = err instanceof Error ? err.message : 'Invalid topic content'
        }
        return
      }

      if (filename.startsWith(`${ACTIVE_TOPIC_DIR}/`)) {
        writeError = 'Topic paths are server-owned; use the topic write endpoint'
        return
      }

      // 容量校验
      const contentSize = Buffer.byteLength(finalContent, 'utf-8')
      if (!checkSizeLimit(agentId, contentSize, filename)) {
        writeError = 'Memory storage limit exceeded (10MB)'
        return
      }

      // 检查内容是否变化，避免无意义的 reindex
      try {
        const oldContent = readMemoryFile(agentId, filename)
        if (oldContent !== finalContent) contentChanged = true
      } catch {
        contentChanged = true
      }

      try {
        writeMemoryFile(agentId, filename, finalContent)
        enforceCapacity(agentId)
        finalSize = contentSize
      } catch (err) {
        writeError = err instanceof Error ? err.message : 'Unknown error'
      }
    },
    { operation: body.append ? 'append-memory-file' : 'write-memory-file', filename },
  )

  if (writeError === 'Memory storage limit exceeded (10MB)') {
    return c.json({ error: writeError }, 413)
  }
  if (writeError) {
    return c.json({ error: writeError }, 400)
  }

  // 触发 reindex（仅在内容变化时，在锁外执行）
  if (contentChanged) {
    logAudit(c, {
      action: 'memory.update',
      resource: 'memory',
      resourceId: agentId,
      details: {
        operation: body.append ? 'append-file' : 'replace-file',
        filename,
        ...runtimeAuditContext(c),
      },
    })
    reindexAgentFts(agentId)
    if (await isEmbeddingAvailable(agentId)) {
      void reindexAgentVectors(agentId, (texts) => getEmbeddings(texts, agentId))
    }
  }

  return c.json({ data: { filename, size: finalSize } })
})

/** DELETE /memories/:agentId/files/* — 删除文件 */
app.delete('/:agentId/files/*', async (c) => {
  const { agentId } = c.req.param()
  await requireMemoryWrite(c, agentId)
  requireRuntimeAction(c, 'explicit:write')
  const filename = getMemoryFilePath(c, agentId)
  try {
    if (detectMemoryHierarchyMode(agentId) === 'topic_v2' && filename === MEMORY_MAIN_FILE) {
      return c.json({ error: 'Managed MEMORY.md cannot be deleted while topics exist' }, 409)
    }
    if (isMemoryTopicPath(filename)) deleteMemoryTopicFile(agentId, filename)
    else deleteMemoryFile(agentId, filename)
    logAudit(c, {
      action: 'memory.delete',
      resource: 'memory',
      resourceId: agentId,
      details: { filename, ...runtimeAuditContext(c) },
    })
    // 触发 reindex（FTS5 同步 + 向量异步后台）
    reindexAgentFts(agentId)
    if (await isEmbeddingAvailable(agentId)) {
      void reindexAgentVectors(agentId, (texts) => getEmbeddings(texts, agentId))
    }
    return c.json({ data: { deleted: filename } })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (message === 'File not found') return c.json({ error: message }, 404)
    return c.json({ error: message }, 400)
  }
})

/** GET /memories/:agentId/search — 搜索 */
app.get('/:agentId/search', async (c) => {
  const { agentId } = c.req.param()
  const agent = await requireMemoryRead(c, agentId)
  requireRuntimeAction(c, 'search')

  const q = c.req.query('q')
  if (!q) {
    return c.json({ error: 'q parameter is required' }, 400)
  }

  // Agent-level defaults for search post-processing
  const cfg = ((await agent).config ?? {}) as Record<string, unknown>
  const defaultDecay = !isConfigDisabled(cfg.memorySearchDecay) // default: true when unset
  const defaultHalfLife = resolveNumericConfig(cfg.memorySearchDecayHalfLife, 14)
  const defaultMmr = !isConfigDisabled(cfg.memorySearchMmr) // default: true when unset
  const defaultMmrLambda = resolveNumericConfig(cfg.memorySearchMmrLambda, 0.7)

  const mode = c.req.query('mode') || 'hybrid'
  if (!MEMORY_SEARCH_MODES.has(mode)) {
    return c.json({ error: 'mode must be one of: keyword, vector, hybrid' }, 400)
  }
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 5))
  // Query params override agent config if explicitly provided
  const decay = c.req.query('decay') !== undefined ? c.req.query('decay') === 'true' : defaultDecay
  const halfLife =
    c.req.query('halfLife') !== undefined
      ? resolveNumericConfig(c.req.query('halfLife'), 14)
      : defaultHalfLife
  const mmr = c.req.query('mmr') !== undefined ? c.req.query('mmr') === 'true' : defaultMmr
  const mmrLambda =
    c.req.query('mmrLambda') !== undefined
      ? Math.min(1, Math.max(0, resolveNumericConfig(c.req.query('mmrLambda'), 0.7)))
      : defaultMmrLambda

  let results: import('../lib/memory-index.js').SearchResult[]
  let vectorIndexReady = false

  if (mode === 'keyword') {
    results = searchByKeyword(agentId, q, limit * 3)
  } else if (mode === 'vector') {
    if (!(await isEmbeddingAvailable(agentId))) {
      return c.json({ error: 'Embedding not configured' }, 400)
    }
    const queryEmbedding = await getEmbeddings([q], agentId)
    if (queryEmbedding.length === 0) {
      return c.json({ error: 'Failed to generate embedding' }, 500)
    }
    results = searchByVector(agentId, queryEmbedding[0], limit * 3)
    vectorIndexReady = results.length > 0
  } else {
    // hybrid
    let queryEmbedding: number[] | undefined
    if (await isEmbeddingAvailable(agentId)) {
      const embeddings = await getEmbeddings([q], agentId)
      queryEmbedding = embeddings[0]
    }
    const response = hybridSearch(agentId, q, limit * 3, { queryEmbedding })
    results = response.results
    vectorIndexReady = response.vectorIndexReady
  }

  // 后处理
  if (decay) {
    results = applyTemporalDecay(results, halfLife)
  }
  if (mmr) {
    results = applyMMR(results, mmrLambda)
  }
  results = rankMemoryResults(results)

  // 截断到 limit
  results = results.slice(0, limit)

  return c.json({ data: { results, vectorIndexReady } })
})

/** GET /memories/:agentId/stats — 统计 */
app.get('/:agentId/stats', async (c) => {
  const { agentId } = c.req.param()
  await requireMemoryRead(c, agentId)
  const stats = getMemoryStats(agentId)
  return c.json({ data: stats })
})

/** POST /memories/:agentId/reindex — 手动触发重建索引 */
app.post('/:agentId/reindex', async (c) => {
  const { agentId } = c.req.param()
  await requireMemoryWrite(c, agentId)
  // requireMemoryWrite short-circuits on the runtime-token path without weighing
  // viewer/editor, so an Agent's own read-only token would otherwise reach this
  // destructive lifecycle route. Same stance as topics/reorganize.
  if (runtimeToken(c)) throw new ForbiddenError('Runtime tokens cannot reindex memory')

  clearAgentIndex(agentId)
  reindexAgentFts(agentId)

  if (await isEmbeddingAvailable(agentId)) {
    await reindexAgentVectors(agentId, (texts) => getEmbeddings(texts, agentId))
  }

  logAudit(c, { action: 'memory.reindex', resource: 'memory', resourceId: agentId })
  return c.json({ data: { reindexed: true } })
})

const consolidateBodySchema = z.object({
  maxAgeDays: z.number().int().min(1).max(3650).optional(),
})

/** POST /memories/:agentId/consolidate — 手动触发日志合并 */
app.post('/:agentId/consolidate', async (c) => {
  const { agentId } = c.req.param()
  const agent = await requireMemoryWrite(c, agentId)
  if (runtimeToken(c)) throw new ForbiddenError('Runtime tokens cannot consolidate memory')

  // `.json<T>()` is a cast, not a check. A negative maxAgeDays puts the cutoff in
  // the future, which makes every daily log — including today's — older than it,
  // so the whole set is summarised away and deleted.
  const parsed = consolidateBodySchema.safeParse(
    await c.req.json<unknown>().catch(() => ({}) as unknown),
  )
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }
  const result = await consolidateMemory(
    agentId,
    { agent: agent },
    { maxAgeDays: parsed.data.maxAgeDays },
  )
  if (result) {
    logAudit(c, {
      action: 'memory.consolidate',
      resource: 'memory',
      resourceId: agentId,
      details: { consolidatedCount: result.consolidatedCount },
    })
  }
  return c.json({ data: result ?? { consolidatedCount: 0 } })
})

export default app
