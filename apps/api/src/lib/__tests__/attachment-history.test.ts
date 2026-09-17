import { describe, expect, it } from 'vitest'
import { extractStepAttachments, pairAttachmentsToMessages } from '../attachment-history.js'

const refA = [{ token: 'att_a', name: 'a.png', mimeType: 'image/png' }]
const refB = [{ token: 'att_b', name: 'b.pdf', mimeType: 'application/pdf' }]

describe('extractStepAttachments', () => {
  it('pulls attachments arrays, empty → undefined', async () => {
    expect(
      extractStepAttachments([
        { input: { message: 'x', attachments: refA } },
        { input: { message: 'y' } },
        { input: null },
        { input: { attachments: [] } },
      ]),
    ).toEqual([refA, undefined, undefined, undefined])
  })

  it('drops malformed non-record attachment values from persisted step input', () => {
    expect(
      extractStepAttachments([
        {
          input: {
            attachments: [
              null,
              'secret',
              ['nested'],
              { name: 'incomplete.pdf' },
              { name: 'safe.pdf', mimeType: 'application/pdf' },
            ],
          },
        },
      ]),
    ).toEqual([[{ name: 'safe.pdf', mimeType: 'application/pdf' }]])
  })

  it('returns only public history fields and strips local paths and signed URIs', () => {
    expect(
      extractStepAttachments([
        {
          input: {
            attachments: [
              {
                token: 'att_1',
                name: 'safe.pdf',
                mimeType: 'application/pdf',
                size: 42,
                path: '/private/runtime/secret.pdf',
                uri: 'https://example.test/file?signature=secret',
                isImage: false,
                message: 'injected prompt',
              },
            ],
          },
        },
      ]),
    ).toEqual([[{ token: 'att_1', name: 'safe.pdf', mimeType: 'application/pdf', size: 42 }]])
  })
})

describe('pairAttachmentsToMessages', () => {
  it('pairs Nth step attachments to Nth user message; agents get undefined', async () => {
    const messages = [
      { role: 'user' }, // turn 1
      { role: 'agent' },
      { role: 'user' }, // turn 2
      { role: 'agent' },
    ]
    const paired = pairAttachmentsToMessages(messages, [refA, refB])
    expect(paired).toEqual([refA, undefined, refB, undefined])
  })

  it('user message without a matching step → undefined', async () => {
    const messages = [{ role: 'user' }, { role: 'user' }]
    expect(pairAttachmentsToMessages(messages, [refA])).toEqual([refA, undefined])
  })

  it('no attachments anywhere', async () => {
    const messages = [{ role: 'user' }, { role: 'agent' }]
    expect(pairAttachmentsToMessages(messages, [undefined])).toEqual([undefined, undefined])
  })
})
