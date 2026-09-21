/**
 * The test trace over a real socket: the real OTLP exporter against a local HTTP server. Covers
 * what the mocked-exporter tests cannot — the headers that actually leave the process and the
 * error string a refused connection really produces.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../version.js', () => ({ getVersion: () => '9.9.9' }))
vi.mock('../../process-instance.js', () => ({ processInstanceId: 'instance-1' }))
vi.mock('../config.js', () => ({
  readOtelConfig: () => null,
  otelConfigFingerprint: () => 'fp',
}))

import type { OtelConfig } from '../config.js'
import { sendOtelTestSpan } from '../test-trace.js'

interface Received {
  url: string | undefined
  headers: IncomingHttpHeaders
  bytes: number
  /** Raw OTLP/protobuf payload; string attribute keys and values appear in it as plain UTF-8. */
  body: Buffer
}

let server: Server | null = null

async function listen(status: number): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = []
  server = createServer((req, res) => {
    let bytes = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      chunks.push(chunk)
    })
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, bytes, body: Buffer.concat(chunks) })
      res.writeHead(status, { 'Content-Type': 'application/x-protobuf' })
      res.end()
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  return { port: (server.address() as AddressInfo).port, received }
}

const close = () =>
  new Promise<void>((resolve) => {
    if (!server) return resolve()
    server.close(() => resolve())
    server = null
  })

const configFor = (port: number, headers: Record<string, string> = {}): OtelConfig => ({
  endpoint: `http://127.0.0.1:${port}`,
  tracesUrl: `http://127.0.0.1:${port}/v1/traces`,
  headers,
  captureContent: false,
  serviceName: 'a2wave',
  resourceAttributes: {},
})

afterEach(close)

describe('sendOtelTestSpan over HTTP', () => {
  it('puts the configured resource attributes on the wire, where backends route on them', async () => {
    // Arize Phoenix files a trace under the project named by the RESOURCE attribute
    // `openinference.project.name` and falls back to "default" without it. A test trace that
    // "succeeds but does not show up" is this attribute missing from the payload.
    const { port, received } = await listen(200)
    const result = await sendOtelTestSpan({
      ...configFor(port),
      serviceName: 'svc-under-test',
      resourceAttributes: { 'openinference.project.name': 'wire-project' },
    })

    expect(result.ok).toBe(true)
    // The exporter gzips the body; string keys and values are plain UTF-8 once inflated.
    const raw = received[0].body
    const inflated = received[0].headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
    const payload = inflated.toString('latin1')
    expect(payload).toContain('openinference.project.name')
    expect(payload).toContain('wire-project')
    expect(payload).toContain('svc-under-test')
  })

  it('posts one request carrying the configured headers and reports the trace id', async () => {
    const { port, received } = await listen(200)
    const result = await sendOtelTestSpan(configFor(port, { 'x-collector-auth': 'wire-value' }))
    expect(result).toEqual({
      ok: true,
      testedUrl: `http://127.0.0.1:${port}/v1/traces`,
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    })
    expect(received).toHaveLength(1)
    expect(received[0].url).toBe('/v1/traces')
    expect(received[0].bytes).toBeGreaterThan(0)
    expect(received[0].headers['x-collector-auth'] === 'wire-value').toBe(true)
  })

  it('reports EXPORT_FAILED without leaking a header value when the collector rejects', async () => {
    const { port } = await listen(401)
    const result = await sendOtelTestSpan(configFor(port, { 'x-collector-auth': 'wire-value' }))
    expect(result).toMatchObject({ ok: false, reason: 'EXPORT_FAILED' })
    expect(JSON.stringify(result)).not.toContain('wire-value')
  })

  it('diagnoses a closed loopback port as LOOPBACK_REFUSED', async () => {
    const { port } = await listen(200)
    await close()
    const result = await sendOtelTestSpan(configFor(port))
    expect(result).toMatchObject({
      ok: false,
      reason: 'LOOPBACK_REFUSED',
      testedUrl: `http://127.0.0.1:${port}/v1/traces`,
    })
    expect(result.error).toContain('ECONNREFUSED')
  })
})
