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
  **new `runs` row** (`lib/job-retry-scheduler.ts`). Fresh workspace, fresh
  session, re-admitted through `tryAcquireSlot`; the failed run keeps its
  `failed` status so every attempt stays its own auditable record.

There is a third thing that is not a retry layer but is easily mistaken for one:
the manual **Rerun / Retry** button. It branches on the source run's status
(`routes/runs.ts` + `lib/run-retry-in-place.ts`):

- `completed` / `cancelled` → a **new `runs` row**, like the job-retry chain.
  Replaying a successful run in place would overwrite a good `result`, and a
  cancelled run was stopped deliberately.
- `failed` → **re-executed on its own row** (`status` CAS `failed → pending`,
  then normal admission; the attempt lands as another `run_steps` row, which
  `executeChatRun` already numbers by `MAX(order)+1` for multi-turn chat). The
  failed attempt's step, output and logs stay; only the run's terminal status
  now reflects the newest attempt. This exists because filing a second row per
  failure makes a Provider outage unreadable: the Runs list fills with pairs of
  identical intents and nothing distinguishes "already recovered" from "still
  broken".

  `executionMetadata` is rebuilt from an **allowlist**, not merged. Carrying
  `liveChatId` (or `resumePending` / `executionStarted`) forward would make
  `resolveQueuedChatId` read the retry as a *resume*: the Agent would be sent a
  continuation prompt instead of the intent, and no chat message would be
  recorded. `gitTriggerOrigin.queued` is forced to `false` so the staleness
  probe cannot cancel a retry a human just asked for, and `retryAttempt` marks
  the row so restart recovery does not mistake a retried native-Feishu run for
  an event still awaiting replay. Each retry writes a `run.retry` audit entry.

The automatic chain deliberately does **not** use the in-place path: it fires
unattended, and erasing the failure it is recovering from would leave nothing to
diagnose.

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

## Run — restart recovery and resume

`recoverOnStartup` (`engine/task-queue.ts`) settles what the dead process left
behind. A `running` run that recorded the provider session it had already opened
is **requeued and continued** from that session rather than failed, so a deploy
restart does not replay a prompt whose side effects have already landed
(`lib/resume-decision.ts`, three attempts max).

**Native Feishu event runs are excluded from resume.** They carry a
`triggerSessionId` and depend on an in-memory reply closure and streaming card
that generic `executeChatRun` promotion cannot rebuild. Promoting them before
`replayPendingFeishuMessages` also makes replay skip them (`prior-run-running`).
Recovery therefore fails these running rows outright
(`SERVER_RESTART_DURING_EXEC`, before the resume check so no attempt is burned)
and lets pending-message replay rebuild the full reply context.

**API-created Feishu reruns can resume.** They have no `triggerSessionId` or
pending event to replay. An in-place retry is the same case wearing the wrong
clothes: it *keeps* the original event's `triggerSessionId`, but that event was
consumed by the first attempt, so no replay is coming — `retryAttempt` is what
tells the recovery gate apart, and the sendable-context requirement still
applies. Their sendable reply target is persisted in
`executionMetadata.nativeChatContext`, or restored from the interrupted step
by `requeueForResume`. The queued recovery gate preserves these reruns only
when that context is available; legacy rows without a reply target fail instead
of completing silently.

For native events, replay opens a **fresh** provider session — `lookupPreviousChatId`
only resolves *completed* runs, so the interrupted run's `liveChatId` is invisible
to it — and side effects can be repeated. A repeated turn is recoverable; a silent
one is not. Removing the carve-out requires teaching the replay path to carry the
interrupted run's `liveChatId` into the run it creates.

## Run — runtime HOME

Every run gets a per-Agent runtime home at `data/agent-homes/<agentId>`
(`engine/runtime-context.ts`): `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
`CODEX_HOME` and `TMPDIR` all point inside it. One exception, applied by every
engine: **`authMode = localSession` keeps the service process HOME** (the engine
drops `HOME` from the runtime env), because that mode reads the CLI's own login
state from the service user's `~/.claude`, `~/.cursor`, `~/.codex`, and so on.
`apiKey` and `oauth` modes get the per-Agent HOME.

Consequence: any external CLI logged in under the service user's HOME — `glab`,
`gh`, `git` (`~/.gitconfig`, `~/.git-credentials`, `~/.config/glab-cli`) — is
**not authenticated** inside an `apiKey` / `oauth` run, even though `a2wave`
itself runs fine. Agent-level env vars starting with `GIT_CONFIG_` are stripped
by `sanitizeAgentRuntimeEnv` (process-injection guard), so `GIT_CONFIG_GLOBAL`
cannot redirect git to the service user's config; `GLAB_CONFIG_DIR` is allowed.

Two workable options:

- **Seed the Agent's runtime home.** Put a `.gitconfig` in
  `data/agent-homes/<agentId>/` that declares
  `credential.helper = store --file=<service user's .git-credentials>`, and
  symlink `data/agent-homes/<agentId>/.config/glab-cli` to the service user's
  `~/.config/glab-cli`.
- **Configure at run start.** In the Agent's system prompt, instruct it to
  `export GLAB_CONFIG_DIR=<service user's ~/.config/glab-cli>` and to run
  idempotent `git config --global ...` commands (user, credential helper) at the
  beginning of each run.

## Run — conversation identity and grouped reads

`runs.conversation_id` identifies one a2wave-managed generation of an actual Provider/CLI
conversation across independently actionable Runs. Ingress creates it from the first Run id and
continuations inherit it; a reset creates a new value. Do not reuse `trigger_session_id` for this:
that field belongs to transport deduplication and previous-turn lookup, and some channels retain it
across `/new`.

The effective grouping key is `COALESCE(conversation_id, runs.id)`, additionally partitioned by
`initiator_agent_id` and `trigger_source`. The extra partition columns are security and correctness
boundaries because an external session identifier need not be globally unique. They also provide a
legacy bridge: when the first pre-migration Run has NULL conversation id, a newer continuation can
point at that Run id and both resolve to the same effective key. Consequently, never add raw
`conversation_id` to the SQL `GROUP BY`, and never treat a NULL detail anchor as unconditionally
singleton without checking the effective key.

Both `GET /runs/sessions` and `GET /runs/:id/session` apply `getRunReadFilter` before reading any
members. The detail endpoint repeats the filter after resolving its anchor so the anchor cannot act
as a capability URL if access changes between queries. Session summaries surface aggregate status:
an active member wins in `running > queued > pending` order; otherwise the latest Run's terminal
status is used. The legacy `GET /runs` endpoint remains execution-granular.

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
