import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type RouteTarget, listAgentsHandler } from '../a2wave-agent-router.js'

beforeEach(() => {
  vi.restoreAllMocks()
})

function mockFetch(response: {
  ok: boolean
  status?: number
  body?: unknown
  contentType?: string
}) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: () => Promise.resolve(response.body),
    text: () =>
      Promise.resolve(
        typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? ''),
      ),
    headers: new Headers({ 'content-type': response.contentType ?? 'application/json' }),
  }) as unknown as typeof fetch
}

describe('listAgentsHandler', () => {
  it('returns all agents when targets is null (legacy mode)', async () => {
    const agents = [
      {
        id: 'agt_1',
        name: 'Agent A',
        description: 'desc',
        publishDescription: null,
        a2aSkills: [],
      },
    ]
    mockFetch({ ok: true, body: { data: agents } })

    const result = await listAgentsHandler(null)

    expect(JSON.parse(result.content[0].text)).toEqual(agents)
  })

  it('returns empty array when no agents in legacy mode', async () => {
    mockFetch({ ok: true, body: { data: [] } })

    const result = await listAgentsHandler(null)

    expect(JSON.parse(result.content[0].text)).toEqual([])
  })

  it('throws on fetch failure in legacy mode', async () => {
    mockFetch({ ok: false, status: 500, body: 'Internal error' })

    await expect(listAgentsHandler(null)).rejects.toThrow('HTTP 500')
  })

  it('returns empty list when routeTargets is empty array', async () => {
    const result = await listAgentsHandler([])

    expect(JSON.parse(result.content[0].text)).toEqual([])
  })

  it('filters local agents by configured agentId and passes ids param', async () => {
    mockFetch({
      ok: true,
      body: {
        data: [
          { id: 'agt_1', name: 'Agent A' },
          { id: 'agt_3', name: 'Agent C' },
        ],
      },
    })
    const targets: RouteTarget[] = [
      { type: 'local', agentId: 'agt_1' },
      { type: 'local', agentId: 'agt_3' },
    ]

    const result = await listAgentsHandler(targets)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.map((agent: { id: string }) => agent.id)).toEqual(['agt_1', 'agt_3'])
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[0]).toContain('/api/internal/agents?ids=agt_1,agt_3')
  })

  it('includes remote agents with remote: prefix ID', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'external-qa',
        url: 'https://qa.example.com/a2a',
        description: 'QA Bot',
      },
    ]

    const result = await listAgentsHandler(targets)

    expect(JSON.parse(result.content[0].text)).toEqual([
      {
        id: 'remote:external-qa',
        name: 'external-qa',
        description: 'QA Bot',
        type: 'remote',
      },
    ])
  })

  it('combines local and remote agents', async () => {
    mockFetch({ ok: true, body: { data: [{ id: 'agt_1', name: 'Agent A' }] } })
    const targets: RouteTarget[] = [
      { type: 'local', agentId: 'agt_1' },
      {
        type: 'remote',
        name: 'remote-bot',
        url: 'https://remote.example.com',
        description: 'Remote',
      },
    ]

    const result = await listAgentsHandler(targets)

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.map((agent: { id: string }) => agent.id)).toEqual(['agt_1', 'remote:remote-bot'])
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[0]).toContain('/api/internal/agents?ids=agt_1')
  })

  it('does not fetch from API when only remote targets configured', async () => {
    const targets: RouteTarget[] = [{ type: 'remote', name: 'bot', url: 'https://example.com' }]
    const spy = vi.fn()
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await listAgentsHandler(targets)

    expect(spy).not.toHaveBeenCalled()
    expect(JSON.parse(result.content[0].text)).toHaveLength(1)
  })
})
