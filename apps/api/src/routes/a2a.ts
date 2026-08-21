import { A2A_VERSION_HEADER } from '@a2a-js/sdk'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { buildAgentCard, serializeAgentCard } from '../a2a/agent-card.js'
import { handleA2ARequest } from '../a2a/handle-request.js'
import { createRecordedA2ACancelFn, createRecordedA2AExecuteFn } from '../a2a/run-recording.js'
import { SqliteTaskStore } from '../a2a/sqlite-task-store.js'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { verifyAgentApiKey } from '../lib/agent-api-key-verify.js'
import { resolveClientIp } from '../lib/client-ip.js'
import {
  type AuthenticatingApiKey,
  type GatewayCaller,
  validateGatewayAuth,
} from '../middleware/gateway-auth.js'
import { rateLimit } from '../middleware/rate-limit.js'

type A2AVariables = {
  oauthCaller?: GatewayCaller
  /** Set when an `agent_api_keys` row authenticated the request; names the trigger in run history. */
  gatewayApiKey?: AuthenticatingApiKey
}

const app = new Hono<{ Variables: A2AVariables }>()

const globalTaskStore = new SqliteTaskStore()
void globalTaskStore.cleanup().catch(() => {})

app.use('*', rateLimit({ windowMs: 60_000, max: 60 }))

async function loadAndAuthAgent(c: Context<{ Variables: A2AVariables }>) {
  const { agentId } = c.req.param()
  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]

  if (!agent) return { error: c.json({ error: 'Agent not found' }, 404) }
  if (agent.publishStatus !== 'published')
    return { error: c.json({ error: 'Agent is not published' }, 403) }

  const channels = (agent.publishChannels as string[]) || ['api']
  if (!channels.includes('a2a'))
    return { error: c.json({ error: 'A2A not enabled for this agent' }, 403) }

  const clientIp = resolveClientIp(c) ?? 'unknown'
  // A2A 入站使用独立的鉴权方式与专属 key（与 REST API 渠道解耦）。
  // 故意不回退到 REST 的 endpointApiKey：若配成 api_key 却没有 a2a 专属 key，
  // validateGatewayAuth 会 fail-closed 拒绝，而非静默复用 REST key 重新耦合两者。
  // 注意：复用 validateGatewayAuth 的 publishAuthType/endpointApiKey 入参字段名，
  // 但喂入的是 a2a* 值。
  const authResult = await validateGatewayAuth(
    {
      publishIpWhitelist: (agent.publishIpWhitelist as string[]) || null,
      publishAuthType: agent.a2aAuthType,
      // Retained only for the dual-read window; cleared once every legacy key is migrated.
      endpointApiKey: agent.a2aEndpointApiKey,
      // Channel-scoped: an 'api' key can never satisfy an A2A request, preserving the
      // deliberate decoupling the separate legacy columns provided.
      verifyApiKey: (plaintext) => verifyAgentApiKey(agent.id, 'a2a', plaintext, { clientIp }),
      // No oauthAccessMode / oauthAllowedEmails: validateGatewayAuth's oauth branch is
      // unreachable from here. `a2aAuthType` is constrained to 'none' | 'api_key' by both
      // publishAuthTypeEnum and the column's own enum, so normalizeAuthType() never yields
      // 'oauth'. Passing an access mode would be dead configuration that reads as if this hop
      // participated in OAuth authorization; if A2A ever gains an oauth auth type, wire the
      // Agent's real mode in here rather than defaulting it.
    },
    { clientIp, authorizationHeader: c.req.header('Authorization') },
  )
  if (authResult.error) {
    return { error: c.json({ error: authResult.error.error }, authResult.error.status) }
  }
  if (authResult.caller) {
    c.set('oauthCaller', authResult.caller)
  }
  if (authResult.apiKey) {
    c.set('gatewayApiKey', authResult.apiKey)
  }

  return { agent }
}

app.get('/:agentId/.well-known/agent-card.json', async (c) => {
  const result = await loadAndAuthAgent(c)
  if ('error' in result) return result.error

  const baseUrl = new URL(c.req.url).origin
  const card = buildAgentCard(result.agent, baseUrl)
  c.header('Vary', 'A2A-Version')
  const requestedVersion = c.req.header(A2A_VERSION_HEADER)
  return c.json(serializeAgentCard(card, requestedVersion?.startsWith('1.') ? '1.0' : '0.3'))
})

app.post('/:agentId', async (c) => {
  const result = await loadAndAuthAgent(c)
  if ('error' in result) return result.error

  const { agent } = result

  return handleA2ARequest(
    c,
    agent,
    globalTaskStore,
    await createRecordedA2AExecuteFn(c, agent),
    createRecordedA2ACancelFn(c, agent),
  )
})

export default app
