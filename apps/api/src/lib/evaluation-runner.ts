/**
 * Evaluation runner.
 *
 * Replays the turns of one evaluation case to the Agent in order and records
 * the actual reply for each turn.
 *
 * Multi-turn context relies on the engine's own session continuation: the first
 * turn carries no chatId, the engine returns a session id, and later turns pass
 * it back (claude-code / cursor / qoder / trae use `--resume`, codex
 * uses `exec resume`, kimi uses `-r`). This is genuine session continuation rather than
 * concatenating history into the prompt — the latter would make the input the
 * Agent under test sees differ in shape from production, which defeats the
 * point of evaluating it.
 *
 * No Run record is created: evaluation execution stays separate from the
 * user-visible run history so it cannot pollute the runs list, the statistics
 * or the leaderboard. Same approach as memory-provider.ts.
 */
import type { RunChannelContext } from '@a2wave/shared'
import type { AgentConfig } from './agent-helpers.js'
import { discardRunArtifactsDir } from './artifact-storage.js'
import { executeWithRetry } from './execute-with-retry.js'
import { logger } from './logger.js'

export interface EvaluationTurnInput {
  request: string
  expectedResponse: string
}

export interface EvaluationActualTurn {
  request: string
  expectedResponse: string
  actualResponse: string | null
  error?: string | null
  durationMs?: number | null
}

export interface ReplayCaseParams {
  taskId: string
  caseId: string
  turns: EvaluationTurnInput[]
  agentConfig: AgentConfig | Record<string, unknown>
  workDir: string
  /**
   * Caller identity for the run.
   *
   * Required in substance rather than in type: a gateway-enabled Agent fails
   * every turn with GATEWAY_NO_USER_IDENTITY before it ever reaches the model
   * unless a channel context is present, so evaluating one without this is not
   * a degraded run but a uniformly failed report.
   */
  channel?: RunChannelContext
  /** Asked before each turn starts; cancellation is granular between turns. */
  isCancelled?: () => boolean | Promise<boolean>
}

export interface ReplayCaseResult {
  status: 'completed' | 'failed' | 'cancelled'
  actualTurns: EvaluationActualTurn[]
  error: string | null
  durationMs: number
}

let replaySeq = 0

/** A taskId namespace of its own, so evaluation ids are never confused with the runId/stepId semantics of chat/invoke. */
function nextReplayTaskId(taskId: string, caseId: string): string {
  replaySeq += 1
  return `eval/${taskId}/${caseId}/${replaySeq}`
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Replay every turn of one case, in order.
 *
 * A failed turn stops the remaining ones: later requests in a multi-turn case
 * depend on the context the previous turn established, so once that context is
 * broken, sending the rest only yields meaningless replies — wasting calls and
 * misleading the reviewer.
 */
export async function replayCase(params: ReplayCaseParams): Promise<ReplayCaseResult> {
  const { taskId, caseId, turns, agentConfig, workDir, channel, isCancelled } = params
  const startedAt = Date.now()
  const actualTurns: EvaluationActualTurn[] = []

  let chatId: string | undefined
  let error: string | null = null
  let cancelled = false

  for (const [index, turn] of turns.entries()) {
    // Only between cases, never mid-case: the API and the user manual both
    // promise a running task finishes the case in flight, and a multi-turn case
    // abandoned halfway leaves a conversation the reviewer cannot judge.
    //
    // The predicate may be async (the route resolves cancellation from the DB),
    // so it must be awaited — an unawaited Promise is always truthy and would
    // abort every case at turn 0.
    if (index === 0 && (await isCancelled?.())) {
      cancelled = true
      error = 'Evaluation cancelled'
      break
    }

    const turnStartedAt = Date.now()
    const turnTaskId = nextReplayTaskId(taskId, caseId)
    try {
      const { result } = await executeWithRetry(turnTaskId, {
        taskId: turnTaskId,
        prompt: turn.request,
        model: (agentConfig as { model?: string }).model,
        workDir,
        chatId,
        agentConfig: agentConfig as AgentConfig,
        // A gateway-enabled Agent signs a per-run JWT on behalf of the caller
        // and fails fast without one.
        ...(channel ? { context: { channel } } : {}),
      } as never)

      if (!result.success) {
        error = result.error || 'Engine execution failed'
        actualTurns.push({
          request: turn.request,
          expectedResponse: turn.expectedResponse,
          actualResponse: null,
          error,
          durationMs: Date.now() - turnStartedAt,
        })
        break
      }

      // The engine returns a session id on the first turn; later turns resume from it.
      if (result.chatId) chatId = result.chatId

      actualTurns.push({
        request: turn.request,
        expectedResponse: turn.expectedResponse,
        actualResponse: result.output ?? '',
        durationMs: Date.now() - turnStartedAt,
      })
    } catch (err) {
      // One failed case must not bring down the whole task; contain the error here.
      error = errorMessage(err)
      logger.warn({ err, taskId, caseId }, 'Evaluation turn threw')
      actualTurns.push({
        request: turn.request,
        expectedResponse: turn.expectedResponse,
        actualResponse: null,
        error,
        durationMs: Date.now() - turnStartedAt,
      })
      break
    } finally {
      // Each turn ran under its own taskId and so its own $A2WAVE_ARTIFACTS_DIR.
      // Evaluation never registers artifacts, so nothing downstream removes the
      // directory — and a checkout that outlives the task would accumulate one
      // per turn.
      await discardRunArtifactsDir(workDir, turnTaskId)
    }
  }

  return {
    // A case the user cancelled is not a case the Agent failed; conflating them
    // puts a red "failed" row under a task badged Cancelled.
    status: cancelled ? 'cancelled' : error ? 'failed' : 'completed',
    actualTurns,
    error,
    durationMs: Date.now() - startedAt,
  }
}

export interface EvaluationSummary {
  total: number
  passed: number
  failed: number
  unreviewed: number
  passRate: number | null
}

/**
 * Summarise the manual review verdicts.
 *
 * passRate is computed over reviewed cases only: counting unreviewed ones in
 * the denominator would show a freshly finished task as 0%, which reads as
 * "everything failed" when in truth nobody has looked at it yet.
 *
 * Cancelled cases are excluded outright rather than counted as unreviewed. They
 * produced no answer and can never receive a verdict, so leaving them in would
 * strand "reviewed 3 / 5" one short of completion forever, with two rows nobody
 * is able to act on.
 */
export function summarizeResults(
  results: Array<{ review?: { verdict?: string } | null; status?: string }>,
): EvaluationSummary {
  let passed = 0
  let failed = 0
  let unreviewed = 0
  let total = 0

  for (const row of results) {
    if (row.status === 'cancelled') continue
    total += 1

    const verdict = row.review?.verdict
    if (verdict === 'pass') passed += 1
    else if (verdict === 'fail') failed += 1
    else unreviewed += 1
  }

  const reviewed = passed + failed
  return {
    total,
    passed,
    failed,
    unreviewed,
    passRate: reviewed > 0 ? passed / reviewed : null,
  }
}
