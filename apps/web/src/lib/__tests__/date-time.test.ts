import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatLocaleTime, localeForLanguage } from '../date-time'

describe('localeForLanguage', () => {
  it.each([
    ['zh', 'zh-CN'],
    ['zh-CN', 'zh-CN'],
    ['en', 'en-US'],
    ['en-US', 'en-US'],
  ])('maps %s to %s', (language, locale) => {
    expect(localeForLanguage(language)).toBe(locale)
  })
})

describe('formatLocaleTime', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('formats timestamps with the locale selected by the UI language', () => {
    const format = vi.spyOn(Date.prototype, 'toLocaleTimeString').mockReturnValue('localized time')

    expect(formatLocaleTime('2026-09-01T13:05:00Z', 'en')).toBe('localized time')
    expect(format).toHaveBeenCalledWith('en-US')
  })
})
