import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '@/i18n'
import { apiErrorKey, formatApiError, HTTP_CODES, KNOWN_CODES } from '../api-error'

describe('apiErrorKey', () => {
  it('maps a known backend error code to its i18n key', () => {
    expect(apiErrorKey('CANNOT_DISABLE_SELF')).toBe('apiError.CANNOT_DISABLE_SELF')
    expect(apiErrorKey('CANNOT_CHANGE_OWN_ROLE')).toBe('apiError.CANNOT_CHANGE_OWN_ROLE')
  })

  it('maps the transport-level codes the api client raises itself', () => {
    expect(apiErrorKey('NETWORK_ERROR')).toBe('apiError.NETWORK_ERROR')
    expect(apiErrorKey('HTTP_500')).toBe('apiError.HTTP_500')
  })

  it('accepts an Error and reads its message', () => {
    expect(apiErrorKey(new Error('USER_NOT_FOUND'))).toBe('apiError.USER_NOT_FOUND')
  })

  it('accepts a plain { message } object, not just a real Error', () => {
    // TanStack exposes `error` typed as Error but callers pass plain objects,
    // and an `instanceof` check would silently downgrade those to UNKNOWN.
    expect(apiErrorKey({ message: 'HTTP_404' })).toBe('apiError.HTTP_404')
  })

  it('falls back to the generic key for an unmapped code', () => {
    // A code the frontend has no copy for must not leak to the user verbatim.
    expect(apiErrorKey('SOME_BRAND_NEW_CODE')).toBe('apiError.UNKNOWN')
  })

  // The route answers 409 with this code plus a per-resource breakdown when the
  // account still owns Agents, Skills, SCM sources and the like. Without the
  // registration the admin is told only that something went wrong, and the one
  // thing they can act on — that a transfer is needed first — never reaches them.
  it('translates the owned-resource deletion block', () => {
    expect(KNOWN_CODES.has('USER_HAS_OWNED_RESOURCES')).toBe(true)
    expect(apiErrorKey('USER_HAS_OWNED_RESOURCES')).toBe('apiError.USER_HAS_OWNED_RESOURCES')
  })

  it('falls back for free-form messages that are not error codes', () => {
    expect(apiErrorKey('Something exploded at line 42')).toBe('apiError.UNKNOWN')
    expect(apiErrorKey('')).toBe('apiError.UNKNOWN')
    expect(apiErrorKey(null)).toBe('apiError.UNKNOWN')
    expect(apiErrorKey(undefined)).toBe('apiError.UNKNOWN')
  })

  it('maps the HTTP_<status> codes that have copy', () => {
    expect(apiErrorKey('HTTP_403')).toBe('apiError.HTTP_403')
    expect(apiErrorKey('HTTP_404')).toBe('apiError.HTTP_404')
  })

  it('falls back for an HTTP status with no copy of its own', () => {
    // Returning `apiError.HTTP_418` would resolve to a missing key, and i18next
    // renders a missing key as the key itself — leaking it back to the user.
    expect(apiErrorKey('HTTP_418')).toBe('apiError.UNKNOWN')
  })

  it('maps the statuses the API actually returns beyond the original six', () => {
    // Rate limiting answers with an *object* `error`, so `api.ts` cannot read a
    // code out of it and synthesises `HTTP_429`; before this was listed the login
    // box printed the literal string "HTTP_429" at the user.
    expect(apiErrorKey('HTTP_429')).toBe('apiError.HTTP_429')
    // `api-body-limit.ts` replies with plain text, so there is no body to parse.
    expect(apiErrorKey('HTTP_413')).toBe('apiError.HTTP_413')
    expect(apiErrorKey('HTTP_501')).toBe('apiError.HTTP_501')
    expect(apiErrorKey('HTTP_502')).toBe('apiError.HTTP_502')
    expect(apiErrorKey('HTTP_503')).toBe('apiError.HTTP_503')
  })
})

describe('formatApiError', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('translates a known code', () => {
    expect(formatApiError(new Error('CANNOT_DISABLE_SELF'), i18n.t)).toBe(
      'You cannot disable your own account',
    )
  })

  it('passes prose from the backend through untouched', () => {
    // Several routes (all of scm-sources, skill/agent upload parsers) answer with
    // human-readable text rather than a code. That text is the diagnosis — replacing
    // it with generic copy would strip the only actionable detail the user gets.
    const prose = 'Cannot delete: referenced by agents: Alpha, Beta'
    expect(formatApiError(new Error(prose), i18n.t)).toBe(prose)
  })

  it('keeps interpolated details in prose', () => {
    const prose = 'Path "/srv/repo" is already used by source "main-repo"'
    expect(formatApiError(new Error(prose), i18n.t)).toBe(prose)
  })

  it('genericises an unrecognised code rather than leaking the identifier', () => {
    expect(formatApiError(new Error('SOME_NEW_CODE'), i18n.t)).toBe(
      'Something went wrong. Please try again.',
    )
  })

  it('genericises when there is no message at all', () => {
    expect(formatApiError(null, i18n.t)).toBe('Something went wrong. Please try again.')
    expect(formatApiError(new Error(''), i18n.t)).toBe('Something went wrong. Please try again.')
  })

  it('resolves every listed code to real copy in both locales', async () => {
    // The allowlists and the locale files are edited separately, so a code can be
    // listed with no copy behind it. i18next renders a missing key *as the key*,
    // which turns the safety net into the leak it exists to prevent — assert the
    // round trip instead of trusting the two lists to stay in step.
    const generic = 'Something went wrong. Please try again.'
    for (const locale of ['en', 'zh']) {
      await i18n.changeLanguage(locale)
      for (const code of [...KNOWN_CODES, ...HTTP_CODES]) {
        const text = formatApiError(new Error(code), i18n.t)
        expect(text, `${locale}: ${code}`).not.toBe(`apiError.${code}`)
        expect(text, `${locale}: ${code} has no copy`).not.toBe(generic)
      }
    }
  })
})
