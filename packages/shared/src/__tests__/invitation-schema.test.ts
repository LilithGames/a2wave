import { describe, expect, it } from 'vitest'
import {
  acceptInvitationInput,
  createInvitationInput,
  DEFAULT_INVITATION_TTL_HOURS,
  emailSchema,
  usernamePolicySchema,
} from '../schemas/user.js'

describe('createInvitationInput', () => {
  it('defaults role and expiry so an admin can issue a link with no choices', () => {
    const parsed = createInvitationInput.parse({})
    expect(parsed.role).toBe('user')
    expect(parsed.expiresInHours).toBe(DEFAULT_INVITATION_TTL_HOURS)
    expect(parsed.email).toBeUndefined()
  })

  it('normalizes a pinned email to lowercase so the accept-side match is case-insensitive', () => {
    const parsed = createInvitationInput.parse({ email: '  Dev@Company.COM  ' })
    expect(parsed.email).toBe('dev@company.com')
  })

  it.each([['not-an-email'], ['a@b'], ['@company.com'], ['']])('rejects the email %s', (email) => {
    expect(createInvitationInput.safeParse({ email }).success).toBe(false)
  })

  it('accepts an admin-role invitation', () => {
    expect(createInvitationInput.parse({ role: 'admin' }).role).toBe('admin')
  })

  it.each([0, -1, 721, 1.5])('rejects the out-of-range expiry %s', (expiresInHours) => {
    expect(createInvitationInput.safeParse({ expiresInHours }).success).toBe(false)
  })

  it('rejects a note longer than the column allows', () => {
    expect(createInvitationInput.safeParse({ note: 'x'.repeat(201) }).success).toBe(false)
    expect(createInvitationInput.safeParse({ note: 'x'.repeat(200) }).success).toBe(true)
  })
})

describe('usernamePolicySchema', () => {
  it.each(['abc', 'new.dev', 'new_dev', 'new-dev', '1st', 'x'.repeat(32)])(
    'accepts %s',
    (username) => {
      expect(usernamePolicySchema.safeParse(username).success).toBe(true)
    },
  )

  it.each([
    ['ab', 'too short'],
    ['x'.repeat(33), 'too long'],
    ['_lead', 'leading underscore'],
    ['.lead', 'leading dot'],
    ['-lead', 'leading hyphen'],
    ['has space', 'contains a space'],
    ['has@at', 'contains @'],
    ['', 'empty'],
  ])('rejects %s (%s)', (username) => {
    expect(usernamePolicySchema.safeParse(username).success).toBe(false)
  })
})

describe('emailSchema', () => {
  it('trims and lowercases', () => {
    expect(emailSchema.parse('  Dev@Company.com ')).toBe('dev@company.com')
  })

  it('rejects an address beyond the maximum length', () => {
    expect(emailSchema.safeParse(`${'x'.repeat(250)}@company.com`).success).toBe(false)
  })
})

describe('acceptInvitationInput', () => {
  const valid = {
    username: 'newdev',
    email: 'dev@company.com',
    password: 'Passw0rd',
    confirmPassword: 'Passw0rd',
  }

  it('accepts a well-formed registration', () => {
    const parsed = acceptInvitationInput.parse(valid)
    expect(parsed.username).toBe('newdev')
    expect(parsed.email).toBe('dev@company.com')
  })

  it('reports a password mismatch on the confirmation field', () => {
    const result = acceptInvitationInput.safeParse({ ...valid, confirmPassword: 'Passw0rdX' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['confirmPassword'])
    }
  })

  // Every field the flow calls required must actually be required — a schema that lets one
  // through would create an account the login page cannot serve.
  it.each(['username', 'email', 'password', 'confirmPassword'])('requires %s', (field) => {
    const body: Record<string, unknown> = { ...valid }
    delete body[field]
    expect(acceptInvitationInput.safeParse(body).success).toBe(false)
  })

  it.each([
    ['short1A', 'shorter than 8'],
    ['alllowercase1', 'no uppercase'],
    ['ALLUPPERCASE1', 'no lowercase'],
    ['NoDigitsHere', 'no digit'],
  ])('rejects the password %s (%s)', (password) => {
    expect(
      acceptInvitationInput.safeParse({ ...valid, password, confirmPassword: password }).success,
    ).toBe(false)
  })

  it('normalizes the email the invitee typed', () => {
    expect(acceptInvitationInput.parse({ ...valid, email: ' DEV@Company.com ' }).email).toBe(
      'dev@company.com',
    )
  })

  it('treats displayName as optional and trims it', () => {
    expect(acceptInvitationInput.parse({ ...valid, displayName: '  New Dev  ' }).displayName).toBe(
      'New Dev',
    )
    expect(acceptInvitationInput.parse(valid).displayName).toBeUndefined()
  })
})
