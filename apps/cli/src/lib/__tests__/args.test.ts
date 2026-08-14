import { describe, expect, it } from 'vitest'
import { CliError } from '../../errors.js'
import { assertKnownOptions } from '../args.js'

describe('assertKnownOptions', () => {
  const definitions = {
    start: {},
    port: { alias: 'p' },
  }

  it('accepts declared long options, boolean negation, and aliases', () => {
    expect(() =>
      assertKnownOptions(['--no-start', '--port=3512', '-p', '3512'], definitions),
    ).not.toThrow()
  })

  it.each(['--with-postgress', '-x'])('rejects unknown option %s', (option) => {
    expect(() => assertKnownOptions([option], definitions)).toThrow(CliError)
    expect(() => assertKnownOptions([option], definitions)).toThrow(`Unknown option: ${option}`)
  })
})
