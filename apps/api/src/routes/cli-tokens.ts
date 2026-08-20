/**
 * CLI token management.
 *
 * A named, long-lived bearer credential a user mints for automation — CI, a
 * script, a machine that cannot run the device grant's browser step. Every route
 * here is scoped to the calling user: tokens are personal credentials, so even an
 * admin manages only their own through this surface.
 *
 * The plaintext is returned exactly once, from POST. It is unrecoverable
 * afterwards by design — only its SHA-256 is stored.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { cliTokens } from '../db/schema.js'
import { env } from '../env.js'
import { logAudit } from '../lib/audit.js'
import { AUDIT_ACTIONS } from '../lib/audit-actions.js'
import { generateCliToken, hashCliToken, tokenPrefixOf } from '../lib/cli-token.js'
import { createId } from '../lib/id.js'

const app = new Hono()

/** A year. Past this a token is effectively permanent and should be re-minted deliberately. */
const MAX_EXPIRES_IN_DAYS = 365

const createSchema = z.object({
  /** Required: an unnamed token cannot be told apart from another later. */
  name: z.string().trim().min(1).max(100),
  /**
   * Omitted means no expiry. Deliberately permitted — a CI credential that dies
   * mid-quarter without warning is worse than one an operator can see and revoke,
   * and the list surfaces last-used precisely so it stays visible.
   */
  expiresInDays: z.number().int().min(1).max(MAX_EXPIRES_IN_DAYS).optional(),
})

/** GET /cli-tokens — the caller's own tokens, newest first. Never returns a credential. */
app.get('/', async (c) => {
  const userId = c.get('userId' as never) as string
  const rows = await db
    .select({
      id: cliTokens.id,
      name: cliTokens.name,
      tokenPrefix: cliTokens.tokenPrefix,
      expiresAt: cliTokens.expiresAt,
      lastUsedAt: cliTokens.lastUsedAt,
      revokedAt: cliTokens.revokedAt,
      createdAt: cliTokens.createdAt,
    })
    .from(cliTokens)
    .where(eq(cliTokens.userId, userId))
    .orderBy(desc(cliTokens.createdAt))

  return c.json({ data: rows })
})

/**
 * GET /cli-tokens/session-policy — the session lifetime, read-only.
 *
 * Surfaced so a user can see what it is without shell access to `.env`. It stays
 * env-only on purpose: `env.ts` deliberately keeps security-sensitive numbers out
 * of the settings table, where they could be changed from a browser.
 */
app.get('/session-policy', (c) =>
  c.json({ data: { sessionTtlDays: env.AUTH_SESSION_TTL_DAYS, configurable: false } }),
)

/** POST /cli-tokens — mint one. The only time the plaintext is ever returned. */
app.post('/', async (c) => {
  const userId = c.get('userId' as never) as string

  // A CLI token must not be able to mint another one. Otherwise revoking a leaked
  // token contains nothing — the attacker simply issues a replacement, and it
  // appears in the owner's list as an ordinary entry. Listing and deleting stay
  // open to tokens so automation can still clean up after itself.
  if ((c.get('authMethod' as never) as string) === 'cli_token') {
    return c.json({ error: 'SESSION_REQUIRED' }, 403)
  }
  const body = await c.req.json().catch(() => null)
  const parsed = createSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const token = generateCliToken()
  const now = new Date()
  const expiresAt = parsed.data.expiresInDays
    ? new Date(now.getTime() + parsed.data.expiresInDays * 86_400_000)
    : null

  const [row] = await db
    .insert(cliTokens)
    .values({
      id: createId('clt'),
      tokenHash: hashCliToken(token),
      tokenPrefix: tokenPrefixOf(token),
      name: parsed.data.name,
      userId,
      expiresAt,
      createdAt: now,
    })
    .returning()

  // The prefix is safe to record (it is already shown in the list); the token is not.
  logAudit(c, {
    action: AUDIT_ACTIONS.CLI_TOKEN_CREATED,
    resource: 'cli_token',
    resourceId: row?.id,
    details: { name: parsed.data.name, expiresInDays: parsed.data.expiresInDays ?? null },
  })

  return c.json({ data: { ...row, tokenHash: undefined, token } })
})

/** DELETE /cli-tokens/:id — revoke. Takes effect on the next request. */
app.delete('/:id', async (c) => {
  const userId = c.get('userId' as never) as string
  const id = c.req.param('id')

  // Scoped by userId and guarded on "not already revoked": this is what stops one
  // user revoking another's token, and keeps a repeat call from re-auditing.
  const revoked = await db
    .update(cliTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(cliTokens.id, id), eq(cliTokens.userId, userId), isNull(cliTokens.revokedAt)))
    .returning()

  if (revoked.length === 0) return c.json({ error: 'CLI_TOKEN_NOT_FOUND' }, 404)

  logAudit(c, {
    action: AUDIT_ACTIONS.CLI_TOKEN_REVOKED,
    resource: 'cli_token',
    resourceId: id,
    details: { name: revoked[0]?.name },
  })

  return c.json({ data: { id, revoked: true } })
})

export default app
