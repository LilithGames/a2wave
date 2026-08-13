/**
 * Covers GET /runs/:id/logs/download and the `hasFullLog` flag on GET /runs/:id.
 * Uses the REAL run-log-file module against a temp dir (A2WAVE_RUN_LOGS_DIR)
 * so the route's fs interaction is exercised end-to-end.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbSelect = vi.fn()
vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    insert: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('../../lib/id.js', () => ({ createId: vi.fn(() => 'id_x') }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/owner-filter.js', () => ({
  getCurrentUserId: vi.fn(() => 'usr_test'),
}))
// Admin-equivalent visibility (no WHERE); the filter is covered by agent-access.test.ts.
vi.mock('../../lib/agent-access.js', () => ({
  getRunReadFilter: vi.fn(() => undefined),
  loadAgentWithPerm: vi.fn(() => null),
  requireAgentWrite: vi.fn(),
  // runs.ts imports this too. A full mock factory that omits it makes any future
  // cancel/execute case added here die with Vitest's "No export is defined on the
  // mock" instead of a readable assertion failure.
  hasAgentScopedAccess: vi.fn(() => true),
}))
vi.mock('../../lib/agent-helpers.js', () => ({
  buildAgentConfig: vi.fn(),
  resolveWorkDir: vi.fn(),
}))
vi.mock('../../lib/execute-with-retry.js', () => ({ executeWithRetry: vi.fn() }))
vi.mock('../../lib/execute-chat-run.js', () => ({ executeChatRun: vi.fn() }))
vi.mock('../../worker/index.js', () => ({ executeInWorker: vi.fn() }))
vi.mock('../../engine/index.js', () => ({ engineRegistry: { get: vi.fn(), types: [] } }))
vi.mock('../../engine/task-queue.js', () => ({ scheduleNext: vi.fn() }))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))

import runsApp from '../runs.js'

import { asyncQuery } from '../../test/async-query.js'

function makeSelectChain(getResult: unknown, allResult: unknown[] = []) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          get: vi.fn().mockReturnValue(getResult),
          all: vi.fn().mockReturnValue(allResult),
          orderBy: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(allResult) })),
        }),
      ),
    }),
  }
}

let tmpRoot: string
let app: Hono

beforeEach(() => {
  vi.clearAllMocks()
  tmpRoot = mkdtempSync(join(tmpdir(), 'a2wave-log-dl-'))
  vi.stubEnv('A2WAVE_RUN_LOGS_DIR', tmpRoot)
  app = new Hono().route('/runs', runsApp)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('GET /runs/:id/logs/download', () => {
  it('streams the NDJSON file with download headers', async () => {
    const line = `${JSON.stringify({ type: 'assistant', text: 'hi', ts: 1 })}\n`
    writeFileSync(join(tmpRoot, 'run_1.ndjson'), line.repeat(3))
    dbSelect.mockReturnValueOnce(makeSelectChain({ id: 'run_1' }))

    const res = await app.request('/runs/run_1/logs/download')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(res.headers.get('content-disposition')).toContain('run_1.ndjson')
    const body = await res.text()
    expect(body.trim().split('\n')).toHaveLength(3)
  })

  it('returns 404 when the run does not exist', async () => {
    dbSelect.mockReturnValueOnce(makeSelectChain(undefined))

    const res = await app.request('/runs/run_missing/logs/download')

    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('Run not found')
  })

  it('returns 404 when the run exists but the log file does not', async () => {
    dbSelect.mockReturnValueOnce(makeSelectChain({ id: 'run_nofile' }))

    const res = await app.request('/runs/run_nofile/logs/download')

    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('Run log file not found')
  })
})

describe('GET /runs/:id — hasFullLog flag', () => {
  it('is true when the sidecar file exists', async () => {
    writeFileSync(join(tmpRoot, 'run_2.ndjson'), '{}\n')
    dbSelect
      .mockReturnValueOnce(makeSelectChain({ id: 'run_2', intent: 'x' }))
      .mockReturnValueOnce(makeSelectChain(undefined, []))
      .mockReturnValueOnce(makeSelectChain(undefined, []))

    const res = await app.request('/runs/run_2')

    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { hasFullLog: boolean } }
    expect(data.hasFullLog).toBe(true)
  })

  it('is false when the sidecar file is absent', async () => {
    dbSelect
      .mockReturnValueOnce(makeSelectChain({ id: 'run_3', intent: 'x' }))
      .mockReturnValueOnce(makeSelectChain(undefined, []))
      .mockReturnValueOnce(makeSelectChain(undefined, []))

    const res = await app.request('/runs/run_3')

    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { hasFullLog: boolean } }
    expect(data.hasFullLog).toBe(false)
  })
})

describe('GET /runs/:id/logs', () => {
  it('returns only the requested page of parsed NDJSON entries', async () => {
    const lines = Array.from(
      { length: 7 },
      (_, i) => `${JSON.stringify({ type: 'assistant', text: `m${i + 1}`, ts: i + 1 })}\n`,
    ).join('')
    writeFileSync(join(tmpRoot, 'run_paged.ndjson'), lines)
    dbSelect.mockReturnValueOnce(makeSelectChain({ id: 'run_paged' }))

    const res = await app.request('/runs/run_paged/logs?page=2&limit=3')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ text: string }>
      meta: { page: number; pageSize: number; totalEntries: number; totalPages: number }
    }
    expect(body.data.map((entry) => entry.text)).toEqual(['m4', 'm5', 'm6'])
    expect(body.meta).toMatchObject({
      page: 2,
      pageSize: 3,
      totalEntries: 7,
      totalPages: 3,
    })
  })

  it('supports page=last without returning the whole file', async () => {
    const lines = Array.from(
      { length: 7 },
      (_, i) => `${JSON.stringify({ type: 'assistant', text: `m${i + 1}`, ts: i + 1 })}\n`,
    ).join('')
    writeFileSync(join(tmpRoot, 'run_last.ndjson'), lines)
    dbSelect.mockReturnValueOnce(makeSelectChain({ id: 'run_last' }))

    const res = await app.request('/runs/run_last/logs?page=last&limit=3')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ text: string }>
      meta: { page: number; totalPages: number; totalEntries: number }
    }
    expect(body.data.map((entry) => entry.text)).toEqual(['m7'])
    expect(body.meta).toMatchObject({ page: 3, totalPages: 3, totalEntries: 7 })
  })

  it('filters before paginating full-log entries', async () => {
    const lines = [
      { type: 'assistant', text: 'ok', ts: 1 },
      { type: 'retry', attempt: 1, nextAttemptIn: 100, ts: 2 },
      { type: 'tool_call', subtype: 'failed', callId: 'c1', toolName: 'Bash', ts: 3 },
      { type: 'assistant', text: 'ignored', ts: 4 },
    ]
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join('')
    writeFileSync(join(tmpRoot, 'run_filter.ndjson'), lines)
    dbSelect.mockReturnValueOnce(makeSelectChain({ id: 'run_filter' }))

    const res = await app.request('/runs/run_filter/logs?filter=problems&page=last&limit=10')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ type: string }>
      meta: { totalEntries: number; stats: { total: number; errors: number } }
    }
    expect(body.data.map((entry) => entry.type)).toEqual(['retry', 'tool_call'])
    expect(body.meta.totalEntries).toBe(2)
    // stats.errors 与 problems 筛选共用谓词（含 retry），口径与 totalEntries 一致
    expect(body.meta.stats).toMatchObject({ total: 4, errors: 2 })
  })

  it('includes A2A lifecycle retries and failures in the problems filter', async () => {
    const lines = [
      { type: 'system', subtype: 'a2a.task.observed', ts: 1 },
      { type: 'system', subtype: 'a2a.task.poll_retry', ts: 2 },
      { type: 'system', subtype: 'a2a.task.resubscribe_failed', ts: 3 },
      { type: 'system', subtype: 'a2a.task.cancel_failed', ts: 4 },
      { type: 'system', subtype: 'a2a.task.cancel_result', ts: 5 },
    ]
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join('')
    writeFileSync(join(tmpRoot, 'run_a2a_problems.ndjson'), lines)
    dbSelect.mockReturnValueOnce(makeSelectChain({ id: 'run_a2a_problems' }))

    const res = await app.request('/runs/run_a2a_problems/logs?filter=problems&page=last&limit=10')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ type: string; subtype?: string }>
      meta: { totalEntries: number; stats: { total: number; errors: number } }
    }
    expect(body.data.map((entry) => entry.subtype)).toEqual([
      'a2a.task.poll_retry',
      'a2a.task.resubscribe_failed',
      'a2a.task.cancel_failed',
    ])
    expect(body.meta.totalEntries).toBe(3)
    expect(body.meta.stats).toMatchObject({ total: 5, errors: 3 })
  })

  it('keeps tool heartbeat entries in the all filter', async () => {
    const lines = [
      { type: 'assistant', text: 'start', ts: 1 },
      { type: 'tool_heartbeat', callId: 'c1', toolName: 'Bash', elapsedMs: 20_000, ts: 2 },
      { type: 'assistant', text: 'done', ts: 3 },
    ]
      .map((entry) => `${JSON.stringify(entry)}\n`)
      .join('')
    writeFileSync(join(tmpRoot, 'run_all.ndjson'), lines)
    dbSelect.mockReturnValueOnce(makeSelectChain({ id: 'run_all' }))

    const res = await app.request('/runs/run_all/logs?filter=all&page=last&limit=10')

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ type: string }>
      meta: { totalEntries: number }
    }
    expect(body.data.map((entry) => entry.type)).toEqual([
      'assistant',
      'tool_heartbeat',
      'assistant',
    ])
    expect(body.meta.totalEntries).toBe(3)
  })
})
