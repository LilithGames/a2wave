import { describe, expect, it, vi } from 'vitest'
import { UnsafeUrlError, createStreamingSafeFetch } from '../streaming-safe-fetch.js'

const PUBLIC = [{ address: '93.184.216.34', family: 4 }]

function dispatcherFactory(destroy = vi.fn(async () => {})) {
  return {
    destroy,
    factory: vi.fn(() => ({ destroy })),
  }
}

describe('createStreamingSafeFetch', () => {
  it('does not start hostname resolution for an already-aborted request', async () => {
    const fetchImpl = vi.fn()
    const resolveHostname = vi.fn(async () => PUBLIC)
    const dispatchers = dispatcherFactory()
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname,
      dispatcherFactory: dispatchers.factory,
    })
    const controller = new AbortController()
    const reason = new DOMException('request was already canceled', 'AbortError')
    controller.abort(reason)

    await expect(
      safeFetch('https://canceled.example/a2a', { signal: controller.signal }),
    ).rejects.toBe(reason)
    expect(resolveHostname).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(dispatchers.factory).not.toHaveBeenCalled()
  })

  it('aborts stalled hostname resolution before opening a socket', async () => {
    const fetchImpl = vi.fn()
    const dispatchers = dispatcherFactory()
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname: () => new Promise(() => undefined),
      dispatcherFactory: dispatchers.factory,
    })
    const controller = new AbortController()
    const reason = new DOMException('control request timed out', 'TimeoutError')

    const request = safeFetch('https://slow.example/a2a', { signal: controller.signal })
    controller.abort(reason)
    const outcome = await Promise.race([
      request.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 20)),
    ])

    expect(outcome).toBe(reason)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(dispatchers.factory).not.toHaveBeenCalled()
  })

  it('aborts hostname resolution for a redirect hop', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: 'https://slow.example/a2a' },
        }),
    )
    const dispatchers = dispatcherFactory()
    const resolveHostname = vi.fn((hostname: string) =>
      hostname === 'public.example' ? Promise.resolve(PUBLIC) : new Promise<never>(() => undefined),
    )
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname,
      dispatcherFactory: dispatchers.factory,
    })
    const controller = new AbortController()
    const reason = new DOMException('redirect resolution timed out', 'TimeoutError')

    const request = safeFetch('https://public.example/a2a', { signal: controller.signal })
    await vi.waitFor(() => expect(resolveHostname).toHaveBeenCalledTimes(2))
    controller.abort(reason)
    const outcome = await Promise.race([
      request.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise((resolve) => setTimeout(() => resolve('still-pending'), 20)),
    ])

    expect(outcome).toBe(reason)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(dispatchers.destroy).toHaveBeenCalledOnce()
  })

  it('rejects private and mixed DNS answers before issuing a request', async () => {
    const fetchImpl = vi.fn()
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname: async () => [...PUBLIC, { address: '10.0.0.5', family: 4 }],
      dispatcherFactory: dispatcherFactory().factory,
    })

    await expect(safeFetch('https://mixed.example/mcp')).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('allows an exact trusted hostname to resolve to enterprise-private DNS', async () => {
    const fetchImpl = vi.fn(async () => new Response('ok'))
    const dispatchers = dispatcherFactory()
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      trustedHosts: new Set(['mcp.internal.example']),
      resolveHostname: async () => [{ address: '10.0.0.5', family: 4 }],
      dispatcherFactory: dispatchers.factory,
    })

    const response = await safeFetch('https://mcp.internal.example/tools')
    expect(await response.text()).toBe('ok')
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(dispatchers.factory).toHaveBeenCalledWith([{ address: '10.0.0.5', family: 4 }])
  })

  it.each(['10.0.0.5', '100.64.0.5', 'fd00::5'])(
    'keeps ordinary enterprise-private address %s usable for exact trusted MCP/A2A hosts',
    async (address) => {
      const fetchImpl = vi.fn(async () => new Response('ok'))
      const safeFetch = createStreamingSafeFetch({
        fetchImpl,
        trustedHosts: new Set(['internal.example']),
        resolveHostname: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
        dispatcherFactory: dispatcherFactory().factory,
      })

      await expect(safeFetch('https://internal.example/mcp')).resolves.toBeInstanceOf(Response)
    },
  )

  it.each([
    ['private DNS', 'http://agent.internal.example/a2a', '10.0.0.5', 4],
    ['private IPv4 literal', 'http://10.0.0.8:8080/a2a', '10.0.0.8', 4],
    ['ULA IPv6 literal', 'http://[fd00::8]:8080/a2a', 'fd00::8', 6],
  ])(
    'allows %s by policy while retaining validated DNS pinning',
    async (_label, url, address, family) => {
      const fetchImpl = vi.fn(async () => new Response('ok'))
      const dispatchers = dispatcherFactory()
      const safeFetch = createStreamingSafeFetch({
        allowPrivateTargets: true,
        fetchImpl,
        resolveHostname: async () => [{ address, family }],
        dispatcherFactory: dispatchers.factory,
      })

      const response = await safeFetch(url)
      expect(await response.text()).toBe('ok')
      expect(dispatchers.factory).toHaveBeenCalledWith([{ address, family }])
    },
  )

  it.each([
    ['metadata IPv4', 'http://169.254.169.254/latest/meta-data', '169.254.169.254', 4],
    ['metadata hostname', 'http://metadata.google.internal/computeMetadata/v1', '10.0.0.5', 4],
    ['loopback', 'http://127.0.0.1:8080/a2a', '127.0.0.1', 4],
    ['link-local', 'http://169.254.1.8/a2a', '169.254.1.8', 4],
  ])('keeps %s blocked in private-network mode', async (_label, url, address, family) => {
    const fetchImpl = vi.fn()
    const safeFetch = createStreamingSafeFetch({
      allowPrivateTargets: true,
      fetchImpl,
      resolveHostname: async () => [{ address, family }],
      dispatcherFactory: dispatcherFactory().factory,
    })

    await expect(safeFetch(url)).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('revalidates a redirect into an ordinary private network in private-network mode', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'http://agent.internal.example/a2a' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok'))
    const safeFetch = createStreamingSafeFetch({
      allowPrivateTargets: true,
      fetchImpl,
      resolveHostname: async (hostname) =>
        hostname === 'public.example' ? PUBLIC : [{ address: '10.0.0.8', family: 4 }],
      dispatcherFactory: dispatcherFactory().factory,
    })

    await expect(safeFetch('https://public.example/a2a')).resolves.toBeInstanceOf(Response)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it.each([
    '169.254.169.254',
    '100.100.100.200',
    'fd00:ec2::254',
    '::ffff:100.100.100.200',
    '64:ff9b::6464:64c8',
    '2002:6464:64c8::',
  ])('hard-blocks metadata address %s for exact trusted MCP/A2A hosts', async (address) => {
    const fetchImpl = vi.fn()
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      trustedHosts: new Set(['internal.example']),
      resolveHostname: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      dispatcherFactory: dispatcherFactory().factory,
    })

    await expect(safeFetch('https://internal.example/mcp')).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not extend trust to child hostnames or forbidden private ranges', async () => {
    const fetchImpl = vi.fn()
    const base = {
      fetchImpl,
      trustedHosts: new Set(['mcp.internal.example']),
      dispatcherFactory: dispatcherFactory().factory,
    }

    await expect(
      createStreamingSafeFetch({
        ...base,
        resolveHostname: async () => [{ address: '10.0.0.5', family: 4 }],
      })('https://child.mcp.internal.example/tools'),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
    await expect(
      createStreamingSafeFetch({
        ...base,
        resolveHostname: async () => [{ address: '169.254.169.254', family: 4 }],
      })('https://mcp.internal.example/tools'),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('revalidates and blocks a redirect whose hostname resolves privately', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://rebound.example/mcp' },
        }),
    )
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname: async (hostname) =>
        hostname === 'public.example' ? PUBLIC : [{ address: '10.0.0.8', family: 4 }],
      dispatcherFactory: dispatcherFactory().factory,
    })

    await expect(safeFetch('https://public.example/mcp')).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('keeps only safe protocol headers across an origin-changing 307 redirect', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 307,
          headers: { location: 'https://mcp-canonical.example/messages' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok'))
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname: async () => PUBLIC,
      dispatcherFactory: dispatcherFactory().factory,
    })

    await safeFetch('https://mcp.example/messages', {
      method: 'POST',
      body: '{"jsonrpc":"2.0"}',
      headers: {
        Authorization: 'Bearer secret',
        'X-Company-Token': 'company-secret',
        'Mcp-Session-Id': 'session-secret',
        'MCP-Protocol-Version': '2025-06-18',
        'A2A-Version': '1.0',
        'Last-Event-ID': 'event-secret',
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      },
    })

    const redirected = fetchImpl.mock.calls[1]?.[1] as RequestInit
    const headers = new Headers(redirected.headers)
    expect(redirected.method).toBe('POST')
    expect(redirected.body).toBe('{"jsonrpc":"2.0"}')
    expect(headers.get('accept')).toBe('application/json, text/event-stream')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('mcp-protocol-version')).toBe('2025-06-18')
    expect(headers.get('a2a-version')).toBe('1.0')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-company-token')).toBeNull()
    expect(headers.get('mcp-session-id')).toBeNull()
    expect(headers.get('last-event-id')).toBeNull()
  })

  it('preserves all request headers across a same-origin redirect', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: '/canonical' } }),
      )
      .mockResolvedValueOnce(new Response('ok'))
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname: async () => PUBLIC,
      dispatcherFactory: dispatcherFactory().factory,
    })

    await safeFetch('https://mcp.example/messages', {
      headers: { Authorization: 'Bearer secret', 'Mcp-Session-Id': 'session-id' },
    })

    const headers = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer secret')
    expect(headers.get('mcp-session-id')).toBe('session-id')
  })

  it('drops body metadata when a 302 rewrites POST to GET', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://mcp-canonical.example/messages' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok'))
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname: async () => PUBLIC,
      dispatcherFactory: dispatcherFactory().factory,
    })

    await safeFetch('https://mcp.example/messages', {
      method: 'POST',
      body: '{}',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': '2',
        'Content-Encoding': 'gzip',
        'Content-MD5': 'deadbeef',
      },
    })

    const redirected = fetchImpl.mock.calls[1]?.[1] as RequestInit
    const headers = new Headers(redirected.headers)
    expect(redirected.method).toBe('GET')
    expect(redirected.body).toBeUndefined()
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('content-type')).toBeNull()
    expect(headers.get('content-length')).toBeNull()
    expect(headers.get('content-encoding')).toBeNull()
    expect(headers.get('content-md5')).toBeNull()
  })

  it('drops every content header on a same-origin POST-to-GET redirect', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: '/canonical' } }),
      )
      .mockResolvedValueOnce(new Response('ok'))
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname: async () => PUBLIC,
      dispatcherFactory: dispatcherFactory().factory,
    })

    await safeFetch('https://mcp.example/messages', {
      method: 'POST',
      body: '{}',
      headers: { 'Content-Type': 'application/json', 'Content-MD5': 'deadbeef' },
    })

    const redirected = fetchImpl.mock.calls[1]?.[1] as RequestInit
    const headers = new Headers(redirected.headers)
    expect(headers.get('content-type')).toBeNull()
    expect(headers.get('content-md5')).toBeNull()
  })

  it('returns a live response stream without buffering or a fixed 15-second deadline', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        controller.enqueue(new TextEncoder().encode('first'))
      },
    })
    const fetchImpl = vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    )
    const dispatchers = dispatcherFactory()
    const safeFetch = createStreamingSafeFetch({
      fetchImpl,
      resolveHostname: async () => PUBLIC,
      dispatcherFactory: dispatchers.factory,
    })

    const response = await safeFetch('https://stream.example/sse')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Expected a streaming response body')
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first')
    expect(dispatchers.destroy).not.toHaveBeenCalled()
    controller.enqueue(new TextEncoder().encode('later'))
    controller.close()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('later')
    expect((await reader.read()).done).toBe(true)
    expect(dispatchers.destroy).toHaveBeenCalledOnce()
  })
})
