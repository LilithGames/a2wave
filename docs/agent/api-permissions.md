# API Permissions & Cross-Cutting Invariants

Endpoint list: `/api/docs` (Swagger UI) or [apps/api/src/openapi.ts](../../apps/api/src/openapi.ts).
Route files under `apps/api/src/routes/` are the implementation. This document
records only what reading those does not tell you: permission derivation,
cross-cutting invariants, and the traps.

## Permission derivation

Agent is the **root** of the permission model. Runs, artifacts, chats, stats and
evaluations all derive access from the Agent they belong to — none carries its own
ACL.

- **Agent** — owner / editor / viewer (admin equals owner).
  - viewer: read + chat debug.
  - editor: read/write + publish/stop/clone/share.
  - owner: delete + manage members.
  - `GET /:id` returns `meta.permission` and `meta.skillBindingScope`
    (`all-visible` for an active-admin owner, else `owner-or-shared`) so editors
    are only offered resources the *owner* can execute.
- **Run** — `runs.userId` records *who triggered it*, and channels without a
  logged-in user disagree: Feishu / gateway API key / OAuth leave it NULL;
  A2A / schedule / Slack / Discord / Telegram stamp the agent owner. Read access therefore
  comes from `getRunReadFilter`: admin sees all; everyone else sees runs of agents
  they can read **plus** runs they triggered. **Mutations are stricter than
  reads** — `cancel` / `execute` / `rerun` need write on the run
  (`canMutateRun`); `execute` and `rerun` *additionally* need write on the target
  agent (`requireAgentWrite`), hence both guards, not either. Consequence: a
  viewer can cancel the debug run they started but cannot rerun it.
- **Run provenance** — `runs.triggerUserName` stores the best available user
  display name; `runs.triggerAgentName` stores the immediate upstream Agent
  display name. Run rows render the known layers in
  `user · calling Agent · source` order. Remote A2A values arrive through the
  optional caller-provenance extension and are display/audit **assertions only**;
  transport authentication remains authoritative, and API keys identify
  integrations rather than end users.
- **Artifact** — `artifacts.userId` inherits from the producing run, so it is NULL
  for the same channels; listing uses `getArtifactReadFilter`, exactly like runs.
  Download stays unauthenticated while `settings.artifacts.requireAuthForDownload`
  is off — the link inside an agent's reply must keep working. Delete needs
  **write**: a viewer sees an artifact but may only delete what they produced.
- **Evaluation** — same owner/editor/viewer gate; every mutation needs
  owner/editor. Set and case lookups are additionally constrained by `agentId`, so
  an id from another Agent is unreachable.
- **Memory** — shared per Agent, not per requester. Runtime topic reads are
  bounded by the Agent memory token; Web management uses viewer/editor.

## Cross-cutting invariants

- **Liveness vs readiness.** `/api/health` is liveness (failure ⇒ restart the
  pod). `/api/health/ready` returns 503 `starting` until boot-time seeding
  finishes. Point `readinessProbe` at the latter, or a rolling update routes
  traffic into the window where the port is bound but env-driven settings (SSO
  among them) are not yet written.
- **`checks.engines` is false for uninstalled CLIs**, and `allOk` deliberately
  excludes engines — the health check does **not** go red for this.
- **OAuth error boundary.** HTTP 401 means *the caller's* external token is
  invalid. Invalid Agent Provider credentials use `PROVIDER_*` codes and must
  never surface as caller auth failures.
- **Providers have no editable field** — `PATCH /api/providers/:id` is 403 by
  design. Model catalogs are probed per credential, never stored.
- **Last-admin and self-target guards.** Cannot change your own role, disable
  yourself, demote the only active admin, or disable the last one. Disabling a
  user revokes outstanding tokens and closes password login, SSO, and OAuth
  gateway invocation together.
- **`DELETE /users/:id` refuses while the user still owns resources** — 409
  `USER_HAS_OWNED_RESOURCES`, with per-resource counts (`agents`, `mcpServers`,
  `skills`, `skillGroups`, `kbDocuments`, `scmSources`, `evaluationSets`) so the
  administrator can transfer or delete them first. Cascading them away would
  destroy work nobody asked to lose, and orphaning them would leave resources no
  one can administer. Provenance references are the opposite case and are severed
  instead: the deleting transaction nulls `audit_logs.user_id`, `runs.user_id`,
  `artifacts.user_id`, `artifact_shares.created_by`, `evaluation_tasks.user_id`
  and `agents.schedule_run_as_user_id` before removing the row, so history
  outlives the account — the audit entry keeps its `details.username`, so "who
  did this" stays answerable. That happens in the route rather than as
  `ON DELETE SET NULL` because altering an existing SQLite foreign key needs a
  table rebuild, and drizzle's generated rebuild runs inside the migrator's
  transaction where `PRAGMA foreign_keys=OFF` is a no-op — see the header of
  `apps/api/drizzle/0100_awesome_marrow.sql`. Disabling remains the right move
  for a departing employee; deletion is for accounts created by mistake.
- **SCM edits during a sync return 409** — changing `localPath`/`config` mid-sync
  would release the running sync's lock.
- **Workspace arbitration is durable and cross-replica, not in-process.** A
  workload lease ("something may be using this checkout") and a removal
  reservation ("something is about to delete it") are both committed under the SCM
  mutation lock *before* the action they describe. Liveness comes from
  `instance_heartbeats` — never from a mark's age, which proves nothing when a Git
  operation can outrun any timeout. An instance that cannot renew its heartbeat
  fail-stops before peers may reclaim its workspaces, and a periodic reconciler
  converges removals nobody is finishing. Before touching sync, cleanup, deletion
  or recovery, read [scm-storage-invariants.md](./scm-storage-invariants.md).
- **Git SCM Agents run in per-Agent worktrees** — see
  [worktree-isolation.md](./worktree-isolation.md).
- **`scm-sources/probe` reuses a masked credential only when the endpoint is
  unchanged** (git scheme+host+path, P4 `p4port`/`p4user`). Capped at
  `MAX_GIT_REPOS` (50) per probe — bounded at the route, not the config schema, so
  sources predating the limit stay editable.
- **Agent PATCH diffs resource ids**: already-mounted skill/mcp/kb are not removed
  by an update that omits them.
- **Two upload paths with different lifetimes.** `/api/uploads` is for icons —
  small, and **permanently public** once written. `/api/attachments` is staged: it
  returns a token, obeys `settings.attachments` limits/TTL, and 404s after expiry.
  Never route user content through the former to dodge the TTL.

## Evaluation: why it bypasses `runs`

Evaluation runs write **no** `runs` rows. That table is a live state machine — the
run queue counts its rows to enforce `agents.maxConcurrency`, and startup recovery
reads them — so a 50-case evaluation landing there would starve interactive chat,
the exact thing the separate queue prevents.

- Auditability is met by an **`evaluation_task.execute` audit entry on every
  terminal path** (failures included).
- `turnsReplayed` counts evaluation **turns**, not Agent invocations — one turn may
  start several workers via retry or provider fallback, so it is **not** a billing
  figure.
- Each task freezes provider + model + reasoning effort + fast mode + system prompt —
  **never credentials**. If
  that provider is unbound before the task starts the task **fails** rather than
  silently substituting and misattributing results.

### Workspace isolation

- Local Agents get a **per-task subdirectory**.
- **git** SCM Agents get a per-task `eval-<taskId>` worktree
  (`cleanup: 'ephemeral'`, removed via `scm.removeWorkspace()` — never `rm -rf`,
  which strands a stale worktree admin entry).
- **P4 has no isolation and cannot get one**: a client spec is server-side state
  bound to a single `Root`, so a second checkout means a new client plus a full
  re-sync, and changing `cwd` would not even redirect where `p4 sync` writes. P4
  evaluations share the one checkout with chat runs and syncs; the create-task
  dialog warns first.

### Queueing

`apps/api/src/engine/evaluation-queue.ts` is **per-Agent** and separate from the
run queue: one evaluation slot fans out into N sequential invocations, so it
deliberately does not share `agents.maxConcurrency`.

- One evaluation task per Agent at a time — serial execution is a **workspace**
  constraint, not a throughput choice.
- `settings.evaluation.maxConcurrency` is retained in existing databases but
  **no longer read**.
- Cancellation is persisted (`cancel_requested_at`), so it survives a queue wait
  or restart.
- On startup `running`/`pending` tasks fail with "Interrupted by a server restart"
  and `queued` ones reschedule — evaluations are **never resumed mid-flight**.

## Channel-specific notes

- **Internal API** (`/api/internal/*`) requires **both** a loopback peer **and** a
  process-scoped credential generated per API process in
  `apps/api/src/lib/internal-admin-auth.ts` — the loopback socket alone proves
  nothing, because a same-host reverse proxy (`TRUSTED_PROXY`) makes every
  internet request arrive from 127.0.0.1. For the same reason the gate denies a
  loopback peer that carries `X-Forwarded-For` when `TRUSTED_PROXY` is on. Two
  credentials exist: `A2WAVE_INTERNAL_TOKEN` (header `x-a2wave-internal-token`),
  injected into the agent-router MCP, opens the non-admin routes; the stronger
  `A2WAVE_INTERNAL_ADMIN_TOKEN` (header `x-a2wave-internal-admin-token`),
  injected only into the platform-admin MCP for an active admin requester, is
  required by `/api/internal/admin/*` and also accepted elsewhere.
- **Internal Admin API** (`/api/internal/admin/*`) is **not filtered by owner** —
  it deliberately sees everything, which is why it takes the admin credential.
- **OAuth channel** attachment upload/consumption is isolated per user as
  `oauth:<issuer>:<sub>`.
- **Feishu connection status** (`/api/agents/feishu-connections`) reflects only the
  current API process; `meta.scope` states the multi-instance semantics.
- `workspacesPath` (SCM create/update) overrides the default worktree root
  `SCM_STORAGE_ROOT/workspaces/<sourceIdSuffix>`. Absolute, globally unique. The
  historical `~/.a2wave/workspaces` root remains allowed for upgraded sources.
- **Adding a chat channel**: it must also handle the registered commands
  (`/status`, `/new`) — see the checklist in
  [agent-status-command.md](./agent-status-command.md#adding-a-new-chat-channel--handle-the-commands).
  A channel that skips this still appears to work: the command reaches the model
  as literal text and the Agent improvises an answer about its own state.
- Auth methods: [oauth-channel.md](./oauth-channel.md). Unified call-context
  shape: [run-channel-context.md](./run-channel-context.md).
