import type { StreamLogEntry } from '../engine/types.js'
import type { WorkerTaskPayload } from '../worker/types.js'
import { executeWithRetry } from './execute-with-retry.js'
/**
 * Run launcher — central helper for the executeWithRetry → finishRun* pattern.
 *
 * Three callsites share this exact 5-step middle section:
 *   1. Set up log collector
 *   2. Call executeWithRetry (with optional onUpdate / onLogEntry callbacks)
 *   3. On success → finishRunSuccess (awaited since Step 4b; returns registered artifacts)
 *   4. On engine result.success=false → finishRunError (sync)
 *   5. On thrown error → finishRunError + return redacted public message
 *
 * Callsites:
 *   - apps/api/src/routes/agents.ts POST /:id/chat (sync + stream)
 *   - apps/api/src/routes/gateway.ts POST /:agentId/invoke (sync + stream + async)
 *   - apps/api/src/lib/feishu-service.ts handleMessage executeJob path
 *
 * Each caller handles its own request loading, slot acquisition, run/step
 * insertion, and HTTP/SSE response shaping. This helper only owns the
 * "execute and finalize" middle section to keep behavior identical across
 * the three entrypoints.
 */
import { runJobRetryHook } from './job-retry-hook.js'
import { logger } from './logger.js'
// Import directly from emit.js + types.js (NOT the barrel) so that consumers
// of run-launcher don't transitively load buildDefaultPlugins → commandsPlugin →
// pipeline/commands/registry.ts → @a2wave/shared.FEISHU_COMMAND_NAMES. The
// barrel pulls plugins eagerly; channel entrypoints (feishu/a2a/api) opt into
// that explicitly when they call buildDefaultPlugins().
import { emit } from './pipeline/emit.js'
import type { LifecyclePlugin, PipelineError, RunCtx, RunOutcome } from './pipeline/types.js'
import {
  createPersistingLogCollector,
  type FinishRunParams,
  finishRunError,
  finishRunSuccess,
} from './run-lifecycle.js'
import { registerLogCollector, unregisterLogCollector } from './run-log-registry.js'

/** Reference to a registered artifact (returned by finishRunSuccess). */
export type ArtifactRef = import('./artifact-storage.js').RegisteredArtifact

/** Normalized result returned by runWithLifecycle. */
export interface LaunchedRunResult {
  /** True iff engine ran and reported success. */
  success: boolean
  /** Engine output text. Present only when success is true. */
  output?: string
  /** Chat session id propagated by the engine. Present only when success is true. */
  chatId?: string
  /**
   * Error message safe to expose to the caller.
   *
   * - When the engine returned `result.success === false`: the engine's own
   *   `result.error` (typically already redacted upstream).
   * - When executeWithRetry threw: the redacted public message returned by
   *   finishRunError (currently the literal
   *   "Execution failed. Check server logs for details.").
   *
   * The non-redacted inner Error is always logged + persisted server-side
   * via finishRunError; this field never carries it.
   */
  error?: string
  /** Wall-clock duration since lifecycleParams.startTime. */
  durationMs: number
  /**
   * Registered artifacts from finishRunSuccess. Present (possibly empty array)
   * on success; undefined on failure paths.
   *
   * Step 4b: finishRunSuccess is now awaited, eliminating the response-vs-DB
   * race. Latency budget validated by Step 4-bench
   * (scripts/bench-finish-run-success.ts).
   */
  artifacts?: ArtifactRef[]
}

export interface RunWithLifecycleOptions {
  /** Forwarded to executeWithRetry; called with each accumulated text update. */
  onUpdate?: (content: string) => void
  /** Forwarded to executeWithRetry; called once per stream log entry. */
  onLogEntry?: (entry: StreamLogEntry) => void
  /**
   * Lifecycle plugins to emit inner stage events to. Unset = no fan-out.
   *
   * Step 4a emits onAfterRun (Transform, await) + onRunSucceeded / onRunFailed
   * (Broadcast, fire-and-forget). onStreamFrame is NOT emitted here —
   * Step 7 (engine adapter) translates engine streams into typed StreamFrames.
   */
  plugins?: readonly LifecyclePlugin[]
  /** Ctx passed to inner hooks (onAfterRun / onRunSucceeded / onRunFailed). */
  pluginCtx?: RunCtx
}

type OutcomePatchCtx = RunCtx & {
  outcome?: RunOutcome | PipelineError | Record<string, unknown>
}

function patchedSuccessOutcome(ctx: OutcomePatchCtx, fallback: RunOutcome): RunOutcome {
  return { ...fallback, ...(ctx.outcome ?? {}), success: true } as RunOutcome
}

function patchedErrorOutcome(ctx: OutcomePatchCtx, fallback: PipelineError): PipelineError {
  return { ...fallback, ...(ctx.outcome ?? {}), success: false } as PipelineError
}

/**
 * Run executeWithRetry inside the standard finishRun* lifecycle and return
 * a normalized result. Fully owns engine error handling — never throws.
 *
 * Lifecycle ordering matches the original inline code:
 * - finishRunSuccess is awaited (since Step 4b) so artifacts are scanned +
 *   registered before the response lands; the resulting refs are returned via
 *   `LaunchedRunResult.artifacts`. Eliminates the prior 200-OK-before-DB-UPDATE
 *   race (spec §6.4). Latency budget validated by bench-finish-run-success.ts.
 * - finishRunError on engine result.success=false is awaited synchronously
 *   so the run row is `failed` before the caller responds.
 * - finishRunError on thrown errors returns the public message used in the
 *   HTTP response.
 */
export async function runWithLifecycle(
  taskId: string,
  payload: WorkerTaskPayload,
  lifecycleParams: Omit<FinishRunParams, 'logs' | 'retries'>,
  options?: RunWithLifecycleOptions,
): Promise<LaunchedRunResult> {
  // Persisting collector flushes logs to runSteps.output.logs on a debounced
  // interval so the web UI sees progress during long-running steps. Also
  // serves as the fallback log source in the catch branch if executeWithRetry
  // throws before returning its own `logs`.
  const collector = createPersistingLogCollector({
    stepId: lifecycleParams.stepId,
    baseOutput: {},
  })
  registerLogCollector(lifecycleParams.runId, collector)

  const streamFrameTasks: Promise<void>[] = []
  const drainStreamFrames = () => Promise.allSettled(streamFrameTasks)

  const wrappedOnLogEntry = (entry: StreamLogEntry) => {
    collector.onLogEntry(entry)
    options?.onLogEntry?.(entry)
  }

  // Note: A2WAVE_CHANNEL_B64 env injection happens inside executeWithRetry
  // (the true single chokepoint that A2A run-recording and feishu-service also
  // call directly). Doing it here would miss those paths.

  try {
    const { result, retries, logs } = await executeWithRetry(taskId, payload, {
      stepId: lifecycleParams.stepId,
      runId: lifecycleParams.runId,
      onUpdate: options?.onUpdate,
      onLogEntry: wrappedOnLogEntry,
    })

    // Drain collector BEFORE finishRun* overwrites `output` in its single
    // authoritative write. Otherwise a pending debounce tick could land
    // after finishRun* and clobber status/durationMs.
    await collector.stop()
    unregisterLogCollector(lifecycleParams.runId)

    const durationMs = Date.now() - lifecycleParams.startTime

    if (result.success) {
      // Step 4b: await so artifacts are scanned + registered before the response
      // lands. Eliminates the prior "200 OK before DB UPDATE" race (spec §6.4).
      // Latency budget validated by scripts/bench-finish-run-success.ts.
      const artifacts = await finishRunSuccess({ ...lifecycleParams, logs, retries }, result)
      await drainStreamFrames()
      const outcome: RunOutcome = {
        success: true,
        output: result.output ?? '',
        chatId: result.chatId,
        durationMs,
        artifacts,
      }
      let finalOutcome = outcome
      if (options?.plugins && options.pluginCtx) {
        const patchCtx = options.pluginCtx as OutcomePatchCtx
        patchCtx.outcome = outcome
        await emit('onAfterRun', patchCtx, options.plugins, outcome)
        finalOutcome = patchedSuccessOutcome(patchCtx, outcome)
        // Broadcast: framework owns fire-and-forget inside emit; caller doesn't await
        void emit('onRunSucceeded', patchCtx, options.plugins, finalOutcome)
      }
      return {
        success: true,
        output: finalOutcome.output,
        chatId: finalOutcome.chatId,
        durationMs: finalOutcome.durationMs,
        artifacts: finalOutcome.artifacts,
      }
    }

    const engineError = result.error ?? 'Execution failed'
    await finishRunError(
      { ...lifecycleParams, logs, retries },
      new Error(engineError),
      result.usage,
    )
    await drainStreamFrames()
    // Replay as a fresh job when the Agent opted in. Fire-and-forget: the
    // retry is a new run with its own lifecycle, so finalization of THIS run
    // must not wait on it.
    void runJobRetryHook(lifecycleParams.runId, engineError)
    const enginePipelineError: PipelineError = {
      success: false,
      error: engineError,
      durationMs,
    }
    let finalEngineError = enginePipelineError
    if (options?.plugins && options.pluginCtx) {
      const patchCtx = options.pluginCtx as OutcomePatchCtx
      patchCtx.outcome = enginePipelineError
      await emit('onAfterRun', patchCtx, options.plugins, enginePipelineError)
      finalEngineError = patchedErrorOutcome(patchCtx, enginePipelineError)
      void emit('onRunFailed', patchCtx, options.plugins, finalEngineError)
    }
    return {
      success: false,
      error: finalEngineError.error,
      durationMs: finalEngineError.durationMs,
    }
  } catch (err) {
    await collector.stop()
    unregisterLogCollector(lifecycleParams.runId)
    const publicErrorMsg = await finishRunError({ ...lifecycleParams, logs: collector.logs }, err)
    logger.warn(
      {
        taskId,
        runId: lifecycleParams.runId,
        err: err instanceof Error ? err.message : String(err),
      },
      'runWithLifecycle: executeWithRetry threw, finalized as failed',
    )
    const thrownDurationMs = Date.now() - lifecycleParams.startTime
    await drainStreamFrames()
    void runJobRetryHook(lifecycleParams.runId, publicErrorMsg)
    const thrownPipelineError: PipelineError = {
      success: false,
      error: publicErrorMsg,
      durationMs: thrownDurationMs,
    }
    let finalThrownError = thrownPipelineError
    if (options?.plugins && options.pluginCtx) {
      const patchCtx = options.pluginCtx as OutcomePatchCtx
      patchCtx.outcome = thrownPipelineError
      await emit('onAfterRun', patchCtx, options.plugins, thrownPipelineError)
      finalThrownError = patchedErrorOutcome(patchCtx, thrownPipelineError)
      void emit('onRunFailed', patchCtx, options.plugins, finalThrownError)
    }
    return {
      success: false,
      error: finalThrownError.error,
      durationMs: finalThrownError.durationMs,
    }
  }
}
