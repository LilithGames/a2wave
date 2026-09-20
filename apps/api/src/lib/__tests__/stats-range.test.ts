import { describe, expect, it } from 'vitest'
import { statsWindow, timeseriesQuerySchema } from '../stats-range.js'

describe('statistics date range', () => {
  it.each(['2026-02-31', '2026-13-01', 'invalid'])(
    'rejects an invalid calendar date %s',
    (from) => {
      expect(timeseriesQuerySchema.safeParse({ from, to: '2026-12-31' }).success).toBe(false)
    },
  )

  it('resolves viewer-local boundaries across a daylight saving transition', () => {
    const query = timeseriesQuerySchema.parse({
      from: '2026-03-07',
      to: '2026-03-09',
      tz: 'America/Los_Angeles',
      tzOffset: -28800,
    })
    expect(statsWindow(query)).toEqual({
      fromSeconds: Date.parse('2026-03-07T08:00:00Z') / 1000,
      toSeconds: Date.parse('2026-03-10T06:59:59Z') / 1000,
    })
  })
})
