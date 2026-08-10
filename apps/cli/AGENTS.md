# apps/cli — Agent Guide

The a2wave command-line tool. For global conventions see the root [AGENTS.md](../../AGENTS.md).

## Directory Structure

```
src/
├── commands/
│   ├── setup.ts      # setup (local platform install via docker compose)
│   ├── login.ts      # login / logout
│   ├── oauth.ts      # IDaaS OAuth browser flow used by login
│   ├── status.ts     # status (self-check: URL / credentials / health / current user)
│   ├── config.ts     # config set-url / get / unset-url
│   ├── skills.ts     # skills list/get/create/install/check-update/update-remote/update/delete
│   ├── agents.ts     # agents list/get/update/delete/stats + export/import/members/artifacts/memory + lifecycle
│   ├── chat.ts       # chat send (one-shot + interactive) / chat list / chat messages
│   ├── eval.ts       # eval sets / cases / run / tasks (evaluation replay + manual verdicts)
│   ├── mcp.ts        # mcp list / get / create / update / delete / tools
│   ├── scm.ts        # scm list/get/create/update/delete/sync/check/status + workspaces/codegraph
│   ├── kb.ts         # kb (knowledge base) list/get/create/upload/update/delete/sync/content
│   ├── providers.ts  # providers list/get/login-status/dependents (read-only)
│   ├── runs.ts       # runs list / get / logs / cancel / rerun / trigger
│   └── update.ts     # update / upgrade (upgrades the npm package)
├── client.ts         # HTTP client (fetch + Bearer auth) + all resolveXId name resolvers
├── config.ts         # Local config read/write (~/.a2wave/config.json)
├── lib/
│   ├── agent-yaml.ts # YAML parsing / reference resolution / diff for agents apply
│   ├── args.ts       # Shared flag utilities: toStringArray / parseKeyValues / confirmDestructive
│   ├── output.ts     # `--json` support: jsonArg flag fragment + emit() / wantsJson()
│   ├── prompt.ts     # readSecret(): echo-suppressed stdin read (login + setup password)
│   ├── setup-plan.ts # docker-compose / .env generation for `a2wave setup`
│   └── token-cache.ts# SSO OAuth token cache path resolution
├── version.ts        # Runtime version number reading
└── index.ts          # Entry point, registers all subcommands
scripts/
└── tag-release.sh    # Tag and push v<version>, triggering Release + Docker + CLI Publish
```

## Installation & Usage

For user installation, upgrades, and the maintainer release flow, see [CLI Install & Publish](../../docs/agent/cli-install-publish.md).

```bash
# 1. Build
pnpm --filter a2wave build

# 2. Global link (registers the a2wave command)
cd apps/cli && pnpm link --global

# 3. Use
a2wave login
a2wave skills list
a2wave runs trigger "Test Agent" --intent "Hello"
```

During development you can run the source directly:

```bash
pnpm --filter a2wave dev -- skills list
```

## Command Quick Reference

### Platform Install (setup)

| Command | Description |
|------|------|
| `a2wave setup` | Install a local a2wave platform: docker/compose preflight + port bind-probe, generate a minimal public `docker-compose.yml` + `.env` (0600, auto `AUTH_SECRET`, **never an admin password**), `compose up -d`, poll `http://localhost:<port>/api/health` (crash-looping containers fail fast with logs), then save the instance URL into `~/.a2wave/config.json` — only after health passes, and the login token is kept only when the URL is unchanged. Requires a nonexistent or **empty** install dir (setup owns it; `--down` deletes it recursively) and writes a `.a2wave-install` ownership marker |
| `a2wave setup` (admin password) | Once healthy, **on a TTY and without `--yes`**, prompts for the admin password twice with the echo suppressed and POSTs it to `/api/auth/setup` on the local port. `--yes` suppresses it even on a TTY — that flag means "no prompting", and automation which allocates a PTY (expect, `ssh -t`, some CI runners) would otherwise block on a hidden prompt. The value never touches `.env`, the compose file, container env, argv or stdout — there is deliberately **no `--admin-password` flag**, since argv is visible in `ps` and lands in shell history. An empty first answer skips to the web setup screen; mismatches and policy violations (≥8 chars, upper + lower + digit, mirroring the server) re-prompt up to 3 times without an API call. Best-effort: a rejected or unreachable POST prints the reason and falls back to the web-screen hint rather than failing an install that already succeeded |
| `a2wave setup --yes` | Non-interactive with defaults (`~/a2wave`, port 3502). Required in CI/pipes — prompting without a TTY errors out |
| `a2wave setup --dir/--port/--image/--base-url/--health-timeout/--no-start` | Overrides. `--base-url` must be a pure origin (LAN/reverse-proxy installs; drives `CORS_ORIGIN` + cookie security; health still probes localhost). **`--image` defaults to `ghcr.io/lilithgames/a2wave:<cli-version>`** — the published GHCR image for this CLI's own version, since the platform and the CLI share one version line; a floating `latest` default would pair a CLI with a platform build it was never tested against, and the tag carries no leading `v` because `docker.yml` strips it. Pass the flag to install a locally built or mirrored ref; validated against the docker reference charset. The `.env` persists a unique `COMPOSE_PROJECT_NAME` and every compose invocation passes it explicitly via `-p` (shell env beats `.env` in Compose precedence, so `-p` is the only override-proof channel) — same-basename install dirs can never share Docker volumes. Health accepts only `status:"ok"` — HTTP 200 + `degraded` fails the install |
| `a2wave setup --database-url <postgres://…>` / `--with-postgres` | **EXPERIMENTAL PostgreSQL backend** (no SQLite → PostgreSQL data migration; starts from an empty database). `--database-url` points at an external server — validated as a `postgres://`/`postgresql://` URL with a whitespace/control-character guard, because `new URL()` silently *strips* newlines and the value lands in `.env`, where a newline starts a new env line; a literal `$` is likewise rejected (percent-encode as `%24`) since Compose interpolates unquoted `.env` values and would mangle it into a variable expansion. `--with-postgres` instead bundles a `postgres:16-alpine` sidecar into the generated compose file (healthcheck + `depends_on: service_healthy`, 5432 `expose`d but never published on the host) and derives `DATABASE_URL=postgres://a2wave:<generated-hex>@postgres:5432/a2wave`; the password is hex precisely so the URL and the `POSTGRES_PASSWORD` key cannot disagree over percent-encoding, and it lives only in the 0600 `.env` (the compose file reads `${POSTGRES_PASSWORD:?}`). The two flags are **mutually exclusive** (the sidecar derives its own URL) and both are **rejected with `--upgrade`** (an upgrade never rewrites `.env`). The generated compose reads `DATABASE_URL=${DATABASE_URL:-/app/data/a2wave.db}` — same pattern as `A2WAVE_IMAGE`: switching backends is a one-line `.env` edit, and a hardcoded value in `environment:` would override `env_file` and make the `.env` key silently inert. `composeChildEnv` therefore also **deletes `DATABASE_URL` / `POSTGRES_PASSWORD` from every compose child env** — `DATABASE_URL` is the likeliest exported shell variable of them all, and Compose prefers the process environment over the install `.env`. In the sidecar layout `image:` stays the **first** key of the a2wave service, or `--upgrade`'s already-migrated check would misread the generated file as hand-edited. A localhost `--database-url` prints a `host.docker.internal` warning (inside the container, localhost is the container). `--upgrade` on a PostgreSQL install warns that the data-volume backup does **not** cover the database. AUTH_SECRET stays explicit in `.env`, which is what keeps the entrypoint's "PostgreSQL requires an explicit AUTH_SECRET" gate green |
| `a2wave setup --reset-password` | **Forgot the admin password.** Runs the in-image recovery script (`apps/api/dist/scripts/set-admin-password.js`) via `compose exec --user appuser` against the running install — `--user` matters because `exec` bypasses the entrypoint's privilege drop and defaults to root otherwise. The script draws its own masked prompt with `stdio: 'inherit'`, so the password is typed **inside the container** and never passes through the CLI process, argv, or the environment — deliberately not a flag, for the same reason. Bumps the admin's `tokenVersion` (revokes every outstanding session/token) and writes an `admin.password_reset` audit entry. Takes effect immediately; **no restart**. Requires a TTY and rejects `--yes` (there is no non-interactive way to supply the new password). Same ownership guards as `--down`: refuses a dir without the `.a2wave-install` marker, and fails closed without a trusted `COMPOSE_PROJECT_NAME`. Writes nothing and never starts a container, and is **mutually exclusive with `--down`** (passing both errors rather than silently picking one). On failure it asks docker whether the container is actually running before diagnosing — with `stdio: 'inherit'` compose's own message goes to the terminal, not the error object, so a stopped container and a script that refused the password are otherwise indistinguishable. **Do not** try to recover via `ADMIN_PASSWORD` — it is applied only when the admin has no password at all (first-boot bootstrap), and is silently ignored otherwise, so editing it while locked out has no effect |
| `a2wave setup --upgrade --image <ref>` | **Upgrade in place.** The image lives in `.env` as `A2WAVE_IMAGE`; `docker-compose.yml` only reads it via `${A2WAVE_IMAGE:-<default>}`, so an upgrade rewrites **one env key** and never has to understand YAML. (Rewriting a line inside the compose file was the original design and cost six distinct false-match shapes — first-match, an `image` key under `environment:`, a top-level `x-template`, an `x-template` nested under a sibling service, a deeply-indented comment fixing the wrong service-name indent, and a missing block-end guard — each of which silently repointed the **wrong service** while the old image still passed health and the CLI reported success.) A legacy install whose compose file hardcodes the ref is **migrated to the variable first**, otherwise the new value would be ignored and the upgrade would report success on the old image — but only when the file matches the single-service layout `buildComposeFile` emits. Anything hand-edited (a sidecar, an anchor block, a quoted value, a second service) is **refused with the exact one-line edit to make**, and "already migrated" is decided by the a2wave service's own image line rather than a whole-file substring search — a sidecar merely *mentioning* `A2WAVE_IMAGE` used to skip the migration and leave a2wave hardcoded, never guessed at: picking "the first `image:` line" repointed the sidecar and left a2wave stale, which is the same wrong-service class the variable exists to eliminate. **Backs up the data volume before anything moves**: stops the container (a live SQLite file can be copied mid-write), packs the volume into `a2wave-data-<stamp>.tar.gz` in the install dir. The volume is **the one the container actually mounts at `/app/data`** (`compose ps` → `docker inspect`), and when that cannot be proven the upgrade **fails closed** rather than falling back to the conventional `<project>_a2wave-data` name — that guess looks safe because the name is existence-checked first, but the documented recovery procedure moves an install onto an external `<project>_a2wave-restore` volume while leaving the old one in place, so "it exists" is true of exactly the stale volume. Archiving that reports a good snapshot while the real data has none, right before a possibly irreversible migration. The `docker run` carries **`--user $(id -u):$(id -g)`** and the archive is chmod **0600**: without `--user`, tar runs as root and the bind mount lands a root-owned `0644` file that a non-root CLI user then cannot chmod — leaving a world-readable copy of every credential the platform holds. A failed chmod is a **hard error**, not best-effort, since swallowing it reproduces exactly that. Only the newest **3** archives are kept, and **restarts the container** before aborting if that fails — the stop happens first, so bailing out without a restart would leave the install down while claiming it was untouched. `--no-backup` skips the snapshot. Then `pull` + `up -d --no-deps` **scoped to the a2wave service** (a bare call would pull and recreate hand-added sidecars too). Every compose invocation passes **both** `-p <project>` and `-f <install>/docker-compose.yml`, each shell-quoted — `COMPOSE_FILE` in the caller's environment beats cwd, and an unquoted path breaks on a space. **Both** `A2WAVE_IMAGE` and `A2WAVE_PORT` are decided in the child env rather than inherited — Compose prefers the process environment over `.env`, so an exported `A2WAVE_IMAGE` would start *that* image while this command rewrote `.env` to `--image`, and health would pass against the hijacked ref. The rollback pins the restore target instead, or it would restart the image that just failed. `A2WAVE_PORT` is pinned **only when `.env` actually recorded one**, and explicitly deleted otherwise: injecting a guessed default would beat the compose file's own `${A2WAVE_PORT:-<installPort>}` fallback and silently republish the container on a different host port. Everything else in `.env` survives byte-for-byte, and the data volume is never deleted (`-v`/`--volumes` appear nowhere). Success requires **readiness**, not just liveness — `/api/health` turns green when the port opens but seeding runs after that, so `/api/health/ready` is polled too (a 404 is accepted; older images predate the route). Both probes carry a per-request `AbortSignal` bounded by the remaining budget, or a container that accepts the socket and never sends headers would hold `fetch` open past `--health-timeout`. **On a failed `up -d`, health check or readiness check the previous value is restored, brought back up, and re-verified** — `compose up` stops the old container before starting the replacement, so restoring the value alone would turn a failed upgrade into an outage. The previously-running image is pinned to an immutable `a2wave:rollback-<id>` tag **whenever it could be captured** (read via `ps` + `docker inspect`, never `compose images`, which already resolves to the new image), never gated on the refs being equal strings — `a2wave` and `a2wave:latest` differ textually but resolve to the same moving tag. No early return when the ref is unchanged: a mutable tag says nothing about the image behind it, and an upgrade interrupted after the rewrite would otherwise report "nothing to upgrade" and leave the instance down. Cannot be combined with `--down`, `--reset-password`, `--base-url`, `--port`, or `--no-start` — checked **before any mode branch dispatches**, since `--down` and `--reset-password` each return on their own |
| `a2wave setup --down` | Uninstall: `docker compose down -v` + remove the install dir. Refuses directories without the `.a2wave-install` marker, and **fails closed** when no trusted `COMPOSE_PROJECT_NAME` can be read from the install's `.env` (a bare `compose down -v` under an external env var could target another project's volumes); interactive confirmation requires typing the install dir path (3 attempts); non-interactive requires `--yes-destroy-all-data` — `--yes` alone never bypasses it |

### Authentication

| Command | Description |
|------|------|
| `a2wave login` | **Pure SSO (OAuth)**: launches browser SSO (or reuses the cached SSO token); the token is written to the SSO token cache + the `token` field in `~/.a2wave/config.json`. **No parameters required**.|
| `a2wave login --idaas-token <jwt>` | CI / headless: manually pass an IDaaS JWT once, skipping the browser |
| `a2wave login --no-browser` | Only reuse the existing cache, don't launch the browser |
| `a2wave login --password` | Legacy username + password login (requires setting the instance URL first via `a2wave config set-url`) |
| `a2wave logout` | Clear local credentials (keeps the SSO token cache) |
| `a2wave status` | One-stop self-check: URL / IDaaS cache / a2wave credentials / backend health / current user. First choice for diagnosing "why 401" or "is the token expired" |

> Login does not need `--url`. Set the a2wave instance URL globally via **`a2wave config set-url`**, or override it per data command with `--url` / `$A2WAVE_URL`.

### Configuration (URL setup)

The a2wave service address is not hardcoded; it is provided by the user. Three sources (highest priority first):

| Command | Scope |
|------|------|
| `<command> --url <url>` | **One-off**: effective only for this command, not persisted |
| `export A2WAVE_URL=<url>` | **Shell-persistent**: effective for all commands in the current shell |
| `a2wave config set-url <url>` | **Globally persistent**: written to `~/.a2wave/config.json`, effective across shells |
| `a2wave config get` | Show current config (token auto-masked to last 4 characters) |
| `a2wave config unset-url` | Clear the global URL (keeps the token) |

Example:
```bash
# First time: log in + set the global URL
a2wave login                                    # get token (no --url needed)
a2wave config set-url http://localhost:3502     # set the global URL

# Afterwards: all commands work out of the box
a2wave skills list
a2wave agents list

# Temporarily switch to staging
a2wave skills list --url https://staging.example.com

# CI scenario: env var
A2WAVE_URL=$STAGING_URL a2wave agents apply -f bot.yaml
```

See [docs/agent/cli-oauth.md](../../docs/agent/cli-oauth.md) for details.

### Skills

| Command | Description |
|------|------|
| `a2wave skills list` | List all Skills |
| `a2wave skills get <id\|name>` | View Skill details |
| `a2wave skills create --name X --content-file ./SKILL.md [--group <id\|name>]` | Create via fields |
| `a2wave skills create --file ./skill.zip` | Create by uploading a .md/.zip |
| `a2wave skills create --url <skills.sh-or-github-url> [--skill <name\|path> \| --all]` | Remote installation by URL |
| `a2wave skills install <skills.sh-or-github-url> [--skill <name\|path> \| --all] [--group <id\|name>]` | Install public GitHub-backed Skills from an immutable commit snapshot |
| `a2wave skills check-update <id\|name>` | Explicitly compare installed, local, and latest upstream files |
| `a2wave skills update-remote <id\|name> [--strategy abort\|preserve-local\|overwrite]` | Apply a checked remote update with explicit conflict handling |
| `a2wave skills update <id\|name> --content "..."` | Update instruction content |
| `a2wave skills update <id\|name> --content-file ./SKILL.md` | Update content from a file |
| `a2wave skills update <id\|name> --name "..." --description "..."` | Update name/description |
| `a2wave skills update <id\|name> --file ./skill.zip` | Full package replacement (.md or .zip) |
| `a2wave skills delete <id\|name> [--force]` | Delete Skill (irreversible; confirms by default; non-interactive needs `--force`) |

### Agents

| Command | Description |
|------|------|
| `a2wave agents list` | List all Agents |
| `a2wave agents get <id\|name>` | View Agent details (incl. Skills, System Prompt) |
| `a2wave agents update <id\|name> --name "..."` | Update name |
| `a2wave agents update <id\|name> --description "..."` | Update description |
| `a2wave agents update <id\|name> --system-prompt "..."` | Update System Prompt |
| `a2wave agents update <id\|name> --add-skill <name\|id>` | Add a Skill |
| `a2wave agents update <id\|name> --remove-skill <name\|id>` | Remove a Skill |
| `a2wave agents update <id\|name> --add-mcp <name\|id>` | Add an MCP Server |
| `a2wave agents update <id\|name> --remove-mcp <name\|id>` | Remove an MCP Server |
| `a2wave agents apply -f agent.yaml` | Idempotent apply: look up by name; POST if absent, otherwise PATCH only changed fields |
| `a2wave agents apply -f agent.yaml --dry-run` | Only print the changes that would be made; no write API calls |
| `a2wave agents apply -f agent.yaml --no-publish` | Ignore the publish block in the yaml; stay in draft |
| `a2wave agents apply --example` | Print a full example yaml to stdout (redirect to a file as a starter template) |
| `a2wave agents publish <id\|name>` | Publish; supports `--channels api,feishu --auth-type api_key --regenerate-api-key` |
| `a2wave agents stop <id\|name>` | Stop a published agent |
| `a2wave agents resume <id\|name>` | Resume a stopped agent |
| `a2wave agents clone <id\|name>` | Clone; the new agent is named "<original> (Copy)" with draft status |
| `a2wave agents delete <id\|name> [--force]` | Delete Agent (irreversible; confirms by default; non-interactive needs `--force`) |
| `a2wave agents regenerate-api-key <id\|name>` | Rotate endpointApiKey; the old key becomes invalid immediately |
| `a2wave agents diagnose <id\|name>` | Comprehensive diagnosis: execution engine / Provider / Feishu / gateway signing, etc.; exit=1 on error |
| `a2wave agents stats <id\|name>` | Overview statistics (KPI / user count / channel distribution); note /stats returns an object directly, not wrapped in `{ data }` |
| `a2wave agents export <id\|name> [-o file.zip]` | Export the full Agent config as a ZIP (filename from `content-disposition` when `-o` is omitted) |
| `a2wave agents import <file.zip>` | Import an Agent from a ZIP; reports the created Agent plus any MCP Servers / Skills and warnings |
| `a2wave agents import-url <url> [--header "K: V"]` | Import from a remote a2wave instance's export URL |
| `a2wave agents members list\|add\|update\|remove ...` | Members: `add --user <id\|name> --role viewer\|editor`; owner-only for writes |
| `a2wave agents artifacts list\|download\|delete ...` | Artifacts: list `?agentId=`; download takes only the basename of the server filename into the current directory (prevents path traversal), needs `--force` if the target exists; delete |
| `a2wave agents memory stats\|search\|reindex\|consolidate ...` | Memory: via `/api/memories/:agentId/*` (memoryAuthMiddleware) |

### Chat

| Command | Description |
|------|------|
| `a2wave chat send <agent> -m "..."` | Send one message and print the streamed reply; prints the `chatId` for follow-ups |
| `a2wave chat send <agent> -m "..." --chat-id <id>` | Continue an existing session (multi-turn) |
| `a2wave chat send <agent>` | Open an interactive session (requires a TTY); `exit` / Ctrl-D to quit. A failed turn is reported without ending the session |
| `a2wave chat send <agent> -m "..." --no-stream` | Wait for the complete reply instead of streaming tokens |
| `a2wave chat send <agent> -m "..." --json` | Emit `{data: {reply, chatId, runId, queued?}}` as one JSON object — note the `data` wrapper, matching every other command (implies `--no-stream`; requires `-m`) |
| `a2wave chat list <agent>` | List the Agent's chat sessions. Prints **both** ids: the `run_xxx` (for `chat messages`) and the `chat-id` (for `--chat-id`) — they are different, and passing a run id to `--chat-id` silently starts a new conversation instead of resuming |
| `a2wave chat messages <agent> <runId>` | Print the messages of one session |

> Chat is available to **viewer** permission and up (debug access), matching `POST /api/agents/:id/chat`.
>
> **Full queue**: when the Agent has no free concurrency slot the server accepts the run and answers `queued` (a bare `{status, runId}` with no `data` wrapper on the sync path, a lone `queued` SSE event with no `done` on the streaming one). Both are reported as an accepted run with its `runId`, not as an error — follow it with `a2wave runs get <runId>`.
>
> The one-shot form lives under `chat send`, not bare `chat <agent>`: citty routes on the first non-flag argument, so a parent command owning both a positional and subcommands makes `chat my-agent` parse as an unknown subcommand name.

### citty argument pitfalls (enforced by tests)

Two structural rules are checked by [src/__tests__/command-structure.test.ts](./src/__tests__/command-structure.test.ts), because both classes of bug are invisible to unit tests that call a command's `run()` directly:

| Rule | Why |
|------|------|
| A node with `subCommands` must declare **no positional** | citty resolves the first non-flag argument against `subCommands`; a positional on the same node is unreachable and errors with `Unknown command`. |
| Never declare an arg named `no-<x>` | citty parses `--no-x` as negation of `x`, setting `args.x = false` — it never populates an arg literally named `no-x`, so the flag is silently inert. Declare `x` with `default: true` and read `args.x === false`; the `--no-x` spelling still works and still shows up in `--help`. |

### Evaluation

| Command | Description |
|------|------|
| `a2wave eval sets list\|create\|update\|delete <agent> ...` | Manage evaluation sets (`create --name X [--description Y]`) |
| `a2wave eval cases list <agent> <set>` | List the cases of a set, in `sortOrder` |
| `a2wave eval cases add <agent> <set> --name X --request "..." [--expected "..."]` | Add a single-turn case |
| `a2wave eval cases import <agent> <set> -f cases.yaml` | Bulk-import cases from YAML or JSON (see the format below). There is no bulk endpoint or transaction, so a mid-way failure leaves a **partial import** — the CLI prints how many cases landed and names them, since a blind retry would duplicate them |
| `a2wave eval cases delete <agent> <set> <caseId>` | Delete one case |
| `a2wave eval run <agent> --set <id\|name>` | Start an evaluation task; returns immediately with the task ID |
| `a2wave eval run <agent> --set X --wait [--fail-on-fail]` | Poll to completion. Exits 1 when the **task** fails/cancels; `--fail-on-fail` also exits 1 when any case carries a `fail` verdict **or errored during replay** (CI gate). Both signals are needed: `summary.failed` counts manual verdicts only (always 0 on a fresh run), while a case that errors leaves the task `completed` — gating on either alone makes the check green by construction |
| `a2wave eval tasks list\|get <agent> [taskId]` | List tasks (newest first) / show one task with per-case results |
| `a2wave eval tasks verdict <agent> <taskId> <resultId> --verdict pass\|fail\|unreviewed [--note "..."]` | Record a manual verdict |
| `a2wave eval tasks cancel <agent> <taskId>` | Request cancellation (a running task stops **between cases**) |
| `a2wave eval tasks delete <agent> <taskId>` | Delete a task and its results |

Cases file format (YAML or JSON — a bare list, or `cases:` wrapping one):

```yaml
- name: greeting                 # optional; defaults to case-1, case-2, ...
  request: Hello                 # single-turn shorthand
  expectedResponse: Hi there
- name: multi-turn
  turns:                         # explicit form for multi-turn cases
    - request: What is 2+2?
      expectedResponse: "4"
    - request: And times 3?
      expectedResponse: "12"
```

> Evaluations do **not** write to the `runs` table; auditability comes from an `evaluation_task.execute` audit entry. Verdicts are manual in v1. Each task freezes a provider/model/prompt snapshot.

> Delete commands (`agents delete` / `skills delete`) replace the old convention of "delete only via the Web UI":
> because deletion is irreversible, an interactive terminal asks for confirmation by default, and non-interactive use (pipes/CI) requires an explicit `--force`.
> Also, when deleting by name with duplicates (`name` has no uniqueness constraint), the CLI **errors out and lists candidates** instead of mistakenly deleting the first match —
> use `agt_`/`skl_` IDs to specify precisely.

### MCP Server

| Command | Description |
|------|------|
| `a2wave mcp list` | List all MCP Servers |
| `a2wave mcp get <id\|name>` | View details |
| `a2wave mcp create --name X --type stdio --command ... [--arg ...] [--env k=v]` | Create; `--arg/--header/--env` are repeatable |
| `a2wave mcp create --name X --type http --endpoint <url>` | Use `--endpoint` for sse/http server addresses (avoids `--url`) |
| `a2wave mcp update <id\|name> ...` | Update fields |
| `a2wave mcp delete <id\|name>` | Delete (returns 409 if referenced by a group) |
| `a2wave mcp tools <id\|name>` | Connect and list the tools the server exposes |

> For the `group` type, use `--config-file <json>` as the fallback for groupConfig.

### SCM Source

| Command | Description |
|------|------|
| `a2wave scm list` / `get <id\|name>` | List / view details |
| `a2wave scm create --type git --name X --local-path P --repo-url U` | Create a git source |
| `a2wave scm create --type p4 --name X --local-path P --p4port ... --p4user ... --p4client ...` | Create a p4 source |
| `a2wave scm update <id\|name> ...` | Update (excludes type; use `--config-file` for complex config) |
| `a2wave scm delete <id\|name>` | Delete (returns 409 if referenced by an agent) |
| `a2wave scm sync\|check\|status <id\|name>` | Trigger sync / check connectivity / status snapshot |
| `a2wave scm workspaces list <id\|name>` | List worktrees with their `occupied` status (a run currently holding them) |
| `a2wave scm workspaces remove <id\|name> <worktree>` | Delete one worktree (409 when occupied; confirms by default, `--force` for CI) |
| `a2wave scm codegraph reindex <id\|name>` | Rebuild the CodeGraph index (400 when CodeGraph is disabled, 409 while the checkout is busy) |

### Knowledge Base (KB Document)

| Command | Description |
|------|------|
| `a2wave kb list` / `get <id\|name>` | List / view details |
| `a2wave kb create --name X --feishu-url U --feishu-app-id ... --feishu-app-secret ...` | Create a Feishu source |
| `a2wave kb create --name X --notion-url U --notion-token ...` | Create a Notion source (`--feishu-url` and `--notion-url` are mutually exclusive) |
| `a2wave kb upload --file ./notes.md` | Upload a local .md/.txt (document name taken from the filename) |
| `a2wave kb update <id\|name> --auto-sync` | Update metadata |
| `a2wave kb update <id\|name> --notion-url <url> --notion-token <token>` | Rotate the Notion page or token (either may be provided alone) |
| `a2wave kb delete <id\|name>` | Delete |
| `a2wave kb sync\|content <id\|name>` | Re-fetch from Feishu / Notion / print cached content |

### Provider

Providers are preset entities (no create; delete always returns 403). The CLI is mostly read-only plus allowlist editing:

| Command | Description |
|------|------|
| `a2wave providers list` / `get <id\|name>` | List / view Providers (models are probed per Agent credential, not stored) |
| `a2wave providers login-status <cursor\|claude-code\|codex\|opencode\|qoder\|trae\|kimi\|pi>` | Check local CLI login state |
| `a2wave providers dependents <id\|name>` | Agents that depend on this Provider |

#### YAML Format (full field overview)

`a2wave agents apply --example` prints the complete annotated example. Core fields:

```yaml
name: my-bot                          # Required; used as the lookup key for idempotent apply
description: Handle Feishu notifications for me
type: cursor                          # Defaults to cursor
icon: "🤖"
systemPrompt: |
  You are an internal company assistant...

# References (all resolved by name to the corresponding ID)
provider: claude-code-builtin         # → prv_xxx
skills: [lark-mail, lark-im]          # → skl_xxx[]
skillGroups: [feishu-tools]           # → skg_xxx[] (mounts the whole group; merged with skills at runtime)
mcpServers: [lark-cli]                # → mcp_xxx[]
kbDocuments: [faq, company-policies]  # → kbd_xxx[]
workspace:
  type: temp                          # temp | scm; when scm, set source
  # source: my-repo                   # → scm_xxx

maxConcurrency: 1                     # 1-5
env:
  LARK_APP_ID:
    value: ${LARK_APP_ID}             # ${ENV} / ${ENV:-default} expanded client-side at apply time
    sensitive: true

# Full Feishu channel config (13 fields; see --example)
feishuConfig:
  appId: ${FEISHU_APP_ID}
  appSecret: ${FEISHU_APP_SECRET}
  groupTriggerOnAt: true
  groupReplyMode: quote               # quote | new | none
  replyContentType: text              # text | post | interactive | streaming_card
  # ... 8 more fields

# Schedule trigger
scheduleConfig:
  cron: "0 9 * * 1-5"                 # 5-field cron
  intent: Send the daily report reminder at 9 AM
  timezone: Asia/Shanghai             # Defaults to Asia/Shanghai

# Publish block (optional; /publish is called automatically after apply)
publish:
  channels: [api, feishu]             # api | a2a | feishu | schedule | oauth
  authType: api_key                   # none | api_key
  ipWhitelist: []
  description: Public API documentation
  regenerateApiKey: false             # true = rotate endpointApiKey
```

Referenced resources support both forms: `provider: name` or `provider: prv_xxx`. `${ENV}` placeholders are expanded client-side, keeping sensitive values in the shell env instead of the yaml.

### Runs

| Command | Description |
|------|------|
| `a2wave runs list [--agent <name\|id>]` | List runs, optionally filtered by Agent |
| `a2wave runs list --page 2 --limit 50` | Paginate (`--limit` clamps to the API's 1..100 window; a footer shows the next page) |
| `a2wave runs list --status failed` | Filter by status. **Narrows the current page only** — the API has no status filter, so the CLI says so in the human output, and stamps a `filter` block into `--json` so a partial count cannot be read as a total |
| `a2wave runs get <id>` | View Run details and execution logs. Prints **every** step of a multi-turn run, ordered by `order` |
| `a2wave runs logs <id> [-o file]` | Download the NDJSON sidecar log; stdout by default. Not subject to the `MAX_STREAM_LOGS` cap that truncates the DB copy shown by `runs get`, but it has **its own** limits: the server stops at **256 MiB** and writes a cap marker, and can record `dropped` markers under sustained backpressure. Streamed to disk/stdout rather than buffered; `-o` writes to a temp file and renames on success, so an interrupted download never destroys a previous log |
| `a2wave runs cancel <id>` | Cancel a queued or running run (400 when it is already terminal) |
| `a2wave runs rerun <id> [--wait]` | Replay a run with its original intent and attachments. The server starts it, so the CLI **never** calls `/execute` afterwards. `--wait` polls to a terminal status and exits 1 on failure |
| `a2wave runs trigger <agent> --intent "..."` | Trigger Agent execution with real-time SSE streaming output |

### Update

| Command | Description |
|------|------|
| `a2wave update` | Check for and update the a2wave CLI to the latest published version. Queries the npm default registry unless `$A2WAVE_NPM_REGISTRY` points at a mirror |
| `a2wave upgrade` | Alias for `a2wave update` |

## Machine-readable output (`--json`)

Read-oriented commands accept `--json` and print the **raw API payload** instead of the human-formatted columns, so scripts and CI never have to scrape output:

```bash
a2wave agents list --json | jq -r '.data[] | select(.publishStatus=="published") | .id'
# --status narrows the CURRENT PAGE only; the payload carries a `filter` block
# ({status, scope:"page", matchedOnPage, scannedOnPage}) so a partial count is
# never mistaken for a total. Raise --limit to widen the window.
a2wave runs list --status failed --json | jq '.filter.matchedOnPage'
a2wave chat send my-bot -m "ping" --json | jq -r '.data.reply'
```

Rules:

- The flag comes from the shared `jsonArg` fragment in [src/lib/output.ts](./src/lib/output.ts); commands call `if (emit(args, result)) return` before their own formatting, so the two modes can never both print.
- **Credentials are redacted by default.** The API returns secrets in plaintext to an owner/editor (the Web UI gates that behind a "click the eye" affordance), but CLI output lands in terminal scrollback, shell history and CI logs. Pass **`--show-secrets`** to print them verbatim; only do so when piping to a secure consumer. Four rules, because secrets arrive in four shapes:

  | Rule | Covers |
  |------|--------|
  | Key **name** looks like a credential | `appSecret`, `providerApiKey`, `providerOauthToken`, `endpointApiKey`, `providerBaseUrl`, `pat`, `p4passwd`, plus any key ending `secret` / `token` / `apikey` / `password` |
  | Key is an **env entry** `{value, sensitive: true}` | Agent env vars — the marker is the sibling flag, since var names are arbitrary |
  | Key is a **secret container** (`env`, `headers`) | MCP servers store credentials in free-form maps the operator names, so **every value** inside is masked regardless of name; the keys stay visible |
  | Key holds a **URL** (`url`, `repoUrl`, `endpoint`, `baseUrl`) | Only the credential-bearing *parts* are masked — userinfo, query, fragment, and opaque token-like path segments. Scheme, host and ordinary path survive, so links stay usable and the server's `********@host/path` sentinel still round-trips through `scm update --config-file` |
- `--json` prints exactly **one** JSON document to stdout. `a2wave chat --json` therefore implies `--no-stream` (streamed tokens would interleave) and requires `-m/--message` — an interactive session has no single payload.
- Errors still go to stderr as plain text with a non-zero exit code; `--json` shapes success output only.

## Numeric flag parsing

Every integer flag (`--page`, `--limit`, `--sync-interval`) goes through
`parseIntFlag`, which accepts **plain decimals only** — optionally signed and
whitespace-padded. Hex (`0x10`), binary (`0b11`), exponent (`1e3`) and empty
values are rejected rather than reinterpreted: `--page 0x10` silently fetching
page 16 is exactly the class of surprise this guards against. Values beyond the
safe integer range are rejected separately, with their own message.

`--limit` is additionally **clamped** to the API's 1..100 window rather than
rejected, since `--limit 1000` as shorthand for "everything" is an established
habit and the API clamps regardless.

## Exit codes

`0` on success, `1` on any `CliError` (auth, validation, API error). Two commands set `1` on a *successful* API call to act as CI gates:

- `a2wave runs rerun --wait` — the replayed run ended `failed` or `cancelled`
- `a2wave eval run --wait` — the task ended `failed`/`cancelled`, or (with `--fail-on-fail`) any case carries a `fail` verdict

Both set the exit code **before** emitting output, so combining them with `--json` still fails the build — otherwise the early `--json` return would silently exit 0.

## ID / Name Resolution

All commands that accept `<id|name>` support two input forms:

- **ID** (prefixed with `skl_`, `agt_`, etc.): calls the API directly
- **Name**: queries the list first and matches exactly by `name`, then calls with the resolved ID

Ambiguous names **error out and list the candidates** rather than silently taking the first match — this applies to Skills / Agents / MCP Servers / SCM Sources / KB Documents / Skill Groups / users, and to evaluation sets (`evs_`) within one Agent.

## Local Configuration

```
~/.a2wave/config.json
{
  "url": "https://your-a2wave.com",
  "token": "eyJ..."
}
```

`a2wave login` writes it automatically and `a2wave logout` clears it. All commands read this file at startup and prompt for re-login when it is missing or invalid.

## Key References

| File | Description |
|------|------|
| [src/client.ts](./src/client.ts) | HTTP client, unified auth and error handling |
| [src/config.ts](./src/config.ts) | Local config read/write |
| [package.json](./package.json) | Available scripts, bin entry |

## Build & Release

| Command | Description |
|------|------|
| `pnpm --filter a2wave build` | tsup compiles to `dist/index.cjs` |
| `pnpm --filter a2wave dev` | Run the source directly with tsx |
| `pnpm --filter a2wave typecheck` | TypeScript type checking |
| `bash apps/cli/scripts/tag-release.sh <version>` | Tag `v<version>` and push it, triggering the release workflows |

The companion AI skill source lives in `skills/a2wave-cli/` at the repo root. When updating CLI behavior, command conventions, or troubleshooting flows, update that skill in sync. `a2wave update` upgrades the npm package only; it does not install or update the skill.

### Release Process

The platform and the CLI share **one version line**, so a single `v*` tag drives
the npm publish alongside the Release and Docker workflows. The **CLI Publish**
workflow ([`.github/workflows/cli-publish.yml`](../../.github/workflows/cli-publish.yml))
handles the npm half.

```bash
# 1. Bump BOTH manifests to the same version, then commit and push
npm version 0.7.1 --no-git-tag-version
cd apps/cli && npm version 0.7.1 --no-git-tag-version && cd ../..
git add package.json apps/cli/package.json CHANGELOG.md
git commit -m "chore: release v0.7.1"
git push origin main

# 2. Tag and push → triggers the release workflows
bash apps/cli/scripts/tag-release.sh 0.7.1
```

What the workflow does:
1. Runs `pnpm --filter a2wave typecheck` and `test`
2. Runs `pnpm --filter a2wave build`
3. Runs `npm pack --dry-run --json`; requires `dist/index.cjs`, `README.md`, `LICENSE`, and `NOTICE`, and fails if the tarball contains `src`, `coverage`, `scripts`, or test files
4. Publishes to the public npm registry with `--provenance --access public`

The GitHub Release is created by the separate Release workflow, which the same
tag triggers.

Publish auth comes from the `NPM_TOKEN` repository secret (an npm automation token).

`tag-release.sh` verifies both manifests agree / main / clean working tree / local-origin sync / tag absent on the remote, then creates and pushes the `v*` tag.

> `package.json` must **not** set `publishConfig.registry` — it overrides both `npm publish --registry` and the registry `setup-node` configures, silently redirecting releases. `src/__tests__/package.test.ts` enforces its absence.

### User Installation

```bash
npm i -g a2wave
```
