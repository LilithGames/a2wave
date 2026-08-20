/**
 * Device authorization grant (RFC 8628) — `a2wave login` on a machine with no
 * browser.
 *
 * The CLI half (`/code`, `/token`) is unauthenticated by necessity: the caller has
 * no credential yet, which is the whole point. The browser half (`/pending`,
 * `/approve`, `/deny`) runs behind the normal session guard, so the decision is
 * always made by an already-authenticated user. No new way in is created — the
 * grant only relays a session the user already established through whatever login
 * the deployment permits.
 *
 * Error codes on the token endpoint are the RFC's own strings (`authorization_pending`,
 * `slow_down`, `expired_token`, `access_denied`) so a standard client can read them.
 */
import { and, eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { deviceAuthorizations, users } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { AUDIT_ACTIONS } from '../lib/audit-actions.js'
import { signToken } from '../lib/auth.js'
import { resolveClientIp } from '../lib/client-ip.js'
import {
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  generateDeviceCode,
  generateUserCode,
  hashDeviceCode,
  isPolledTooSoon,
  normalizeUserCode,
} from '../lib/device-code.js'
import { createId } from '../lib/id.js'
import { getServerUrl } from '../lib/server-url.js'

const app = new Hono()

/** Shown on the approve page; truncated because it is attacker-supplied and rendered. */
const USER_AGENT_MAX_LENGTH = 200

/**
 * A user code must be unique to be looked up, and the alphabet is small enough
 * that a collision inside a 10-minute window is possible on a busy instance.
 * Retry a few times rather than failing a login on bad luck.
 */
const USER_CODE_MAX_ATTEMPTS = 5

async function allocateUserCode(): Promise<string | null> {
  for (let attempt = 0; attempt < USER_CODE_MAX_ATTEMPTS; attempt++) {
    const candidate = generateUserCode()
    const existing = await db
      .select({ id: deviceAuthorizations.id })
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.userCode, candidate))
      .limit(1)
    if (existing.length === 0) return candidate
  }
  return null
}

/**
 * POST /auth/device/code — start a login. Public: the caller has no credential yet.
 */
app.post('/code', async (c) => {
  const userCode = await allocateUserCode()
  if (!userCode) {
    return c.json({ error: 'DEVICE_CODE_ALLOCATION_FAILED' }, 503)
  }

  const deviceCode = generateDeviceCode()
  const now = new Date()
  const expiresAt = new Date(now.getTime() + DEVICE_CODE_TTL_SECONDS * 1000)

  await db.insert(deviceAuthorizations).values({
    id: createId('dev'),
    deviceCodeHash: hashDeviceCode(deviceCode),
    userCode,
    status: 'pending',
    userId: null,
    clientIp: resolveClientIp(c) ?? null,
    userAgent: c.req.header('User-Agent')?.slice(0, USER_AGENT_MAX_LENGTH) ?? null,
    expiresAt,
    createdAt: now,
  })

  // Neither code goes into `details`: the audit page renders it verbatim to every
  // admin, and both are live credentials for the next ten minutes.
  logAudit(c, {
    action: AUDIT_ACTIONS.AUTH_DEVICE_REQUESTED,
    resource: 'device_authorization',
    details: { expiresIn: DEVICE_CODE_TTL_SECONDS },
  })

  const baseUrl = (await getServerUrl()).replace(/\/+$/, '')
  return c.json({
    data: {
      deviceCode,
      userCode,
      verificationUri: `${baseUrl}/device`,
      verificationUriComplete: `${baseUrl}/device?code=${userCode}`,
      expiresIn: DEVICE_CODE_TTL_SECONDS,
      interval: DEVICE_POLL_INTERVAL_SECONDS,
    },
  })
})

const tokenSchema = z.object({ deviceCode: z.string().min(1) })

/**
 * POST /auth/device/token — the CLI's poll. Public, for the same reason as /code.
 */
app.post('/token', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = tokenSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)

  const [row] = await db
    .select()
    .from(deviceAuthorizations)
    .where(eq(deviceAuthorizations.deviceCodeHash, hashDeviceCode(parsed.data.deviceCode)))
    .limit(1)

  // An unknown code answers exactly as an expired one does. Distinguishing them
  // would turn this endpoint into an oracle for which codes exist.
  if (!row) return c.json({ error: 'expired_token' }, 400)

  const now = new Date()
  if (row.expiresAt.getTime() <= now.getTime()) return c.json({ error: 'expired_token' }, 400)
  if (row.status === 'denied') return c.json({ error: 'access_denied' }, 400)
  // Terminal by design: the CLI already holds its token, so a second presentation
  // of this code is a replay rather than a retry.
  if (row.status === 'claimed') return c.json({ error: 'expired_token' }, 400)

  if (isPolledTooSoon(row.lastPolledAt, now)) {
    return c.json({ error: 'slow_down', interval: DEVICE_POLL_INTERVAL_SECONDS }, 400)
  }

  if (row.status === 'pending') {
    await db
      .update(deviceAuthorizations)
      .set({ lastPolledAt: now })
      .where(eq(deviceAuthorizations.id, row.id))
    return c.json({ error: 'authorization_pending', interval: DEVICE_POLL_INTERVAL_SECONDS }, 400)
  }

  if (!row.userId) return c.json({ error: 'access_denied' }, 400)

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1)
  // Re-checked at claim time, not just at approval: an account can be disabled in
  // between, and this is the moment a long-lived credential would be handed out.
  if (!user?.isActive) {
    logAudit(c, {
      action: AUDIT_ACTIONS.AUTH_DEVICE_DENIED,
      resource: 'device_authorization',
      resourceId: row.id,
      userId: row.userId,
      details: { reason: 'ACCOUNT_DISABLED' },
    })
    return c.json({ error: 'access_denied' }, 400)
  }

  // Compare-and-set on `approved`: two concurrent polls must not both mint a token.
  const claimed = await db
    .update(deviceAuthorizations)
    .set({ status: 'claimed', lastPolledAt: now })
    .where(and(eq(deviceAuthorizations.id, row.id), eq(deviceAuthorizations.status, 'approved')))
    .returning()
  if (claimed.length === 0) return c.json({ error: 'expired_token' }, 400)

  const token = await signToken({ id: user.id, role: user.role, tokenVersion: user.tokenVersion })

  logAudit(c, {
    action: AUDIT_ACTIONS.AUTH_DEVICE_CLAIMED,
    resource: 'device_authorization',
    resourceId: row.id,
    userId: user.id,
    details: { username: user.username },
  })

  return c.json({
    data: {
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        email: user.email,
      },
    },
  })
})

/**
 * Load a row for the browser half. Returns null for anything the approver must not
 * be offered: unknown, expired, or already decided.
 */
async function loadPendingByUserCode(rawCode: string) {
  const userCode = normalizeUserCode(rawCode)
  if (!userCode) return { error: 'INVALID_USER_CODE' as const, row: null }

  const [row] = await db
    .select()
    .from(deviceAuthorizations)
    .where(eq(deviceAuthorizations.userCode, userCode))
    .limit(1)

  if (!row || row.expiresAt.getTime() <= Date.now()) {
    return { error: 'DEVICE_REQUEST_NOT_FOUND' as const, row: null }
  }
  return { error: null, row }
}

/**
 * GET /auth/device/pending?userCode= — what the approver is about to authorize.
 * Authenticated.
 */
app.get('/pending', async (c) => {
  const { error, row } = await loadPendingByUserCode(c.req.query('userCode') ?? '')
  // A malformed code is the caller's mistake (400); a well-formed one that no
  // longer exists is a missing resource (404).
  if (error === 'INVALID_USER_CODE') return c.json({ error }, 400)
  if (!row) return c.json({ error: 'DEVICE_REQUEST_NOT_FOUND' }, 404)

  // Deliberately omits deviceCodeHash. The browser needs to recognise the request,
  // not to be able to complete it.
  return c.json({
    data: {
      userCode: row.userCode,
      status: row.status,
      clientIp: row.clientIp,
      userAgent: row.userAgent,
      requestedAt: row.createdAt,
      expiresAt: row.expiresAt,
    },
  })
})

const decisionSchema = z.object({ userCode: z.string().min(1) })

/** Approve and deny differ only in the status they write and the audit they leave. */
async function decide(c: Context, approve: boolean) {
  const body = await c.req.json().catch(() => null)
  const parsed = decisionSchema.safeParse(body)
  if (!parsed.success) return c.json({ error: 'INVALID_USER_CODE' }, 400)

  const { error, row } = await loadPendingByUserCode(parsed.data.userCode)
  if (error === 'INVALID_USER_CODE') return c.json({ error }, 400)
  // An already-decided request must not be reopened: otherwise replaying the page
  // could flip a denial back into an approval.
  if (row?.status !== 'pending') return c.json({ error: 'DEVICE_REQUEST_NOT_FOUND' }, 400)

  const userId = c.get('userId' as never) as string
  const now = new Date()
  const updated = await db
    .update(deviceAuthorizations)
    .set(
      approve
        ? { status: 'approved', userId, approvedAt: now }
        : { status: 'denied', userId, approvedAt: null },
    )
    // Guarded on `pending` so a concurrent decision wins outright instead of being
    // silently overwritten by whichever request commits last.
    .where(and(eq(deviceAuthorizations.id, row.id), eq(deviceAuthorizations.status, 'pending')))
    .returning()
  if (updated.length === 0) return c.json({ error: 'DEVICE_REQUEST_NOT_FOUND' }, 400)

  logAudit(c, {
    action: approve ? AUDIT_ACTIONS.AUTH_DEVICE_APPROVED : AUDIT_ACTIONS.AUTH_DEVICE_DENIED,
    resource: 'device_authorization',
    resourceId: row.id,
    details: { clientIp: row.clientIp },
  })

  return c.json({ data: { status: approve ? 'approved' : 'denied' } })
}

/** POST /auth/device/approve — authenticated; binds the request to the caller. */
app.post('/approve', (c) => decide(c, true))

/** POST /auth/device/deny — authenticated. */
app.post('/deny', (c) => decide(c, false))

export default app
