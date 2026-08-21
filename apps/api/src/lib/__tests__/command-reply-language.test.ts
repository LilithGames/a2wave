import { describe, expect, it } from 'vitest'
import { resolveCommandReplyLanguage } from '../command-reply-language.js'

describe('resolveCommandReplyLanguage', () => {
  it('honours an explicit agent setting over any hint', () => {
    expect(resolveCommandReplyLanguage('en', { text: '/状态' })).toBe('en')
    expect(resolveCommandReplyLanguage('zh', { text: '/status' })).toBe('zh')
  })

  it('infers zh from a Chinese command alias under auto', () => {
    expect(resolveCommandReplyLanguage('auto', { text: '/状态' })).toBe('zh')
  })

  it('infers zh from Chinese characters anywhere in the message under auto', () => {
    expect(resolveCommandReplyLanguage('auto', { text: '/status 看一下' })).toBe('zh')
  })

  it('falls back to en under auto when there is no Chinese hint', () => {
    expect(resolveCommandReplyLanguage('auto', { text: '/status' })).toBe('en')
  })

  it('treats a missing setting as auto', () => {
    expect(resolveCommandReplyLanguage(undefined, { text: '/状态' })).toBe('zh')
    expect(resolveCommandReplyLanguage(null, { text: '/status' })).toBe('en')
  })

  it('ignores an unrecognised stored value rather than rendering nothing', () => {
    expect(resolveCommandReplyLanguage('fr' as never, { text: '/status' })).toBe('en')
  })
})
