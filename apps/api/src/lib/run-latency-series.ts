/**
 * Bucketed queue-wait / execution latency aggregation for the per-agent
 * timeseries endpoint.
 *
 * Aggregated in JS from raw completed-turn samples rather than in SQL:
 * percentiles have no portable expression across the SQLite and PostgreSQL
 * backends, and per-bucket percentiles cannot be recombined into a range
 * percentile anyway. Sample volume is bounded in practice by per-agent
 * throughput (maxConcurrency defaults to 1) and the range's bucket cap.
 */

/** One completed turn: bucket start (epoch seconds) plus its two latency legs. */
export interface LatencySample {
  bucket: number
  waitMs: number
  durationMs: number
}

export interface BucketLatency {
  /** Mean queue wait; averages (unlike percentiles) stack honestly with execAvgMs. */
  waitAvgMs: number | null
  execAvgMs: number | null
  e2eP50Ms: number | null
  e2eP90Ms: number | null
  samples: number
}

export interface LatencySummary {
  e2eP50Ms: number | null
  e2eP90Ms: number | null
  samples: number
}

/** null, never 0 — "no measured turns" is a different claim from "instant turns". */
export const EMPTY_BUCKET_LATENCY: BucketLatency = {
  waitAvgMs: null,
  execAvgMs: null,
  e2eP50Ms: null,
  e2eP90Ms: null,
  samples: 0,
}

/** Nearest-rank percentile over an ASCENDING-sorted array; null when empty. */
export function nearestRankPercentile(sortedValues: number[], q: number): number | null {
  if (sortedValues.length === 0) return null
  const rank = Math.max(1, Math.ceil(q * sortedValues.length))
  return sortedValues[Math.min(rank, sortedValues.length) - 1] ?? null
}

export function aggregateLatencyByBucket(rows: LatencySample[]): Map<number, BucketLatency> {
  const grouped = new Map<number, LatencySample[]>()
  for (const row of rows) {
    const bucket = grouped.get(row.bucket)
    if (bucket) bucket.push(row)
    else grouped.set(row.bucket, [row])
  }
  const result = new Map<number, BucketLatency>()
  for (const [bucket, samples] of grouped) {
    const e2e = samples.map((s) => s.waitMs + s.durationMs).sort((a, b) => a - b)
    const waitTotal = samples.reduce((sum, s) => sum + s.waitMs, 0)
    const execTotal = samples.reduce((sum, s) => sum + s.durationMs, 0)
    result.set(bucket, {
      waitAvgMs: Math.round(waitTotal / samples.length),
      execAvgMs: Math.round(execTotal / samples.length),
      e2eP50Ms: nearestRankPercentile(e2e, 0.5),
      e2eP90Ms: nearestRankPercentile(e2e, 0.9),
      samples: samples.length,
    })
  }
  return result
}

export function summarizeLatency(rows: LatencySample[]): LatencySummary {
  const e2e = rows.map((s) => s.waitMs + s.durationMs).sort((a, b) => a - b)
  return {
    e2eP50Ms: nearestRankPercentile(e2e, 0.5),
    e2eP90Ms: nearestRankPercentile(e2e, 0.9),
    samples: e2e.length,
  }
}
