import type { ChildProcess } from 'node:child_process'
import type { CodexQuota, CodexQuotaWindow } from '@a2wave/shared'
import { spawnCli } from './cli-spawn.js'
import { buildSafeAgentProcessEnv } from './runtime-context.js'
import { terminateCliProcess } from './windows-process-tree.js'

const CACHE_MS = 30_000
const TIMEOUT_MS = 10_000
const MAX_OUTPUT_BYTES = 1024 * 1024
let cached: { key: string; expiresAt: number; value: CodexQuota } | undefined
let pending: { key: string; promise: Promise<CodexQuota> } | undefined

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeLimits(result: Record<string, unknown>): CodexQuota {
  const buckets = record(result.rateLimitsByLimitId)
  const entries = Object.keys(buckets).length
    ? Object.entries(buckets)
    : [['codex', result.rateLimits]]
  const windows: CodexQuotaWindow[] = []
  for (const [id, value] of entries) {
    const bucket = record(value)
    for (const slot of ['primary', 'secondary']) {
      const window = record(bucket[slot])
      const usedPercent = finite(window.usedPercent)
      if (usedPercent === null) continue
      const duration = finite(window.windowDurationMins)
      const resetsAt = finite(window.resetsAt)
      windows.push({
        id: `${id}:${slot}`,
        label: typeof bucket.limitName === 'string' ? bucket.limitName : null,
        usedPercent: Math.min(100, Math.max(0, usedPercent)),
        windowDurationMins: duration !== null && duration > 0 ? duration : null,
        resetsAt: resetsAt !== null && resetsAt > 0 && resetsAt <= 8.64e12 ? resetsAt : null,
      })
    }
  }
  return { status: windows.length ? 'available' : 'unavailable', windows }
}

function readQuota(path: string, env: NodeJS.ProcessEnv): Promise<CodexQuota> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawnCli(path, ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve({ status: 'unavailable', windows: [] })
      return
    }

    let settled = false
    let closed = false
    let buffer = ''
    let outputBytes = 0
    let expectedId = 1
    let killTimer: NodeJS.Timeout | undefined
    const kill = (signal: NodeJS.Signals) => {
      try {
        void terminateCliProcess(child, signal).catch(() => {})
      } catch {}
    }
    const finish = (value: CodexQuota) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!closed) {
        child.stdin?.end()
        kill('SIGTERM')
        if (!closed) {
          killTimer = setTimeout(() => kill('SIGKILL'), 1000)
          killTimer.unref()
        }
      }
      resolve(value)
    }
    const fail = (status: CodexQuota['status'] = 'unavailable') => finish({ status, windows: [] })
    const timer = setTimeout(() => fail(), TIMEOUT_MS)
    const send = (message: Record<string, unknown>) => {
      try {
        if (!child.stdin) fail()
        else child.stdin.write(`${JSON.stringify(message)}\n`)
      } catch {
        fail()
      }
    }
    const handle = (message: Record<string, unknown>) => {
      if (message.id !== expectedId) return
      if (message.error) {
        fail(record(message.error).code === -32601 ? 'unsupported' : 'unavailable')
        return
      }
      if (!('result' in message)) {
        fail()
        return
      }
      const result = record(message.result)
      if (expectedId === 1) {
        expectedId = 2
        send({ method: 'initialized', params: {} })
        send({ id: 2, method: 'account/read', params: { refreshToken: false } })
      } else if (expectedId === 2) {
        if (result.account === null) fail('not_logged_in')
        else if (record(result.account).type === 'apiKey') fail('unsupported')
        else if (!['chatgpt', 'chatgptAuthTokens'].includes(String(record(result.account).type)))
          fail()
        else {
          expectedId = 3
          send({ id: 3, method: 'account/rateLimits/read', params: {} })
        }
      } else finish(normalizeLimits(result))
    }
    const countOutput = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > MAX_OUTPUT_BYTES) fail()
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled) return
      countOutput(chunk)
      if (settled) return
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (!settled && newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
          try {
            handle(record(JSON.parse(line)))
          } catch {
            fail()
          }
        }
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (!settled) countOutput(chunk)
    })
    child.stdin?.on('error', () => fail())
    child.on('error', () => fail())
    child.once('close', () => {
      closed = true
      if (killTimer) clearTimeout(killTimer)
      fail()
    })
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'a2wave', version: '1.0.0' } },
    })
  })
}

/** Read the deployment's local Codex account; never starts an inference turn. */
export function getCodexQuota(path: string): Promise<CodexQuota> {
  const env = buildSafeAgentProcessEnv()
  const key = JSON.stringify([path, env.HOME, env.CODEX_HOME])
  if (cached?.key === key && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
  if (pending?.key === key) return pending.promise
  const promise = readQuota(path, env).then((value) => {
    cached = { key, expiresAt: Date.now() + CACHE_MS, value }
    if (pending?.promise === promise) pending = undefined
    return value
  })
  pending = { key, promise }
  return promise
}
