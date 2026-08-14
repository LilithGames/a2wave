/**
 * Per-command metadata for the CLI's primary consumer, an AI agent.
 *
 * citty's own `meta` carries a name and a one-line description — enough for a
 * human reading `--help`, not enough for a caller deciding whether it is
 * allowed to run something. `agentMeta` rides alongside it and is read by
 * `a2wave schema` (function-calling specs), by `--help` (the `Risk:` line) and
 * by `requireConfirmation` (which gates `high-risk-write` behind `--yes`).
 *
 * It is attached to `meta` rather than to a side table so a command and its
 * risk label cannot be moved apart, and so a new leaf command is caught by the
 * structural test in src/__tests__/command-structure.test.ts the moment it is
 * registered.
 */

/**
 * What a command does to the instance. Deliberately three values:
 *
 * - `read`  — no server-side state changes. Safe to call speculatively.
 * - `write` — changes state, and is expected to. No confirmation.
 * - `high-risk-write` — irreversible, or of unknowable effect. Requires
 *   `--yes`/`--force` when there is no TTY.
 *
 * The high-risk set is kept SMALL on purpose: a label everything carries is a
 * label nothing reads. It is exactly deletes, an `apply` whose diff removes
 * things, and `api` with a non-GET method (an arbitrary route the CLI cannot
 * reason about). Everything else that writes is `write`.
 */
export type CommandRisk = 'read' | 'write' | 'high-risk-write'

export interface AgentMeta {
  risk: CommandRisk
  /** What must already be true before this call can succeed. */
  preconditions?: string[]
  /** Cases an agent might reach for this command in, and should not. */
  notFor?: string[]
  /** Realistic invocations, complete enough to copy and run. */
  examples?: string[]
}

/** `meta` shape once `agentMeta` is attached. Structural, so citty stays happy. */
export interface MetaWithAgentMeta {
  name?: string
  description?: string
  agentMeta?: AgentMeta
}

/** Read `agentMeta` off any command node without asserting citty's own types. */
export function readAgentMeta(node: unknown): AgentMeta | undefined {
  const meta = (node as { meta?: MetaWithAgentMeta } | undefined)?.meta
  return meta?.agentMeta
}
