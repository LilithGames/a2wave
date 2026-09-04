/**
 * Turning Feishu/lark SDK failures into log lines that are useful *and* safe.
 *
 * The lark SDK surfaces failures as raw AxiosErrors, which replay the whole
 * outbound request — including the `{"app_id","app_secret"}` token-request body
 * and the `Bearer t-…` tenant access token. Everything that logs a lark failure
 * goes through this module so neither ever reaches a log file.
 */
import type { Logger as LarkLogger } from '@larksuiteoapi/node-sdk'
import { logger } from './logger.js'

/**
 * Flattens a Feishu/axios error into a small, loggable object.
 *
 * An axios error carries circular references through request/response/socket,
 * so handing one straight to the logger serialises thousands of lines. Only the
 * fields that actually help diagnose a failure are kept: the Feishu business
 * code/msg, the HTTP status, the log_id (what Feishu support asks for) and the
 * network-layer code.
 */
export function summarizeFeishuError(err: unknown): Record<string, unknown> {
  const e = err as {
    code?: string
    message?: string
    response?: {
      status?: number
      headers?: Record<string, string>
      data?: { code?: number; msg?: string; error?: { log_id?: string } }
    }
  }
  const resp = e?.response
  const body = resp?.data
  const summary: Record<string, unknown> = {}
  if (e?.code) summary.netCode = e.code // network layer, e.g. ECONNRESET / ERR_BAD_REQUEST
  if (resp?.status) summary.status = resp.status
  if (body?.code != null) summary.feishuCode = body.code // Feishu business code, e.g. 41050
  if (body?.msg) summary.feishuMsg = body.msg
  const logId = body?.error?.log_id ?? resp?.headers?.['x-tt-logid']
  if (logId) summary.logId = logId
  if (!Object.keys(summary).length) summary.message = e?.message ?? String(err)
  return summary
}

/**
 * Logger handed to every lark SDK client so the SDK never writes to stderr itself.
 *
 * The SDK's built-in logger prints the raw AxiosError it caught, and that error
 * replays the outbound request: `config.data` is the
 * `{"app_id","app_secret"}` token-request body and `config.headers.Authorization`
 * is the `Bearer t-…` tenant access token. `loggerLevel` does not suppress it —
 * the SDK logs its own failures at `error` level, which every usable level
 * admits. Routing through `summarizeFeishuError` keeps the diagnosable fields
 * (HTTP status, Feishu business code, log_id) and drops the credential-bearing
 * request.
 */
export function createLarkSdkLogger(): LarkLogger {
  const forward = (level: 'error' | 'warn' | 'debug', args: unknown[]): void => {
    const messages: string[] = []
    const details: Record<string, unknown>[] = []
    for (const arg of args) {
      if (typeof arg === 'object' && arg !== null) details.push(summarizeFeishuError(arg))
      else messages.push(String(arg))
    }
    logger[level]({ larkDetails: details }, `Feishu SDK: ${messages.join(' ') || 'no message'}`)
  }
  return {
    error: (...args: unknown[]) => forward('error', args),
    warn: (...args: unknown[]) => forward('warn', args),
    // The SDK's info/trace stream is per-request chatter, not operator signal.
    info: (...args: unknown[]) => forward('debug', args),
    debug: (...args: unknown[]) => forward('debug', args),
    trace: (...args: unknown[]) => forward('debug', args),
  }
}

/** Shared SDK logger — stateless, so one instance serves every client. */
export const larkSdkLogger = createLarkSdkLogger()
