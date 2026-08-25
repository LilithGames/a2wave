/**
 * Shared rerun construction, extracted from `POST /runs/:id/rerun` so the manual
 * button and the automatic job retry build the identical replacement run.
 *
 * Deliberately free of any Hono `Context`: the automatic path fires from
 * run-launcher after a run finishes, where there is no HTTP request. Permission
 * checks, `getCurrentUserId` and the request-scoped audit entry therefore stay in
 * the route — this module only answers "what does the replay of this run look
 * like", which is the part both callers must agree on.
 */
import { desc, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { runSteps, type runs } from '../db/schema.js'
import { logger } from './logger.js'

/** Attachment ref read back from step.input.attachments / executionMetadata.attachments. */
export type RerunAttachmentRef = {
  token?: string
  /** External uri attachments carry no token; the materializer re-fetches them. */
  uri?: string
  name?: string
  mimeType?: string
  size?: number
} & Record<string, unknown>

export interface RerunSource {
  /** Agent that should execute the replay (from the latest step, falling back to the initiator). */
  agentId: string | null
  /** Context of the turn matching the current intent. */
  originalContext: Record<string, unknown> | undefined
  /** Replayable attachment refs, before consumer-id resolution. */
  rawAttachments: RerunAttachmentRef[]
}

/**
 * Resolve the turn a rerun should replay.
 *
 * Reads the LATEST step (max order): `runs.intent` is rewritten to the most
 * recent turn in a multi-turn conversation, so attachments and context must come
 * from that same turn or the replay pairs new text with stale files.
 */
export async function loadRerunSource(originalRun: typeof runs.$inferSelect): Promise<RerunSource> {
  const latestStep = (
    await db
      .select({ agentId: runSteps.agentId, input: runSteps.input })
      .from(runSteps)
      .where(eq(runSteps.runId, originalRun.id))
      .orderBy(desc(runSteps.order))
      .limit(1)
  )[0]

  const originalContext = (latestStep?.input as Record<string, unknown> | undefined)?.context as
    | Record<string, unknown>
    | undefined

  const stepAttachmentsRaw = (latestStep?.input as { attachments?: unknown } | undefined)
    ?.attachments as RerunAttachmentRef[] | undefined
  const metaAttachmentsRaw = originalRun.executionMetadata?.attachments as
    | RerunAttachmentRef[]
    | undefined

  // queuedTurn marker: this turn was queued then cancelled and never became a
  // step, so the latest step belongs to the PREVIOUS turn. Reading its
  // attachments back would pair turn-2 text with turn-1 files.
  const rawAttachments = originalRun.executionMetadata?.queuedTurn
    ? (metaAttachmentsRaw ?? [])
    : (stepAttachmentsRaw ?? metaAttachmentsRaw ?? [])

  return {
    agentId: latestStep?.agentId ?? originalRun.initiatorAgentId,
    originalContext,
    rawAttachments,
  }
}

/**
 * Keep only refs a replay can actually reproduce.
 *
 * A2A inline bytes have neither token nor uri and are unrecoverable — dropped
 * with a warning rather than silently producing a text-only replay.
 */
export function filterReplayableAttachments(
  rawAttachments: RerunAttachmentRef[],
  originalRunId: string,
): RerunAttachmentRef[] {
  const replayable = rawAttachments.filter((a) =>
    Boolean(a && (typeof a.token === 'string' || typeof a.uri === 'string')),
  )
  const dropped = rawAttachments.length - replayable.length
  if (dropped > 0) {
    logger.warn(
      { originalRunId, dropped },
      'Rerun dropped attachments without token or uri (A2A inline bytes cannot be replayed)',
    )
  }
  return replayable
}
