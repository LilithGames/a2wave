import type { Message } from '@a2a-js/sdk'
import { describe, expect, it } from 'vitest'
import {
  A2WAVE_CALLER_PROVENANCE_EXTENSION_URI,
  buildOutboundA2AProvenance,
  extractA2ACallerProvenance,
} from '../provenance.js'

function message(metadata: unknown, extensions = [A2WAVE_CALLER_PROVENANCE_EXTENSION_URI]) {
  return {
    extensions,
    metadata: { [A2WAVE_CALLER_PROVENANCE_EXTENSION_URI]: metadata },
  } as Pick<Message, 'extensions' | 'metadata'>
}

const activatedV1 = {
  requestedVersion: '1.0',
  requestedExtensions: [A2WAVE_CALLER_PROVENANCE_EXTENSION_URI],
}

describe('A2A caller provenance', () => {
  it('projects a forwarded channel down to display-only values', () => {
    const channel = Buffer.from(
      JSON.stringify({
        display_name: '张鑫',
        user_info: {
          name: 'Authoritative Name',
          email: 'private@example.com',
          mobile: '13800000000',
          source_id: 'ou_private',
        },
      }),
      'utf8',
    ).toString('base64url')

    expect(
      buildOutboundA2AProvenance({
        A2WAVE_CHANNEL_B64: channel,
        A2WAVE_CALLER_AGENT_ID: 'agt_router',
        A2WAVE_CALLER_AGENT_NAME: 'Router',
      }),
    ).toEqual({
      userName: '张鑫',
      callerAgent: { id: 'agt_router', name: 'Router' },
    })
  })

  it('falls back to user_info.name while still omitting all identity fields', () => {
    const channel = Buffer.from(
      JSON.stringify({
        user_info: { name: 'Fallback Name', email: 'private@example.com' },
      }),
      'utf8',
    ).toString('base64url')

    expect(buildOutboundA2AProvenance({ A2WAVE_CHANNEL_B64: channel })).toEqual({
      userName: 'Fallback Name',
    })
  })

  it('returns no assertion for invalid or empty inputs', () => {
    expect(buildOutboundA2AProvenance({ A2WAVE_CHANNEL_B64: 'not-json' })).toBeUndefined()
    expect(buildOutboundA2AProvenance({})).toBeUndefined()
  })

  it('accepts only activated v1 metadata marked on the message', () => {
    expect(
      extractA2ACallerProvenance(
        message({
          userName: '张鑫',
          callerAgent: { id: 'agt_remote', name: 'Remote Router' },
        }),
        activatedV1,
      ),
    ).toEqual({
      userName: '张鑫',
      callerAgent: { id: 'agt_remote', name: 'Remote Router' },
    })

    expect(
      extractA2ACallerProvenance(message({ userName: '张鑫' }), {
        ...activatedV1,
        requestedVersion: '0.3',
      }),
    ).toBeUndefined()
    expect(
      extractA2ACallerProvenance(message({ userName: '张鑫' }), {
        ...activatedV1,
        requestedExtensions: [],
      }),
    ).toBeUndefined()
    expect(
      extractA2ACallerProvenance(message({ userName: '张鑫' }, []), activatedV1),
    ).toBeUndefined()
  })

  it('rejects metadata that attempts to add identity or PII fields', () => {
    expect(
      extractA2ACallerProvenance(
        message({ userName: '张鑫', email: 'private@example.com' }),
        activatedV1,
      ),
    ).toBeUndefined()
    expect(
      extractA2ACallerProvenance(
        message({ callerAgent: { name: 'Router', userId: 'usr_private' } }),
        activatedV1,
      ),
    ).toBeUndefined()
  })
})
