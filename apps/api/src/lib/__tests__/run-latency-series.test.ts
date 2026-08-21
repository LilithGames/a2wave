import { describe, expect, it } from 'vitest'
import {
  aggregateLatencyByBucket,
  nearestRankPercentile,
  summarizeLatency,
} from '../run-latency-series.js'

describe('nearestRankPercentile', () => {
  it('returns null for an empty sample set', () => {
    expect(nearestRankPercentile([], 0.5)).toBeNull()
  })

  it('returns the single value for a one-sample set at every quantile', () => {
    expect(nearestRankPercentile([42], 0.5)).toBe(42)
    expect(nearestRankPercentile([42], 0.9)).toBe(42)
  })

  it('uses nearest-rank, not interpolation', () => {
    // P50 of 10 values is rank ceil(0.5*10)=5 -> the 5th value.
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(nearestRankPercentile(values, 0.5)).toBe(5)
    expect(nearestRankPercentile(values, 0.9)).toBe(9)
    expect(nearestRankPercentile(values, 1)).toBe(10)
  })
})

describe('aggregateLatencyByBucket', () => {
  it('averages both legs and ranks the combined end-to-end time', () => {
    const buckets = aggregateLatencyByBucket([
      { bucket: 100, waitMs: 1_000, durationMs: 3_000 },
      { bucket: 100, waitMs: 3_000, durationMs: 5_000 },
      { bucket: 200, waitMs: 0, durationMs: 700 },
    ])
    expect(buckets.get(100)).toEqual({
      waitAvgMs: 2_000,
      execAvgMs: 4_000,
      e2eP50Ms: 4_000,
      e2eP90Ms: 8_000,
      samples: 2,
    })
    expect(buckets.get(200)?.samples).toBe(1)
    expect(buckets.get(200)?.e2eP50Ms).toBe(700)
  })

  it('omits empty buckets so the route can gap-fill with the null shape', () => {
    expect(aggregateLatencyByBucket([]).size).toBe(0)
  })
})

describe('summarizeLatency', () => {
  it('ranks across every bucket, not within them', () => {
    // Split across two buckets on purpose: a recombination of per-bucket
    // percentiles could not produce these numbers.
    const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({
      bucket: i % 2,
      waitMs: 0,
      durationMs: i * 1_000,
    }))
    expect(summarizeLatency(rows)).toEqual({ e2eP50Ms: 5_000, e2eP90Ms: 9_000, samples: 10 })
  })

  it('reports the null shape when nothing was measured', () => {
    expect(summarizeLatency([])).toEqual({ e2eP50Ms: null, e2eP90Ms: null, samples: 0 })
  })
})
