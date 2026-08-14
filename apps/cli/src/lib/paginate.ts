/**
 * Shared pagination flags for list commands.
 *
 * Before this existed, `runs list` was the only list with a `--limit`; every
 * other one hardcoded `?pageSize=100`. That is the wrong default in both
 * directions for an agent: it over-fetches when you wanted three rows, and
 * silently truncates at 100 when you wanted all of them, with nothing in the
 * output saying so.
 */
import { parseIntFlag } from './args.js'

/** The window the API itself accepts. Mirrored here so we clamp before sending. */
const MIN_PAGE_SIZE = 1
const MAX_PAGE_SIZE = 100

/** Default rows for a list command that does not say otherwise. */
export const DEFAULT_PAGE_SIZE = 20

/**
 * Shared args fragment: add `...pageArgs` to any list command.
 *
 * The description deliberately does not name a default. The per-command default
 * is passed to `pageQuery`, and the six resource lists keep the 100 they always
 * had (lowering it would silently truncate output for anyone relying on
 * `agents list` showing everything), while `runs list` keeps its 20. Stating one
 * number here would be wrong for one group or the other.
 */
export const pageArgs = {
  limit: {
    type: 'string' as const,
    description: `Rows to return, ${MIN_PAGE_SIZE}-${MAX_PAGE_SIZE}`,
  },
  page: {
    type: 'string' as const,
    description: 'Page number, 1-based (default 1)',
  },
}

/**
 * Parse a 1-based page number. Omitted means page 1; anything else must be
 * valid — silently coercing `--page abc` to 1 hides a typo behind results that
 * look right.
 */
export function parsePage(raw: unknown): number {
  if (raw === undefined || raw === '') return 1
  return parseIntFlag(raw, 'page', { min: 1 })
}

/**
 * Parse `--limit` against the API's own 1..100 window.
 *
 * Junk errors, but an out-of-range NUMBER still clamps. `--limit 1000` as
 * shorthand for "give me everything" is an established habit, and turning it
 * into a hard failure would break scripts on upgrade for no safety gain — the
 * API clamps to 100 regardless. Rejecting `--limit abc` is the actual
 * improvement: that one silently returned a page nobody asked for.
 */
export function parsePageSize(raw: unknown, fallback = DEFAULT_PAGE_SIZE): number {
  if (raw === undefined || raw === '') return fallback
  const n = parseIntFlag(raw, 'limit')
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, n))
}

/** Build the `?page=&pageSize=` query string a list route expects. */
export function pageQuery(args: Record<string, unknown>, fallbackSize = DEFAULT_PAGE_SIZE): string {
  const params = new URLSearchParams({
    page: String(parsePage(args.page)),
    pageSize: String(parsePageSize(args.limit, fallbackSize)),
  })
  return params.toString()
}
