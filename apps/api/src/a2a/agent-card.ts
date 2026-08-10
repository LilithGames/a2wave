import { AgentCard } from '@a2a-js/sdk'
import { type A2ASkill, ATTACHMENT_MIME_TYPES } from '@a2wave/shared'
import { normalizeAuthType } from '../middleware/gateway-auth.js'
import { A2WAVE_CALLER_PROVENANCE_EXTENSION_URI } from './provenance.js'

export interface AgentLike {
  id: string
  name: string
  description: string | null | undefined
  publishDescription: string | null | undefined
  a2aAuthType: string | null | undefined
  a2aSkills: A2ASkill[] | null | undefined
}

export function buildAgentCard(agent: AgentLike, baseUrl: string): AgentCard {
  const authType = normalizeAuthType(agent.a2aAuthType)
  const endpointUrl = `${baseUrl}/api/a2a/${agent.id}`

  return AgentCard.fromJSON({
    name: agent.name,
    description: agent.publishDescription ?? agent.description ?? '',
    version: '1.0.0',
    supportedInterfaces: [
      {
        url: endpointUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
        tenant: '',
      },
      {
        url: endpointUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: '0.3',
        tenant: '',
      },
    ],
    capabilities: {
      streaming: true,
      extensions: [
        {
          uri: A2WAVE_CALLER_PROVENANCE_EXTENSION_URI,
          description:
            'Carries audit-only original user and immediate caller Agent display names across A2A hops.',
          required: false,
          params: { metadataKey: A2WAVE_CALLER_PROVENANCE_EXTENSION_URI },
        },
      ],
    },
    defaultInputModes: ['text/plain', ...ATTACHMENT_MIME_TYPES],
    defaultOutputModes: ['text/plain'],
    provider: { organization: 'a2wave', url: baseUrl },
    ...(authType === 'api_key' && {
      securitySchemes: {
        bearerAuth: {
          httpAuthSecurityScheme: {
            scheme: 'Bearer',
          },
        },
      },
      securityRequirements: [{ schemes: { bearerAuth: { list: [] } } }],
    }),
    skills: (agent.a2aSkills ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      tags: s.tags,
    })),
    signatures: [],
  })
}

/** Convert the SDK model to the requested protocol's Agent Card wire shape. */
export function serializeAgentCard(
  card: AgentCard,
  protocolVersion: '1.0' | '0.3' = '1.0',
): Record<string, unknown> {
  if (protocolVersion === '1.0') {
    return AgentCard.toJSON(card) as Record<string, unknown>
  }

  const legacyInterface = card.supportedInterfaces.find(
    (candidate) =>
      candidate.protocolBinding === 'JSONRPC' && candidate.protocolVersion.startsWith('0.3'),
  )
  if (!legacyInterface) {
    throw new Error('Agent Card does not advertise a JSON-RPC v0.3 interface')
  }

  const securitySchemes = Object.fromEntries(
    Object.entries(card.securitySchemes).flatMap(([name, scheme]) => {
      if (scheme.scheme?.$case !== 'httpAuthSecurityScheme') return []
      return [
        [
          name,
          {
            type: 'http',
            scheme: scheme.scheme.value.scheme,
            ...(scheme.scheme.value.bearerFormat
              ? { bearerFormat: scheme.scheme.value.bearerFormat }
              : {}),
          },
        ],
      ]
    }),
  )
  const security = card.securityRequirements.map((requirement) =>
    Object.fromEntries(
      Object.entries(requirement.schemes).map(([name, scopes]) => [name, scopes.list]),
    ),
  )

  return {
    name: card.name,
    description: card.description,
    url: legacyInterface.url,
    version: card.version,
    protocolVersion: '0.3.0',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: card.capabilities?.streaming ?? false },
    defaultInputModes: card.defaultInputModes,
    defaultOutputModes: card.defaultOutputModes,
    ...(card.provider ? { provider: card.provider } : {}),
    ...(Object.keys(securitySchemes).length > 0 ? { securitySchemes } : {}),
    ...(security.length > 0 ? { security } : {}),
    skills: card.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      tags: skill.tags,
      ...(skill.examples.length > 0 ? { examples: skill.examples } : {}),
      ...(skill.inputModes.length > 0 ? { inputModes: skill.inputModes } : {}),
      ...(skill.outputModes.length > 0 ? { outputModes: skill.outputModes } : {}),
    })),
  }
}
