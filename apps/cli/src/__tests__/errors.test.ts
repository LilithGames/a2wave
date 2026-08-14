import { describe, expect, it } from 'vitest'
import { CliError } from '../errors.js'

describe('CliError', () => {
  it('keeps the single-string constructor working', () => {
    // ~60 existing throw sites pass only a message. Structured fields are
    // additive; making them required would have meant touching every one.
    const err = new CliError('something went wrong')
    expect(err.message).toBe('something went wrong')
    expect(err.name).toBe('CliError')
    expect(err.type).toBeUndefined()
    expect(err.subtype).toBeUndefined()
    expect(err.hint).toBeUndefined()
  })

  it('carries type / subtype / hint when given', () => {
    const err = new CliError('Session expired or invalid', {
      type: 'auth',
      subtype: 'expired',
      hint: 'a2wave login',
    })
    expect(err.type).toBe('auth')
    expect(err.subtype).toBe('expired')
    expect(err.hint).toBe('a2wave login')
  })

  it('is still an Error, so existing catch/instanceof paths hold', () => {
    expect(new CliError('x')).toBeInstanceOf(Error)
  })
})

describe('toErrorEnvelope', () => {
  it('shapes a bare CliError with a generic type', async () => {
    const { toErrorEnvelope } = await import('../errors.js')
    expect(toErrorEnvelope(new CliError('boom'))).toEqual({
      ok: false,
      error: { type: 'cli', message: 'boom' },
    })
  })

  it('carries subtype and hint through when present', async () => {
    const { toErrorEnvelope } = await import('../errors.js')
    expect(
      toErrorEnvelope(new CliError('nope', { type: 'auth', subtype: 'expired', hint: 'run x' })),
    ).toEqual({
      ok: false,
      error: { type: 'auth', subtype: 'expired', message: 'nope', hint: 'run x' },
    })
  })

  it('omits absent fields rather than emitting nulls', async () => {
    // An agent branching on `error.subtype` should get `undefined`, not a
    // null it has to special-case.
    const { toErrorEnvelope } = await import('../errors.js')
    const env = toErrorEnvelope(new CliError('boom'))
    expect('subtype' in env.error).toBe(false)
    expect('hint' in env.error).toBe(false)
  })

  it('maps an unexpected non-CliError to type "internal"', async () => {
    const { toErrorEnvelope } = await import('../errors.js')
    const env = toErrorEnvelope(new TypeError('x.y is not a function'))
    expect(env.error.type).toBe('internal')
    expect(env.error.message).toContain('x.y is not a function')
  })

  it('handles a thrown non-Error value', async () => {
    const { toErrorEnvelope } = await import('../errors.js')
    expect(toErrorEnvelope('just a string').error.type).toBe('internal')
  })
})
