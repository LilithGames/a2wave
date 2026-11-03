import { z } from 'zod'

/** Public account metadata. OAuth credentials never belong in an API response. */
export const providerOauthAccountSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  label: z.string(),
  email: z.string().nullable(),
  subject: z.string(),
  clientId: z.string(),
  createdByUserId: z.string().nullable(),
  canManage: z.boolean(),
  status: z.enum(['ready', 'expired', 'reauth_required']),
  expiresAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ProviderOauthAccount = z.infer<typeof providerOauthAccountSchema>
export const providerOauthLoginInput = z.object({
  accountId: z.string().min(1).optional(),
  label: z.string().trim().min(1).max(100).optional(),
})
export const providerOauthLoginStatusSchema = z.object({
  status: z.enum(['pending', 'started', 'completed', 'failed', 'expired']),
  accountId: z.string().optional(),
  error: z.string().optional(),
})
export type ProviderOauthLoginStatus = z.infer<typeof providerOauthLoginStatusSchema>
