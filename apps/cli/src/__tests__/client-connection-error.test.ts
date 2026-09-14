/**
 * A fetch that never reaches the server is a network / configuration problem,
 * not a bug in this CLI. Node surfaces it as `TypeError: fetch failed` with the
 * errno on `cause`, and until this was handled the CLI printed
 * "Internal error: fetch failed ... This is a bug in the a2wave CLI" — telling
 * the user to file a bug for a mistyped instance URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockUrl = 'http://10.3.113.32:3512'
let mockToken = 'test-token'

vi.mock('../config.js', () => ({
  resolveCredential: () => mockToken,
  resolveUrl: (override?: string) => override ?? mockUrl,
  loadConfig: vi.fn(),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { createClient, toConnectionError } from '../client.js'
import { CliError } from '../errors.js'

function makeJwt(alg: string): string {
  const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url')
  const b = Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url')
  return `${h}.${b}.sig`
}

/** Node's undici shape: a TypeError whose `cause` carries the errno. */
function fetchFailed(cause: unknown): TypeError {
  return new TypeError('fetch failed', { cause })
}

function errnoError(code: string): Error & { code: string } {
  return Object.assign(new Error(`connect ${code} 10.3.113.32:3512`), { code })
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  throw new Error('expected the call to throw')
}

describe('toConnectionError', () => {
  it('returns null for anything that is not a connection failure', () => {
    expect(toConnectionError(new TypeError('x.y is not a function'), mockUrl)).toBeNull()
    expect(toConnectionError(new Error('boom'), mockUrl)).toBeNull()
    expect(toConnectionError('string', mockUrl)).toBeNull()
  })

  it('names the errno code from the fetch cause', () => {
    const err = toConnectionError(fetchFailed(errnoError('ECONNREFUSED')), mockUrl)
    expect(err).toBeInstanceOf(CliError)
    expect(err?.message).toBe(
      [
        'Cannot reach a2wave at http://10.3.113.32:3512 (ECONNREFUSED).',
        'Check the instance URL: a2wave config get / a2wave config set-url <url>, or pass --url.',
      ].join('\n'),
    )
    expect(err?.type).toBe('network')
    expect(err?.subtype).toBe('ECONNREFUSED')
  })

  it.each(['ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET', 'EAI_AGAIN'])(
    'recognises %s',
    (code) => {
      const err = toConnectionError(fetchFailed(errnoError(code)), mockUrl)
      expect(err?.message).toContain(`(${code})`)
      expect(err?.subtype).toBe(code)
    },
  )

  it('digs the code out of an AggregateError cause (dual-stack connect)', () => {
    // Node tries every resolved address and reports them together.
    const aggregate = new AggregateError(
      [errnoError('ECONNREFUSED'), errnoError('ECONNREFUSED')],
      'connect failed',
    )
    const err = toConnectionError(fetchFailed(aggregate), mockUrl)
    expect(err?.message).toContain('(ECONNREFUSED)')
    expect(err?.subtype).toBe('ECONNREFUSED')
  })

  it('falls back to the cause message when there is no errno code', () => {
    const err = toConnectionError(fetchFailed(new Error('unable to verify certificate')), mockUrl)
    expect(err?.message).toContain('(unable to verify certificate)')
    expect(err?.subtype).toBeUndefined()
  })

  it('treats an abort / timeout as a connection failure', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError')
    const err = toConnectionError(abort, mockUrl)
    expect(err?.message).toContain('Cannot reach a2wave at http://10.3.113.32:3512 (timed out)')
    expect(err?.subtype).toBe('timeout')

    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    expect(toConnectionError(timeout, mockUrl)?.subtype).toBe('timeout')
  })
})

describe('createClient — unreachable instance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockToken = 'test-token'
  })

  it('converts a refused connection on a data request into a network CliError', async () => {
    mockFetch.mockRejectedValueOnce(fetchFailed(errnoError('ECONNREFUSED')))

    const err = (await captureError(() => createClient().get('/api/agents'))) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.type).toBe('network')
    expect(err.message).toContain('Cannot reach a2wave at http://10.3.113.32:3512 (ECONNREFUSED).')
  })

  it('uses the --url override in the message', async () => {
    mockFetch.mockRejectedValueOnce(fetchFailed(errnoError('ENOTFOUND')))

    const err = (await captureError(() =>
      createClient({ url: 'https://typo.example' }).get('/api/agents'),
    )) as CliError
    expect(err.message).toContain('Cannot reach a2wave at https://typo.example (ENOTFOUND).')
  })

  it('converts a refused connection during the IDaaS exchange too', async () => {
    mockToken = makeJwt('RS256')
    mockFetch.mockRejectedValueOnce(fetchFailed(errnoError('EHOSTUNREACH')))

    const err = (await captureError(() => createClient().get('/api/agents'))) as CliError
    expect(err).toBeInstanceOf(CliError)
    expect(err.type).toBe('network')
    expect(err.message).toContain('(EHOSTUNREACH)')
  })

  it('leaves a genuine programming error alone so it still reports as internal', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('x.y is not a function'))

    const err = await captureError(() => createClient().get('/api/agents'))
    expect(err).not.toBeInstanceOf(CliError)
    expect((err as Error).message).toBe('x.y is not a function')
  })
})
