import { z } from 'zod'
import i18n from '@/i18n'

// Resolved on every validation so the message follows the active language,
// instead of being frozen at module-evaluation time.
const nameErrorMap: z.ZodErrorMap = (issue, ctx) =>
  issue.code === z.ZodIssueCode.too_small
    ? { message: i18n.t('agentDetail.nameRequired') }
    : { message: ctx.defaultError }

export const agentFormSchema = z.object({
  name: z.string({ errorMap: nameErrorMap }).min(1).max(100),
  description: z.string(),
  systemPrompt: z.string(),
  icon: z.string().min(1),
  providerApiKey: z.string(),
  providerBaseUrl: z.string(),
  providerOauthToken: z.string(),
  authMode: z.enum(['apiKey', 'oauth', 'localSession']),
  providerId: z.string().nullable(),
  model: z.string(),
  readOnly: z.boolean(),
  force: z.boolean(),
  cleanResult: z.boolean(),
  maxConcurrency: z.number().int().min(1).max(5),
  commandReplyLanguage: z.enum(['auto', 'en', 'zh']),
  timeoutMinutes: z.number().int().min(5).max(120),
  maxRetries: z.number().int().min(0).max(5),
  maxJobRetries: z.number().int().min(0).max(3),
  totalTimeoutMinutes: z.number().int().min(5).max(600).nullable(),
})
