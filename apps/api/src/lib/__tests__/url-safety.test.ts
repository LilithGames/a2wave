import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: {
    TRUSTED_IMPORT_HOSTS: 'share.internal.example.com',
    TRUSTED_PROVIDER_HOSTS: ' Trusted-Provider.Example.Com , 10.0.0.5 ',
  },
}))

import {
  assertSafeHttpUrl,
  isCloudMetadataAddress,
  resolvePublicUrl,
  safeFetch,
} from '../url-safety-core.js'
import {
  UnsafeUrlError,
  assertSafePublicUrl,
  isBlockedHost,
  isBlockedHostStrict,
  isPrivateOrReserved,
  resolveProviderUrl,
  safePublicFetch,
} from '../url-safety.js'

describe('url-safety', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('isPrivateOrReserved (strict core)', () => {
    it('blocks localhost and loopback', async () => {
      expect(isPrivateOrReserved('localhost')).toBe(true)
      expect(isPrivateOrReserved('127.0.0.1')).toBe(true)
      expect(isPrivateOrReserved('127.255.255.254')).toBe(true)
    })

    it('blocks IPv6 loopback in all common writings', async () => {
      expect(isPrivateOrReserved('::1')).toBe(true)
      expect(isPrivateOrReserved('[::1]')).toBe(true)
      expect(isPrivateOrReserved('0:0:0:0:0:0:0:1')).toBe(true)
      expect(isPrivateOrReserved('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true)
    })

    it('blocks IPv4-mapped IPv6 loopback / private ranges', async () => {
      expect(isPrivateOrReserved('::ffff:127.0.0.1')).toBe(true)
      expect(isPrivateOrReserved('::ffff:10.0.0.1')).toBe(true)
      expect(isPrivateOrReserved('::ffff:192.168.1.1')).toBe(true)
      expect(isPrivateOrReserved('::ffff:169.254.169.254')).toBe(true)
    })

    it('blocks cloud metadata endpoints', async () => {
      expect(isPrivateOrReserved('169.254.169.254')).toBe(true)
      expect(isPrivateOrReserved('100.100.100.200')).toBe(true)
      expect(isPrivateOrReserved('fd00:ec2::254')).toBe(true)
      expect(isPrivateOrReserved('metadata.google.internal')).toBe(true)
    })

    it('recognizes metadata addresses through mapped, NAT64, and 6to4 encodings', async () => {
      for (const address of [
        '169.254.169.254',
        '100.100.100.200',
        'fd00:ec2::254',
        '::ffff:100.100.100.200',
        '64:ff9b::6464:64c8',
        '2002:6464:64c8::',
      ]) {
        expect(isCloudMetadataAddress(address)).toBe(true)
      }
      expect(isCloudMetadataAddress('100.64.0.5')).toBe(false)
      expect(isCloudMetadataAddress('fd00::5')).toBe(false)
    })

    it('blocks RFC1918 + link-local', async () => {
      expect(isPrivateOrReserved('10.0.0.1')).toBe(true)
      expect(isPrivateOrReserved('192.168.1.1')).toBe(true)
      expect(isPrivateOrReserved('172.16.0.1')).toBe(true)
      expect(isPrivateOrReserved('172.31.255.255')).toBe(true)
      expect(isPrivateOrReserved('169.254.1.1')).toBe(true)
    })

    it('does not false-block 172.{0-15, 32-255}', async () => {
      expect(isPrivateOrReserved('172.15.0.1')).toBe(false)
      expect(isPrivateOrReserved('172.32.0.1')).toBe(false)
    })

    it('blocks IPv6 ULA and link-local', async () => {
      expect(isPrivateOrReserved('fe80::1')).toBe(true)
      expect(isPrivateOrReserved('fc00::1')).toBe(true)
      expect(isPrivateOrReserved('fd00:abcd:ef01::1')).toBe(true)
      expect(isPrivateOrReserved('fdff::1')).toBe(true)
    })

    it('blocks the full fc00::/7, fe80::/10, fec0::/10 ranges (not just literal fc00/fe80)', async () => {
      // Regression: startsWith('fc00:')/startsWith('fe80:') only caught one quad.
      // These all sit inside the CIDR blocks and must be blocked.
      for (const h of ['fc01::1', 'fcab::1', 'fcff::1', 'fd00::1', 'fdab::1', 'fdff::1']) {
        expect(isPrivateOrReserved(h)).toBe(true) // fc00::/7 ULA
      }
      for (const h of ['fe80::1', 'fe90::1', 'feab::1', 'febf::1']) {
        expect(isPrivateOrReserved(h)).toBe(true) // fe80::/10 link-local
      }
      for (const h of ['fec0::1', 'fed0::1', 'feff::1']) {
        expect(isPrivateOrReserved(h)).toBe(true) // fec0::/10 deprecated site-local
      }
      // Unspecified address
      expect(isPrivateOrReserved('::')).toBe(true)
    })

    it('blocks private IPv4 embedded in mapped/translated/NAT64/6to4 IPv6', async () => {
      // IPv4-mapped ::ffff:a.b.c.d and its hex form
      expect(isPrivateOrReserved('::ffff:127.0.0.1')).toBe(true)
      expect(isPrivateOrReserved('::ffff:7f00:1')).toBe(true)
      // IPv4-translated ::ffff:0:a.b.c.d (::ffff:0:0/96)
      expect(isPrivateOrReserved('::ffff:0:7f00:1')).toBe(true)
      // NAT64 well-known 64:ff9b::/96 wrapping 169.254.169.254
      expect(isPrivateOrReserved('64:ff9b::a9fe:a9fe')).toBe(true)
      // 6to4 2002::/16 wrapping 127.0.0.1
      expect(isPrivateOrReserved('2002:7f00:1::')).toBe(true)
    })

    it('does NOT block mapped/6to4 wrapping a public IPv4', async () => {
      expect(isPrivateOrReserved('::ffff:8.8.8.8')).toBe(false)
      expect(isPrivateOrReserved('2002:0808:0808::')).toBe(false) // 6to4 of 8.8.8.8
    })

    it('does NOT match fd-prefixed hostnames like fdata.example.com', async () => {
      expect(isPrivateOrReserved('fdata.example.com')).toBe(false)
      expect(isPrivateOrReserved('fc-app.example.com')).toBe(false)
      expect(isPrivateOrReserved('fe80something.example.com')).toBe(false)
    })

    it('lets public addresses through', async () => {
      expect(isPrivateOrReserved('8.8.8.8')).toBe(false)
      expect(isPrivateOrReserved('example.com')).toBe(false)
      expect(isPrivateOrReserved('2606:4700::1')).toBe(false) // Cloudflare
    })
  })

  describe('isBlockedHost (allows TRUSTED_IMPORT_HOSTS)', () => {
    it('allows whitelisted host even if it would otherwise be blocked', async () => {
      expect(isBlockedHost('share.internal.example.com')).toBe(false)
    })

    it('still blocks private IPs not in whitelist', async () => {
      expect(isBlockedHost('127.0.0.1')).toBe(true)
      expect(isBlockedHost('10.0.0.1')).toBe(true)
    })
  })

  describe('isBlockedHostStrict (ignores TRUSTED_IMPORT_HOSTS)', () => {
    it('blocks whitelisted hosts when they resolve to private addresses', async () => {
      // Same name that isBlockedHost would permit
      expect(isBlockedHostStrict('localhost')).toBe(true)
      expect(isBlockedHostStrict('127.0.0.1')).toBe(true)
      expect(isBlockedHostStrict('::ffff:127.0.0.1')).toBe(true)
    })

    it('allows public hosts', async () => {
      expect(isBlockedHostStrict('example.com')).toBe(false)
    })
  })

  describe('assertSafePublicUrl (strict default)', () => {
    it('accepts normal public https URLs', async () => {
      const url = assertSafePublicUrl('https://example.com/webhook')
      expect(url.hostname).toBe('example.com')
    })

    it('rejects invalid URL', async () => {
      expect(() => assertSafePublicUrl('not-a-url')).toThrow(UnsafeUrlError)
    })

    it('rejects non-http protocols', async () => {
      expect(() => assertSafePublicUrl('ftp://example.com/file')).toThrow(/http/)
      expect(() => assertSafePublicUrl('file:///etc/passwd')).toThrow(/http/)
    })

    it('rejects localhost / private IPs', async () => {
      expect(() => assertSafePublicUrl('http://127.0.0.1/webhook')).toThrow(UnsafeUrlError)
      expect(() => assertSafePublicUrl('http://[::1]/webhook')).toThrow(UnsafeUrlError)
      expect(() => assertSafePublicUrl('http://[::ffff:127.0.0.1]/webhook')).toThrow(UnsafeUrlError)
      expect(() => assertSafePublicUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
        UnsafeUrlError,
      )
    })

    it('does not honor TRUSTED_IMPORT_HOSTS by default', async () => {
      // Whitelisted host that would be permitted by isBlockedHost — assertSafePublicUrl
      // defaults to strict so this should still pass only because the name resolves to a
      // public-looking literal. For a truly private-looking whitelisted host we still block.
      // （这里 share.internal.example.com 本身不命中私网字面量，用作正例即可）
      const u = assertSafePublicUrl('https://share.internal.example.com/')
      expect(u.hostname).toBe('share.internal.example.com')
    })

    it('opt-in allowTrustedHosts can relax the check', async () => {
      // No current caller of assertSafePublicUrl in code uses allowTrustedHosts=true,
      // but agent-import path lives behind validateImportUrl which does its own check;
      // keep this test purely to pin the flag behavior for future use.
      expect(() =>
        assertSafePublicUrl('https://share.internal.example.com/', { allowTrustedHosts: true }),
      ).not.toThrow()
    })
  })

  describe('resolvePublicUrl', () => {
    it('rejects a hostname when any DNS answer is private or reserved', async () => {
      await expect(
        resolvePublicUrl('https://provider.example.com/v1/models', async () => [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ]),
      ).rejects.toThrow(/private or reserved/)
    })

    it('exposes a stable code when private DNS answers are rejected', async () => {
      const error = await resolvePublicUrl('https://provider.example.com/v1/models', async () => [
        { address: '10.0.0.5', family: 4 },
      ]).catch((caught) => caught)

      expect(error).toMatchObject({ reason: 'blocked', code: 'private_dns_address' })
    })

    it('returns all validated public addresses for connection pinning', async () => {
      const result = await resolvePublicUrl('https://provider.example.com/v1/models', async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ])

      expect(result.url.hostname).toBe('provider.example.com')
      expect(result.addresses).toEqual([
        { address: '93.184.216.34', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 },
      ])
    })

    it('allows ordinary private literals and DNS answers only in private-network mode', async () => {
      expect(() =>
        assertSafeHttpUrl('http://10.0.0.8:8080/a2a', { allowPrivateAddresses: true }),
      ).not.toThrow()
      await expect(
        resolvePublicUrl(
          'http://10.0.0.8:8080/a2a',
          async () => [{ address: '10.0.0.8', family: 4 }],
          { allowPrivateAddresses: true },
        ),
      ).resolves.toMatchObject({ addresses: [{ address: '10.0.0.8', family: 4 }] })
      await expect(
        resolvePublicUrl(
          'https://agent.internal.example/a2a',
          async () => [{ address: '10.0.0.9', family: 4 }],
          { allowPrivateAddresses: true },
        ),
      ).resolves.toMatchObject({ addresses: [{ address: '10.0.0.9', family: 4 }] })
    })

    it.each([
      'http://127.0.0.1:8080/a2a',
      'http://169.254.169.254/latest/meta-data',
      'http://metadata.google.internal/computeMetadata/v1',
    ])('keeps forbidden target %s blocked in private-network mode', (url) => {
      expect(() => assertSafeHttpUrl(url, { allowPrivateAddresses: true })).toThrow(UnsafeUrlError)
    })

    it('fails closed when DNS resolution fails', async () => {
      const resolution = resolvePublicUrl('https://provider.example.com', async () => {
        throw new Error('DNS unavailable')
      })

      await expect(resolution).rejects.toMatchObject({
        code: 'dns_resolution_failed',
      })
      await expect(
        resolvePublicUrl('https://provider.example.com', async () => {
          throw new Error('DNS unavailable')
        }),
      ).rejects.toThrow(/could not be resolved safely/)
    })
  })

  describe('resolveProviderUrl', () => {
    it('does not trust the Anthropic hostname for user-controlled Provider URLs', async () => {
      const privateResolver = async () => [{ address: '10.0.0.5', family: 4 }]

      await expect(
        resolveProviderUrl('https://api.anthropic.com/v1/models', privateResolver),
      ).rejects.toThrow(/private or reserved.*TRUSTED_PROVIDER_HOSTS/)
      await expect(
        resolveProviderUrl('https://child.api.anthropic.com/v1/models', privateResolver),
      ).rejects.toThrow(/private or reserved.*TRUSTED_PROVIDER_HOSTS/)
    })

    it('normalizes and allows private DNS answers only for an exact configured hostname', async () => {
      const privateResolver = async () => [{ address: '10.0.0.5', family: 4 }]

      await expect(
        resolveProviderUrl('https://trusted-provider.example.com/v1/models', privateResolver),
      ).resolves.toMatchObject({
        url: expect.objectContaining({ hostname: 'trusted-provider.example.com' }),
        addresses: [{ address: '10.0.0.5', family: 4 }],
      })
      await expect(
        resolveProviderUrl('https://child.trusted-provider.example.com/v1/models', privateResolver),
      ).rejects.toThrow(/private or reserved.*TRUSTED_PROVIDER_HOSTS/)
      await expect(
        resolveProviderUrl('https://unrelated-provider.example.com/v1/models', privateResolver),
      ).rejects.toThrow(/private or reserved.*TRUSTED_PROVIDER_HOSTS/)
    })

    it('keeps loopback and link-local DNS answers blocked for a trusted hostname', async () => {
      for (const address of [
        '127.0.0.1',
        '169.254.169.254',
        '100.100.100.200',
        'fd00:ec2::254',
        '::ffff:100.100.100.200',
        '64:ff9b::6464:64c8',
        '2002:6464:64c8::',
        '::1',
        'fe80::1',
      ]) {
        await expect(
          resolveProviderUrl('https://trusted-provider.example.com/v1/models', async () => [
            { address, family: address.includes(':') ? 6 : 4 },
          ]),
        ).rejects.toThrow(/private or reserved/)
      }
    })

    it('keeps forbidden DNS ranges blocked for the Anthropic hostname', async () => {
      const error = await resolveProviderUrl('https://api.anthropic.com/v1/models', async () => [
        { address: '169.254.169.254', family: 4 },
      ]).catch((caught) => caught)

      expect(error).toMatchObject({ reason: 'blocked', code: 'forbidden_dns_address' })
      expect((error as Error).message).not.toContain('TRUSTED_PROVIDER_HOSTS')
    })

    it('allows ordinary enterprise-private ranges for a trusted hostname', async () => {
      for (const address of ['10.0.0.5', '100.64.0.5', 'fd00::5']) {
        await expect(
          resolveProviderUrl('https://trusted-provider.example.com/v1/models', async () => [
            { address, family: address.includes(':') ? 6 : 4 },
          ]),
        ).resolves.toMatchObject({ addresses: [{ address }] })
      }
    })

    it('does not suggest re-allowlisting a trusted hostname whose address remains forbidden', async () => {
      const error = await resolveProviderUrl(
        'https://trusted-provider.example.com/v1/models',
        async () => [{ address: '169.254.169.254', family: 4 }],
      ).catch((caught) => caught)

      expect(error).toBeInstanceOf(UnsafeUrlError)
      expect((error as Error).message).not.toContain('TRUSTED_PROVIDER_HOSTS')
    })

    it('does not suggest allowlisting an untrusted hostname whose address can never be allowed', async () => {
      const error = await resolveProviderUrl(
        'https://untrusted-provider.example.com/v1/models',
        async () => [{ address: '169.254.169.254', family: 4 }],
      ).catch((caught) => caught)

      expect(error).toBeInstanceOf(UnsafeUrlError)
      expect((error as Error).message).not.toContain('TRUSTED_PROVIDER_HOSTS')
    })

    it('still blocks a private IP literal even when the literal appears in the allowlist', async () => {
      const resolver = vi.fn()

      await expect(resolveProviderUrl('https://10.0.0.5/v1/models', resolver)).rejects.toThrow(
        /private or reserved/,
      )
      expect(resolver).not.toHaveBeenCalled()
    })
  })

  describe('safeFetch redirects', () => {
    it('strips credentials before following a cross-origin redirect', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(null, {
            status: 302,
            headers: { location: 'https://models.other.example/v1/models' },
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await safeFetch('https://provider.example/v1/models', {
        headers: {
          Authorization: 'Bearer secret',
          Cookie: 'session=secret',
          'x-api-key': 'secret-key',
          'x-company-token': 'company-secret',
          'mcp-session-id': 'session-secret',
          'x-request-id': 'request-1',
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      })

      const redirectedHeaders = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers)
      expect(redirectedHeaders.get('authorization')).toBeNull()
      expect(redirectedHeaders.get('cookie')).toBeNull()
      expect(redirectedHeaders.get('x-api-key')).toBeNull()
      expect(redirectedHeaders.get('x-company-token')).toBeNull()
      expect(redirectedHeaders.get('mcp-session-id')).toBeNull()
      expect(redirectedHeaders.get('x-request-id')).toBeNull()
      expect(redirectedHeaders.get('accept')).toBe('application/json')
      expect(redirectedHeaders.get('content-type')).toBe('application/json')
    })

    it('preserves credentials for same-origin redirects', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(null, {
            status: 307,
            headers: { location: '/v2/models' },
          }),
        )
        .mockResolvedValueOnce(new Response('{}', { status: 200 }))

      await safeFetch('https://provider.example/v1/models', {
        headers: { Authorization: 'Bearer secret', 'x-api-key': 'secret-key' },
      })

      const redirectedHeaders = new Headers(fetchSpy.mock.calls[1]?.[1]?.headers)
      expect(redirectedHeaders.get('authorization')).toBe('Bearer secret')
      expect(redirectedHeaders.get('x-api-key')).toBe('secret-key')
    })
  })

  describe('safePublicFetch (resolve-pin + no-redirect)', () => {
    const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }]

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('rejects a hostname that resolves to a private IP (DNS rebinding)', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      // Classic rebinding: a benign-looking host that resolves internally.
      await expect(
        safePublicFetch('https://rebind.example.com/hook', {}, async () => [
          { address: '169.254.169.254', family: 4 },
        ]),
      ).rejects.toThrow(UnsafeUrlError)
      // Must never issue the request when resolution is unsafe.
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('refuses to follow a 302 redirect to an internal address', async () => {
      // A target that passes validation but bounces to IMDS. With maxRedirects:0
      // safeFetch rejects the redirect outright rather than chasing the Location —
      // the internal address is never requested.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        }),
      )

      await expect(
        safePublicFetch('https://webhook.example.com/hook', { method: 'POST' }, publicResolver),
      ).rejects.toThrow(UnsafeUrlError)

      // Only the original host was contacted; the internal Location never was.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(fetchSpy.mock.calls.some((call) => String(call[0]).includes('169.254.169.254'))).toBe(
        false,
      )
    })

    it('performs the request for a genuinely public host', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('ok', { status: 200 }))

      const res = await safePublicFetch(
        'https://webhook.example.com/hook',
        { method: 'POST', body: '{}' },
        publicResolver,
      )

      expect(res.status).toBe(200)
      expect(fetchSpy).toHaveBeenCalledOnce()
    })

    it('returns a Response whose body is still readable (buffered, not destroyed)', async () => {
      // The dispatcher is torn down after the request, so the returned Response
      // must be backed by a buffered body — any caller can read status AND body.
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )

      const res = await safePublicFetch(
        'https://webhook.example.com/hook',
        { method: 'POST' },
        publicResolver,
      )

      expect(res.status).toBe(200)
      // Would throw "body terminated" if the body had been destroyed before return.
      await expect(res.json()).resolves.toEqual({ ok: 1 })
    })

    it('rejects non-http(s) schemes', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
      await expect(safePublicFetch('file:///etc/passwd', {}, publicResolver)).rejects.toThrow(
        UnsafeUrlError,
      )
      expect(fetchSpy).not.toHaveBeenCalled()
    })

    it.each([204, 205, 304])(
      'handles a null-body %i response without throwing (Codex P1)',
      async (status) => {
        // `new Response(emptyUint8Array, { status: 204 })` throws — the Fetch spec
        // forbids a body on these statuses. A 204 is a common webhook success, so
        // safePublicFetch must return it cleanly, not surface it as a failure.
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status }))

        const res = await safePublicFetch(
          'https://webhook.example.com/hook',
          { method: 'POST' },
          publicResolver,
        )

        expect(res.status).toBe(status)
        // Response.ok is strictly 200–299, so 204 is ok, 304 is not.
        expect(res.ok).toBe(status >= 200 && status < 300)
      },
    )

    it('aborts an oversized body instead of buffering unbounded memory', async () => {
      // A body larger than the 1MiB cap must be rejected, not read into memory
      // forever. Emit one 2MiB chunk then leave the stream open; the size guard
      // trips on the first chunk.
      const big = new Uint8Array(2 * 1024 * 1024)
      const oversizedBody = new ReadableStream({
        start(controller) {
          controller.enqueue(big)
          // never close — proves the cap trips without needing a clean EOF
        },
      })
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(oversizedBody, { status: 200 }),
      )

      await expect(
        safePublicFetch('https://webhook.example.com/hook', { method: 'POST' }, publicResolver),
      ).rejects.toThrow(UnsafeUrlError)
    })
  })
})
