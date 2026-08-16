import { z } from 'zod'

// ============================================================
// Evaluation — evaluation sets, cases and tasks for a single Agent
// ============================================================
//
// An Evaluation Set is a named collection of cases. A case is a multi-turn
// conversation: an ordered list of {request, expectedResponse} turns, so a
// single-turn case is simply a list of length 1 — one uniform shape.
//
// An Evaluation Task runs one set against the Agent's current config and
// freezes a config snapshot. The variables that matter are provider + model;
// the system prompt is captured as the secondary variable so historical
// results stay explainable.
//
// v1 reviews results manually (see evaluationReviewSchema). Automatic
// LLM-judged scoring is deferred; `score` on a result row is reserved for it
// and stays null in v1.

/** One conversational turn: what the user says, and what the Agent should say back. */
export const evaluationTurnSchema = z.object({
  request: z.string().min(1).max(50_000),
  /** Empty is allowed: a turn may exist only to set up context for a later one. */
  expectedResponse: z.string().max(50_000).default(''),
})

export type EvaluationTurn = z.infer<typeof evaluationTurnSchema>

// ------------------------------------------------------------
// Evaluation Set
// ------------------------------------------------------------

export const evaluationSetSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type EvaluationSet = z.infer<typeof evaluationSetSchema>

export const createEvaluationSetInput = z.object({
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
})

export type CreateEvaluationSetInput = z.infer<typeof createEvaluationSetInput>

export const updateEvaluationSetInput = createEvaluationSetInput.partial()
export type UpdateEvaluationSetInput = z.infer<typeof updateEvaluationSetInput>

// ------------------------------------------------------------
// Evaluation Case
// ------------------------------------------------------------

export const evaluationCaseSchema = z.object({
  id: z.string(),
  setId: z.string(),
  name: z.string().min(1).max(200),
  turns: z.array(evaluationTurnSchema).min(1),
  sortOrder: z.number().int().default(0),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>

export const createEvaluationCaseInput = z.object({
  name: z.string().min(1).max(200),
  turns: z.array(evaluationTurnSchema).min(1).max(50),
  sortOrder: z.number().int().default(0),
})

export type CreateEvaluationCaseInput = z.infer<typeof createEvaluationCaseInput>

export const updateEvaluationCaseInput = createEvaluationCaseInput.partial()
export type UpdateEvaluationCaseInput = z.infer<typeof updateEvaluationCaseInput>

// ------------------------------------------------------------
// Config snapshot
// ------------------------------------------------------------

/**
 * Frozen at task creation. An explicit allowlist, NOT a filtered copy of the
 * agent config — provider credentials (apiKey / oauthToken / baseUrl) must
 * never be persisted here, since snapshots are long-lived and readable by
 * every agent viewer. Zod strips unknown keys, so a careless caller passing a
 * whole agent row cannot leak them.
 *
 * engineType is deliberately absent: it is derived from the provider name via
 * getProviderEngineType(), so storing it would be redundant and could drift.
 */
export const evaluationConfigSnapshotSchema = z.object({
  providerId: z.string().nullable().default(null),
  /** Denormalized so the snapshot survives provider deletion. */
  providerName: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  /**
   * Frozen beside the model, because the two execution controls belong to the
   * binding rather than to the Agent. Without them two tasks that differed only
   * in reasoning depth read as identical, which is what the snapshot exists to
   * prevent. `null` covers both "not set" and a row written before they existed
   * — the default keeps those rows parsing.
   */
  reasoningEffort: z.string().nullable().default(null),
  fastMode: z.boolean().nullable().default(null),
  systemPrompt: z.string().default(''),
  capturedAt: z.coerce.date(),
})

export type EvaluationConfigSnapshot = z.infer<typeof evaluationConfigSnapshotSchema>

// ------------------------------------------------------------
// Evaluation Task
// ------------------------------------------------------------

/**
 * `pending` is the brief window between insert and scheduling; `queued` means
 * the agent's evaluation slots are full and the task is waiting its turn. They
 * are distinct because only `queued` is a state a task can sit in for minutes,
 * and the UI says so explicitly rather than showing an unexplained stall.
 */
export const evaluationTaskStatusEnum = z.enum([
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
])

export type EvaluationTaskStatus = z.infer<typeof evaluationTaskStatusEnum>

export const evaluationTaskSummarySchema = z.object({
  total: z.number().int().default(0),
  passed: z.number().int().default(0),
  failed: z.number().int().default(0),
  unreviewed: z.number().int().default(0),
  /** passed / (passed + failed); null when nothing has been reviewed yet. */
  passRate: z.number().nullable().default(null),
})

export type EvaluationTaskSummary = z.infer<typeof evaluationTaskSummarySchema>

export const createEvaluationTaskInput = z.object({
  setId: z.string().min(1),
  name: z.string().max(200).nullable().optional(),
})

export type CreateEvaluationTaskInput = z.infer<typeof createEvaluationTaskInput>

// ------------------------------------------------------------
// Evaluation Result + manual review
// ------------------------------------------------------------

export const evaluationResultStatusEnum = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled',
])
export type EvaluationResultStatus = z.infer<typeof evaluationResultStatusEnum>

/**
 * Statuses a human may pass judgement on.
 *
 * A case only becomes reviewable once it has an answer to judge — `completed`
 * for a normal reply, `failed` because "the Agent could not answer" is itself a
 * verdict-worthy outcome. `pending` / `running` have produced nothing yet, and
 * `cancelled` never will, so a verdict on either would be counted in the pass
 * rate while describing a case that was never really run.
 */
export const REVIEWABLE_RESULT_STATUSES: readonly EvaluationResultStatus[] = ['completed', 'failed']

export const evaluationVerdictEnum = z.enum(['pass', 'fail', 'unreviewed'])
export type EvaluationVerdict = z.infer<typeof evaluationVerdictEnum>

/** One replayed turn: the expectation alongside what the Agent actually said. */
export const evaluationActualTurnSchema = z.object({
  request: z.string(),
  expectedResponse: z.string().default(''),
  actualResponse: z.string().nullable().default(null),
  error: z.string().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
})

export type EvaluationActualTurn = z.infer<typeof evaluationActualTurnSchema>

/** Stored human verdict. reviewedBy/At are stamped server-side. */
export const evaluationReviewSchema = z.object({
  verdict: evaluationVerdictEnum,
  note: z.string().max(5_000).nullable().optional(),
  reviewedBy: z.string(),
  reviewedAt: z.coerce.date(),
})

export type EvaluationReview = z.infer<typeof evaluationReviewSchema>

/**
 * Request body for setting a verdict. Deliberately omits reviewedBy/reviewedAt:
 * identity comes from the session, never from the caller.
 */
export const reviewEvaluationResultInput = z.object({
  verdict: evaluationVerdictEnum,
  note: z.string().max(5_000).nullable().optional(),
})

export type ReviewEvaluationResultInput = z.infer<typeof reviewEvaluationResultInput>
