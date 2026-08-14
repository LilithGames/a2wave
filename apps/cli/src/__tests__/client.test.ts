import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockUrl = 'https://api.test'
const mockResolveUrl = vi.fn((override?: string) => override ?? mockUrl)
let mockToken = 'test-token' // HS256 default (does not trigger exchange)
const mockResolveCredential = vi.fn((_url: string) => mockToken)

vi.mock('../config.js', () => ({
  requireToken: () => mockToken,
  resolveCredential: (url: string) => mockResolveCredential(url),
  resolveUrl: (override?: string) => mockResolveUrl(override),
  loadConfig: vi.fn(),
}))

/** Build a JWT with given alg in header. The body and signature don't matter here. */
function makeJwt(alg: string, body: Record<string, unknown> = {}): string {
  const h = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url')
  const b = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${h}.${b}.signature`
}

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { ApiError, createClient } from '../client.js'

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('createClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('IDaaS JWT exchange', () => {
    afterEach(() => {
      mockToken = 'test-token' // restore default
    })

    it('uses token directly when alg=HS256 (a2wave self-signed, no exchange)', async () => {
      mockToken = makeJwt('HS256', { sub: 'usr_1' })
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))

      const client = createClient()
      await client.get('/api/skills')

      // Should only call /api/skills, not /api/auth/oauth/exchange
      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch.mock.calls[0][0]).toMatch(/\/api\/skills/)
    })

    it('exchanges first when alg=RS256 (IDaaS JWT), then calls API with new token', async () => {
      mockToken = makeJwt('RS256', { sub: 'idaas-uid', email: 'me@l.com' })
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ data: { token: 'a2w-exchanged-token' } })) // exchange
        .mockResolvedValueOnce(jsonResponse({ data: [] })) // /api/skills

      const client = createClient()
      await client.get('/api/skills')

      expect(mockFetch).toHaveBeenCalledTimes(2)
      const exchangeCall = mockFetch.mock.calls[0]
      expect(exchangeCall[0]).toMatch(/\/api\/auth\/oauth\/exchange$/)
      expect(JSON.parse(exchangeCall[1].body as string)).toMatchObject({ idaasToken: mockToken })

      const apiCall = mockFetch.mock.calls[1]
      expect(apiCall[0]).toMatch(/\/api\/skills/)
      expect((apiCall[1].headers as Record<string, string>).Authorization).toBe(
        'Bearer a2w-exchanged-token',
      )
    })

    /**
     * The server verifies OIDC tokens with any of ALLOWED_ALGS
     * (RS256/RS384/RS512/PS256/ES256/ES384). An earlier version of the CLI asked
     * `alg === 'RS256'` and treated everything else as an a2wave session token, so an IdP
     * signing with ES256 had its token sent straight to /api/* — login reported success and
     * every later command failed 401. The predicate now identifies our own HS256 session
     * instead, so adding a server-side algorithm cannot silently break the CLI again.
     */
    it.each(['RS384', 'RS512', 'PS256', 'ES256', 'ES384'])(
      'exchanges an IdP token signed with %s',
      async (alg) => {
        mockToken = makeJwt(alg, { sub: 'idaas-uid' })
        mockFetch
          .mockResolvedValueOnce(jsonResponse({ data: { token: 'a2w-exchanged-token' } }))
          .mockResolvedValueOnce(jsonResponse({ data: [] }))

        await createClient().get('/skills')

        const exchangeCall = mockFetch.mock.calls[0]
        expect(exchangeCall[0]).toMatch(/\/api\/auth\/oauth\/exchange$/)
        expect(JSON.parse(exchangeCall[1].body as string)).toMatchObject({
          idaasToken: mockToken,
        })
        expect((mockFetch.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe(
          'Bearer a2w-exchanged-token',
        )
      },
    )

    // Every token this CLI stores comes from an a2wave endpoint, so an opaque value is far
    // more likely to be a corrupted config than an IdP credential. Passing it through yields
    // a plain 401 that says so; exchanging it would report "malformed exchange response".
    it('passes an opaque (non-JWT) token through without exchanging', async () => {
      mockToken = 'opaque-not-a-jwt'
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))

      await createClient().get('/skills')

      expect(mockFetch).toHaveBeenCalledTimes(1)
      expect(mockFetch.mock.calls[0][0]).toBe('https://api.test/skills')
    })

    it('caches the exchanged token across multiple requests in one client', async () => {
      mockToken = makeJwt('RS256', { sub: 'idaas-uid' })
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ data: { token: 'cached-token' } })) // exchange (only once)
        .mockResolvedValueOnce(jsonResponse({ data: [] }))
        .mockResolvedValueOnce(jsonResponse({ data: [] }))

      const client = createClient()
      await client.get('/api/skills')
      await client.get('/api/agents')

      // 1 exchange + 2 API calls = 3 total
      expect(mockFetch).toHaveBeenCalledTimes(3)
      const exchangeCalls = mockFetch.mock.calls.filter((c) => /\/oauth\/exchange$/.test(c[0]))
      expect(exchangeCalls).toHaveLength(1)
    })

    it('gives clear error when exchange returns 503 (OAuth not enabled on server)', async () => {
      mockToken = makeJwt('RS256')
      mockFetch.mockResolvedValueOnce(new Response('OAUTH_DISABLED_BY_ADMIN', { status: 503 }))

      const client = createClient()
      await expect(client.get('/api/skills')).rejects.toThrow(/Server OAuth is not enabled/)
    })

    it('gives clear error when exchange returns 401 (IDaaS token expired)', async () => {
      mockToken = makeJwt('RS256')
      mockFetch.mockResolvedValueOnce(new Response('expired', { status: 401 }))

      const client = createClient()
      await expect(client.get('/api/skills')).rejects.toThrow(/IDaaS token expired/)
    })
  })

  describe('URL resolution', () => {
    it('passes opts.url to resolveUrl (--url override path)', () => {
      createClient({ url: 'https://from-flag.test' })
      expect(mockResolveUrl).toHaveBeenCalledWith('https://from-flag.test')
    })

    it('passes undefined to resolveUrl when no opts (env / config / default fallback)', () => {
      createClient()
      expect(mockResolveUrl).toHaveBeenCalledWith(undefined)
    })

    it('uses the URL returned by resolveUrl for outbound requests', async () => {
      mockResolveUrl.mockReturnValueOnce('https://override.test')
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
      const client = createClient({ url: 'https://override.test' })
      await client.get('/api/x')
      expect(mockFetch).toHaveBeenCalledWith('https://override.test/api/x', expect.anything())
    })

    it('propagates resolveUrl errors as-is (e.g. when no URL anywhere)', () => {
      mockResolveUrl.mockImplementationOnce(() => {
        throw new Error('No a2wave instance URL configured')
      })
      expect(() => createClient()).toThrow(/No a2wave instance URL configured/)
    })

    // The regression this pins: the credential is fetched FOR the resolved URL.
    // Previously `requireToken()` took no argument, so `--url https://other`
    // paired that host with the stored token for a different instance — leaking
    // it there and then reporting a 401 that blamed the user's login.
    it('asks for the credential belonging to the RESOLVED url', () => {
      mockResolveUrl.mockReturnValueOnce('https://override.test')
      createClient({ url: 'https://override.test' })
      expect(mockResolveCredential).toHaveBeenCalledWith('https://override.test')
    })

    it('surfaces a missing per-URL credential instead of sending the wrong one', () => {
      mockResolveUrl.mockReturnValueOnce('https://unknown.test')
      mockResolveCredential.mockImplementationOnce(() => {
        throw new Error('No stored credential for https://unknown.test')
      })
      expect(() => createClient({ url: 'https://unknown.test' })).toThrow(/No stored credential/)
    })
  })

  describe('get', () => {
    it('sends GET with Authorization header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
      const client = createClient()
      await client.get('/api/skills')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test/api/skills',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      )
    })

    it('returns parsed JSON', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'skl_1' }] }))
      const client = createClient()
      const result = await client.get<{ data: Array<{ id: string }> }>('/api/skills')
      expect(result.data).toEqual([{ id: 'skl_1' }])
    })

    it('throws ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }))
      const client = createClient()
      await expect(client.get('/api/missing')).rejects.toThrow(ApiError)
    })
  })

  // An agent recovers from a failure by branching on it, and matching prose is
  // a brittle way to do that. The status is the one thing the server always
  // states unambiguously, so it becomes the stable branch key.
  describe('ApiError classification', () => {
    async function statusOf(status: number, body = 'x'): Promise<ApiError> {
      mockFetch.mockResolvedValueOnce(new Response(body, { status }))
      const client = createClient()
      try {
        await client.get('/api/thing')
      } catch (err) {
        return err as ApiError
      }
      throw new Error(`expected HTTP ${status} to throw`)
    }

    it('maps common statuses to a stable type', async () => {
      expect((await statusOf(403)).type).toBe('permission')
      expect((await statusOf(404)).type).toBe('not_found')
      expect((await statusOf(409)).type).toBe('conflict')
      expect((await statusOf(422)).type).toBe('validation')
      expect((await statusOf(429)).type).toBe('rate_limit')
      expect((await statusOf(500)).type).toBe('server')
      expect((await statusOf(503)).type).toBe('server')
    })

    it('carries the numeric status as the subtype', async () => {
      expect((await statusOf(404)).subtype).toBe('404')
    })

    it('keeps the status and body in the message', async () => {
      const err = await statusOf(404, 'Agent not found')
      expect(err.message).toContain('404')
      expect(err.message).toContain('Agent not found')
    })

    it('caps an oversized body instead of dumping it whole', async () => {
      // A 5xx can answer with a full HTML error page. Untruncated, that lands
      // in a terminal, a CI log, or an agent's context window.
      const err = await statusOf(500, 'E'.repeat(9000))
      expect(err.message.length).toBeLessThan(3000)
      expect(err.message).toContain('truncated')
    })

    it('leaves a short body untouched', async () => {
      const err = await statusOf(400, 'name is required')
      expect(err.message).toContain('name is required')
      expect(err.message).not.toContain('truncated')
    })
  })

  describe('getRaw', () => {
    afterEach(() => {
      mockToken = 'test-token'
    })

    // P1 regression: export used to read client.config.token synchronously; right after
    // an OAuth login, the first ID-based call still held the IDaaS RS256 JWT and always 401'd.
    // getRaw goes through the unified path, which triggers the exchange.
    it('triggers IDaaS exchange before fetching when token is RS256 (no prior request)', async () => {
      mockToken = makeJwt('RS256', { sub: 'idaas-uid' })
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ data: { token: 'a2w-exchanged' } }))
        .mockResolvedValueOnce(new Response('zip-bytes', { status: 200 }))

      const client = createClient()
      const res = await client.getRaw('/api/agents/agt_x/export')

      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(mockFetch.mock.calls[0][0]).toMatch(/\/api\/auth\/oauth\/exchange$/)
      expect(mockFetch.mock.calls[1][0]).toMatch(/\/api\/agents\/agt_x\/export$/)
      expect((mockFetch.mock.calls[1][1].headers as Record<string, string>).Authorization).toBe(
        'Bearer a2w-exchanged',
      )
      expect(await res.text()).toBe('zip-bytes')
    })

    it('returns the raw Response (does not parse JSON)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('binary-payload', {
          status: 200,
          headers: { 'content-disposition': 'attachment; filename="agt.zip"' },
        }),
      )
      const client = createClient()
      const res = await client.getRaw('/api/agents/agt_x/export')

      expect(res.headers.get('content-disposition')).toBe('attachment; filename="agt.zip"')
      expect(await res.arrayBuffer()).toEqual(new TextEncoder().encode('binary-payload').buffer)
    })

    it('throws ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }))
      const client = createClient()
      await expect(client.getRaw('/api/agents/missing/export')).rejects.toThrow(ApiError)
    })
  })

  describe('post', () => {
    it('sends POST with JSON body and correct headers', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'run_1' } }))
      const client = createClient()
      await client.post('/api/runs', { intent: 'hello' })

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test/api/runs',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ intent: 'hello' }),
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token',
          }),
        }),
      )
    })
  })

  describe('patch', () => {
    it('sends PATCH with JSON body', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: {} }))
      const client = createClient()
      await client.patch('/api/skills/skl_1', { name: 'updated' })

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test/api/skills/skl_1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ name: 'updated' }),
        }),
      )
    })
  })

  describe('post error handling', () => {
    it('throws ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('bad request', { status: 400 }))
      const client = createClient()
      await expect(client.post('/api/runs', {})).rejects.toThrow(ApiError)
    })

    it('returns parsed JSON on success', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'run_1' } }))
      const client = createClient()
      const result = await client.post<{ data: { id: string } }>('/api/runs', { intent: 'hi' })
      expect(result.data.id).toBe('run_1')
    })
  })

  describe('patch error handling', () => {
    it('throws ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }))
      const client = createClient()
      await expect(client.patch('/api/skills/skl_1', {})).rejects.toThrow(ApiError)
    })
  })

  describe('postStream', () => {
    it('sends POST and returns raw Response on success', async () => {
      const streamResponse = new Response('stream data', { status: 200 })
      mockFetch.mockResolvedValueOnce(streamResponse)
      const client = createClient()
      const res = await client.postStream('/api/runs/run_1/execute', { stream: true })

      expect(res).toBeInstanceOf(Response)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test/api/runs/run_1/execute',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ stream: true }),
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      )
    })

    it('throws ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('server error', { status: 500 }))
      const client = createClient()
      await expect(client.postStream('/api/runs/run_1/execute', {})).rejects.toThrow(ApiError)
    })
  })

  describe('postFormData', () => {
    it('sends POST with FormData and returns parsed JSON', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { id: 'skl_1' } }))
      const client = createClient()
      const formData = new FormData()
      formData.append('file', new Blob(['test']), 'test.md')
      const result = await client.postFormData<{ data: { id: string } }>(
        '/api/skills/skl_1/reupload',
        formData,
      )

      expect(result.data.id).toBe('skl_1')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test/api/skills/skl_1/reupload',
        expect.objectContaining({
          method: 'POST',
          body: formData,
        }),
      )
    })

    it('throws ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('error', { status: 400 }))
      const client = createClient()
      const formData = new FormData()
      await expect(client.postFormData('/api/skills/skl_1/reupload', formData)).rejects.toThrow(
        ApiError,
      )
    })
  })

  describe('401 handling', () => {
    it('throws CliError on 401 response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
      const client = createClient()
      await expect(client.get('/api/agents')).rejects.toThrow('Session expired or invalid')
    })
  })

  describe('resolveSkillId', () => {
    it('returns ID directly if prefixed with skl_', async () => {
      const client = createClient()
      const id = await client.resolveSkillId('skl_abc')
      expect(id).toBe('skl_abc')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('queries API and matches by name', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'skl_1', name: 'My Skill' },
            { id: 'skl_2', name: 'Other' },
          ],
        }),
      )
      const client = createClient()
      const id = await client.resolveSkillId('My Skill')
      expect(id).toBe('skl_1')
    })

    it('throws when skill name not found', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
      const client = createClient()
      await expect(client.resolveSkillId('Nope')).rejects.toThrow('Skill not found: "Nope"')
    })

    it('throws (does not silently pick first) when the name is ambiguous', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'skl_1', name: 'Dup' },
            { id: 'skl_2', name: 'Dup' },
          ],
        }),
      )
      const client = createClient()
      await expect(client.resolveSkillId('Dup')).rejects.toThrow(/matches multiple/)
    })

    it('warns when result count hits pageSize limit', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const items = Array.from({ length: 100 }, (_, i) => ({ id: `skl_${i}`, name: `Skill ${i}` }))
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: items }))
      const client = createClient()
      await client.resolveSkillId('Skill 0')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('100'))
      warnSpy.mockRestore()
    })
  })

  describe('resolveAgentId', () => {
    it('returns ID directly if prefixed with agt_', async () => {
      const client = createClient()
      const id = await client.resolveAgentId('agt_xyz')
      expect(id).toBe('agt_xyz')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('queries API and matches by name', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'agt_1', name: 'Test Agent' }] }))
      const client = createClient()
      const id = await client.resolveAgentId('Test Agent')
      expect(id).toBe('agt_1')
    })

    it('throws when agent name not found', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
      const client = createClient()
      await expect(client.resolveAgentId('Missing')).rejects.toThrow('Agent not found: "Missing"')
    })

    it('throws (does not silently pick first) when the name is ambiguous', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'agt_1', name: 'Dup' },
            { id: 'agt_2', name: 'Dup' },
          ],
        }),
      )
      const client = createClient()
      await expect(client.resolveAgentId('Dup')).rejects.toThrow(/matches multiple/)
    })
  })

  describe('resolveMcpServerId', () => {
    it('returns ID directly if prefixed with mcp_', async () => {
      const client = createClient()
      const id = await client.resolveMcpServerId('mcp_abc')
      expect(id).toBe('mcp_abc')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('queries API and matches by name', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'mcp_1', name: 'My MCP' },
            { id: 'mcp_2', name: 'Other' },
          ],
        }),
      )
      const client = createClient()
      const id = await client.resolveMcpServerId('My MCP')
      expect(id).toBe('mcp_1')
    })

    it('throws when MCP server name not found', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
      const client = createClient()
      await expect(client.resolveMcpServerId('Nope')).rejects.toThrow(
        'MCP Server not found: "Nope"',
      )
    })
  })

  describe('resolveProviderId', () => {
    it('returns ID directly if prefixed with prv_', async () => {
      const client = createClient()
      const id = await client.resolveProviderId('prv_abc')
      expect(id).toBe('prv_abc')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('queries API and matches by name', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'prv_1', name: 'Claude Code' },
            { id: 'prv_2', name: 'Codex' },
          ],
        }),
      )
      const client = createClient()
      const id = await client.resolveProviderId('Claude Code')
      expect(id).toBe('prv_1')
    })

    it('throws with available list when not found', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'prv_1', name: 'Claude Code' }] }),
      )
      const client = createClient()
      await expect(client.resolveProviderId('Nope')).rejects.toThrow(/Claude Code/)
    })
  })

  describe('resolveScmSourceId', () => {
    it('returns ID directly if prefixed with scm_', async () => {
      const client = createClient()
      const id = await client.resolveScmSourceId('scm_abc')
      expect(id).toBe('scm_abc')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('queries API and matches by name', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'scm_1', name: 'my-repo' }] }))
      const client = createClient()
      const id = await client.resolveScmSourceId('my-repo')
      expect(id).toBe('scm_1')
    })

    it('throws when not found', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
      const client = createClient()
      await expect(client.resolveScmSourceId('ghost')).rejects.toThrow(/SCM Source not found/)
    })
  })

  describe('resolveSkillGroupId', () => {
    it('returns ID directly if prefixed with skg_', async () => {
      const client = createClient()
      const id = await client.resolveSkillGroupId('skg_abc')
      expect(id).toBe('skg_abc')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('queries API and matches by name', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 'skg_1', name: 'feishu-tools' }] }),
      )
      const client = createClient()
      const id = await client.resolveSkillGroupId('feishu-tools')
      expect(id).toBe('skg_1')
    })

    it('throws when not found', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
      const client = createClient()
      await expect(client.resolveSkillGroupId('ghost')).rejects.toThrow(/Skill Group not found/)
    })
  })

  describe('resolveKbDocumentId', () => {
    it('returns ID directly if prefixed with kbd_', async () => {
      const client = createClient()
      const id = await client.resolveKbDocumentId('kbd_abc')
      expect(id).toBe('kbd_abc')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('queries API and matches by name', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'kbd_1', name: 'FAQ' }] }))
      const client = createClient()
      const id = await client.resolveKbDocumentId('FAQ')
      expect(id).toBe('kbd_1')
    })

    it('throws when not found', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
      const client = createClient()
      await expect(client.resolveKbDocumentId('ghost')).rejects.toThrow(/KB Document not found/)
    })
  })

  describe('resolveUserId', () => {
    it('returns ID directly if prefixed with usr_ (no HTTP call)', async () => {
      const client = createClient()
      const id = await client.resolveUserId('usr_abc')
      expect(id).toBe('usr_abc')
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it('queries /api/user-lookup with encoded q and limit=10', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: 'usr_1', username: 'alice', displayName: 'Alice', email: 'a@x.com' }],
        }),
      )
      const client = createClient()
      const id = await client.resolveUserId('alice@x.com')
      expect(id).toBe('usr_1')
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/api\/user-lookup\?q=alice%40x\.com&limit=10$/),
        expect.anything(),
      )
    })

    it('throws when no match', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }))
      const client = createClient()
      await expect(client.resolveUserId('ghost')).rejects.toThrow('User not found: ghost')
    })

    it('throws and lists candidates when multiple matches', async () => {
      const multi = {
        data: [
          { id: 'usr_1', username: 'alice', displayName: 'Alice', email: 'a@x.com' },
          { id: 'usr_2', username: 'alicia', displayName: null, email: null },
        ],
      }
      mockFetch
        .mockResolvedValueOnce(jsonResponse(multi))
        .mockResolvedValueOnce(jsonResponse(multi))
      const client = createClient()
      await expect(client.resolveUserId('ali')).rejects.toThrow(/Multiple users matched/)
      await expect(client.resolveUserId('ali')).rejects.toThrow(/usr_1/)
    })
  })

  describe('del', () => {
    it('sends DELETE with Authorization header and parses JSON', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: { removed: true, userId: 'usr_1' } }))
      const client = createClient()
      const result = await client.del<{ data: { removed: boolean; userId: string } }>(
        '/api/agents/agt_1/members/usr_1',
      )

      expect(result.data).toEqual({ removed: true, userId: 'usr_1' })
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.test/api/agents/agt_1/members/usr_1',
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
          }),
        }),
      )
    })

    it('throws ApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }))
      const client = createClient()
      await expect(client.del('/api/agents/agt_1/members/usr_x')).rejects.toThrow(ApiError)
    })
  })

  describe('findAgentByName', () => {
    it('returns null when no match', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'agt_x', name: 'Other' }] }))
      const client = createClient()
      const result = await client.findAgentByName('my-bot')
      expect(result).toBeNull()
    })

    it('returns the agent when single match', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'agt_x', name: 'my-bot' }] }))
      const client = createClient()
      const result = await client.findAgentByName('my-bot')
      expect(result).toEqual({ id: 'agt_x', name: 'my-bot' })
    })

    it('throws on duplicate names', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          data: [
            { id: 'agt_a', name: 'my-bot' },
            { id: 'agt_b', name: 'my-bot' },
          ],
        }),
      )
      const client = createClient()
      await expect(client.findAgentByName('my-bot')).rejects.toThrow(/Name conflict/)
    })
  })
})
