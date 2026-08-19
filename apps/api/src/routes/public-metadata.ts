import { inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { normalizeOauthAccessMode } from '../lib/gateway-auth-errors.js'
import { isOauthChannelConfigured } from '../lib/oidc.js'

const MAX_AGENT_IDS = 50

const app = new Hono()

function parseAgentIds(agentIds: string | undefined, agentId: string | undefined): string[] {
  const raw = agentIds ?? agentId ?? ''
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  return Array.from(new Set(ids))
}

app.get('/agents/metadata', async (c) => {
  const requestedIds = parseAgentIds(c.req.query('agentIds'), c.req.query('agentId'))
  if (requestedIds.length === 0) {
    return c.json({ error: 'agentIds is required' }, 400)
  }
  if (requestedIds.length > MAX_AGENT_IDS) {
    return c.json({ error: `agentIds supports at most ${MAX_AGENT_IDS} IDs` }, 400)
  }

  const [rows, oauthChannelConfigured] = await Promise.all([
    db
      .select({
        id: agents.id,
        name: agents.name,
        description: agents.description,
        publishStatus: agents.publishStatus,
        publishChannels: agents.publishChannels,
        oauthAccessMode: agents.oauthAccessMode,
      })
      .from(agents)
      .where(inArray(agents.id, requestedIds)),
    isOauthChannelConfigured(),
  ])

  const byId = new Map(rows.map((agent) => [agent.id, agent]))
  const data = requestedIds.map((agentId) => {
    const agent = byId.get(agentId)
    if (agent?.publishStatus !== 'published') {
      return { agentId, exists: false, metadata: null }
    }

    const publishChannels = (agent.publishChannels as string[] | null | undefined) ?? []
    return {
      agentId,
      exists: true,
      metadata: {
        name: agent.name,
        description: agent.description ?? '',
        oauthEnabled: publishChannels.includes('oauth') && oauthChannelConfigured,
        oauthAccessMode: normalizeOauthAccessMode(agent.oauthAccessMode),
      },
    }
  })

  c.header('Cache-Control', 'public, max-age=60')
  return c.json({ data })
})

export default app
