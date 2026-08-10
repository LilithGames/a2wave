import { DefaultAgentCardResolver } from '@a2a-js/sdk/client'
import { ATTACHMENT_MIME_TYPES } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import { buildAgentCard, serializeAgentCard } from '../agent-card.js'
import { A2WAVE_CALLER_PROVENANCE_EXTENSION_URI } from '../provenance.js'

const BASE_URL = 'https://example.com'

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agt_123',
    name: 'Test Agent',
    description: 'A test agent',
    publishDescription: 'Published description',
    a2aAuthType: 'none',
    a2aSkills: [{ id: 'skl_1', name: 'Skill One', description: 'First skill', tags: ['tag1'] }],
    ...overrides,
  }
}

describe('buildAgentCard', () => {
  it('advertises standard JSON-RPC v1.0 with an explicit v0.3 compatibility interface', () => {
    const card = buildAgentCard(makeAgent(), BASE_URL)

    expect(card.name).toBe('Test Agent')
    expect(card.description).toBe('Published description')
    expect(card.version).toBe('1.0.0')
    expect(card.supportedInterfaces).toEqual([
      {
        url: 'https://example.com/api/a2a/agt_123',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: '',
      },
      {
        url: 'https://example.com/api/a2a/agt_123',
        protocolBinding: 'JSONRPC',
        protocolVersion: '0.3',
        tenant: '',
      },
    ])
    expect(card.capabilities).toEqual({
      streaming: true,
      extensions: [
        {
          uri: A2WAVE_CALLER_PROVENANCE_EXTENSION_URI,
          description:
            'Carries audit-only original user and immediate caller Agent display names across A2A hops.',
          required: false,
          params: {
            metadataKey: A2WAVE_CALLER_PROVENANCE_EXTENSION_URI,
          },
        },
      ],
    })
    expect(card.defaultInputModes).toEqual(['text/plain', ...ATTACHMENT_MIME_TYPES])
    expect(card.defaultOutputModes).toEqual(['text/plain'])
    expect(card.provider).toEqual({ organization: 'a2wave', url: BASE_URL })
    expect(card.skills).toHaveLength(1)
  })

  it('serializes the protobuf-backed model to the standard JSON card shape', () => {
    const wireCard = serializeAgentCard(buildAgentCard(makeAgent(), BASE_URL))

    expect(wireCard.supportedInterfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ protocolBinding: 'JSONRPC', protocolVersion: '1.0' }),
      ]),
    )
    expect(wireCard).not.toHaveProperty('url')
    expect(wireCard).not.toHaveProperty('protocolVersion')
  })

  it('serializes a v0.3 card for legacy discovery clients', () => {
    const wireCard = serializeAgentCard(buildAgentCard(makeAgent(), BASE_URL), '0.3')

    expect(wireCard).toMatchObject({
      url: 'https://example.com/api/a2a/agt_123',
      protocolVersion: '0.3.0',
      preferredTransport: 'JSONRPC',
      capabilities: { streaming: true },
    })
    expect(wireCard).not.toHaveProperty('supportedInterfaces')
  })

  it('produces a v0.3 card accepted by the official legacy-compatible resolver', async () => {
    const wireCard = serializeAgentCard(buildAgentCard(makeAgent(), BASE_URL), '0.3')
    const resolver = new DefaultAgentCardResolver({
      legacyCompat: { enabled: true },
      fetchImpl: async () => Response.json(wireCard),
    })

    const resolved = await resolver.resolve('https://example.com')

    expect(resolved.supportedInterfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          protocolBinding: 'JSONRPC',
          protocolVersion: '0.3.0',
        }),
      ]),
    )
  })

  it('maps A2A skills and fills the v1-required collection fields', () => {
    const card = buildAgentCard(
      makeAgent({
        a2aSkills: [
          { id: 'skl_a', name: 'Alpha', description: 'Alpha skill', tags: ['alpha'] },
          { id: 'skl_b', name: 'Beta', description: 'Beta skill', tags: [] },
        ],
      }),
      BASE_URL,
    )

    expect(card.skills).toEqual([
      {
        id: 'skl_a',
        name: 'Alpha',
        description: 'Alpha skill',
        tags: ['alpha'],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
      {
        id: 'skl_b',
        name: 'Beta',
        description: 'Beta skill',
        tags: [],
        examples: [],
        inputModes: [],
        outputModes: [],
        securityRequirements: [],
      },
    ])
  })

  it('uses an empty skills array and description fallback when optional fields are absent', () => {
    const card = buildAgentCard(
      makeAgent({ publishDescription: null, description: null, a2aSkills: null }),
      BASE_URL,
    )

    expect(card.description).toBe('')
    expect(card.skills).toEqual([])
  })

  it('uses the independent A2A auth setting for bearer security', () => {
    const wireCard = serializeAgentCard(
      buildAgentCard(makeAgent({ a2aAuthType: 'api_key' }), BASE_URL),
    )

    expect(wireCard.securitySchemes).toEqual({
      bearerAuth: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
    })
    expect(wireCard.securityRequirements).toEqual([{ schemes: { bearerAuth: {} } }])
  })

  it('fails closed for null and unknown A2A auth values', () => {
    for (const a2aAuthType of [null, 'mystery']) {
      const wireCard = serializeAgentCard(buildAgentCard(makeAgent({ a2aAuthType }), BASE_URL))
      expect(wireCard.securitySchemes).toHaveProperty('bearerAuth')
    }
  })

  it('does not advertise bearer auth for public or legacy OAuth values', () => {
    for (const a2aAuthType of ['none', 'oauth']) {
      const wireCard = serializeAgentCard(buildAgentCard(makeAgent({ a2aAuthType }), BASE_URL))
      expect(wireCard.securitySchemes).toBeUndefined()
      expect(wireCard.securityRequirements).toBeUndefined()
    }
  })
})
