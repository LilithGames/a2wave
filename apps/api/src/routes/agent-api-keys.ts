/**
 * Per-Agent API key management for the REST gateway (`api`) and A2A channels.
 *
 * Mounted at `/api/agents`, owning only the `/:id/api-keys*` subtree so there is no
 * path conflict with the main agents router (same arrangement as agent-members).
 *
 * Permission model: **write** (owner / editor / admin) on every route, matching the
 * regenerate-api-key endpoint these supersede. Key metadata — last-used time, the
 * display prefix, which integrations exist — is operational information, so it is not
 * exposed to viewers.
 *
 * The plaintext is returned exactly once, from POST, and is unrecoverable afterwards:
 * only its SHA-256 is stored.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { agentApiKeys } from '../db/schema.js'
import { requireAgentWrite } from '../lib/agent-access.js'
import {
  type AgentApiKeyChannel,
  generateAgentApiKey,
  hashAgentApiKey,
  keyPrefixOf,
  MAX_ACTIVE_KEYS_PER_CHANNEL,
  MAX_KEY_NAME_LENGTH,
} from '../lib/agent-api-key.js'
import { logAudit } from '../lib/audit.js'
import { AUDIT_ACTIONS } from '../lib/audit-actions.js'
import { createId } from '../lib/id.js'

const app = new Hono()

/** Past a year a key is effectively permanent and should be re-minted deliberately. */
const MAX_EXPIRES_IN_DAYS = 365

const channelSchema = z.enum(['api', 'a2a'])

const createSchema = z.object({
  channel: channelSchema,
  /** Required: this is the description shown in run history and the key list. */
  name: z.string().trim().min(1).max(MAX_KEY_NAME_LENGTH),
  /** Omitted means no expiry — see the schema comment on `expires_at`. */
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRES_IN_DAYS).optional(),
})

/**
 * Name and expiry are editable in place so a note can be corrected, or a lifetime
 * extended/shortened, without forcing a rotation that breaks the integration.
 * `expiresAt: null` clears the expiry.
 */
const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_KEY_NAME_LENGTH).optional(),
    expiresAt: z.string().datetime().nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.expiresAt !== undefined, {
    message: 'Nothing to update',
  })

/** Columns safe to return: everything except the hash. */
const listColumns = {
  id: agentApiKeys.id,
  channel: agentApiKeys.channel,
  name: agentApiKeys.name,
  keyPrefix: agentApiKeys.keyPrefix,
  expiresAt: agentApiKeys.expiresAt,
  lastUsedAt: agentApiKeys.lastUsedAt,
  lastUsedIp: agentApiKeys.lastUsedIp,
  revokedAt: agentApiKeys.revokedAt,
  createdAt: agentApiKeys.createdAt,
}

/** GET /:id/api-keys?channel=api|a2a — never returns a credential. */
app.get('/:id/api-keys', async (c) => {
  const { id } = c.req.param()
  await requireAgentWrite(c, id)

  const channel = channelSchema.safeParse(c.req.query('channel'))
  if (!channel.success) return c.json({ error: 'INVALID_CHANNEL' }, 400)

  const rows = await db
    .select(listColumns)
    .from(agentApiKeys)
    .where(and(eq(agentApiKeys.agentId, id), eq(agentApiKeys.channel, channel.data)))
    .orderBy(desc(agentApiKeys.createdAt))

  return c.json({ data: rows })
})

/** POST /:id/api-keys — mint one. The only time the plaintext is returned. */
app.post('/:id/api-keys', async (c) => {
  const { id } = c.req.param()
  await requireAgentWrite(c, id)

  const body = await c.req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const channel = parsed.data.channel as AgentApiKeyChannel

  // Bounded per channel: without a cap, one leaked credential could seed unlimited
  // backdoor keys and drown the list an operator would use to spot them.
  const active = await db
    .select({ id: agentApiKeys.id })
    .from(agentApiKeys)
    .where(
      and(
        eq(agentApiKeys.agentId, id),
        eq(agentApiKeys.channel, channel),
        isNull(agentApiKeys.revokedAt),
      ),
    )
  if (active.length >= MAX_ACTIVE_KEYS_PER_CHANNEL) {
    return c.json({ error: 'TOO_MANY_API_KEYS', limit: MAX_ACTIVE_KEYS_PER_CHANNEL }, 409)
  }

  const key = generateAgentApiKey(channel)
  const now = new Date()
  const expiresAt = parsed.data.expiresInDays
    ? new Date(now.getTime() + parsed.data.expiresInDays * 86_400_000)
    : null

  const [row] = await db
    .insert(agentApiKeys)
    .values({
      id: createId('aak'),
      agentId: id,
      channel,
      keyHash: hashAgentApiKey(key),
      keyPrefix: keyPrefixOf(key),
      name: parsed.data.name,
      expiresAt,
      createdBy: (c.get('userId' as never) as string | undefined) ?? null,
      createdAt: now,
    })
    .returning(listColumns)

  // The prefix is already shown in the list; the key itself never goes in `details`.
  logAudit(c, {
    action: AUDIT_ACTIONS.AGENT_API_KEY_CREATED,
    resource: 'agent_api_key',
    resourceId: row?.id,
    details: {
      agentId: id,
      channel,
      name: parsed.data.name,
      expiresInDays: parsed.data.expiresInDays ?? null,
    },
  })

  return c.json({ data: { ...row, key } })
})

/** PATCH /:id/api-keys/:keyId — edit the note or the expiry; never the credential. */
app.patch('/:id/api-keys/:keyId', async (c) => {
  const { id, keyId } = c.req.param()
  await requireAgentWrite(c, id)

  const body = await c.req.json().catch(() => null)
  const parsed = updateSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const updates: Record<string, unknown> = {}
  if (parsed.data.name !== undefined) updates.name = parsed.data.name
  if (parsed.data.expiresAt !== undefined) {
    updates.expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null
  }

  // Scoped by agentId as well as key id: a key id from another Agent is unreachable.
  const updated = await db
    .update(agentApiKeys)
    .set(updates)
    .where(and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.agentId, id)))
    .returning(listColumns)

  if (updated.length === 0) return c.json({ error: 'API_KEY_NOT_FOUND' }, 404)

  logAudit(c, {
    action: AUDIT_ACTIONS.AGENT_API_KEY_UPDATED,
    resource: 'agent_api_key',
    resourceId: keyId,
    details: {
      agentId: id,
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.expiresAt !== undefined ? { expiresAt: parsed.data.expiresAt } : {}),
    },
  })

  return c.json({ data: updated[0] })
})

/** DELETE /:id/api-keys/:keyId — revoke. Effective on the next request. */
app.delete('/:id/api-keys/:keyId', async (c) => {
  const { id, keyId } = c.req.param()
  await requireAgentWrite(c, id)

  // Guarded on "not already revoked" so a repeat call cannot re-audit, and scoped by
  // agentId so a key id from another Agent is unreachable.
  const revoked = await db
    .update(agentApiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(agentApiKeys.id, keyId), eq(agentApiKeys.agentId, id), isNull(agentApiKeys.revokedAt)),
    )
    .returning(listColumns)

  if (revoked.length === 0) return c.json({ error: 'API_KEY_NOT_FOUND' }, 404)

  logAudit(c, {
    action: AUDIT_ACTIONS.AGENT_API_KEY_REVOKED,
    resource: 'agent_api_key',
    resourceId: keyId,
    details: { agentId: id, channel: revoked[0]?.channel, name: revoked[0]?.name },
  })

  return c.json({ data: { id: keyId, revoked: true } })
})

export default app
