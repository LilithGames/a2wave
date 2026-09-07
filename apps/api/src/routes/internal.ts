import { A2A_VERSION_HEADER } from '@a2a-js/sdk'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { buildAgentCard, serializeAgentCard } from '../a2a/agent-card.js'
import { handleA2ARequest } from '../a2a/handle-request.js'
import { createRecordedA2ACancelFn, createRecordedA2AExecuteFn } from '../a2a/run-recording.js'
import { SqliteTaskStore } from '../a2a/sqlite-task-store.js'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { env } from '../env.js'
import {
  INTERNAL_ADMIN_TOKEN_HEADER,
  INTERNAL_TOKEN_HEADER,
  verifyInternalAdminToken,
  verifyInternalToken,
} from '../lib/internal-admin-auth.js'
import {
  getStreamingCard,
  shouldShowRemoteChildOutput,
  touchStreamingCard,
} from '../lib/streaming-card-registry.js'
import internalAdminRoutes from './internal-admin.js'

const app = new Hono()

const globalTaskStore = new SqliteTaskStore()
void globalTaskStore.cleanup().catch(() => {})

// --- Localhost + process-credential middleware ---
const LOCALHOST_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

app.use('*', async (c, next) => {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress
  // Fail CLOSED: allow ONLY when we positively resolve a loopback address.
  // An absent/unknown address is not "trusted local" — it means the request did
  // not arrive over the expected 127.0.0.1 socket, so deny.
  if (!incoming || !LOCALHOST_IPS.has(incoming)) {
    return c.json({ error: 'Forbidden: internal API is localhost-only' }, 403)
  }
  // A same-host reverse proxy (a supported deployment, see TRUSTED_PROXY) makes
  // EVERY internet request arrive from loopback. When the deployment declares one,
  // a forwarded request is by definition not a local caller.
  if (env.TRUSTED_PROXY && c.req.header('x-forwarded-for')) {
    return c.json({ error: 'Forbidden: internal API is localhost-only' }, 403)
  }
  // The loopback socket alone proves nothing about the caller, so every internal
  // route — not just /admin — requires a process-scoped credential. Otherwise
  // POST /api/internal/a2a/:agentId is an anonymous Agent invoke (Iron Rule 5).
  const hasAdminCredential = verifyInternalAdminToken(c.req.header(INTERNAL_ADMIN_TOKEN_HEADER))
  // Admin endpoints return purpose-built redacted DTOs and need the STRONGER
  // credential specifically; the agent-router token must not reach them.
  if (/\/admin(?:\/|$)/.test(c.req.path) && !hasAdminCredential) {
    return c.json({ error: 'Forbidden: invalid internal admin credential' }, 403)
  }
  if (!hasAdminCredential && !verifyInternalToken(c.req.header(INTERNAL_TOKEN_HEADER))) {
    return c.json({ error: 'Forbidden: invalid internal credential' }, 403)
  }
  await next()
})

// --- GET /agents — list published A2A agents ---
app.get('/agents', async (c) => {
  const allAgents = await db.select().from(agents)

  const idsParam = c.req.query('ids')
  const filterIds = idsParam ? new Set(idsParam.split(',')) : null

  const published = allAgents.filter((a) => {
    if (a.publishStatus !== 'published') return false
    const channels = (a.publishChannels as string[]) || ['api']
    if (!channels.includes('a2a')) return false
    if (filterIds && !filterIds.has(a.id)) return false
    return true
  })

  const data = published.map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description,
    publishDescription: a.publishDescription,
    a2aSkills: a.a2aSkills,
  }))

  return c.json({ data })
})

// --- GET /a2a/:agentId/card — get agent card ---
app.get('/a2a/:agentId/card', async (c) => {
  const { agentId } = c.req.param()
  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]

  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  if (agent.publishStatus !== 'published') return c.json({ error: 'Agent is not published' }, 403)
  const channels = (agent.publishChannels as string[]) || ['api']
  if (!channels.includes('a2a')) return c.json({ error: 'A2A not enabled for this agent' }, 403)

  const baseUrl = new URL(c.req.url).origin
  const card = buildAgentCard(agent, baseUrl)
  c.header('Vary', 'A2A-Version')
  const requestedVersion = c.req.header(A2A_VERSION_HEADER)
  return c.json(serializeAgentCard(card, requestedVersion?.startsWith('1.') ? '1.0' : '0.3'))
})

// --- POST /a2a/:agentId — invoke A2A (loopback + internal process credential) ---
app.post('/a2a/:agentId', async (c) => {
  const { agentId } = c.req.param()
  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]

  if (!agent) return c.json({ error: 'Agent not found' }, 404)
  if (agent.publishStatus !== 'published') return c.json({ error: 'Agent is not published' }, 403)
  const channels = (agent.publishChannels as string[]) || ['api']
  if (!channels.includes('a2a')) return c.json({ error: 'A2A not enabled for this agent' }, 403)

  return handleA2ARequest(
    c,
    agent,
    globalTaskStore,
    await createRecordedA2AExecuteFn(c, agent),
    createRecordedA2ACancelFn(c, agent),
  )
})

// --- Admin management API (platform-admin MCP 数据源) ---
app.route('/admin', internalAdminRoutes)

// --- POST /streaming-card/:cardId/child — create child section (remote agents) ---
app.post('/streaming-card/:cardId/child', async (c) => {
  const { cardId } = c.req.param()
  const card = getStreamingCard(cardId)
  if (!card) return c.json({ error: 'Streaming card not found' }, 404)
  if (!shouldShowRemoteChildOutput(cardId)) return c.json({ ok: true, skipped: true })

  const { childId, label } = await c.req.json<{ childId: string; label?: string }>()
  if (!childId) return c.json({ error: 'childId is required' }, 400)

  touchStreamingCard(cardId)
  await card.addChildSection(childId, label)
  return c.json({ ok: true })
})

// --- PUT /streaming-card/:cardId/child/:childId — update child content ---
app.put('/streaming-card/:cardId/child/:childId', async (c) => {
  const { cardId, childId } = c.req.param()
  const card = getStreamingCard(cardId)
  if (!card) return c.json({ error: 'Streaming card not found' }, 404)
  if (!shouldShowRemoteChildOutput(cardId)) return c.json({ ok: true, skipped: true })

  const { content } = await c.req.json<{ content: string }>()
  touchStreamingCard(cardId)
  card.updateChildContent(childId, content)
  return c.json({ ok: true })
})

export default app
