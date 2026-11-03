import { providerOauthLoginInput } from '@a2wave/shared'
import { and, eq, or } from 'drizzle-orm'
import { type Context, Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { agents, providerOauthAccounts, providers } from '../db/schema.js'
import { runExclusive, withTransaction } from '../db/transaction.js'
import { logAudit } from '../lib/audit.js'
import { jsonArrayContainsKeyValue } from '../lib/json-sql.js'
import {
  completeProviderOauthLogin,
  createProviderOauthLogin,
  disconnectProviderOauthAccount,
  getProviderOauthLoginStatus,
  ProviderOauthError,
  startProviderOauthLogin,
  toProviderOauthAccountDto,
} from '../lib/provider-oauth-accounts.js'
import { getOauthAccount, listOauthAccounts } from '../lib/provider-oauth-store.js'
import { isAdmin } from '../middleware/auth-middleware.js'
import { rateLimit } from '../middleware/rate-limit.js'

export const providerOauthAccountsRoutes = new Hono()
export const providerOauthLoginRoutes = new Hono()
const accounts = providerOauthAccountsRoutes
const logins = providerOauthLoginRoutes
function actor(c: Context) {
  return { userId: String(c.get('userId')), isAdmin: isAdmin(c) }
}
function safeError(error: unknown, c: Context) {
  if (error instanceof ProviderOauthError)
    return c.json({ error: error.message, code: error.code }, error.status)
  return c.json(
    { error: 'Could not complete the ChatGPT account operation', code: 'provider_oauth_failed' },
    500,
  )
}
for (const router of [accounts, logins]) {
  router.onError(safeError)
  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store')
    await next()
  })
}
accounts.use('/:id/oauth-accounts*', async (c, next) => {
  if (!c.get('userId' as never)) return c.json({ error: 'Authentication required' }, 401)
  const [provider] = await db
    .select()
    .from(providers)
    .where(eq(providers.id, c.req.param('id')))
    .limit(1)
  if (!provider) return c.json({ error: 'Provider not found' }, 404)
  if (provider.kind !== 'codex')
    return c.json({ error: 'ChatGPT accounts require the Codex Provider' }, 400)
  await next()
})
accounts.get('/:id/oauth-accounts', async (c) =>
  c.json({
    data: (await listOauthAccounts(c.req.param('id'))).map((row) =>
      toProviderOauthAccountDto(row, actor(c)),
    ),
  }),
)
accounts.post('/:id/oauth-accounts/login', rateLimit({ windowMs: 60_000, max: 10 }), async (c) => {
  const parsed = providerOauthLoginInput.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid login request' }, 400)
  const data = await createProviderOauthLogin(c.req.param('id') ?? '', actor(c), parsed.data)
  logAudit(c, {
    action: 'provider_oauth_account.login_create',
    resource: 'provider_oauth_account',
    resourceId: parsed.data.accountId ?? data.loginId,
  })
  return c.json({ data }, 201)
})
accounts.get('/:id/oauth-accounts/logins/:loginId', async (c) =>
  c.json({
    data: await getProviderOauthLoginStatus(c.req.param('loginId'), c.req.param('id'), actor(c)),
  }),
)

async function manageableAccount(c: Context) {
  const row = await getOauthAccount(c.req.param('accountId') ?? '')
  if (!row || row.providerId !== c.req.param('id'))
    throw new ProviderOauthError('account_not_found', 'ChatGPT account not found', 404)
  const current = actor(c)
  if (!current.isAdmin && row.createdByUserId !== current.userId)
    throw new ProviderOauthError(
      'forbidden',
      'Only the creator or an administrator may manage this account',
      403,
    )
  return row
}
accounts.patch('/:id/oauth-accounts/:accountId', async (c) => {
  const row = await manageableAccount(c)
  const parsed = z
    .object({ label: z.string().trim().min(1).max(100) })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'A label is required' }, 400)
  const [updated] = await runExclusive(async () =>
    db
      .update(providerOauthAccounts)
      .set({ label: parsed.data.label, updatedAt: new Date() })
      .where(eq(providerOauthAccounts.id, row.id))
      .returning(),
  )
  if (!updated) return c.json({ error: 'ChatGPT account not found' }, 404)
  logAudit(c, {
    action: 'provider_oauth_account.update',
    resource: 'provider_oauth_account',
    resourceId: row.id,
  })
  return c.json({ data: toProviderOauthAccountDto(updated, actor(c)) })
})
accounts.delete('/:id/oauth-accounts/:accountId', async (c) => {
  const row = await manageableAccount(c)
  const referencesBefore = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      or(
        eq(agents.providerOauthAccountId, row.id),
        jsonArrayContainsKeyValue(
          agents.config,
          ['providerChain'],
          'providerOauthAccountId',
          row.id,
        ),
      ),
    )
    .limit(1)
  if (referencesBefore.length)
    throw new ProviderOauthError(
      'account_in_use',
      'Remove this account from its Agent bindings before deleting it',
      409,
    )
  await disconnectProviderOauthAccount(row.id, actor(c).userId)
  await withTransaction(async (tx) => {
    const references = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(
        or(
          eq(agents.providerOauthAccountId, row.id),
          jsonArrayContainsKeyValue(
            agents.config,
            ['providerChain'],
            'providerOauthAccountId',
            row.id,
          ),
        ),
      )
      .limit(1)
    if (references.length)
      throw new ProviderOauthError(
        'account_in_use',
        'Remove this account from its Agent bindings before deleting it',
        409,
      )
    await tx
      .delete(providerOauthAccounts)
      .where(
        and(
          eq(providerOauthAccounts.id, row.id),
          eq(providerOauthAccounts.providerId, row.providerId),
        ),
      )
  })
  logAudit(c, {
    action: 'provider_oauth_account.delete',
    resource: 'provider_oauth_account',
    resourceId: row.id,
  })
  return c.json({ data: { id: row.id } })
})

logins.use('*', rateLimit({ windowMs: 60_000, max: 20 }))
function loginBearer(c: Context) {
  const match = c.req.header('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]+)$/)
  if (!match)
    throw new ProviderOauthError(
      'invalid_login_token',
      'A short-lived authorization token is required',
      401,
    )
  return match[1] as string
}
logins.post('/:loginId/start', async (c) => {
  const token = loginBearer(c)
  const parsed = z
    .object({ redirectUri: z.string().max(512) })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'A loopback redirect URI is required' }, 400)
  return c.json({
    data: await startProviderOauthLogin(c.req.param('loginId'), token, parsed.data.redirectUri),
  })
})
logins.post('/:loginId/complete', async (c) => {
  const token = loginBearer(c)
  const parsed = z
    .object({
      code: z.string().min(1).max(8192).optional(),
      state: z.string().min(1).max(512),
      clientId: z.string().min(1).max(512).optional(),
      error: z.string().max(128).optional(),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: 'Invalid OAuth callback' }, 400)
  return c.json({
    data: await completeProviderOauthLogin(c.req.param('loginId'), token, parsed.data),
  })
})
