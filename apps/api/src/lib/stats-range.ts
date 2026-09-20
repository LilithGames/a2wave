import { z } from 'zod'
import { MAX_TZ_OFFSET_SECONDS, zoneOffsetSecondsAt } from './time-buckets.js'

/**
 * A calendar date that actually exists.
 *
 * The shape regex alone accepts `2026-13-45` and `2026-02-31`; `Date.parse` then
 * yields NaN (or silently rolls over), the bucket loop never iterates, and the
 * handler returns an empty 200 that the UI renders as "no data in this range" —
 * a malformed request misreported as a quiet agent. Round-tripping through
 * `toISOString()` rejects both cases at the boundary instead.
 */
const calendarDate = (field: string) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${field} must be YYYY-MM-DD`)
    .refine(
      (s) => {
        // Guard the parse itself: `new Date('2026-13-45T00:00:00Z')` is an
        // Invalid Date, and calling toISOString() on it throws a RangeError,
        // which would surface as a 500 instead of the intended 400.
        const ms = Date.parse(`${s}T00:00:00Z`)
        return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(s)
      },
      { message: `${field} is not a real calendar date` },
    )

/** Query contract for the per-agent time series. */
export const timeseriesQuerySchema = z
  .object({
    from: calendarDate('from'),
    to: calendarDate('to'),
    bucket: z.enum(['day', 'hour']).default('day'),
    // Viewer's UTC offset in seconds (`-getTimezoneOffset() * 60`). It reaches
    // SQL as a bound number, but bound it anyway so bad input fails loudly
    // instead of silently shifting every bucket.
    tzOffset: z.coerce
      .number()
      .int()
      .min(-MAX_TZ_OFFSET_SECONDS)
      .max(MAX_TZ_OFFSET_SECONDS)
      .default(0),
    // IANA zone (e.g. 'America/Los_Angeles'). Preferred over tzOffset for day
    // buckets: a single offset cannot express a range crossing a DST switch,
    // where every later boundary shifts an hour and the transition day is 23 or
    // 25 hours long. tzOffset remains the fallback for clients that omit it and
    // stays exact for hour buckets, which DST does not distort.
    tz: z.string().min(1).max(64).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to' })

export function statsWindow({ from, to, tzOffset, tz }: z.infer<typeof timeseriesQuerySchema>) {
  // Interpret the calendar dates against the viewer's offset so the query window
  // and the bucket boundaries share one definition of "a day". The window edges
  // use the offset in force on each edge's own date, so a range that crosses a
  // DST switch still starts and ends at real local midnight.
  const fromEdge = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000)
  const toEdge = Math.floor(Date.parse(`${to}T23:59:59Z`) / 1000)
  const fromOffset = tz ? (zoneOffsetSecondsAt(tz, fromEdge - tzOffset) ?? tzOffset) : tzOffset
  const toOffset = tz ? (zoneOffsetSecondsAt(tz, toEdge - tzOffset) ?? tzOffset) : tzOffset
  const fromSeconds = fromEdge - fromOffset
  const toSeconds = toEdge - toOffset

  return { fromSeconds, toSeconds }
}
