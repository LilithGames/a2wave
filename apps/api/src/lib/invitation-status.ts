import type { InvitationStatus } from '@a2wave/shared'

/** The invitation columns any status decision needs. Structural so both query shapes fit. */
export interface InvitationRow {
  acceptedAt: Date | null
  revokedAt: Date | null
  expiresAt: Date
}

/**
 * Derive an invitation's status from its own columns.
 *
 * Status is computed, never stored. A persisted `expired` would only become true when some
 * sweeper happened to run, so a link would keep working past its deadline until then —
 * deriving it makes the deadline exact and needs no background job.
 *
 * Order matters: a terminal transition outranks the clock. An invitation that was accepted
 * and has since passed `expiresAt` is `accepted` — reporting it as `expired` would suggest
 * the account it created never happened.
 */
export function invitationStatusOf(row: InvitationRow, now: Date = new Date()): InvitationStatus {
  if (row.acceptedAt) return 'accepted'
  if (row.revokedAt) return 'revoked'
  if (row.expiresAt.getTime() <= now.getTime()) return 'expired'
  return 'pending'
}

interface SerializableInvitation extends InvitationRow {
  id: string
  code: string
  email: string | null
  role: 'admin' | 'user'
  note: string | null
  invitedBy?: string | null
  invitedByName?: string | null
  invitedByUsername?: string | null
  acceptedUserId: string | null
  createdAt: Date
}

/**
 * Shape an invitation row for an administrator.
 *
 * The `code` is included: an admin needs the link to send it, and this response is already
 * behind the admin guard. It is the *audit* `details` that must never carry it.
 */
export function serializeInvitation(row: SerializableInvitation) {
  return {
    id: row.id,
    code: row.code,
    email: row.email,
    role: row.role,
    status: invitationStatusOf(row),
    note: row.note,
    invitedBy: row.invitedBy ?? null,
    invitedByName: row.invitedByName || row.invitedByUsername || null,
    acceptedUserId: row.acceptedUserId,
    acceptedAt: row.acceptedAt,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}
