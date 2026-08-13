import { extractUsageFromError } from '../engine/cli-engine-base.js'
import { registerExecutionProcessLogSink } from '../engine/execution-process-log.js'
import { engineRegistry } from '../engine/index.js'
import type { StreamLogEntry, TokenUsage } from '../engine/types.js'
import { logger } from '../lib/logger.js'
import {
  cleanupRuntimeGroupConfigs,
  materializeRuntimeGroupConfigs,
} from '../lib/runtime-group-config.js'
import { getSetting } from '../lib/settings.js'
import type { ExecuteWorkerOptions, ExecuteWorkerResult, WorkerTaskPayload } from './types.js'

const ENGINE_SETTLEMENT_GRACE_MS = 250

async function waitForEngineUsage(
  execution: Promise<{ usage?: TokenUsage }>,
): Promise<TokenUsage | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ENGINE_SETTLEMENT_GRACE_MS)
    execution.then(
      (result) => {
        clearTimeout(timer)
        resolve(result.usage)
      },
      (error) => {
        clearTimeout(timer)
        resolve(extractUsageFromError(error))
      },
    )
  })
}

/** Resolve timeout from: options > agentConfig.timeoutMinutes > settings > 15min default */
function resolveTimeoutMs(
  optionTimeoutMs?: number,
  agentConfig?: { timeoutMinutes?: number } | null,
): number {
  if (optionTimeoutMs) return optionTimeoutMs
  const agentMinutes = agentConfig?.timeoutMinutes
  if (agentMinutes != null && Number.isFinite(agentMinutes) && agentMinutes > 0) {
    return agentMinutes * 60 * 1000
  }
  const minutesStr = getSetting('general', 'timeoutMinutes')
  const minutes = minutesStr ? Number(minutesStr) : 15
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 15) * 60 * 1000
}

/**
 * Execute an agent task locally using the engine registry.
 *
 * This replaces executeViaNode() — instead of dispatching to a remote node
 * via WebSocket, it runs the task directly in the server process.
 *
 * Each engine (e.g. CursorAgentEngine) already provides process-level
 * isolation by spawning child processes.
 */
export async function executeInWorker(
  taskId: string,
  payload: WorkerTaskPayload,
  options?: ExecuteWorkerOptions,
): Promise<ExecuteWorkerResult> {
  const { onUpdate, onLogEntry, timeoutMs: optionTimeoutMs } = options || {}
  const timeoutMs = resolveTimeoutMs(optionTimeoutMs, payload.agentConfig)
  const startTime = Date.now()

  // Resolve engine type from agent config
  const engineType = payload.agentConfig?.engineType || 'cursor'
  const engine = engineRegistry.get(engineType)

  if (!engine) {
    logger.warn(
      { taskId, engineType, available: engineRegistry.types },
      'No engine registered for requested type',
    )
    return {
      success: false,
      output: '',
      error: `No engine registered for type "${engineType}". Available: [${engineRegistry.types.join(', ')}]`,
      durationMs: Date.now() - startTime,
    }
  }

  let runtimeGroupLease: ReturnType<typeof materializeRuntimeGroupConfigs>
  try {
    runtimeGroupLease = materializeRuntimeGroupConfigs(payload.agentConfig)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ taskId, err: message }, 'Failed to prepare runtime group configuration')
    return {
      success: false,
      output: '',
      error: message,
      durationMs: Date.now() - startTime,
    }
  }
  const executionAgentConfig = runtimeGroupLease.agentConfig

  logger.info(
    {
      taskId,
      engineType,
      hasUpdate: !!onUpdate,
      hasLogEntry: !!onLogEntry,
      timeoutMs,
      timeoutMin: Math.round(timeoutMs / 60000),
    },
    'Executing task via local worker',
  )

  // Heartbeat: log progress every 60s so operators can tell if a task is stuck.
  // Only start heartbeat for tasks with timeout > 2min to avoid noise on short tasks.
  const heartbeatInterval =
    timeoutMs > 120_000
      ? setInterval(() => {
          const elapsed = Math.round((Date.now() - startTime) / 1000)
          const remaining = Math.round((timeoutMs - (Date.now() - startTime)) / 1000)
          logger.info(
            { taskId, engineType, elapsedSec: elapsed, remainingSec: remaining },
            `Task still running (${elapsed}s elapsed, ${remaining}s until timeout)`,
          )
        }, 60_000)
      : null

  // Create a timeout promise with cleanup handle
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  let timeoutTriggered = false
  let emittedUsage: TokenUsage | undefined
  const handleLogEntry = (entry: StreamLogEntry) => {
    if (entry.type === 'result' && entry.usage) emittedUsage = entry.usage
    onLogEntry?.(entry)
  }
  const unregisterProcessLogSink = registerExecutionProcessLogSink(taskId, handleLogEntry)
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timeoutTriggered = true
      reject(new Error(`Task execution timeout (${timeoutMs / 1000}s)`))
    }, timeoutMs)
  })

  let executePromise: ReturnType<typeof engine.executeStream> | undefined
  try {
    executePromise = engine.executeStream({
      taskId,
      workDir: payload.workDir || '',
      prompt: payload.prompt,
      context: payload.context,
      model: payload.model,
      fallbackModels: payload.agentConfig?.fallbackModels || [],
      chatId: payload.chatId,
      branch: 'main',
      onUpdate,
      onLogEntry: handleLogEntry,
      agentConfig: executionAgentConfig,
    })

    const result = await Promise.race([executePromise, timeoutPromise])
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (heartbeatInterval) clearInterval(heartbeatInterval)
    const durationMs = Date.now() - startTime

    if (result.success) {
      logger.info(
        { taskId, engineType, durationMs, outputLen: result.output.length },
        'Task execution completed in local worker',
      )
    } else {
      logger.warn(
        { taskId, engineType, durationMs, error: result.error },
        'Task execution returned failure in local worker',
      )
    }

    return {
      success: result.success,
      output: result.output,
      chatId: result.chatId,
      error: result.error,
      durationMs,
      usage: result.usage ?? emittedUsage,
    }
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    if (heartbeatInterval) clearInterval(heartbeatInterval)
    if (timeoutTriggered) {
      try {
        await engineRegistry.cancel(taskId)
      } catch (cancelError) {
        logger.error(
          { taskId, err: cancelError },
          'Failed to clean up CLI process after worker timeout',
        )
      }
      if (executePromise) {
        emittedUsage = (await waitForEngineUsage(executePromise)) ?? emittedUsage
      }
    }
    const errorMsg = err instanceof Error ? err.message : String(err)
    logger.error({ taskId, err: errorMsg }, 'Task execution failed in local worker')

    return {
      success: false,
      output: '',
      error: errorMsg,
      durationMs: Date.now() - startTime,
      // Engine errors may carry tokens consumed before failure.
      usage: extractUsageFromError(err) ?? emittedUsage,
    }
  } finally {
    unregisterProcessLogSink()
    cleanupRuntimeGroupConfigs(runtimeGroupLease)
  }
}
