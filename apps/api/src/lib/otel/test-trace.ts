/**
 * The settings page's "test connection" trace. A bare span proves reachability but GenAI backends
 * (Arize Phoenix, Langfuse) barely display it, so the admin cannot tell whether real runs will
 * show up. This drives the real run tracer instead, with obviously synthetic content: what arrives
 * is shaped exactly like an Agent run, and every span carries `a2wave.test = true`.
 */
import type { OtelTestResult } from '@a2wave/shared'
import { createId } from '../id.js'
import type { OtelConfig } from './config.js'
import { exportOtelProbe, type OtelRuntime } from './provider.js'
import { startRunTraceOn } from './run-tracer.js'

const TEST_AGENT_ID = 'a2wave-connection-test'
const TEST_AGENT_NAME = 'a2wave connection test'
const TEST_MODEL = 'a2wave-connection-test'
const TEST_USAGE = { inputTokens: 1, outputTokens: 1 }

/** Writes the synthetic run (`invoke_agent` → `attempt`) and returns its trace id. */
export function emitOtelTestTrace(runtime: OtelRuntime): string | undefined {
  const runId = `otel_test_${createId()}`
  const run = startRunTraceOn(
    runtime,
    runId,
    {
      taskId: runId,
      prompt: 'ping',
      model: TEST_MODEL,
      agentConfig: { agentId: TEST_AGENT_ID, agentName: TEST_AGENT_NAME, engineType: 'a2wave' },
      context: { channel: { channel_type: 'otel_test' } },
    },
    { runId },
  )
  const result = { success: true, output: 'pong', durationMs: 0, usage: TEST_USAGE }
  const attempt = run.startAttempt({
    attempt: 1,
    providerIndex: 0,
    model: TEST_MODEL,
    engineType: 'a2wave',
    resetChat: false,
  })
  // The run tracer exposes span identity only as the attempt's `traceparent` (version-traceId-…).
  const traceId = attempt.traceparent()?.split('-')[1]
  attempt.end(result)
  run.finish({ result, retries: 0 })
  return traceId
}

export async function sendOtelTestSpan(
  config: OtelConfig | null,
  timeoutMs?: number,
): Promise<OtelTestResult> {
  if (!config) return { ok: false, reason: 'OTEL_NOT_CONFIGURED' }
  return exportOtelProbe(config, emitOtelTestTrace, timeoutMs)
}
