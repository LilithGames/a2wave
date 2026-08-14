import { z } from 'zod'

export const runStatusEnum = z.enum([
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type RunStatus = z.infer<typeof runStatusEnum>

export const ACTIVE_RUN_STATUSES = [
  'pending',
  'queued',
  'running',
] as const satisfies readonly RunStatus[]
export type ActiveRunStatus = (typeof ACTIVE_RUN_STATUSES)[number]

const activeRunStatusSet: ReadonlySet<RunStatus> = new Set(ACTIVE_RUN_STATUSES)

export function isActiveRunStatus(status: RunStatus | null | undefined): status is ActiveRunStatus {
  return status !== null && status !== undefined && activeRunStatusSet.has(status)
}

export const runTriggerSourceEnum = z.enum([
  'debug',
  'api',
  'feishu',
  'slack',
  'discord',
  'a2a',
  'schedule',
  'oauth',
  'chat_app',
  'glab',
  'gh',
])
export type RunTriggerSource = z.infer<typeof runTriggerSourceEnum>

export const runSchema = z.object({
  id: z.string(),
  intent: z.string().min(1),
  status: runStatusEnum,
  result: z.record(z.unknown()).nullable().optional(),
  triggerSource: runTriggerSourceEnum.nullable().optional(),
  /** Best available cross-channel display name of the asker. */
  triggerUserName: z.string().nullable().optional(),
  /** Immediate caller Agent display name for A2A provenance. */
  triggerAgentName: z.string().nullable().optional(),
  initiatorAgentId: z.string().nullable().optional(),
  inputTokens: z.number().nullable().optional(),
  outputTokens: z.number().nullable().optional(),
  reasoningTokens: z.number().nullable().optional(),
  cacheReadTokens: z.number().nullable().optional(),
  cacheWriteTokens: z.number().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type Run = z.infer<typeof runSchema>

// Run with joined agent info
export const runWithAgentSchema = runSchema.extend({
  agentName: z.string().nullable().optional(),
  agentIcon: z.string().nullable().optional(),
})

export type RunWithAgent = z.infer<typeof runWithAgentSchema>

// Pagination metadata
export const paginationSchema = z.object({
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
})

export type Pagination = z.infer<typeof paginationSchema>

export const runStepSchema = z.object({
  id: z.string(),
  runId: z.string(),
  agentId: z.string().nullable().optional(),
  order: z.number(),
  input: z.record(z.unknown()).nullable().optional(),
  output: z.record(z.unknown()).nullable().optional(),
  status: runStatusEnum,
  durationMs: z.number().nullable().optional(),
  createdAt: z.coerce.date(),
})

export type RunStep = z.infer<typeof runStepSchema>

export const chatMessageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  role: z.enum(['user', 'agent']),
  content: z.string(),
  createdAt: z.coerce.date(),
})

export type ChatMessage = z.infer<typeof chatMessageSchema>

// ============================================================
// Worktree call parameters
// ============================================================

export const worktreeCleanupEnum = z.enum(['ephemeral', 'persistent', 'ttl'])
export type WorktreeCleanup = z.infer<typeof worktreeCleanupEnum>

export const worktreeCallParamsSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'Worktree name: 1-64 chars, alphanumeric/hyphen/underscore'),
  // `branch` is passed to git as a positional argument (execFile, no shell), but
  // git still parses a leading `-` as an option — a branch value of `--orphan` /
  // `--detach` / `--help` would be taken as a flag (changing branch state,
  // detaching HEAD, or opening man). A `--` separator is not used here because
  // `rev-parse --verify` and `checkout` treat `--` inconsistently; instead the
  // regex is strict: the first character must be alphanumeric or an underscore,
  // and the rest allows the usual git-ref characters (alphanumerics, `.`, `_`,
  // `/`, `-`).
  branch: z
    .string()
    .regex(
      /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/,
      'Branch: must start with alphanumeric/underscore, then alphanumeric/._/-',
    )
    .optional(),
  cleanup: worktreeCleanupEnum.default('ttl'),
})
export type WorktreeCallParams = z.infer<typeof worktreeCallParamsSchema>

export const createRunInput = z.object({
  // Reject a blank/whitespace-only intent, but do NOT trim: the intent is the
  // run prompt and is echoed into the audit log, so the stored value must match
  // what the caller sent verbatim. Capped to match the gateway invoke `message`
  // limit (100k) since both carry the run prompt.
  intent: z
    .string()
    .min(1)
    .max(100_000)
    .refine((s) => s.trim().length > 0, { message: 'intent must not be blank' }),
  // Required: a run must target an Agent to be executable. A run without an
  // initiatorAgentId can never run — POST /runs/:id/execute rejects it with
  // 400 — so creating one only produces a dead record.
  initiatorAgentId: z.string().min(1),
})

export type CreateRunInput = z.infer<typeof createRunInput>
