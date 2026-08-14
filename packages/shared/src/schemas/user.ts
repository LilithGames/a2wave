import { z } from 'zod'

export const userRoleEnum = z.enum(['admin', 'user'])
export type UserRole = z.infer<typeof userRoleEnum>

export const passwordPolicySchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/\d/, 'Password must contain at least one digit')

export const setupInput = z
  .object({
    password: passwordPolicySchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
export type SetupInput = z.infer<typeof setupInput>

export const loginInput = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})
export type LoginInput = z.infer<typeof loginInput>

/**
 * Username accepted at self-registration.
 *
 * Stricter than the historical `z.string().min(1)` the admin-create path used, because the
 * value now arrives from an unauthenticated caller rather than an administrator typing it:
 * it is a login identifier, so leading/trailing spaces and look-alike whitespace produce
 * accounts nobody can sign in to. Existing rows are never re-validated — this gates writes
 * only.
 */
export const usernamePolicySchema = z
  .string()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
    'Username may only contain letters, digits, dot, underscore and hyphen, and must start with a letter or digit',
  )

export const emailSchema = z.string().trim().toLowerCase().email('Invalid email address').max(254)

/**
 * How long an invitation link stays usable, in hours.
 *
 * One hour: the link is a bearer credential for account creation, so its lifetime is scoped
 * to the conversation that produces it — an admin sends it and the colleague opens it now.
 * The console offers no picker; an API or CLI caller with a different need can still pass
 * `expiresInHours` explicitly.
 */
export const DEFAULT_INVITATION_TTL_HOURS = 1

/** Invitation lifecycle as the API reports it. Only `pending` can still be accepted. */
export const invitationStatusEnum = z.enum(['pending', 'accepted', 'expired', 'revoked'])
export type InvitationStatus = z.infer<typeof invitationStatusEnum>

export const createInvitationInput = z.object({
  /**
   * Pins the invitation to one address. Optional: an admin who does not know the recipient's
   * address yet can still issue a link, and the invitee supplies their own email on accept.
   */
  email: emailSchema.optional(),
  role: userRoleEnum.default('user'),
  expiresInHours: z.number().int().min(1).max(720).default(DEFAULT_INVITATION_TTL_HOURS),
  note: z.string().max(200).optional(),
})
export type CreateInvitationInput = z.infer<typeof createInvitationInput>

export const acceptInvitationInput = z
  .object({
    username: usernamePolicySchema,
    displayName: z.string().trim().max(64).optional(),
    email: emailSchema,
    password: passwordPolicySchema,
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  })
export type AcceptInvitationInput = z.infer<typeof acceptInvitationInput>

export interface Invitation {
  id: string
  code: string
  email: string | null
  role: UserRole
  status: InvitationStatus
  note: string | null
  invitedBy: string | null
  invitedByName: string | null
  acceptedUserId: string | null
  acceptedAt: Date | null
  expiresAt: Date
  createdAt: Date
}

export const changePasswordInput = z.object({
  oldPassword: z.string().min(1),
  newPassword: passwordPolicySchema,
})
export type ChangePasswordInput = z.infer<typeof changePasswordInput>

export interface User {
  id: string
  username: string
  displayName: string | null
  role: UserRole
  isActive: boolean
  /** First-time user experience (FTUE) state, keyed by guide id. A reset deletes the key, so only these two values ever occur. */
  onboarding?: Record<string, 'completed' | 'dismissed'>
  createdAt: Date
  updatedAt: Date
}

export interface AuditLog {
  id: string
  userId: string | null
  action: string
  resource: string | null
  resourceId: string | null
  details: Record<string, unknown> | null
  ipAddress: string | null
  createdAt: Date
}
