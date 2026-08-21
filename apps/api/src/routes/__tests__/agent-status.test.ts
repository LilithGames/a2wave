import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Scoped to wiring and permission only. The report's own semantics are covered
 * directly in lib/__tests__/agent-self-report.test.ts, so the builder is mocked
 * here rather than reconstructed through a positional DB-chain mock.
 */

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}))
vi.mock('../../lib/id.js', () => ({ createId: vi.fn(() => 'test_id') }))
vi.mock('../../engine/index.js', () => ({
  engineRegistry: { get: vi.fn().mockReturnValue(true), types: [] },
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))
vi.mock('../../worker/index.js', () => ({ executeInWorker: vi.fn() }))
vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn(), logBackgroundAudit: vi.fn() }))

const mockRequireAgentRead = vi.hoisted(() => vi.fn())
vi.mock('../../lib/agent-access.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireAgentRead: (c: unknown, id: string) => mockRequireAgentRead(c, id),
}))

const mockBuildReport = vi.hoisted(() => vi.fn())
vi.mock('../../lib/agent-self-report.js', () => ({
  buildAgentSelfReport: (agent: unknown) => mockBuildReport(agent),
}))

const { AppError, NotFoundError } = await import('../../lib/errors.js')

const REPORT = {
  meta: {
    id: 'agt_test',
    name: 'Reviewer',
    icon: '🤖',
    description: null,
    status: 'active',
    publishStatus: 'published',
    channels: ['api'],
    model: 'claude-opus-5',
  },
  health: { ok: true, checks: [] },
  queue: { running: 0, queued: 0, maxConcurrency: 1, queueLimit: 50, capacity: 'idle' },
  checkedAt: '2026-08-21T00:00:00.000Z',
}

function makeApp(routes: Hono): Hono {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('userId' as never, 'usr_admin' as never)
    c.set('userRole' as never, 'admin' as never)
    await next()
  })
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    return c.json({ error: 'Internal Server Error' }, 500)
  })
  app.route('/agents', routes)
  return app
}

let app: Hono

beforeEach(async () => {
  vi.clearAllMocks()
  mockRequireAgentRead.mockResolvedValue({
    agent: { id: 'agt_test', userId: 'usr_admin', name: 'Reviewer' },
    permission: 'owner',
  })
  mockBuildReport.mockResolvedValue(REPORT)
  vi.resetModules()
  app = makeApp((await import('../agents.js')).default as unknown as Hono)
})

describe('GET /agents/:id/status', () => {
  it('returns the composed report', async () => {
    const res = await app.request('/agents/agt_test/status')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: REPORT })
  })

  it('enforces read permission through requireAgentRead', async () => {
    mockRequireAgentRead.mockRejectedValue(new NotFoundError('Agent'))

    const res = await app.request('/agents/agt_missing/status')

    expect(res.status).toBe(404)
    expect(mockBuildReport).not.toHaveBeenCalled()
  })

  it('builds the report for the agent the guard resolved, not the raw path id', async () => {
    await app.request('/agents/agt_test/status')

    expect(mockBuildReport).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'agt_test', name: 'Reviewer' }),
    )
  })
})
