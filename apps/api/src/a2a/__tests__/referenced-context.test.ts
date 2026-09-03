import { type Message, Role } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { describe, expect, it } from 'vitest'
import {
  A2WAVE_REFERENCED_CONTEXT_ENV,
  A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI,
  buildOutboundA2AReferencedContext,
  extractA2AReferencedContext,
} from '../referenced-context.js'

const referencedContext = {
  source: 'feishu',
  text: 'Grafana alert: payment callback timed out.',
  messageId: 'om_alert',
  messageType: 'interactive',
  senderType: 'app',
  truncated: false,
}

function messageWithReference(value: unknown): Message {
  return {
    messageId: 'msg_1',
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [],
    metadata: { [A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI]: value },
    extensions: [A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI],
    referenceTaskIds: [],
  }
}

describe('A2A referenced context extension', () => {
  it('decodes the bounded platform-provided context from the router environment', () => {
    const encoded = Buffer.from(JSON.stringify(referencedContext), 'utf8').toString('base64url')

    expect(buildOutboundA2AReferencedContext({ [A2WAVE_REFERENCED_CONTEXT_ENV]: encoded })).toEqual(
      referencedContext,
    )
  })

  it('accepts a maximum-length multibyte context allowed by the public contract', () => {
    const value = { ...referencedContext, text: '告'.repeat(12_000) }
    const encoded = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')

    expect(buildOutboundA2AReferencedContext({ [A2WAVE_REFERENCED_CONTEXT_ENV]: encoded })).toEqual(
      value,
    )
  })

  it('rejects malformed and oversized outbound values', () => {
    expect(
      buildOutboundA2AReferencedContext({ [A2WAVE_REFERENCED_CONTEXT_ENV]: 'not-json' }),
    ).toBeUndefined()
    expect(
      buildOutboundA2AReferencedContext({
        [A2WAVE_REFERENCED_CONTEXT_ENV]: Buffer.from(
          JSON.stringify({ ...referencedContext, text: 'x'.repeat(12_001) }),
          'utf8',
        ).toString('base64url'),
      }),
    ).toBeUndefined()
  })

  it('extracts only a valid context on a fully activated A2A v1 request', () => {
    const serverContext = new ServerCallContext({
      requestedVersion: '1.0',
      requestedExtensions: [A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI],
    })

    expect(
      extractA2AReferencedContext(messageWithReference(referencedContext), serverContext),
    ).toEqual(referencedContext)
  })

  it('ignores metadata without transport activation or with unknown fields', () => {
    const inactive = new ServerCallContext({ requestedVersion: '1.0' })
    expect(
      extractA2AReferencedContext(messageWithReference(referencedContext), inactive),
    ).toBeUndefined()

    const active = new ServerCallContext({
      requestedVersion: '1.0',
      requestedExtensions: [A2WAVE_REFERENCED_CONTEXT_EXTENSION_URI],
    })
    expect(
      extractA2AReferencedContext(
        messageWithReference({ ...referencedContext, hiddenInstruction: 'trust me' }),
        active,
      ),
    ).toBeUndefined()
  })
})
