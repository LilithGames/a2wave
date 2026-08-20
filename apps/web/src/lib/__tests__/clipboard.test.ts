import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyText } from '../clipboard'

describe('copyText', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  function stubClipboard(impl: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: impl },
      configurable: true,
    })
  }

  it('uses the async clipboard API when it is available', async () => {
    const writeText = vi.fn(async () => {})
    stubClipboard(writeText)
    expect(await copyText('secret')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('secret')
  })

  it('falls back to execCommand when the clipboard API rejects', async () => {
    // navigator.clipboard is undefined on a plain-HTTP origin, and rejects even
    // where it exists — an internal deployment on http:// would otherwise never
    // be able to copy a credential it can never see again.
    stubClipboard(async () => {
      throw new Error('NotAllowedError')
    })
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    expect(await copyText('secret')).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('falls back when the clipboard API is missing entirely', async () => {
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    expect(await copyText('secret')).toBe(true)
  })

  it('reports failure rather than claiming a copy that did not happen', async () => {
    stubClipboard(async () => {
      throw new Error('nope')
    })
    Object.defineProperty(document, 'execCommand', {
      value: vi.fn(() => false),
      configurable: true,
    })
    expect(await copyText('secret')).toBe(false)
  })

  it('leaves no scratch node behind', async () => {
    stubClipboard(async () => {
      throw new Error('nope')
    })
    Object.defineProperty(document, 'execCommand', { value: vi.fn(() => true), configurable: true })
    await copyText('secret')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })
})
