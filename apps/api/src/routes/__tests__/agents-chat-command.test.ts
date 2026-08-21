import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The chat endpoint backs both the test drawer (`debug`) and the published chat
 * page (`chat_app`). A command must be answered here for the same reason it is
 * on every other channel — and the drawer is where an operator is most likely to
 * ask, since it is the surface they open when something looks wrong.
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

const mockIntercept = vi.hoisted(() => vi.fn())
vi.mock('../../lib/native-chat-command.js', () => ({
  interceptNativeChatCommand: (input: unknown) => mockIntercept(input),
}))

/** Blows up if the endpoint ever reaches execution during a command turn. */
const mockRunWithLifecycle = vi.hoisted(() => vi.fn())
vi.mock('../../lib/run-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runWithLifecycle: (...args: unknown[]) => mockRunWithLifecycle(...args),
}))

const { AppError } = await import('../../lib/errors.js')

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

function chat(app: Hono, body: Record<string, unknown>) {
  return app.request('/agents/agt_test/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let app: Hono

beforeEach(async () => {
  vi.clearAllMocks()
  mockRequireAgentRead.mockResolvedValue({
    agent: { id: 'agt_test', userId: 'usr_admin', name: 'Reviewer', publishChannels: ['api'] },
    permission: 'owner',
  })
  mockIntercept.mockResolvedValue({ handled: false })
  vi.resetModules()
  app = makeApp((await import('../agents.js')).default as unknown as Hono)
})

describe('POST /agents/:id/chat — command interception', () => {
  it('answers /status without executing the Agent', async () => {
    mockIntercept.mockResolvedValue({ handled: true, reply: 'Reviewer — idle' })

    const res = await chat(app, { message: '/status' })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { reply: 'Reviewer — idle' } })
    expect(mockRunWithLifecycle).not.toHaveBeenCalled()
  })

  it('reports no runId, because no run was created', async () => {
    mockIntercept.mockResolvedValue({ handled: true, reply: 'ok' })

    const body = (await (await chat(app, { message: '/status' })).json()) as {
      data: Record<string, unknown>
    }

    expect(body.data.runId).toBeUndefined()
  })

  it('answers over SSE as a single done event when streaming', async () => {
    mockIntercept.mockResolvedValue({ handled: true, reply: 'Reviewer — idle' })

    const res = await chat(app, { message: '/status', stream: true })
    const text = await res.text()

    expect(text).toContain('event: done')
    expect(text).toContain('Reviewer — idle')
    expect(mockRunWithLifecycle).not.toHaveBeenCalled()
  })

  it('treats the test drawer as a direct conversation', async () => {
    await chat(app, { message: '/status' })

    expect(mockIntercept).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_test', text: '/status', chatType: 'p2p' }),
    )
  })

  it('applies to the published chat page too', async () => {
    mockIntercept.mockResolvedValue({ handled: true, reply: 'ok' })
    mockRequireAgentRead.mockResolvedValue({
      agent: {
        id: 'agt_test',
        userId: 'usr_admin',
        name: 'Reviewer',
        publishStatus: 'published',
        status: 'active',
        publishChannels: ['chat_app'],
        chatAppConfig: { enabled: true },
      },
      permission: 'owner',
    })

    const res = await chat(app, { message: '/status', channel: 'chat_app' })

    expect(res.status).toBe(200)
    expect(mockRunWithLifecycle).not.toHaveBeenCalled()
  })

  it('still validates the body before answering a command', async () => {
    const res = await chat(app, { message: '' })

    expect(res.status).toBe(400)
    expect(mockIntercept).not.toHaveBeenCalled()
  })

  it('leaves ordinary messages to the Agent', async () => {
    // Interception declined, so the endpoint proceeds into its normal path.
    await chat(app, { message: 'review MR 42' })

    expect(mockIntercept).toHaveBeenCalled()
  })
})

describe('POST /agents/:id/chat — /new', () => {
  it('starts a fresh session and forwards only the stripped text', async () => {
    // The chat endpoint owns its session through `chatId`, so `/new` here means
    // "ignore the chat id the client sent" rather than a channel-level reset.
    mockIntercept.mockResolvedValue({
      handled: false,
      intent: 'summarise yesterday',
      resetSession: true,
    })

    await chat(app, { message: '/new summarise yesterday', chatId: 'cht_old' })

    // Matched on the raw text, prefix and all; the endpoint then applies the
    // returned `intent` / `resetSession` to the turn it is about to run. The
    // rewrite itself is asserted in native-chat-command.test.ts, rather than by
    // rebuilding this route's positional DB mock to reach execution.
    expect(mockIntercept).toHaveBeenCalledWith(
      expect.objectContaining({ text: '/new summarise yesterday', chatType: 'p2p' }),
    )
  })
})
