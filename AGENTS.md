# a2wave — Project Guide

> Natural-language-driven Agent orchestration. See [PRODUCT.md](./docs/PRODUCT.md) for product vision, boundaries, and operating priorities.

> **Primary language: English.** This is an OSS-facing repository — all code, comments, commit messages, documentation, and identifiers must be written in English.

> **Trust model — an internal enterprise team.** a2wave assumes **Agent authors
> and Agent users are all trusted colleagues acting in good faith**. Agents run
> the underlying CLIs with real capabilities (filesystem, shell, injected
> credentials) *by design*; the platform does not sandbox trusted authors from
> each other, nor defend against a malicious insider deliberately building a
> hostile Agent.
>
> Security controls — authentication, per-Agent owner/editor/viewer permissions,
> audit logging, rate limiting, per-run credential injection — enforce
> **accountability and least privilege among cooperating teammates**, not
> containment of an adversary inside the trust boundary.
>
> **What this means when working in this repo:** do not file, "fix", or harden
> against threats that only arise from a hostile authenticated author — that is
> outside the design, and such changes add complexity while protecting nobody.
> This does *not* relax the controls that do apply: never skip authentication,
> never allow anonymous invocation, never drop an audit entry, and never put
> credentials in `details` (Iron Rule 5). Deployments exposing a2wave to
> untrusted users must add their own isolation layer.
>
> Full statement: [SECURITY.md](./SECURITY.md) · [docs/PRODUCT.md](./docs/PRODUCT.md)

## Architecture

```
a2wave (pnpm monorepo)
├── apps/api/         # Hono + SQLite (Drizzle ORM) + Local Agent Execution
├── apps/web/         # React 19 + Vite + TailwindCSS v4 + Ant Design
├── apps/cli/         # CLI tool (a2wave command)
└── packages/shared/  # Zod schemas & types
```

Stack: TypeScript, Biome (lint), TanStack Query, React Router v7

## Product Identity & Iron Rules

a2wave is a general-purpose Agent building and orchestration platform for enterprises. It builds on mature agent CLIs such as Cursor Agent / Claude Code / OpenAI Codex, extends capabilities via Skills and MCP Servers, and publishes Agents over API / Feishu / Slack / Discord / A2A / scheduled / chat page / GitLab repository trigger / GitHub repository trigger.

**The goal: a business team can build a general-purpose business Agent** — not a pipeline hardcoded for one scenario, but a reusable, composable digital worker callable from the channels the team already uses. Generality comes from *combining information sources* — a code checkout, Skills and Memory, live systems over MCP — never from a single one of them. The platform makes each source reliable to attach and dependable to run against; what to do with them is the Agent's decision. See [docs/PRODUCT.md](./docs/PRODUCT.md).

The following Iron Rules define the product boundary; every new feature must be checked against them first:

| # | Iron Rule | Description |
|---|------|------|
| 1 | **Orchestrate, don't execute** | a2wave is the orchestration layer; execution capability comes from the underlying agent CLIs (Cursor/Claude Code/Codex). Do not build our own LLM inference, code execution, or sandbox runtime. |
| 2 | **Extend through composition** | New capabilities are delivered by combining Skills + MCP Servers, not by hardcoding business logic into the platform core. If a feature can be solved with a Skill or MCP, it should not become a built-in platform feature. |
| 3 | **Natural-language-driven, not flow-driven** | Agents are configured and orchestrated in natural language — prompts, intents, and A2A messages. No drag-and-drop DAG editor, no traditional workflow primitives like variable mapping or conditional branches. |
| 4 | **Agent autonomy — the platform does not intervene in execution details** | The platform creates, configures, triggers, and monitors Agents; it does not interfere with an Agent's runtime reasoning or tool-call decisions. No "step approval", "manual checkpoints", or other flow controls that break Agent autonomy. |
| 5 | **Enterprise-grade constraints, scoped by the trust model** | Security (AUTH_SECRET, rate limiting), auditability (Run records; for background work that deliberately writes none, an equivalent audit-log entry — see Evaluation), and operability (health checks, logs) are hard requirements. Never sacrifice infrastructure for "quick trial" experiences. No anonymous invocation; never skip authentication. But the goal is **accountability and least privilege among trusted colleagues** (see the trust model above), *not* containment of a hostile insider — do not harden against threats that only a malicious authenticated author could pose. |
| 6 | **The barrier is lowered by the user's own local Agent, not by our UI** | Our users already run Claude Code, Codex, Cursor Agent on their own machines. Anything they can accomplish by asking *that* Agent — writing a prompt, filling in a config, generating an Agent YAML, driving the CLI or API — does not earn a platform screen. The platform's effort concentrates on what no local Agent can provide: runtime, observability, fault tolerance, Skill and tool hosting, channels, permissions and audit. |

> **For feature requests that violate the Iron Rules, contact the maintainers for confirmation before proceeding.**

Rules 1–5 constrain a feature's *shape*; Rule 6 constrains where effort goes, since a
convenience screen can satisfy all five and still only add weight. Ask of a request:
**could the user get this by asking the Agent on their laptop?**

| Answer | Verdict | Examples |
|---|---|---|
| **Yes** | No new screen. What may be missing is machine-readable surface — a CLI command, API, schema or Skill — never a form. | Visual prompt editor, Skill-binding wizard, MCP parameter form, config generator |
| **No — only the platform has the information** | Build it. | Run failure cause, execution traces, token spend, diagnosis, audit trail |
| **No — only the platform has the capability** | Build it. | Runtime and queueing, retry and fallback, credential injection, permissions, channels, Skill/MCP hosting |

Hence: console and CLI share one API, an Agent is reviewable/diffable YAML, and
`a2wave setup` writes `.env` and `docker-compose.yml` instead of demanding clicks.
The answer to "users can't figure this out" is a better CLI, API and docs for their
Agent to read. Rule 6 governs what is *added* — retiring an existing surface is its
own change, with its own review.

## Core Concepts

Agent, Provider, MCP Server (stdio/sse/http/group), Skill, SCM Source, Run, ChatMessage, Settings, Evaluation Set / Case / Task.
A Skill is creator-private by default (`visibility = private`); only an administrator may publish it as `all-users`, after which every signed-in user can discover and bind it while mutations remain owner/admin-only. Platform-seeded built-in Skills are system-owned and persist as `all-users` so every signed-in user can discover, bind, clone, and authenticated-export them; public share exports still omit all Skill content.
A **Provider must be able to enumerate the models its bound credentials can run** — that is a hard onboarding condition, so `modelDiscovery` is `automatic` or `manual` with no "unsupported" escape hatch. Providers therefore persist no model catalog and expose no editable field: the list is probed from the CLI per Agent credential and cannot drift from what the account really has. (`copilot` was retired under this rule — its CLI has no model-list command.)
A Provider's **CLI is not preinstalled** — it is installed at runtime from `provider-cli-lock.json` and tracked in `cli_installations` (keyed by lock identity, not by Provider id, since a managed CLI need not be a Provider). See the Agent CLI API section.
MCP Server group type uses `groupConfig` (multi-backend progressive disclosure via proxy).
Generic stdio and other `admin-only` MCP bindings remain usable through all approved execution channels while the Agent owner is an active administrator; the system-owned `a2wave-platform-admin` is control-plane-only and additionally requires an explicitly identified active backend administrator. Group backends follow the same runtime rule.
An Evaluation Set groups Cases (each an ordered list of `{request, expectedResponse}` turns); an Evaluation Task replays a set against the Agent's current config and freezes a provider/model/prompt snapshot for comparison.
The **git repository trigger** channels (`glab` / `gh`) poll a repository through the vendor CLI and start a Run only when a watched merge/pull request actually moves — the deliberate contrast with `schedule`, which fires unconditionally and spends tokens on every tick even when nothing changed. Change detection diffs a per-request fingerprint (head SHA + comment count), never an opaque payload hash, so the fired event names the exact request and transition. The CLIs are **probed, never installed** — absent from `provider-cli-lock.json`, with forge auth left in the CLI's own keyring or environment — so `glabConfig` / `ghConfig` hold no credentials and need no masking. Repositories are polled serially and a poll owns its channel via a token, so a config change retires the running poll rather than racing it.

The **chat page** channel (`chat_app`) publishes an Agent at `/agents/:agentId/chat_app` — a first-party page pairing the Agent's profile with a chat window. `chatAppConfig` holds presentation copy only (welcome message, suggested questions, display toggles), never credentials, so it needs no masking on read and round-trips through agent export/import intact.
Details: [docs/core-concepts.md](docs/core-concepts.md)

## Development

```bash
pnpm install        # install
cp .env.example .env  # required: leave AUTH_SECRET empty — pnpm dev generates one into .env
pnpm run dev        # API :3502 + Web :3501 (override with PORT / WEB_PORT in .env)
pnpm stop           # free the ports if a previous run left orphans
```

### Database (SQLite or PostgreSQL, via Drizzle)

```bash
# Generate migration files
pnpm db:generate

# Run migrations (reads DATABASE_URL, applies the matching lineage)
pnpm db:migrate
```

The backend is selected by `DATABASE_URL` alone: a `postgres://` scheme means
PostgreSQL (≥ 9.6), anything else is a SQLite file path. **SQLite is the
supported default** — one container, no external dependency.

> ⚠️ **PostgreSQL is EXPERIMENTAL** and not yet recommended for production: it
> passes the full suite and an end-to-end smoke test, but has no production soak
> time, and there is **no SQLite → PostgreSQL data migration path**. It exists
> for multi-instance deployments, where a single SQLite file cannot be shared
> safely. The process prints a warning on boot when it is selected.

The two dialects keep **separate migration lineages** (`drizzle/` vs
`drizzle-pg/`) because the generated DDL differs and a fresh PostgreSQL database
must not replay ~100 migrations of SQLite history. `schema.pg.ts` is **generated**
from the SQLite schema (`pnpm db:generate:pg`), never hand-edited — that is what
stops the dialects drifting. There is **no SQLite → PostgreSQL data migration
tool**; pick the backend at deploy time.

Three rules keep application code dialect-neutral: transactions go through
`withTransaction` (`src/db/transaction.ts`) and never `db.transaction()` directly
— better-sqlite3 rejects an async callback outright; result counts come from
`.returning()`, never the driver-specific `changes`/`rowCount`; and JSON / LIKE /
time-bucket queries go through the `dialect-runtime.ts` helpers.

Full guide: [docs/agent/postgresql.md](./docs/agent/postgresql.md).
Detailed database operation rules: see [apps/api/AGENTS.md](apps/api/AGENTS.md).

### Git Worktree Conventions

All git worktrees of this repository live **inside the repo** under `.claude/worktrees/` (already gitignored) — never as a sibling directory of the repo:

```bash
# Create (branch name mirrors the worktree name)
git worktree add -b <branch> .claude/worktrees/<name> origin/main

# Clean up when done
git worktree remove .claude/worktrees/<name>
```

- **Path**: always `.claude/worktrees/<name>`; `<name>` should describe the task (e.g. `repo-maintenance-2026-07-23`, `e2e`, `fix-oauth-401`).
- **Base ref**: branch from `origin/main` (run `git fetch origin main` first), so the worktree is not polluted by local uncommitted state.
- **Cleanup**: remove with `git worktree remove` — never `rm -rf`, which strands a stale worktree admin entry (then requires `git worktree prune`).
- **Setup inside a worktree**: run `pnpm install` there (hooks re-wire via `prepare`).
- **Ports**: the main tree owns the default `3501` (Web) / `3502` (API); a worktree running dev/e2e in parallel must use the **agreed `WEB_PORT=3503` / `PORT=3504`** (all configs — vite/playwright/e2e constants — read these env vars). Never start a second server on 3501/3502 — see [docs/agent/e2e.md](./docs/agent/e2e.md).
- **Database**: `DATABASE_URL` defaults to the **relative** path `./data/a2wave.db`, so each worktree naturally gets its own isolated SQLite file. When copying `.env` into a worktree, never set an absolute `DATABASE_URL` pointing at the main tree's DB — two processes on one SQLite file (even with WAL) risks lock contention and cross-polluted test data.
- Consumers of this convention: isolated e2e runs ([docs/agent/e2e.md](./docs/agent/e2e.md)), MR reviews (`mr-review` skill), and any agent/tool-created worktree (e.g. Claude Code's worktree isolation, which defaults to this path).

**Important**: During development, prefer the **Agents Team** approach to fully leverage multi-agent collaboration and improve decomposition and parallel execution of complex tasks.

## API Endpoints

**Endpoint list: `/api/docs` (Swagger UI) or [src/openapi.ts](apps/api/src/openapi.ts).** Route files under `apps/api/src/routes/` are the implementation. This section records only what reading those does not tell you: permission derivation, cross-cutting invariants, and the traps.

### Permission derivation

Agent is the root of the permission model. Runs, artifacts, chats, stats and evaluations all derive access from the Agent they belong to — none carries its own ACL.

- **Agent** — owner / editor / viewer (admin equals owner). viewer: read + chat debug. editor: read/write + publish/stop/clone/share. owner: delete + manage members. `GET /:id` returns `meta.permission` and `meta.skillBindingScope` (`all-visible` for an active-admin owner, else `owner-or-shared`) so editors are only offered resources the *owner* can execute.
- **Run** — `runs.userId` records *who triggered it*, and channels without a logged-in user disagree: Feishu / gateway API key / OAuth leave it NULL; A2A / schedule / Slack / Discord stamp the agent owner. Read access therefore comes from `getRunReadFilter`: admin sees all; everyone else sees runs of agents they can read **plus** runs they triggered. **Mutations are stricter than reads** — `cancel` / `execute` / `rerun` need write on the run (`canMutateRun`); `execute` and `rerun` *additionally* need write on the target agent (`requireAgentWrite`), hence both guards, not either. Consequence: a viewer can cancel the debug run they started but cannot rerun it.
- **Run provenance** — `runs.triggerUserName` stores the best available user display name and `runs.triggerAgentName` stores the immediate upstream Agent display name. Run rows render the known layers in `user · calling Agent · source` order. Remote A2A values arrive through the optional caller-provenance extension and are display/audit assertions only; transport authentication remains authoritative, and API keys identify integrations rather than end users.
- **Artifact** — `artifacts.userId` inherits from the producing run, so it is NULL for the same channels; listing uses `getArtifactReadFilter`, exactly like runs. Download stays unauthenticated while `settings.artifacts.requireAuthForDownload` is off — the link inside an agent's reply must keep working. Delete needs **write**: a viewer sees an artifact but may only delete what they produced.
- **Evaluation** — same owner/editor/viewer gate; every mutation needs owner/editor. Set and case lookups are additionally constrained by `agentId`, so an id from another Agent is unreachable.
- **Memory** — shared per Agent, not per requester. Runtime topic reads are bounded by the Agent memory token; Web management uses viewer/editor.

### Cross-cutting invariants

- **Liveness vs readiness.** `/api/health` is liveness (failure ⇒ restart the pod). `/api/health/ready` returns 503 `starting` until boot-time seeding finishes. Point `readinessProbe` at the latter, or a rolling update routes traffic into the window where the port is bound but env-driven settings (SSO among them) are not yet written.
- **`checks.engines` is false for uninstalled CLIs**, and `allOk` deliberately excludes engines — the health check does **not** go red for this.
- **OAuth error boundary.** HTTP 401 means *the caller's* external token is invalid. Invalid Agent Provider credentials use `PROVIDER_*` codes and must never surface as caller auth failures.
- **Providers have no editable field** — `PATCH /api/providers/:id` is 403 by design. Model catalogs are probed per credential, never stored.
- **Last-admin and self-target guards.** Cannot change your own role, disable yourself, demote the only active admin, or disable the last one. Disabling a user revokes outstanding tokens and closes password login, SSO, and OAuth gateway invocation together.
- **SCM edits during a sync return 409** — changing `localPath`/`config` mid-sync would release the running sync's lock.
- **Git SCM Agents run in per-Agent worktrees** (`agent-<agentId suffix>`, persistent, followSource). The shared `localPath` checkout is only synced into and no longer executed in — Agents sharing one Source stopped sharing a working directory because a run of Agent B re-mounting `.claude/skills` deleted the files Agent A's in-flight run was executing. The worktree sits on a branch named after it (so `git branch --show-current` answers — the contract git-sync keeps for the shared checkout; `GIT_BRANCH` keeps meaning the Source's tracked branch). `A2WAVE_WORKSPACE_BRANCH` is owned by `resolveWorkDir` and set **only when the run actually lands in its per-agent worktree** — absent on explicit-worktree, evaluation, fallback and P4 runs, because a wrong value would send the agent to move a checkout it does not own. Explicit worktree names may not use the reserved `agent-` prefix — rejected at the request entry points (400) so persisted legacy configs keep replaying. Those legacy configs are neutralized in **one place**: `normalizeWorktreeParams` drops any worktree params whose name has the per-agent shape, so the run lands in the Agent's own worktree instead of taking the explicit path (which would write the workspace's state file, switch its branch off `agent-<id>` — after which followSource skips it forever — and expose it to run-end cleanup). Guarding each of those ends separately is what made the same legacy branch resurface for three review rounds; the downstream guards remain as defense in depth but no longer carry the case. On reuse it advances to the synced HEAD **only through the ancestor guard** (`merge-base --is-ancestor`): tracked modifications or unmerged agent commits pin it — with a warn log — and it unpins by itself once those commits reach the source branch. A multi-repo advance is **all-or-nothing**: every sub-repo is decided before any of them moves, and one pinned repo pins the workspace, because advancing the rest would hand the agent a tree whose repos sit at commits that never coexisted upstream. Platform-rewritten paths never count as pinning modifications; the set comes from `platformWorkspacePaths()`, which each writer — skill-sync, mcp-sync, kb-sync, the CodeGraph link — registers its own paths with, so adding a writer and updating the set are the same edit. Those paths are registered at **full depth** (`.claude/skills`, not `.claude`): the dirty check excludes them verbatim, and exempting a whole shared root would let `reset --hard` silently revert a repo-tracked `.claude/settings.json` the agent edited. Workspace removal needs root names instead, and derives them (`platformWorkspaceEntries()` = top segment of each path); it deletes the registered paths first and **logs by name** anything left in a shared root that the platform never wrote (a repo-tracked `settings.json`, the CLI's own `settings.local.json`) before removing it — the workspace is going away regardless, so refusing would only wedge TTL sweeps, but the deletion must not be silent. Same-Agent runs share their worktree **without an occupancy check** (serializing them would stall concurrent chat), but the advance is **suppressed while a sibling run is executing** — `reset --hard` is not a read-only share. The sibling probe, the create and the `runs.workDir` write all happen **inside** the per-workspace lock: probing outside it left a window where a sibling started executing between the probe and the reset, and two runs resolving concurrently both read an empty table and both advanced. Every channel records `runs.workDir` for the runs it executes (queued runs record at dequeue), so the workspace-delete route's occupancy check sees in-flight runs; that write is the only occupancy marker there is, so it is retried and then **fails the run** rather than executing unprotected. Agent deletion, the workspace-delete route, the TTL sweeper and a followSource rebuild/rollback all reclaim per-agent worktrees with `keepBranches` (the branch may hold the only copy of unpushed commits); run-end ephemeral cleanup skips them entirely, because deleting the directory would discard uncommitted work. Each reclaim path tests both sides: the exact `perAgentWorkspaceName` match keeps a legacy explicit workspace such as `agent-refactor` on ordinary delete-branch semantics, while the `isPerAgentWorkspaceName` shape test still protects an orphan whose Agent row is already deleted, another Agent's worktree named by a sticky config, and a rebuild or create-rollback reached through the explicit path (which never sets `followSource`). The shape test is anchored to `createId`'s exact 16 base64url chars, so a hand-typed `agent-payments-refactor` is not mistaken for one and does not leak its branch. Agent deletion runs in the background, probes occupancy inside the per-workspace lock, and leaves an occupied worktree in place — but **demotes its state file to `ttl`** on the way out, so the sweeper reclaims it once idle. Left `persistent` it leaked forever: the Agent row is gone, so no run resolves that worktree again and the sweeper skips persistent workspaces. A legacy detached worktree is adopted onto the branch, and an existing branch is attached as-is — never force-moved. CodeGraph stays reachable through an idempotent `.codegraph` symlink into the shared checkout (allowlisted by workspace removal). P4 keeps the shared checkout (no isolation possible). Worktree creation failure degrades to `localPath`, never fails the run.
- **`scm-sources/probe` reuses a masked credential only when the endpoint is unchanged** (git scheme+host+path, P4 `p4port`/`p4user`). Capped at `MAX_GIT_REPOS` (50) per probe — bounded at the route, not the config schema, so sources predating the limit stay editable.
- **Agent PATCH diffs resource ids**: already-mounted skill/mcp/kb are not removed by an update that omits them.
- **Two upload paths with different lifetimes.** `/api/uploads` is for icons — small, and **permanently public** once written. `/api/attachments` is staged: it returns a token, obeys `settings.attachments` limits/TTL, and 404s after expiry. Never route user content through the former to dodge the TTL.

### Evaluation: why it bypasses `runs`

Evaluation runs write **no** `runs` rows. That table is a live state machine — the run queue counts its rows to enforce `agents.maxConcurrency`, and startup recovery reads them — so a 50-case evaluation landing there would starve interactive chat, the exact thing the separate queue prevents. Auditability is met by an **`evaluation_task.execute` audit entry on every terminal path** (failures included). `turnsReplayed` counts evaluation turns, **not** Agent invocations — one turn may start several workers via retry or provider fallback, so it is not a billing figure. Each task freezes provider + model + system prompt — never credentials; if that provider is unbound before the task starts the task **fails** rather than silently substituting and misattributing results.

**Workspace isolation**: local Agents get a per-task subdirectory; **git** SCM Agents get a per-task `eval-<taskId>` worktree (`cleanup: 'ephemeral'`, removed via `scm.removeWorkspace()` — never `rm -rf`, which strands a stale worktree admin entry). **P4 has no isolation and cannot get one**: a client spec is server-side state bound to a single `Root`, so a second checkout means a new client plus a full re-sync, and changing `cwd` would not even redirect where `p4 sync` writes. P4 evaluations share the one checkout with chat runs and syncs; the create-task dialog warns first.

**Queueing** (`apps/api/src/engine/evaluation-queue.ts`) is **per-Agent** and separate from the run queue: one evaluation slot fans out into N sequential invocations, so it deliberately does not share `agents.maxConcurrency`. One evaluation task per Agent at a time — serial execution is a workspace constraint, not a throughput choice. `settings.evaluation.maxConcurrency` is retained in existing databases but **no longer read**. Cancellation is persisted (`cancel_requested_at`), so it survives a queue wait or restart. On startup `running`/`pending` tasks fail with "Interrupted by a server restart" and `queued` ones reschedule — evaluations are never resumed mid-flight.

### Agent CLI: installed at runtime, not baked in

**The image preinstalls no Agent CLI.** The roster adds well over 1GB (plus CodeGraph) while a deployment typically binds one or two. Admin-only.

`provider-cli-lock.json` has two arrays: `providers` (CLI `kind` contract-tested against `PROVIDER_KINDS`) and `tools` — CLIs a2wave installs that are **not** Providers. CodeGraph is the only one today; it indexes SCM sources and has no Provider record, so putting it in `providers` would break that four-way contract. Installs reuse the lock and `scripts/provider-clis/install.mjs` with the same pinned versions and SHA-256/SRI verification the build once performed — there is no floating `curl | bash` path. Upgrading a version means editing the lock (reviewed via MR), not typing one into the UI.

- **Where they land**: `A2WAVE_CLI_INSTALL_ROOT` (`/home/appuser/.a2wave`), inside the persisted `a2wave-cli-home` volume — an image upgrade does not force a reinstall, but `docker compose down -v` deletes them. Both `bin/` and `npm/bin/` are on `PATH` and engines spawn bare names (`CLAUDE_CODE_PATH` defaults to `claude`), so no engine code is CLI-location-aware.
- **`installed` is always probed from `PATH`**, never read from the DB — a CLI can be removed outside a2wave, so `cli_installations` records the *job* (status / last error / output), not the truth. A missing row degrades to `idle`, not "not installed".
- **The lock pins an exact version, not a floor.** `versionOutputMatches()` compares whole tokens for equality; `PRESET_PROVIDERS.minVersion` is the *minimum* the engine gates on via `isVersionAtLeast()`. Conflating them is why `lockDrift` exists: reporting only match/mismatch made a build **newer** than the pin look outdated, and the offered "update" silently downgraded it while the engine was fine. `lockDrift` (`match` / `below` / `above` / `unknown`; null when not installed) carries direction so the UI offers "update" only for `below`.
- **`minVersion` floors are guarded by a snapshot, not derived.** `apps/api/src/engine/__tests__/cli-invocation-surface.test.ts` snapshots the CLI tokens each engine adapter can pass and fails on drift, so adding a flag that only exists in a newer CLI forces the author to confirm (or raise) the floor instead of silently invalidating it. The same file asserts every lock pin is `>=` its Provider's floor.
- **A floor can also be probed against reality.** The snapshot catches drift but cannot decide whether a floor is *right*. `node scripts/verify-provider-min-versions.mjs` (alias `pnpm provider-min-versions:verify`) reads that snapshot, installs each Provider's declared floor from npm into a temp dir, and checks the floor actually **accepts** every flag its adapter passes — the dangerous direction, since a floor set too low passes the version gate and then breaks at spawn time. Manually-run: it needs network and takes minutes, so it is not in `pnpm test` or the hooks (only its pure helpers are unit-tested; `--snapshot <path>` overrides the default snapshot location). Notes on reading its output:
  - Verdicts come from **acceptance probing**, not help-text scraping: a supported flag gets past argument parsing and fails later (a credentials error is a **positive** result). A `--version` **control gate** runs first, because some published builds fail everything identically and would otherwise read as "missing every flag".
  - **Acceptance probing only works on a CLI that rejects unknown flags detectably**, so a **classifier self-test** runs right after the control gate: a sentinel flag (`--a2wave-nonexistent-sentinel`) nothing can legitimately support is probed through the same two-phase path. If the CLI does not *reject* it, every verdict for that CLI is withheld. Not hypothetical — **qodercli 1.0.0 answers any unknown flag with its usage banner on exit 0** while `--version` returns a clean `1.0.0`, so it cleared the control gate, every flag classified as `accepted`, and the tool reported a confident all-clear for a floor it had never tested.
  - Probes run under an **allowlisted environment** with `HOME`/`TMPDIR` pointed at the throwaway install dir. These are published third-party builds being executed, so no ambient credential reaches them — and the empty `HOME` is also what guarantees the CLI finds no session and takes the deterministic "no API key" branch the classifier depends on.
  - Only npm-distributed CLIs are candidates (qoder / kimi / pi / codex); `curl | bash` installers publish no enumerable versions. Codex declares no floor, and **qoder fails the sentinel self-test — it is not probeable by this method at all**. Today's actually-verifiable set is therefore **kimi and pi**.
  - It exits non-zero **only** for a flag the floor genuinely rejects. **Exit 0 does not mean "all floors verified"**: a withheld Provider yields no evidence, which is not a failure but is not a pass either, so the report names the verified and the withheld set on every run. Read that, not the exit status.
  - A top-level rejection is downgraded to `inconclusive` **only when some candidate subcommand chain fails to reject the same flag** (every single bare word in the surface, then every ordered pair, capped at 12). The earlier blanket rule — "the surface contains any bare word, therefore excuse every rejection" — masked genuine defects on mixed surfaces like qoder and opencode, which carry top-level flags *and* a `status` subcommand. `kimi --json` is still correctly excused, because it really does parse as `kimi provider list --json`.
  - It cannot decide whether the CLI's **output shape** matches what the adapter parses, and it never says a floor is *higher* than it needs to be.
- A failed install cleans up its partial tree — no dangling symlink looks installed. Status is persisted, so a crash mid-install settles to `error` at startup instead of wedging in `installing` forever.
- `GET /api/agents/:id/diagnose` reports `provider_cli_not_installed` (severity `error`) when a bound Provider's CLI is absent; without it diagnosis reads all-green while every run fails at spawn with `ENOENT`. It reports `provider_cli_version_below_minimum` (severity `error`) when the CLI is installed but below that preset's `minVersion` floor. Neither blocks the run: no diagnose check does.
- **There is no standalone Agent CLI page** — install/update/uninstall live on the Providers list card and Provider detail page. CodeGraph therefore has **no UI entry** and is installed via the API.

### Channel-specific notes

- **Internal Admin API** (`/api/internal/admin/*`) is localhost-only, used by the platform-admin MCP, and **not filtered by owner** — it deliberately sees everything.
- **OAuth channel** attachment upload/consumption is isolated per user as `oauth:<issuer>:<sub>`.
- **Feishu connection status** (`/api/agents/feishu-connections`) reflects only the current API process; `meta.scope` states the multi-instance semantics.
- `workspacesPath` (SCM create/update) overrides the default worktree root `~/.a2wave/workspaces/<sourceIdSuffix>`. Absolute, globally unique.
- Auth methods: [docs/agent/oauth-channel.md](./docs/agent/oauth-channel.md). Unified call-context shape: [docs/agent/run-channel-context.md](./docs/agent/run-channel-context.md).
## UI Conventions

The web UI must follow the **design system tokens** (Tailwind semantic classes + `tokens.ts` / `globals.css` consistent with the antd theme); Modal/Dialog must stay consistent with existing wrappers such as [`apps/web/src/components/ui/dialog.tsx`](apps/web/src/components/ui/dialog.tsx). Detailed rules: [Design Tokens & antd alignment](./docs/agent/design-tokens.md); **i18n**: see [i18n conventions](./docs/agent/i18n.md). Component references: `apps/web/src/pages/agent-detail/publish-tab.tsx`, `apps/web/src/pages/agent-detail/index.tsx`.

## Testing

**All tests must pass before a feature is done or anything lands on main.** Per-app test conventions, commands and coverage rules live in each app's own `AGENTS.md`; E2E layout and fixtures in [e2e/AGENTS.md](./e2e/AGENTS.md); E2E environment prep and troubleshooting in [docs/agent/e2e.md](./docs/agent/e2e.md). This section holds only the repo-wide gates and the rules that decide whether a change is allowed to exist.

### TDD is mandatory

Red (failing test stating the expected behavior) → Green (minimum code to pass) → Refactor.

- **Production code not validated by a failing test must never be committed.**
- Bug fix ⇒ regression test reproducing the bug.
- New route or page ⇒ ships with E2E.
- New utility / pure function / React hook ⇒ unit test required. New API route ⇒ integration test required. Route or navigation change ⇒ E2E required.

### Gates — non-negotiable, `--no-verify` forbidden

| Gate | Command | Bar |
|------|------|------|
| Lint | `pnpm lint` | 0 errors. Warnings are debt; an MR must add none |
| Typecheck | `pnpm typecheck` | Fully green, **test files included** — type drift with nobody running tsc is how tests rot. Use the root script, not bare `pnpm -r typecheck`: it builds `@a2wave/shared` first, which every app resolves through its gitignored build output |
| Test | `pnpm test` | All pass; changed code ships with tests |
| E2E (recovery / task-queue / Feishu paths) | `bash scripts/e2e/restart-recovery.sh` | 4/4 scenarios |

Code coverage is **advisory**, not a merge gate. `pnpm test:coverage` remains
available for targeted review, but CI does not enforce a repository-wide
percentage: observable behavior and regression tests are the required bar.
This does not relax the TDD or changed-code testing requirements above.

Lint, typecheck and test also gate in CI. **E2E does not** — Playwright needs web + api running together, so run `pnpm test:all` locally.

**Onboarding E2E** (`pnpm test:e2e:onboarding`) is not a per-MR gate — it clones, installs and boots from scratch, so it costs minutes. Run it before a release, and whenever a change touches `.env.example`, `scripts/dev.mjs`, the install/build wiring, or the README's Local Development section: it is the only test that sees what a newcomer sees, since a resident working tree already has the `node_modules`, `packages/shared/dist` and `.env` a fresh clone lacks. Details: [docs/agent/e2e.md](./docs/agent/e2e.md#onboarding-e2e-fresh-clone-first-run-flow).

Never mask a pre-existing typecheck error with `@ts-ignore` / `@ts-nocheck`; if one is coupled to your change, fix it.

### CI jobs (GitHub Actions, [`.github/workflows/`](./.github/workflows/))

CI is an **orchestrated pipeline behind a single aggregate gate**: branch protection requires only `all-checks-pass`, which treats `skipped` as success and any `failure` as red — so adding or gating a job never needs a branch-protection edit, and a new job can never land unprotected. A `detect` job classifies the PR diff once (`scripts/ci/detect-changes.mjs` — pure, unit-tested, **fail-open**: unrecognised files and pipeline-touching paths turn every lane on, and push-to-main always runs everything, so lane skipping never weakens post-merge validation; skipping happens *inside* the workflow, never via `on.paths`, which would leave a required check pending forever). Always-on quality floor: `lint` (biome + repo-wide arch/forbidden-token/file-line sweeps + pinned `actionlint`), `typecheck`, `secret-scan` (gitleaks, full history), `audit` (`pnpm audit`, critical level). Lane-gated: `test-web`, `test-cli` (cli + the `scripts/` `node --test` groups), `test-api` (**4 parallel shards** through `scripts/gates/check-api-tests.mjs`), `license-inventory` (package.json/lockfile diffs), `pgschema` (regenerates `schema.pg.ts` and fails on any diff). `review-labels` blocks PRs touching CI-sensitive paths (workflows, gate scripts, `provider-cli-lock.json`, test configuration, DB migrations) until a maintainer adds the **`ci-reviewed` label** — the counterweight to merge-on-green. PR runs of the same ref cancel superseded runs; pushes to main never cancel. Merge-latency baseline lives in `scripts/ci/merge-latency.mjs` (run quarterly). Tag-triggered: `release` (`v*`), `docker` (`v*` + manual; `:latest` moves **only** on a tag run), `publish` (`v[0-9]+.[0-9]+.[0-9]+`, prerelease shape included — the CLI shares the platform version line, so there is no separate `cli-v*` tag; needs `NPM_TOKEN`). `release-check` warns when HEAD is ≥10 commits past the latest tag.

`check-api-tests.mjs` carries two waiver lists, `BASELINE` (per assertion) and `SUITE_BASELINE` (whole file); **both are now empty**, so every api test is under full regression protection. A waived file has no protection at all, so both lists shrink, never grow — an addition needs a recorded reason. The job must install **without** `--ignore-scripts` — `better-sqlite3` may build its native addon from source, and skipping install scripts fails every test on a missing addon instead of a real regression.

### Local hooks (husky v9, wired by `prepare` on `pnpm install`)

- **pre-commit** — `lint-staged` (biome autoformat) · `check-forbidden-tokens` · `check-arch-rules` · `check-docker-context` · `check-file-lines` (≤3000 lines/file; existing violations frozen in an allowlist, shrink-only)
- **commit-msg** — `check-commit-msg` enforces Conventional Commits (feat/fix/refactor/docs/test/chore/style/perf/build/ci/revert)
- **pre-push** — changed-file biome vs `origin/main` → shared build → `pnpm typecheck`

Gate scripts in `scripts/gates/` carry their own allowlists; `node scripts/gates/check-*.mjs --all` sweeps the whole repo.

**Architecture rules R1–R9**: ① apps must not import each other ② shared must not depend back on apps ③ `@/` is web-only ④ no `@ts-ignore`/`@ts-nocheck` ⑤ locales zh/en key sets aligned ⑥ `--no-verify` bypass is forbidden (no hook can block it; CI is the backstop) ⑦ every audit action/resource has zh+en copy ⑧ antd feedback APIs (`message` / `notification` / `Modal.confirm`) must come from `@/lib/antd-static`, never `from 'antd'` — the static instance renders outside `<StyleProvider layer>`, so its unlayered `a` reset repaints every sidebar link link-blue ⑨ `apps/web` must not pull in `@radix-ui/*` / `cmdk` / shadcn.

**Only R1–R5, R7 and R8 are mechanically enforced** — `check-arch-rules.mjs` prints `✓ all sources pass R1–R8` and skips R6 and R9, which sit in its second-wave backlog because both are heuristic and would need long-term allowlist tuning. Treat **R6 and R9 as review-enforced conventions**: adding a shadcn component or a `@radix-ui/*` dependency passes every local hook and CI job today, so a reviewer has to catch it.

### Coverage thresholds

Defined per app in `vitest.config.ts`: api 82/77/74/81, web 48/35/43/46, cli 80/82/72/78 (lines/functions/branches/statements).

Thresholds are a **ratchet against regression**, set just under measured coverage — not a target to aim down to. Raise them as tests land; **never lower one to make a red run green**. New modules aim for 80%+ lines. Enforced only in coverage mode, so `pnpm test:coverage` checks them and the plain CI runs do not — run it locally before pushing.

### Shared test utilities

`apps/api/src/test/` (barrel: `index.ts`) — `factories.ts` builds entities, `mock-db.ts` mocks the Drizzle chain, `test-app.ts` builds a Hono app with mock auth. **Unit tests never connect to a real DB.**

`apps/web/src/test/` — `setup.ts` (DOM globals), `render.tsx` (`renderWithProviders()` wrapping QueryClient + Router + i18n).

`e2e/utils/` — `auth.ts` (`loginAsAdmin()`, promise-cached so parallel specs do not trip rate limiting), `api-helpers.ts`, `test-constants.ts`.

Mock policy: external SDKs (Feishu, Anthropic) **must** be mocked; time via `vi.useFakeTimers()`; `createId()` mocked to deterministic ids; `logger` mocked. Tests live in `__tests__/` beside the source, named `<source>.test.ts(x)`.
## Conventions

- **Language**: English is the primary language of this repo — code comments, commit messages, docs, and log/error messages are written in English
- **IDs**: `agt_`, `prv_`, `mcp_`, `skl_`, `skg_`, `scm_`, `run_`, `rst_`, `msg_`, `usr_`, `aud_`, `art_`, `kbd_`, `att_`, `evs_`, `evc_`, `evt_`, `evr_` prefixes
- **Naming**: camelCase (TS), snake_case (DB)
- **Imports**: `@/` → `apps/web/src/`, `@a2wave/shared` for shared
- **Commits**: conventional (`feat:`, `fix:`, `refactor:`)
- **Product docs sync**: key business rule changes must be synced to [PRODUCT.md](./docs/PRODUCT.md)
- **User manual sync**: when adding or changing **user-facing** functionality (pages/routes, capability usage, trigger methods, workflows, terminology/limits), the in-app user manual (`/wiki`, content in `apps/web/src/content/manual/zh/`) must be updated in sync. **The `user-manual-sync` skill must be invoked** and followed per its conventions; when there is no user-visible change, note "manual update not needed" in the PR/commit.
- **Multi-language copy**: new or changed user-visible copy must maintain both `apps/web/src/locales/zh.json` and `en.json` (keys aligned), and update E2E as appropriate; details: [docs/agent/i18n.md](./docs/agent/i18n.md).
- **Page changes sync E2E**: when changing routes, navigation, page structure, or i18n copy, update the corresponding tests under `e2e/`. Navigation names match `nav` in `apps/web/src/locales/zh.json`; constants live in `e2e/utils/test-constants.ts`.
- **Audit logging**: **every new write operation (create/update/delete) must write an audit entry** via `logAudit()` (or `logBackgroundAudit()` for work with no request context). `details` is rendered verbatim to every admin, so it must **never** carry credentials, tokens, keys, or raw config — mask or hash instead. Each new action/resource needs zh + en copy, enforced by arch gate R7. Details: [docs/agent/audit-logging.md](./docs/agent/audit-logging.md).
- **Clean Code**: follow and use the `/clean-code` skill — meaningful naming, small functions, single responsibility, no side effects, avoid comment smells, Law of Demeter
- **Changelog sync**: when creating a git tag (release), add a matching version entry to `CHANGELOG.md` summarizing the changes
- **Release process**: update the CHANGELOG before creating a tag. Follow the `release-workflow` skill for the full release flow.
