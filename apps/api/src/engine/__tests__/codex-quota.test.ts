import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnCli = vi.hoisted(() => vi.fn())
vi.mock('../cli-spawn.js', () => ({ spawnCli }))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
}

describe('getCodexQuota', () => {
  let child: ReturnType<typeof childProcess>
  let getCodexQuota: typeof import('../codex-quota.js').getCodexQuota
  let requests: Record<string, unknown>[]
  const reply = (id: number, result: unknown) =>
    child.stdout.write(`${JSON.stringify({ id, result })}\n`)
  const handshake = (account: unknown = { type: 'chatgpt' }) => {
    reply(1, {})
    reply(2, { account })
  }

  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    child = childProcess()
    requests = []
    child.stdin.on('data', (chunk) => requests.push(JSON.parse(chunk.toString())))
    spawnCli.mockReset().mockReturnValue(child)
    ;({ getCodexQuota } = await import('../codex-quota.js'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('reads only account quotas after initializing and preserves actual windows', async () => {
    vi.stubEnv('HOME', '/account')
    vi.stubEnv('CODEX_HOME', '/codex-account')
    vi.stubEnv('OPENAI_API_KEY', 'secret')
    vi.stubEnv('CODEX_API_KEY', 'secret')
    const result = getCodexQuota('/bin/codex')
    handshake()
    reply(3, {
      rateLimits: { primary: { usedPercent: 99 } },
      rateLimitsByLimitId: {
        codex: {
          limitName: 'Codex',
          secondary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 2000000000 },
        },
      },
    })
    expect(await result).toEqual({
      status: 'available',
      windows: [
        {
          id: 'codex:secondary',
          label: 'Codex',
          usedPercent: 24,
          windowDurationMins: 10080,
          resetsAt: 2000000000,
        },
      ],
    })
    expect(requests.map((r) => r.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'account/rateLimits/read',
    ])
    expect(spawnCli).toHaveBeenCalledWith(
      '/bin/codex',
      ['app-server'],
      expect.objectContaining({
        env: expect.objectContaining({ HOME: '/account', CODEX_HOME: '/codex-account' }),
      }),
    )
    const options = spawnCli.mock.calls[0][2]
    expect(options.env.OPENAI_API_KEY).toBeUndefined()
    expect(options.env.CODEX_API_KEY).toBeUndefined()
    expect(child.kill).toHaveBeenCalled()
  })

  it('falls back to legacy limits and rejects invalid numbers while clamping percentages', async () => {
    const result = getCodexQuota('codex')
    handshake()
    reply(3, { rateLimits: { primary: { usedPercent: 140 }, secondary: { usedPercent: '10' } } })
    expect(await result).toEqual({
      status: 'available',
      windows: [
        {
          id: 'codex:primary',
          label: null,
          usedPercent: 100,
          windowDurationMins: null,
          resetsAt: null,
        },
      ],
    })
  })

  it.each([
    [null, 'not_logged_in'],
    [{ type: 'apiKey' }, 'unsupported'],
  ])('handles account %j', async (account, status) => {
    const result = getCodexQuota('codex')
    handshake(account)
    expect(await result).toEqual({ status, windows: [] })
    expect(requests).toHaveLength(3)
  })

  it('reports unsupported RPC without forwarding raw errors', async () => {
    const result = getCodexQuota('codex')
    handshake()
    child.stdout.write(`${JSON.stringify({ id: 3, error: { code: -32601, message: 'secret' } })}\n`)
    expect(await result).toEqual({ status: 'unsupported', windows: [] })
  })

  it('bounds stalled processes and escalates cleanup', async () => {
    const result = getCodexQuota('codex')
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toEqual({ status: 'unavailable', windows: [] })
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    await vi.advanceTimersByTimeAsync(1000)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it.each(['error', 'close', 'stdin-error', 'oversized', 'malformed'])(
    'handles %s without leaking details',
    async (failure) => {
      const result = getCodexQuota('codex')
      if (failure === 'error') child.emit('error', new Error('secret'))
      if (failure === 'close') child.emit('close', 1)
      if (failure === 'stdin-error') child.stdin.emit('error', new Error('secret'))
      if (failure === 'oversized') child.stdout.write('x'.repeat(1024 * 1024 + 1))
      if (failure === 'malformed') child.stdout.write('bad-json\n')
      expect(await result).toEqual({ status: 'unavailable', windows: [] })
    },
  )

  it('rejects reset timestamps outside the JavaScript date range', async () => {
    const result = getCodexQuota('codex')
    handshake()
    reply(3, { rateLimits: { primary: { usedPercent: 10, resetsAt: 1e100 } } })
    expect((await result).windows[0].resetsAt).toBeNull()
  })

  it('decodes labels across split UTF-8 chunks and ignores notifications', async () => {
    const result = getCodexQuota('codex')
    handshake()
    child.stdout.write(`${JSON.stringify({ method: 'account/updated', params: {} })}\n`)
    const payload = Buffer.from(
      `${JSON.stringify({ id: 3, result: { rateLimits: { limitName: '额度', primary: { usedPercent: 10 } } } })}\n`,
    )
    const split = payload.indexOf(Buffer.from('额')) + 1
    child.stdout.write(payload.subarray(0, split))
    child.stdout.write(payload.subarray(split))
    expect((await result).windows[0].label).toBe('额度')
  })

  it('deduplicates requests and caches outcomes briefly', async () => {
    const first = getCodexQuota('codex')
    const second = getCodexQuota('codex')
    handshake()
    reply(3, { rateLimits: {} })
    expect(await first).toEqual({ status: 'unavailable', windows: [] })
    expect(await second).toEqual(await first)
    await getCodexQuota('codex')
    expect(spawnCli).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30001)
    const next = getCodexQuota('codex')
    child.emit('close', 1)
    await next
    expect(spawnCli).toHaveBeenCalledTimes(2)
  })
})
