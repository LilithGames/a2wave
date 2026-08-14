import { describe, expect, it } from 'vitest'
import { CliError } from '../../errors.js'
import { DEFAULT_PAGE_SIZE, pageArgs, pageQuery, parsePage, parsePageSize } from '../paginate.js'

describe('parsePage', () => {
  it('defaults to page 1 when omitted', () => {
    expect(parsePage(undefined)).toBe(1)
    expect(parsePage('')).toBe(1)
  })

  it('parses a plain decimal', () => {
    expect(parsePage('3')).toBe(3)
  })

  it('rejects junk rather than silently returning page 1', () => {
    // Coercing `--page abc` to 1 hides the typo behind results that look right.
    expect(() => parsePage('abc')).toThrow(CliError)
  })

  it('rejects page 0 and negatives', () => {
    expect(() => parsePage('0')).toThrow(CliError)
    expect(() => parsePage('-1')).toThrow(CliError)
  })
})

describe('parsePageSize', () => {
  it('defaults to DEFAULT_PAGE_SIZE when omitted', () => {
    expect(parsePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE)
  })

  it('honours a caller-supplied fallback', () => {
    expect(parsePageSize(undefined, 50)).toBe(50)
  })

  it('clamps an out-of-range number instead of failing', () => {
    // `--limit 1000` meaning "everything" is an established habit, and the API
    // clamps to 100 anyway, so erroring would break scripts for no safety gain.
    expect(parsePageSize('1000')).toBe(100)
    expect(parsePageSize('0')).toBe(1)
  })

  it('still rejects junk', () => {
    expect(() => parsePageSize('abc')).toThrow(CliError)
  })
})

describe('pageQuery', () => {
  it('builds the query a list route expects', () => {
    expect(pageQuery({ page: '2', limit: '50' })).toBe('page=2&pageSize=50')
  })

  it('applies defaults when neither flag is passed', () => {
    expect(pageQuery({})).toBe(`page=1&pageSize=${DEFAULT_PAGE_SIZE}`)
  })

  it('respects a per-command fallback size', () => {
    expect(pageQuery({}, 100)).toBe('page=1&pageSize=100')
  })
})

describe('pageArgs', () => {
  it('exposes citty-shaped flags', () => {
    expect(pageArgs.limit.type).toBe('string')
    expect(pageArgs.page.type).toBe('string')
  })
})
