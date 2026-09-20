import { describe, expect, it } from 'vitest'
import {
  normalizeOauthAllowedEmail,
  OAUTH_ALLOWED_EMAILS_MAX,
  oauthAllowedEmailSchema,
  oauthAllowedEmailsSchema,
} from '../schemas/agent.js'

describe('normalizeOauthAllowedEmail', () => {
  // The single rule shared by the schema, the runtime gate and the web editor. If these three
  // ever disagree, the list an owner sees and the list that actually admits callers diverge
  // with nothing to catch it — hence one function, pinned here.
  it('lowercases and trims', () => {
    expect(normalizeOauthAllowedEmail('  Alice@Example.COM ')).toBe('alice@example.com')
  })

  it('is idempotent', () => {
    const once = normalizeOauthAllowedEmail(' Bob@Corp.io ')
    expect(normalizeOauthAllowedEmail(once)).toBe(once)
  })
})

describe('oauthAllowedEmailSchema', () => {
  it('normalizes a valid address', () => {
    expect(oauthAllowedEmailSchema.parse(' Alice@Example.COM ')).toBe('alice@example.com')
  })

  /**
   * The web editor validates with this exact schema. It used to use a looser local regex, which
   * let these through as chips and deferred the rejection to publish time — surfacing as a bare
   * 400 that named no offending address.
   */
  it.each(['a@b.c', 'bob@example..com', 'no-at-sign', '', 'a b@c.com'])('rejects %j', (bad) => {
    expect(oauthAllowedEmailSchema.safeParse(bad).success).toBe(false)
  })
})

describe('oauthAllowedEmailsSchema', () => {
  it('normalizes every entry', () => {
    expect(oauthAllowedEmailsSchema.parse([' Alice@Example.COM ', 'BOB@corp.io'])).toEqual([
      'alice@example.com',
      'bob@corp.io',
    ])
  })

  // Without dedup the cap counts entries rather than people (500 copies of one address would
  // pass), and duplicates would also collide as React keys in the editor.
  it('deduplicates addresses that differ only by case or padding', () => {
    expect(oauthAllowedEmailsSchema.parse(['a@b.co', 'A@B.CO', ' a@b.co '])).toEqual(['a@b.co'])
  })

  it('accepts an empty list — deny-all is a legal, fail-closed state', () => {
    expect(oauthAllowedEmailsSchema.parse([])).toEqual([])
  })

  it('enforces the cap on distinct addresses', () => {
    const distinct = Array.from({ length: OAUTH_ALLOWED_EMAILS_MAX + 1 }, (_, i) => `u${i}@x.com`)
    expect(oauthAllowedEmailsSchema.safeParse(distinct).success).toBe(false)
    // The same count of duplicates collapses under the cap rather than tripping it.
    const dupes = Array.from({ length: OAUTH_ALLOWED_EMAILS_MAX + 1 }, () => 'u@x.com')
    expect(oauthAllowedEmailsSchema.parse(dupes)).toEqual(['u@x.com'])
  })

  it('rejects a list containing an invalid address', () => {
    expect(oauthAllowedEmailsSchema.safeParse(['ok@x.com', 'nope']).success).toBe(false)
  })
})
