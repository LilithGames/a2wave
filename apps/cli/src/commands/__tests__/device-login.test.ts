/**
 * Device grant on the CLI side: the poll loop and how it reports the four RFC 8628
 * outcomes back to a user staring at a terminal on a machine with no browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockSaveConfig = vi.fn()
const mockLoadConfig = vi.fn()
const mockSaveCredential = vi.fn()
vi.mock('../../config.js', () => ({
  saveConfig: (...a: unknown[]) => mockSaveConfig(...a),
  loadConfig: () => mockLoadConfig(),
  saveCredential: (...a: unknown[]) => mockSaveCredential(...a),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const { deviceLogin } = await import('../device-login.js')

const URL_BASE = 'https://a2w.test'

function codeResponse(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: {
        deviceCode: 'DEVICE-CODE',
        userCode: 'WDJB-MJHT',
        verificationUri: `${URL_BASE}/device`,
        verificationUriComplete: `${URL_BASE}/device?code=WDJB-MJHT`,
        expiresIn: 600,
        interval: 0, // keeps the test's poll loop instant
        ...over,
      },
    }),
  }
}

function pollError(error: string) {
  return { ok: false, status: 400, json: async () => ({ error }) }
}

function pollSuccess() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: { token: 'a2w_tok', user: { username: 'ada' } } }),
  }
}

beforeEach(() => {
  mockFetch.mockReset()
  mockSaveConfig.mockReset()
  mockSaveCredential.mockReset()
  mockLoadConfig.mockReset().mockReturnValue({ token: '' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('deviceLogin', () => {
  it('shows the user the code and the page to open', async () => {
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')))
    mockFetch.mockResolvedValueOnce(codeResponse()).mockResolvedValueOnce(pollSuccess())

    await deviceLogin({ url: URL_BASE, openBrowser: false })

    const out = logs.join('\n')
    expect(out).toContain('WDJB-MJHT')
    expect(out).toContain(`${URL_BASE}/device`)
  })

  it('keeps polling while the request is pending, then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(codeResponse())
      .mockResolvedValueOnce(pollError('authorization_pending'))
      .mockResolvedValueOnce(pollError('authorization_pending'))
      .mockResolvedValueOnce(pollSuccess())

    await deviceLogin({ url: URL_BASE, openBrowser: false })

    expect(mockFetch).toHaveBeenCalledTimes(4)
    expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ token: 'a2w_tok' }))
  })

  it('files the credential under the instance URL, not just the top-level slot', async () => {
    // Otherwise logging into a second deployment silently drops the first's token.
    mockFetch.mockResolvedValueOnce(codeResponse()).mockResolvedValueOnce(pollSuccess())
    await deviceLogin({ url: URL_BASE, openBrowser: false })
    expect(mockSaveCredential).toHaveBeenCalledWith(URL_BASE, 'a2w_tok')
  })

  it('backs off when the server says slow_down instead of hammering it', async () => {
    const sleeps: number[] = []
    mockFetch
      .mockResolvedValueOnce(codeResponse())
      .mockResolvedValueOnce(pollError('slow_down'))
      .mockResolvedValueOnce(pollSuccess())

    await deviceLogin({
      url: URL_BASE,
      openBrowser: false,
      sleep: async (ms) => void sleeps.push(ms),
    })

    // The wait after slow_down must exceed the wait before it.
    expect(sleeps.length).toBeGreaterThanOrEqual(2)
    expect(sleeps.at(-1)).toBeGreaterThan(sleeps[0])
  })

  it('waits out a rate limit instead of aborting the login', async () => {
    // authRateLimit returns { error: { code, message } } — an object, not a string.
    // Treating it as a poll outcome kills a login that would have succeeded, with
    // an unreadable message.
    mockFetch
      .mockResolvedValueOnce(codeResponse())
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => '1' },
        json: async () => ({ error: { code: 'RATE_LIMITED', message: 'too many' } }),
      })
      .mockResolvedValueOnce(pollSuccess())

    await deviceLogin({ url: URL_BASE, openBrowser: false, sleep: async () => {} })

    expect(mockSaveConfig).toHaveBeenCalledWith(expect.objectContaining({ token: 'a2w_tok' }))
  })

  it('never renders a non-string error as [object Object]', async () => {
    mockFetch.mockResolvedValueOnce(codeResponse()).mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'X' } }),
    })
    await expect(
      deviceLogin({ url: URL_BASE, openBrowser: false, sleep: async () => {} }),
    ).rejects.toThrow(/^(?!.*\[object Object\]).*$/s)
  })

  it("reports a refusal in the user's terms rather than as a protocol code", async () => {
    mockFetch
      .mockResolvedValueOnce(codeResponse())
      .mockResolvedValueOnce(pollError('access_denied'))
    await expect(deviceLogin({ url: URL_BASE, openBrowser: false })).rejects.toThrow(/denied/i)
    expect(mockSaveConfig).not.toHaveBeenCalled()
  })

  it('reports expiry and tells the user to start over', async () => {
    mockFetch
      .mockResolvedValueOnce(codeResponse())
      .mockResolvedValueOnce(pollError('expired_token'))
    await expect(deviceLogin({ url: URL_BASE, openBrowser: false })).rejects.toThrow(/expired/i)
  })

  it('gives up once the advertised lifetime has elapsed', async () => {
    // Without this the loop would poll a dead code until the user gives up.
    mockFetch.mockResolvedValueOnce(codeResponse({ expiresIn: 0 }))
    mockFetch.mockResolvedValue(pollError('authorization_pending'))
    await expect(
      deviceLogin({ url: URL_BASE, openBrowser: false, sleep: async () => {} }),
    ).rejects.toThrow(/expired|timed out/i)
  })

  it('surfaces a server that has no device endpoint as a clear message', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, text: async () => 'Not Found' })
    await expect(deviceLogin({ url: URL_BASE, openBrowser: false })).rejects.toThrow(
      /does not support|404/i,
    )
  })

  it('never writes a token when the poll never succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(codeResponse())
      .mockResolvedValueOnce(pollError('access_denied'))
    await expect(deviceLogin({ url: URL_BASE, openBrowser: false })).rejects.toThrow()
    expect(mockSaveCredential).not.toHaveBeenCalled()
  })
})
