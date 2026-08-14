import {
  type ListTasksRequest,
  type ListTasksResponse,
  Role,
  type Task,
  Task as TaskCodec,
  TaskState,
} from '@a2a-js/sdk'
import { RequestMalformedError } from '@a2a-js/sdk/errors'
import type { ServerCallContext, TaskStore } from '@a2a-js/sdk/server'
import { and, count, desc, eq, gte, lt, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { a2aTasks } from '../db/schema.js'
import { jsonExtractNumber, jsonExtractText } from '../lib/json-sql.js'
import { logger } from '../lib/logger.js'

interface TaskScope {
  tenant: string
  owner: string
}

interface PersistedTaskEnvelope {
  persistenceVersion: 1
  scope: TaskScope
  task: unknown
}

function getScope(context: ServerCallContext): TaskScope {
  const tenant = context.tenant?.trim()
  const owner = context.user?.userName?.trim()
  if (!tenant || !owner) {
    throw new Error('A2A task access requires both tenant and caller scope')
  }
  return { tenant, owner }
}

function isPersistedEnvelope(value: unknown): value is PersistedTaskEnvelope {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PersistedTaskEnvelope>
  return (
    candidate.persistenceVersion === 1 &&
    !!candidate.scope &&
    typeof candidate.scope.tenant === 'string' &&
    typeof candidate.scope.owner === 'string' &&
    'task' in candidate
  )
}

function sameScope(left: TaskScope, right: TaskScope): boolean {
  return left.tenant === right.tenant && left.owner === right.owner
}

/**
 * Code points that are valid JSON but that PostgreSQL's jsonb cannot hold.
 *
 * jsonb stores *unescaped* text, so a code point with no text representation
 * fails the `(data)::jsonb` cast outright. Two shapes qualify, both verified
 * against a live PostgreSQL 14:
 *
 *   U+0000          22P05 unsupported Unicode escape sequence
 *   lone surrogate  22P02 Unicode low surrogate must follow a high surrogate
 *
 * A *paired* surrogate is fine — it is just an astral character, and an emoji
 * round-trips — so only unpaired halves are removed.
 *
 * The blast radius is what makes this worth handling at the write path.
 * `list()` casts the entire envelope to filter on `scope.tenant`, so one bad
 * code point anywhere in one task's text — a field the query never reads —
 * makes `tasks/list` fail for **every** task in that scope, not just the
 * offending one. A2A message content is caller-supplied, and a lone surrogate
 * is what an ordinary client produces by truncating a UTF-16 string mid-emoji,
 * so this is reachable input rather than a hypothetical.
 *
 * Stripping rather than rejecting: neither shape carries meaning in the message
 * text these envelopes hold, and failing a `tasks/send` over a stray code unit
 * would be the worse outcome.
 *
 * This fixes the write path only; a row persisted **before** this change can
 * still carry such a code point and would still fail `list()` on PostgreSQL. No
 * backfill ships with it, for two reasons: PostgreSQL is experimental with no
 * SQLite -> PostgreSQL data migration path, so no deployment can have inherited
 * such a row from SQLite; and `cleanup()` retires envelopes past its retention
 * cutoff, so an affected row ages out rather than persisting indefinitely. A
 * deployment that hits it before then can delete the offending task by id —
 * `load()` and `save()` still work on it, since they read the column directly
 * and only the whole-envelope cast in `list()` raises.
 */
const PG_UNREPRESENTABLE = new RegExp(
  [
    '\\u0000',
    '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])',
    '(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  ].join('|'),
  'g',
)

/**
 * Serialise an envelope, dropping those code points from every string in it.
 *
 * Applied to the VALUES during serialisation rather than to the JSON text
 * afterwards. An earlier revision rewrote the serialised string with a regex
 * over escape sequences; that worked, but it had to reason about backslash
 * parity to avoid corrupting a user who typed the escape literally, and it did
 * not generalise — the surrogate case would have needed a second, subtler
 * escape-level pattern. Sanitising the data is the level the problem lives at,
 * so one rule covers both shapes and cannot mangle neighbouring text.
 */
function encodeEnvelope(envelope: unknown): string {
  return JSON.stringify(envelope, (_key, value) =>
    typeof value === 'string' ? value.replace(PG_UNREPRESENTABLE, '') : value,
  )
}

function encodeTask(task: Task, scope: TaskScope): string {
  const envelope: PersistedTaskEnvelope = {
    persistenceVersion: 1,
    scope,
    task: TaskCodec.toJSON(task),
  }
  return encodeEnvelope(envelope)
}

function decodeEnvelope(data: string): PersistedTaskEnvelope | undefined {
  const parsed = JSON.parse(data) as unknown
  return isPersistedEnvelope(parsed) ? parsed : undefined
}

function decodeScopedTask(data: string, scope: TaskScope): Task | undefined {
  const envelope = decodeEnvelope(data)
  if (!envelope || !sameScope(envelope.scope, scope)) return undefined
  return TaskCodec.fromJSON(envelope.task)
}

interface TaskPageCursor {
  version: 1
  statusTimestamp: string
  taskId: string
}

function encodePageCursor(statusTimestamp: string, taskId: string): string {
  return Buffer.from(
    JSON.stringify({ version: 1, statusTimestamp, taskId } satisfies TaskPageCursor),
    'utf8',
  ).toString('base64url')
}

function parsePageCursor(pageToken: string): TaskPageCursor | undefined {
  if (!pageToken) return undefined
  if (pageToken.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(pageToken)) {
    throw new RequestMalformedError('Invalid A2A task page token')
  }
  try {
    const parsed = JSON.parse(
      Buffer.from(pageToken, 'base64url').toString('utf8'),
    ) as Partial<TaskPageCursor>
    if (
      parsed.version !== 1 ||
      typeof parsed.statusTimestamp !== 'string' ||
      typeof parsed.taskId !== 'string' ||
      !parsed.taskId ||
      encodePageCursor(parsed.statusTimestamp, parsed.taskId) !== pageToken
    ) {
      throw new RequestMalformedError('Invalid A2A task page token')
    }
    return parsed as TaskPageCursor
  } catch (error) {
    if (error instanceof RequestMalformedError) throw error
    throw new RequestMalformedError('Invalid A2A task page token')
  }
}

export function normalizeStatusTimestampAfter(value: string | undefined): string | undefined {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) {
    throw new RequestMalformedError('statusTimestampAfter must be a valid ISO 8601 date string')
  }
  // Persisted task timestamps use Date#toISOString. Normalize the request to
  // the same UTC representation before SQLite compares text; comparing a Z
  // timestamp with an equivalent +08:00 string lexicographically is incorrect.
  return new Date(timestamp).toISOString()
}

export class SqliteTaskStore implements TaskStore {
  private lastCleanupAt = 0
  private static readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000

  async save(task: Task, context: ServerCallContext): Promise<void> {
    const now = Date.now()
    const scope = getScope(context)
    const [existing] = await db.select().from(a2aTasks).where(eq(a2aTasks.id, task.id)).limit(1)

    if (existing) {
      let persisted: PersistedTaskEnvelope | undefined
      try {
        persisted = decodeEnvelope(existing.data)
      } catch {
        persisted = undefined
      }
      if (!persisted || !sameScope(persisted.scope, scope)) {
        throw new Error('A2A task ID is already owned by another caller scope')
      }
      await db
        .update(a2aTasks)
        .set({ data: encodeTask(task, scope), updatedAt: now })
        .where(eq(a2aTasks.id, task.id))
    } else {
      await db
        .insert(a2aTasks)
        .values({ id: task.id, data: encodeTask(task, scope), createdAt: now, updatedAt: now })
    }

    if (now - this.lastCleanupAt > SqliteTaskStore.CLEANUP_INTERVAL_MS) {
      this.lastCleanupAt = now
      this.cleanup().catch(() => {})
    }
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const [row] = await db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId)).limit(1)
    if (!row) return undefined
    try {
      return decodeScopedTask(row.data, getScope(context))
    } catch (err) {
      logger.warn({ err, taskId }, 'Failed to parse persisted A2A task')
      return undefined
    }
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const scope = getScope(context)
    const cursor = parsePageCursor(params.pageToken)
    const normalizedStatusTimestampAfter = normalizeStatusTimestampAfter(
      params.statusTimestampAfter,
    )
    // Via the dialect helpers, not raw json_extract: `data` is a text column
    // holding JSON, and both the extraction syntax and the malformed-JSON guard
    // differ per backend (see lib/json-sql.ts).
    const persistenceVersion = jsonExtractNumber(a2aTasks.data, ['persistenceVersion'])
    const tenant = jsonExtractText(a2aTasks.data, ['scope', 'tenant'])
    const owner = jsonExtractText(a2aTasks.data, ['scope', 'owner'])
    const taskContextId = jsonExtractText(a2aTasks.data, ['task', 'contextId'])
    const taskStatus = jsonExtractText(a2aTasks.data, ['task', 'status', 'state'])
    const statusTimestamp = sql<string>`COALESCE(${jsonExtractText(a2aTasks.data, ['task', 'status', 'timestamp'])}, '')`
    const requestedStatus = params.status ?? TaskState.TASK_STATE_UNSPECIFIED
    const filter = and(
      eq(persistenceVersion, 1),
      eq(tenant, scope.tenant),
      eq(owner, scope.owner),
      params.contextId ? eq(taskContextId, params.contextId) : undefined,
      requestedStatus !== TaskState.TASK_STATE_UNSPECIFIED
        ? eq(taskStatus, TaskState[requestedStatus])
        : undefined,
      normalizedStatusTimestampAfter
        ? gte(statusTimestamp, normalizedStatusTimestampAfter)
        : undefined,
    )
    const [totalRow] = await db.select({ value: count() }).from(a2aTasks).where(filter).limit(1)
    const totalSize = Number(totalRow?.value ?? 0)
    const cursorFilter = cursor
      ? or(
          lt(statusTimestamp, cursor.statusTimestamp),
          and(eq(statusTimestamp, cursor.statusTimestamp), lt(a2aTasks.id, cursor.taskId)),
        )
      : undefined
    const pageSize = params.pageSize ?? 50
    const rows = await db
      .select({ id: a2aTasks.id, data: a2aTasks.data })
      .from(a2aTasks)
      .where(and(filter, cursorFilter))
      .orderBy(desc(statusTimestamp), desc(a2aTasks.id))
      // Fetch one look-ahead row for the continuation token. This bounds JSON
      // decoding to at most 101 tasks even when the retained scope is large.
      .limit(pageSize + 1)
    const visibleTasks = rows
      .flatMap((row) => {
        try {
          const task = decodeScopedTask(row.data, scope)
          return task ? [{ task, statusTimestamp: task.status?.timestamp ?? '' }] : []
        } catch (err) {
          logger.warn({ err, taskId: row.id }, 'Failed to parse persisted A2A task while listing')
          return []
        }
      })
      .filter(({ task }) => !params.contextId || task.contextId === params.contextId)
      .filter(
        ({ task }) =>
          requestedStatus === TaskState.TASK_STATE_UNSPECIFIED ||
          task.status?.state === requestedStatus,
      )
      .filter(({ task }) => {
        if (!normalizedStatusTimestampAfter) return true
        const timestamp = task.status?.timestamp
        return !!timestamp && Date.parse(timestamp) >= Date.parse(normalizedStatusTimestampAfter)
      })
      .sort((left, right) => {
        if (right.statusTimestamp !== left.statusTimestamp) {
          return right.statusTimestamp.localeCompare(left.statusTimestamp)
        }
        return right.task.id.localeCompare(left.task.id)
      })

    // The SQL query applies these predicates before LIMIT. Keep the checks here
    // as a fail-closed guard for malformed rows and for simple test doubles.
    const remainingTasks = cursor
      ? visibleTasks.filter(
          ({ task, statusTimestamp }) =>
            statusTimestamp < cursor.statusTimestamp ||
            (statusTimestamp === cursor.statusTimestamp && task.id < cursor.taskId),
        )
      : visibleTasks
    const page = remainingTasks.slice(0, pageSize)
    const tasks = page.map(({ task }) => ({
      ...task,
      artifacts: params.includeArtifacts ? task.artifacts : [],
    }))
    const lastItem = page.at(-1)

    return {
      tasks,
      nextPageToken:
        lastItem && (rows.length > pageSize || remainingTasks.length > page.length)
          ? encodePageCursor(lastItem.statusTimestamp, lastItem.task.id)
          : '',
      pageSize,
      totalSize,
    }
  }

  async cleanup(maxAgeDays = 14): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    // `.returning()` rather than a driver row count: better-sqlite3 reports
    // `changes` and node-postgres `rowCount`, so counting the returned ids is
    // the one form that means the same thing on both.
    const deleted = await db
      .delete(a2aTasks)
      .where(lt(a2aTasks.updatedAt, cutoff))
      .returning({ id: a2aTasks.id })
    return deleted.length
  }

  /**
   * Force a persisted task into the failed state during startup recovery.
   * Legacy unscoped rows remain recoverable internally but are never exposed by load/list.
   */
  async markTaskFailed(taskId: string, reasonMessage: string): Promise<boolean> {
    const [row] = await db.select().from(a2aTasks).where(eq(a2aTasks.id, taskId)).limit(1)
    if (!row) return false

    let parsed: unknown
    try {
      parsed = JSON.parse(row.data) as unknown
    } catch (err) {
      logger.warn({ err, taskId }, 'Failed to parse persisted A2A task while marking it failed')
      return false
    }

    const now = Date.now()
    if (isPersistedEnvelope(parsed)) {
      const task = TaskCodec.fromJSON(parsed.task)
      const existingState = task.status?.state
      if (
        existingState === TaskState.TASK_STATE_FAILED ||
        existingState === TaskState.TASK_STATE_COMPLETED ||
        existingState === TaskState.TASK_STATE_CANCELED ||
        existingState === TaskState.TASK_STATE_REJECTED
      ) {
        return false
      }
      task.status = {
        state: TaskState.TASK_STATE_FAILED,
        message: {
          messageId: `recovery-${now}`,
          role: Role.ROLE_AGENT,
          parts: [
            {
              content: { $case: 'text', value: reasonMessage },
              mediaType: 'text/plain',
              filename: '',
              metadata: undefined,
            },
          ],
          taskId: task.id,
          contextId: task.contextId,
          metadata: undefined,
          extensions: [],
          referenceTaskIds: [],
        },
        timestamp: new Date(now).toISOString(),
      }
      await db
        .update(a2aTasks)
        .set({ data: encodeTask(task, parsed.scope), updatedAt: now })
        .where(eq(a2aTasks.id, taskId))
      return true
    }

    const legacyTask = parsed as {
      id?: string
      contextId?: string
      status?: { state?: string; message?: unknown; timestamp?: string }
    }
    if (
      legacyTask.status?.state === 'failed' ||
      legacyTask.status?.state === 'completed' ||
      legacyTask.status?.state === 'canceled' ||
      legacyTask.status?.state === 'rejected'
    ) {
      return false
    }
    if (!legacyTask.id) return false

    const updated = {
      ...legacyTask,
      status: {
        state: 'failed',
        message: {
          kind: 'message',
          messageId: `recovery-${now}`,
          role: 'agent',
          parts: [{ kind: 'text', text: reasonMessage }],
          taskId: legacyTask.id,
          contextId: legacyTask.contextId ?? '',
        },
        timestamp: new Date(now).toISOString(),
      },
    }
    await db
      .update(a2aTasks)
      .set({ data: encodeEnvelope(updated), updatedAt: now })
      .where(eq(a2aTasks.id, taskId))
    return true
  }
}
