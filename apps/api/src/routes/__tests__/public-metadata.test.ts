import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}))

vi.mock('../../db/schema.js', () => ({
  agents: {
    id: 'agents.id',
    name: 'agents.name',
    description: 'agents.description',
    publishStatus: 'agents.publishStatus',
    publishChannels: 'agents.publishChannels',
    oauthAccessMode: 'agents.oauthAccessMode',
  },
}))

const isOauthChannelConfigured = vi.fn()
vi.mock('../../lib/oidc.js', () => ({
  isOauthChannelConfigured: () => isOauthChannelConfigured(),
}))

import { db } from '../../db/client.js'

import { asyncQuery } from '../../test/async-query.js'

function selectChain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          all: vi.fn().mockReturnValue(rows),
        }),
      ),
    }),
  }
}

describe('Public metadata routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    isOauthChannelConfigured.mockResolvedValue(true)
    const mod = await import('../public-metadata.js')
    app = new Hono()
    app.route('/api/public', mod.default)
  })

  it('returns public metadata for published agents in request order', async () => {
    ;(db.select as Mock).mockReturnValue(
      selectChain([
        {
          id: 'agt_2',
          name: 'Agent Two',
          description: null,
          publishStatus: 'published',
          publishChannels: ['api'],
          oauthAccessMode: 'all_idaas_users',
        },
        {
          id: 'agt_1',
          name: 'Agent One',
          description: 'Internal config description',
          publishStatus: 'published',
          publishChannels: ['api', 'oauth'],
          oauthAccessMode: 'all_idaas_users',
        },
      ]),
    )

    const res = await app.request('/api/public/agents/metadata?agentIds=agt_1,agt_2')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        {
          agentId: 'agt_1',
          exists: true,
          metadata: {
            name: 'Agent One',
            description: 'Internal config description',
            oauthEnabled: true,
            oauthAccessMode: 'all_idaas_users',
          },
        },
        {
          agentId: 'agt_2',
          exists: true,
          metadata: {
            name: 'Agent Two',
            description: '',
            oauthEnabled: false,
            oauthAccessMode: 'all_idaas_users',
          },
        },
      ],
    })
  })

  it('supports agentId as a single-id alias', async () => {
    ;(db.select as Mock).mockReturnValue(
      selectChain([
        {
          id: 'agt_1',
          name: 'Agent One',
          description: 'desc',
          publishStatus: 'published',
          publishChannels: ['oauth'],
          oauthAccessMode: null,
        },
      ]),
    )

    const res = await app.request('/api/public/agents/metadata?agentId=agt_1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        {
          agentId: 'agt_1',
          exists: true,
          metadata: {
            name: 'Agent One',
            description: 'desc',
            oauthEnabled: true,
            oauthAccessMode: 'all_idaas_users',
          },
        },
      ],
    })
  })

  it('reports OAuth as disabled when the platform channel is not configured', async () => {
    isOauthChannelConfigured.mockResolvedValue(false)
    ;(db.select as Mock).mockReturnValue(
      selectChain([
        {
          id: 'agt_1',
          name: 'Agent One',
          description: 'desc',
          publishStatus: 'published',
          publishChannels: ['oauth'],
          oauthAccessMode: 'all_idaas_users',
        },
      ]),
    )

    const res = await app.request('/api/public/agents/metadata?agentId=agt_1')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        {
          agentId: 'agt_1',
          exists: true,
          metadata: {
            name: 'Agent One',
            description: 'desc',
            oauthEnabled: false,
            oauthAccessMode: 'all_idaas_users',
          },
        },
      ],
    })
    expect(isOauthChannelConfigured).toHaveBeenCalledTimes(1)
  })

  it('hides missing, draft, and stopped agents behind exists=false', async () => {
    ;(db.select as Mock).mockReturnValue(
      selectChain([
        {
          id: 'agt_draft',
          name: 'Draft',
          description: 'draft',
          publishStatus: 'draft',
          publishChannels: ['oauth'],
          oauthAccessMode: 'all_idaas_users',
        },
        {
          id: 'agt_stopped',
          name: 'Stopped',
          description: 'stopped',
          publishStatus: 'stopped',
          publishChannels: ['oauth'],
          oauthAccessMode: 'all_idaas_users',
        },
      ]),
    )

    const res = await app.request(
      '/api/public/agents/metadata?agentIds=agt_missing,agt_draft,agt_stopped',
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [
        { agentId: 'agt_missing', exists: false, metadata: null },
        { agentId: 'agt_draft', exists: false, metadata: null },
        { agentId: 'agt_stopped', exists: false, metadata: null },
      ],
    })
  })

  it('rejects missing or excessive IDs', async () => {
    const missing = await app.request('/api/public/agents/metadata')
    expect(missing.status).toBe(400)

    const ids = Array.from({ length: 51 }, (_, i) => `agt_${i}`).join(',')
    const excessive = await app.request(`/api/public/agents/metadata?agentIds=${ids}`)
    expect(excessive.status).toBe(400)
  })
})
