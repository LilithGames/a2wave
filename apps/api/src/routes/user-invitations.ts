import { randomBytes } from 'node:crypto'
import { acceptInvitationInput, createInvitationInput } from '@a2wave/shared'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { userInvitations, users } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { logAudit } from '../lib/audit.js'
import { AUDIT_ACTIONS } from '../lib/audit-actions.js'
import { hashPassword, signToken, validatePassword } from '../lib/auth.js'
import { setAuthCookie } from '../lib/auth-cookie.js'
import { createId } from '../lib/id.js'
import { invitationStatusOf, serializeInvitation } from '../lib/invitation-status.js'

/**
 * Admin-facing invitation management. Mounted under the admin-guarded `/api/users` prefix.
 */
export const adminInvitationRoutes = new Hono()

/**
 * The invite code. 32 bytes of CSPRNG entropy, base64url — this is a bearer credential for
 * account creation reachable without authentication, so it is sized to be unguessable
 * rather than typed by hand. `createId` is not reused here: 12 bytes is right for a
 * database identifier that leaks nothing, but too little for a secret.
 */
function generateInvitationCode(): string {
  return randomBytes(32).toString('base64url')
}

/** GET /users/invitations — list invitations, newest first. */
adminInvitationRoutes.get('/', async (c) => {
  const rows = await db
    .select({
      id: userInvitations.id,
      code: userInvitations.code,
      email: userInvitations.email,
      role: userInvitations.role,
      note: userInvitations.note,
      invitedBy: userInvitations.invitedBy,
      invitedByName: users.displayName,
      invitedByUsername: users.username,
      acceptedUserId: userInvitations.acceptedUserId,
      acceptedAt: userInvitations.acceptedAt,
      revokedAt: userInvitations.revokedAt,
      expiresAt: userInvitations.expiresAt,
      createdAt: userInvitations.createdAt,
    })
    .from(userInvitations)
    .leftJoin(users, eq(users.id, userInvitations.invitedBy))
    .orderBy(desc(userInvitations.createdAt))
    .limit(200)

  return c.json({ data: rows.map(serializeInvitation) })
})

/** POST /users/invitations — issue a new invitation link. */
adminInvitationRoutes.post('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = createInvitationInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { email, role, expiresInHours, note } = parsed.data

  // An address that already belongs to an account cannot be invited: accept would fail at
  // the unique index anyway, and reporting it now is the difference between the admin
  // learning it here and the invitee hitting a dead link.
  if (email) {
    const existingUser = (
      await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
    )[0]
    if (existingUser) {
      return c.json({ error: 'EMAIL_ALREADY_REGISTERED' }, 409)
    }
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + expiresInHours * 3_600_000)

  // Re-inviting the same address is a normal thing to do — the first mail got lost, or the
  // link expired. Rather than refusing (which leaves the admin stuck) or silently stacking
  // links (which leaves several live credentials for one person), the outstanding one is
  // revoked and replaced, so exactly one link per address is ever live.
  const supersededId = email ? await revokePendingInvitationFor(email, now) : null

  const id = createId('inv')
  const code = generateInvitationCode()
  const inserted = (
    await db
      .insert(userInvitations)
      .values({
        id,
        code,
        email: email ?? null,
        role,
        note: note ?? null,
        invitedBy: (c.get('userId' as never) as string | undefined) ?? null,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
  )[0]

  logAudit(c, {
    action: AUDIT_ACTIONS.USER_INVITATION_CREATED,
    resource: 'user_invitation',
    resourceId: id,
    // The code is deliberately absent: `details` renders verbatim to every admin, and the
    // code is the credential itself (Iron Rule 5). Only its non-secret shape is recorded.
    details: {
      role,
      expiresInHours,
      hasEmail: !!email,
      ...(supersededId ? { supersededInvitationId: supersededId } : {}),
    },
  })

  return c.json({ data: serializeInvitation(inserted) }, 201)
})

/**
 * Revoke whatever pending invitation an address already holds, returning its id.
 *
 * Scoped by the same "still pending" predicate the accept path uses, so an already
 * accepted or revoked row is left untouched and stays auditable.
 */
async function revokePendingInvitationFor(email: string, now: Date): Promise<string | null> {
  const revoked = await db
    .update(userInvitations)
    .set({ revokedAt: now, updatedAt: now })
    .where(
      and(
        eq(userInvitations.email, email),
        isNull(userInvitations.acceptedAt),
        isNull(userInvitations.revokedAt),
      ),
    )
    .returning({ id: userInvitations.id })
  return revoked[0]?.id ?? null
}

/** POST /users/invitations/:id/revoke — withdraw an invitation that has not been used. */
adminInvitationRoutes.post('/:id/revoke', async (c) => {
  const { id } = c.req.param()

  const invitation = (
    await db.select().from(userInvitations).where(eq(userInvitations.id, id)).limit(1)
  )[0]
  if (!invitation) {
    return c.json({ error: 'INVITATION_NOT_FOUND' }, 404)
  }
  // An accepted invitation is history, not a live credential — revoking it would suggest
  // the account it created is somehow undone, which it is not. Deleting the user is the
  // operation that means that.
  if (invitation.acceptedAt) {
    return c.json({ error: 'INVITATION_ALREADY_ACCEPTED' }, 409)
  }

  const now = new Date()
  // Compare-and-set on "not yet accepted": between the read above and this write the
  // invitee may have accepted, and revoking then would leave a row claiming both.
  const revoked = await db
    .update(userInvitations)
    .set({ revokedAt: now, updatedAt: now })
    .where(and(eq(userInvitations.id, id), isNull(userInvitations.acceptedAt)))
    .returning({ id: userInvitations.id })

  if (revoked.length === 0) {
    return c.json({ error: 'INVITATION_ALREADY_ACCEPTED' }, 409)
  }

  logAudit(c, {
    action: AUDIT_ACTIONS.USER_INVITATION_REVOKED,
    resource: 'user_invitation',
    resourceId: id,
    details: { role: invitation.role, hasEmail: !!invitation.email },
  })

  return c.json({ data: { id, status: 'revoked' } })
})

/**
 * Public invitation routes — mounted under `/api/auth/invitations`, unauthenticated by
 * necessity (the caller has no account yet) and therefore rate limited at the mount point.
 */
export const publicInvitationRoutes = new Hono()

/**
 * GET /auth/invitations/:code — what the registration page asks before rendering a form.
 *
 * Returns the invitation's *status* rather than 404-ing everything that is not usable, so
 * the page can say "this link expired" instead of "not found" — the two call for different
 * actions from the invitee (ask for a new link vs check the URL).
 */
publicInvitationRoutes.get('/:code', async (c) => {
  const { code } = c.req.param()
  const invitation = (
    await db.select().from(userInvitations).where(eq(userInvitations.code, code)).limit(1)
  )[0]

  if (!invitation) {
    return c.json({ error: 'INVITATION_NOT_FOUND' }, 404)
  }

  const status = invitationStatusOf(invitation)
  return c.json({
    data: {
      status,
      // Only echoed for a still-usable link, and only the pinned address the admin already
      // knows — an expired or spent code must not become an address oracle.
      email: status === 'pending' ? invitation.email : null,
      expiresAt: invitation.expiresAt,
    },
  })
})

/**
 * Error code per non-pending status.
 *
 * Spelled out rather than derived from the status string: these codes are a contract the
 * web client maps to copy, and a template would let a future status silently emit a code
 * nothing translates — surfacing to the invitee as a raw identifier.
 */
/**
 * Signals that a concurrent submit consumed the invitation first.
 *
 * A thrown sentinel rather than a `null` return because the transaction must **roll back**:
 * the user row is inserted before the claim (see the accept handler for why the order is
 * forced), so returning normally would commit an account created by a spent invitation.
 */
class InvitationRaceLostError extends Error {
  constructor() {
    super('Invitation was accepted concurrently')
    this.name = 'InvitationRaceLostError'
  }
}

const NON_PENDING_ERROR = {
  accepted: 'INVITATION_ALREADY_ACCEPTED',
  expired: 'INVITATION_EXPIRED',
  revoked: 'INVITATION_REVOKED',
} as const

/**
 * POST /auth/invitations/:code/accept — the invitee creates their own account.
 *
 * This is the only unauthenticated account-creation path besides SSO provisioning, so every
 * refusal is audited: without it an admin cannot tell a mistyped link from a code being
 * probed.
 */
publicInvitationRoutes.post('/:code/accept', async (c) => {
  const { code } = c.req.param()
  const body = await c.req.json().catch(() => null)
  const parsed = acceptInvitationInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  const { username, displayName, email, password } = parsed.data

  const invitation = (
    await db.select().from(userInvitations).where(eq(userInvitations.code, code)).limit(1)
  )[0]
  if (!invitation) {
    return c.json({ error: 'INVITATION_NOT_FOUND' }, 404)
  }

  const status = invitationStatusOf(invitation)
  if (status !== 'pending') {
    return failAccept(c, invitation.id, NON_PENDING_ERROR[status], 409)
  }

  // A pinned invitation may only be accepted by the address it names. Without this the link
  // is fully transferable, and the role the admin chose for one person silently lands on
  // whoever the link reached.
  if (invitation.email && invitation.email !== email) {
    return failAccept(c, invitation.id, 'INVITATION_EMAIL_MISMATCH', 400)
  }

  // Belt-and-braces over the shared schema: the policy lives in one place server-side, and
  // a client that skips the shared schema must not get a weaker password accepted.
  const validation = validatePassword(password)
  if (!validation.valid) {
    return c.json({ error: validation.message }, 400)
  }

  const existingUsername = (
    await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1)
  )[0]
  if (existingUsername) {
    return failAccept(c, invitation.id, 'USERNAME_EXISTS', 409)
  }

  const existingEmail = (
    await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
  )[0]
  if (existingEmail) {
    return failAccept(c, invitation.id, 'EMAIL_ALREADY_REGISTERED', 409)
  }

  const userId = createId('usr')
  const passwordHash = await hashPassword(password)
  const now = new Date()

  // The user row and the invitation's consumption commit together. Split apart, a failure
  // between them either creates an account whose invitation stays reusable (a second
  // account from one link) or burns a link that produced no account.
  //
  // Order matters, and not for the reason it first appears. Claiming the invitation first
  // reads as the safer order — but `accepted_user_id` is a FOREIGN KEY to `users`, and
  // PostgreSQL checks it immediately (the constraint is NOT DEFERRABLE), so writing the id
  // of a row that does not exist yet aborts the transaction outright. Every accept failed
  // with a 500 on PostgreSQL until this was flipped; SQLite did not catch it because
  // foreign keys are off by default there, and the unit tests did not because they mock
  // the database and have no constraints at all.
  //
  // Inserting the user first is still single-use-safe: the claim below is a compare-and-set
  // on `acceptedAt IS NULL`, so a second concurrent submit matches no row, and returning
  // null rolls the whole transaction back — including the user it just inserted.
  const created = await withTransaction(async (tx) => {
    const inserted = (
      await tx
        .insert(users)
        .values({
          id: userId,
          username,
          displayName: displayName || null,
          email,
          role: invitation.role,
          passwordHash,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    )[0]

    const claimed = await tx
      .update(userInvitations)
      .set({ acceptedAt: now, acceptedUserId: userId, updatedAt: now })
      .where(and(eq(userInvitations.id, invitation.id), isNull(userInvitations.acceptedAt)))
      .returning({ id: userInvitations.id })
    // Lost the race: another submit consumed the invitation first. Throwing rather than
    // returning null so the user row inserted above is rolled back — returning normally
    // would commit the transaction and leave an account created by a spent invitation.
    if (claimed.length === 0) throw new InvitationRaceLostError()

    return inserted
  }).catch((error) => {
    if (error instanceof InvitationRaceLostError) return null
    throw error
  })

  if (!created) {
    return failAccept(c, invitation.id, 'INVITATION_ALREADY_ACCEPTED', 409)
  }

  logAudit(c, {
    action: AUDIT_ACTIONS.USER_INVITATION_ACCEPTED,
    resource: 'user_invitation',
    resourceId: invitation.id,
    // Attributed to the account just created — the request carries no caller identity, and
    // an audit entry with a null actor would be the one entry nobody can trace.
    userId: created.id,
    details: { userId: created.id, username: created.username, role: created.role },
  })

  // Signing the invitee in immediately is the point of the flow: they have just proven they
  // hold the invitation and chosen their own password, so a login form here would only ask
  // them to retype what they typed a second ago.
  const token = await signToken({
    id: created.id,
    role: created.role,
    tokenVersion: created.tokenVersion,
  })
  setAuthCookie(c, token)

  return c.json(
    {
      data: {
        token,
        user: {
          id: created.id,
          username: created.username,
          displayName: created.displayName,
          role: created.role,
          email: created.email,
          onboarding: created.onboarding ?? {},
        },
      },
    },
    201,
  )
})

/**
 * Refuse an accept attempt, recording why.
 *
 * Every rejection is audited because this endpoint is unauthenticated: the audit log is the
 * only place an administrator can see that a link is being replayed or guessed.
 */
function failAccept(
  c: Parameters<typeof logAudit>[0],
  invitationId: string,
  reason: string,
  status: 400 | 404 | 409,
) {
  logAudit(c, {
    action: AUDIT_ACTIONS.USER_INVITATION_ACCEPT_FAILED,
    resource: 'user_invitation',
    resourceId: invitationId,
    details: { reason, status },
  })
  return c.json({ error: reason }, status)
}
