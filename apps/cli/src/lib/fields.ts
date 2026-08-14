/**
 * `--fields` projection: keep only the named paths of a JSON payload.
 *
 * The CLI's primary consumer is an AI agent, and the dominant cost of an
 * API-wrapping CLI is dumping a whole response into a context window. Listing
 * 100 agents to read two columns pays for every `systemPrompt` in the account.
 * Projection is the cheapest fix available, and unlike `--jq` it needs no
 * runtime dependency (the published package ships only `citty` + `yaml`; an
 * agent that wants real jq still has `| jq` in its own shell).
 *
 * ORDERING IS A SECURITY PROPERTY: projection runs AFTER redaction, never
 * before. See the note on `projectFields` and the invariant test in
 * `__tests__/fields.test.ts`.
 */
import { CliError } from '../errors.js'

/** An explicit "map over this array" segment, written `[]` in a path. */
const ARRAY_SEGMENT = '[]'

/**
 * Parse `--fields 'data[].id,data.name'` into segment lists.
 *
 * An empty selection throws rather than projecting to `{}`: an agent reading
 * `{}` cannot tell "you asked for nothing" from "the server returned nothing",
 * and would report the latter.
 */
export function parseFieldPaths(raw: string): string[][] {
  const paths = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) =>
      p
        .split('.')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        // `data[].id` splits on '.' into `data[]`, so peel the suffix into its
        // own segment: the traversal logic matches on a bare `[]`.
        .flatMap((s) => (s.endsWith(ARRAY_SEGMENT) ? [s.slice(0, -2), ARRAY_SEGMENT] : [s]))
        .filter((s) => s.length > 0),
    )
    .filter((segments) => segments.length > 0)

  if (paths.length === 0) {
    throw new CliError('--fields needs at least one path, e.g. --fields data[].id,data[].name')
  }
  return paths
}

export interface ProjectionResult {
  value: unknown
  /** Paths that matched nothing, rendered back in their `a.b.c` form. */
  unmatched: string[]
}

/**
 * Keep only `paths` within `payload`.
 *
 * Call this on ALREADY-REDACTED data. `redactSecrets` decides whether a value
 * is secret partly from its siblings — an agent env var is `{value, sensitive:
 * true}`, and dropping `sensitive` would leave `value` looking ordinary. So
 * projecting first would defeat the redactor for exactly the fields most worth
 * protecting. Redacting first is safe in both directions: projection only
 * removes keys, and a `********` placeholder survives it unchanged.
 *
 * A path that matches nothing is omitted and reported instead of throwing: an
 * agent composing `--fields` from a schema will legitimately name an optional
 * field that is absent on this particular row, and failing the whole call for
 * that is hostile.
 */
export function projectFields(payload: unknown, paths: string[][]): ProjectionResult {
  const unmatched: string[] = []
  let result: unknown

  for (const segments of paths) {
    const { value, matched } = pick(payload, segments)
    if (!matched) {
      unmatched.push(segments.join('.'))
      continue
    }
    result = merge(result, value)
  }

  return { value: result ?? {}, unmatched }
}

interface PickResult {
  value: unknown
  matched: boolean
}

/** Extract `segments` from `node`, rebuilding the surrounding shape as it goes. */
function pick(node: unknown, segments: string[]): PickResult {
  if (segments.length === 0) return { value: node, matched: true }
  if (node === null || node === undefined) return { value: undefined, matched: false }

  const [head, ...rest] = segments

  if (Array.isArray(node)) {
    // `[]` is the explicit spelling, but a path that simply continues into an
    // array (`data.id` where data is a list) is the common agent typo and
    // means the same thing, so both traverse.
    const nextSegments = head === ARRAY_SEGMENT ? rest : segments
    const picked = node.map((item) => pick(item, nextSegments))
    const matched = picked.some((p) => p.matched)
    return { value: picked.map((p) => p.value), matched }
  }

  if (head === ARRAY_SEGMENT) {
    // `[]` against a non-array: the shape does not match the request.
    return { value: undefined, matched: false }
  }

  if (typeof node !== 'object') return { value: undefined, matched: false }

  const source = node as Record<string, unknown>
  // `in` rather than a truthiness check, so `null` and `false` count as present.
  if (!(head in source)) return { value: undefined, matched: false }

  const child = pick(source[head], rest)
  if (!child.matched) return { value: undefined, matched: false }
  return { value: { [head]: child.value }, matched: true }
}

/** Deep-merge two projections so sibling paths land in one object. */
function merge(a: unknown, b: unknown): unknown {
  if (a === undefined) return b
  if (b === undefined) return a

  if (Array.isArray(a) && Array.isArray(b)) {
    return a.map((item, i) => merge(item, b[i]))
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a }
    for (const [k, v] of Object.entries(b)) {
      out[k] = k in out ? merge(out[k], v) : v
    }
    return out
  }

  return b
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
