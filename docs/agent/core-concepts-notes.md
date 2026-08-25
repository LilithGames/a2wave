# Core Concepts — Platform Rules

Entity reference: [docs/core-concepts.md](../core-concepts.md). This file records
the rules that reading the entity list does not tell you.

Entities: Agent, Provider, MCP Server (stdio/sse/http/group), Skill, SCM Source,
Run, ChatMessage, Settings, Evaluation Set / Case / Task.

## Skill visibility

- Creator-private by default (`visibility = private`).
- Only an **administrator** may publish it as `all-users`, after which every
  signed-in user can discover and bind it while mutations remain owner/admin-only.
- Platform-seeded **built-in** Skills are system-owned and persist as `all-users`
  so every signed-in user can discover, bind, clone, and authenticated-export them.
- **Public share exports still omit all Skill content.**

## Provider

- A Provider must be able to **enumerate the models its bound credentials can
  run** — a hard onboarding condition, so `modelDiscovery` is `automatic` or
  `manual`, with no "unsupported" escape hatch. Providers therefore persist no
  model catalog and expose no editable field: the list is probed from the CLI per
  Agent credential and cannot drift from what the account really has. (`copilot`
  was retired under this rule — its CLI has no model-list command.)
- A Provider's **CLI is not preinstalled** — installed at runtime from
  `provider-cli-lock.json`, tracked in `cli_installations` (keyed by lock identity,
  not by Provider id, since a managed CLI need not be a Provider). See
  [provider-cli.md](./provider-cli.md).

## MCP Server

- Group type uses `groupConfig` (multi-backend progressive disclosure via proxy).
- Generic stdio and other `admin-only` MCP bindings remain usable through all
  approved execution channels while the Agent owner is an **active administrator**.
- The system-owned `a2wave-platform-admin` is **control-plane-only** and
  additionally requires an explicitly identified **active backend administrator**.
- Group backends follow the same runtime rule.

## Run — the two retry layers

They are different layers and both exist; do not collapse them.

- **`maxRetries` (0–5, default 2)** — retries *inside* one job execution
  (`lib/execute-with-retry.ts`). Same `runs` row, same concurrency slot, same
  workspace, and on a same-provider retry the same chat session. Exponential
  backoff with jitter, plus depth-first provider-chain fallback: each provider
  gets its own budget, then the chain moves on and never comes back. The right
  tool for a flaky subprocess — but it inherits whatever dirty state the failed
  attempt left in the workspace.
- **`maxJobRetries` (0–3, default 0 = off)** — replays the *whole job* as a
  **new `runs` row** (`lib/job-retry-scheduler.ts`), which is exactly what the
  manual **Rerun** button builds. Fresh workspace, fresh session, re-admitted
  through `tryAcquireSlot`; the failed run keeps its `failed` status so every
  attempt stays its own auditable record.

Both layers multiply, and both are bounded by `totalTimeoutMinutes`.

Job retry is deliberately **narrower than the Rerun button**, because it fires
unattended: `cancelled` runs are never replayed (someone asked for it to stop),
and neither are permanent or hard-quota errors (401/403, content policy,
worktree/SCM, session/daily limits) — a fresh job hits the identical wall. Soft
429s *are* replayed, since the rate window has usually moved on by then.

Default-off is the product decision, not an oversight: a job that already posted
a reply, opened an MR, or wrote through MCP has no idempotency key, so replaying
it repeats those effects. Opting in belongs to the Agent author.

The chain is bounded by `executionMetadata.jobRetryAttempt`, carried forward on
every replay, with `jobRetryOf` pointing at the chain's *original* run so the
whole chain is queryable from one id. Dropping either field makes the chain
non-terminating. Each replay writes a `run.auto_retry` background audit entry
(Iron Rule 5 — background work still needs a trail).

## Evaluation

An Evaluation Set groups Cases (each an ordered list of
`{request, expectedResponse}` turns); an Evaluation Task replays a set against the
Agent's current config and freezes a provider/model/reasoning-effort/fast-mode/prompt
snapshot for comparison — the two execution controls belong to the binding, so a task
that differed only in reasoning depth would otherwise be indistinguishable. Why it bypasses the `runs` table, its queueing and workspace
isolation: [api-permissions.md](./api-permissions.md#evaluation-why-it-bypasses-runs).

## Channels

- **Git repository trigger** (`glab` / `gh`) — see
  [git-trigger-channels.md](./git-trigger-channels.md).
- **Chat page** (`chat_app`) — publishes an Agent at `/agents/:agentId/chat_app`, a
  first-party page pairing the Agent's profile with a chat window. `chatAppConfig`
  holds **presentation copy only** (welcome message, suggested questions, display
  toggles), never credentials, so it needs no masking on read and round-trips
  through agent export/import intact.
