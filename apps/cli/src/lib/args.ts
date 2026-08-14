import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { CliError } from '../errors.js'

/**
 * Read the JSON file pointed to by `--config-file` and parse it into an object. Read failures
 * and invalid JSON are wrapped into a CliError carrying the flag name (instead of throwing the
 * raw fs / SyntaxError stack). The mcp / scm create/update full-body fallback goes through here,
 * avoiding three diverging copies of JSON.parse.
 */
export function readJsonFile(filePath: string, flagName = 'config-file'): Record<string, unknown> {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err) {
    throw new CliError(`Failed to read --${flagName} (${filePath}): ${(err as Error).message}`)
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (err) {
    throw new CliError(`--${flagName} is not valid JSON (${filePath}): ${(err as Error).message}`)
  }
}

/**
 * citty's repeatable string flags (e.g. `--arg a --arg b`) yield `string | string[]`;
 * a single occurrence is a string, multiple are an array, absent is undefined.
 * Normalize all of them into string[].
 */
export function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map((v) => String(v))
  return [String(value)]
}

/**
 * Parse repeatable `--header k=v` flags into a `Record<string, string>`.
 * Used for key=value flags like MCP headers/env. Empty input returns undefined
 * (so it can go straight into the body without an empty object).
 */
export function parseKeyValues(
  value: unknown,
  flagName: string,
): Record<string, string> | undefined {
  const items = toStringArray(value)
  if (items.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const item of items) {
    const eq = item.indexOf('=')
    if (eq <= 0) {
      throw new CliError(`--${flagName} must be key=value, got: "${item}"`)
    }
    out[item.slice(0, eq).trim()] = item.slice(eq + 1)
  }
  return out
}

/**
 * Parse an integer flag (e.g. `--sync-interval 10`) into a number, failing fast with a clear
 * error on bad input. A bare `Number('10m')` gives NaN → serialized as null → the server-side
 * zod reports an opaque 400 like "Expected number, received null"; intercept it on the CLI side
 * with a readable error instead. Optional min/max bounds.
 */
export function parseIntFlag(
  value: unknown,
  flagName: string,
  opts?: { min?: number; max?: number },
): number {
  // Applies to EVERY caller, not just --page/--limit: --sync-interval on
  // `kb create|update` and `scm create` share this helper. Tightening them
  // together is deliberate — a sync interval written as `1e3` or `0x10` is a
  // typo in any of them, and silently reinterpreting it is the failure mode
  // this gate exists to remove.
  //
  // Gate on a plain decimal BEFORE converting. `Number()` also accepts hex,
  // binary, exponent and whitespace-padded forms, all of which pass
  // `Number.isInteger` — so `--page 0x10` quietly fetched page 16 and
  // `--limit 1e3` reported "at most 100 (got 1000)" without ever showing what
  // was typed. An empty string converts to 0 as well.
  const raw = String(value ?? '')
  // `\d+` already rejects an empty string, so no separate emptiness check.
  if (!/^[+-]?\d+$/.test(raw.trim())) {
    throw new CliError(`Invalid --${flagName}: ${raw} (must be an integer)`)
  }
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) {
    throw new CliError(`Invalid --${flagName}: ${raw} (out of the safe integer range)`)
  }
  if (opts?.min !== undefined && n < opts.min) {
    throw new CliError(`--${flagName} must be at least ${opts.min} (got ${n})`)
  }
  if (opts?.max !== undefined && n > opts.max) {
    throw new CliError(`--${flagName} must be at most ${opts.max} (got ${n})`)
  }
  return n
}

/**
 * Second confirmation for destructive operations (delete etc.). Semantics:
 *   - `--force` given → proceed without asking (scripts / CI).
 *   - Non-interactive stdin (pipe / CI, no TTY) → **never run silently**; error out and require
 *     an explicit `--force`, so irreversible operations don't run in unattended automation.
 *   - Interactive terminal → print message, read one line; continue only on y/yes
 *     (case-insensitive), otherwise abort.
 */
export async function confirmDestructive(message: string, force: boolean): Promise<void> {
  if (force) return
  if (!process.stdin.isTTY) {
    // The single most likely error an agent hits, since it never has a TTY.
    // A stable type plus a runnable hint lets it decide whether to re-run with
    // --force or stop and ask the human, without parsing the sentence. The
    // sentence keeps saying it too — the structured fields are for the machine,
    // and dropping the human-readable instruction to avoid repeating itself
    // would make the plain-text mode strictly worse.
    throw new CliError(`${message}\nIn a non-interactive environment, add --force to confirm.`, {
      type: 'confirmation',
      subtype: 'confirmation_required',
      hint: '--force',
    })
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(`${message} Proceed? [y/N] `)
    if (!/^y(es)?$/i.test(answer.trim())) {
      throw new CliError('Cancelled.')
    }
  } finally {
    rl.close()
  }
}
