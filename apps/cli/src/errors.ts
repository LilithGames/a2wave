/**
 * Error types and the machine-readable envelope.
 *
 * The CLI's primary consumer is an AI agent, which recovers from a failure by
 * branching on it. Prose is a poor branch key — an agent matching on
 * "Session expired" breaks the moment someone rewords the sentence — so errors
 * carry a stable `type`/`subtype` pair and, where there is one, a `hint` that
 * is a RUNNABLE next step rather than advice.
 *
 * Structured fields are optional. The single-string constructor still works,
 * so the ~60 existing throw sites needed no edit and can be enriched one at a
 * time as each is shown to matter.
 */

/** Stable branch keys. Add sparingly — an agent may switch on these. */
export type CliErrorType =
  | 'auth' // the caller's own credentials
  | 'permission' // authenticated, but not allowed
  | 'not_found'
  | 'validation' // bad input, caught client- or server-side
  | 'conflict' // 409: state prevents the operation
  | 'rate_limit'
  | 'server' // 5xx
  | 'network' // could not reach the instance at all
  | 'confirmation' // needs --force / --yes
  | 'cli' // any other deliberate CLI failure
  | 'internal' // a bug in this CLI

export interface CliErrorOptions {
  type?: CliErrorType
  subtype?: string
  /** A command or flag the caller can actually run. Not prose. */
  hint?: string
}

export class CliError extends Error {
  readonly type?: CliErrorType
  readonly subtype?: string
  readonly hint?: string

  constructor(message: string, options: CliErrorOptions = {}) {
    super(message)
    this.name = 'CliError'
    this.type = options.type
    this.subtype = options.subtype
    this.hint = options.hint
  }
}

export interface ErrorEnvelope {
  ok: false
  error: {
    type: CliErrorType
    subtype?: string
    message: string
    hint?: string
  }
}

/**
 * Shape any thrown value into the envelope printed under `--json`.
 *
 * Absent fields are OMITTED rather than emitted as null: an agent checking
 * `error.subtype` should get `undefined`, not a null it has to special-case.
 *
 * Anything that is not a CliError is a bug in this CLI rather than a condition
 * the user hit, so it is typed `internal` — which also keeps a raw Node stack
 * trace from being the thing an agent has to parse.
 */
export function toErrorEnvelope(err: unknown): ErrorEnvelope {
  if (err instanceof CliError) {
    return {
      ok: false,
      error: {
        type: err.type ?? 'cli',
        ...(err.subtype ? { subtype: err.subtype } : {}),
        message: err.message,
        ...(err.hint ? { hint: err.hint } : {}),
      },
    }
  }

  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: { type: 'internal', message } }
}
