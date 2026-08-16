# apps/cli — Agent Guide

The a2wave command-line tool. For global conventions see the root [AGENTS.md](../../AGENTS.md).

## Directory Structure

```
src/
├── commands/
│   ├── setup.ts      # setup (local platform install via docker compose)
│   ├── login.ts      # login / logout
│   ├── oauth.ts      # IDaaS OAuth browser flow used by login
│   ├── status.ts     # status (self-check narrative; renders lib/checks.ts)
│   ├── whoami.ts     # whoami (cheap identity read: one /api/auth/me call)
│   ├── doctor.ts     # doctor (same probes as an addressable checklist; exit 1 on fail)
│   ├── api.ts        # api (raw HTTP escape hatch for uncovered endpoints)
│   ├── config.ts     # config set-url / get / unset-url
│   ├── skills.ts     # skills list/get/create/install/check-update/update-remote/update/delete + files
│   ├── skill-groups.ts # skill-groups list/get/create/update/delete (the values --group accepts)
│   ├── agents.ts     # agents list/get/update/delete/stats + export/import/members/artifacts/memory + lifecycle
│   ├── chat.ts       # chat send (one-shot + interactive, --attach) / chat list / chat messages
│   ├── channels.ts   # channels set / chat-app (per-channel config WITHOUT republishing)
│   ├── eval.ts       # eval sets / cases / run / tasks (evaluation replay + manual verdicts)
│   ├── mcp.ts        # mcp list / get / create / update / delete / tools
│   ├── memory.ts     # memory files list/get/put/delete + topics list/recall/remember
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
│   ├── checks.ts     # Self-diagnosis probes as data; shared by status / doctor
│   ├── fields.ts     # `--fields` dot-path projection (applied AFTER redaction — see below)
│   ├── output.ts     # `--json` support: jsonArg flag fragment + emit() / wantsJson()
│   ├── paginate.ts   # `--limit` / `--page`: pageArgs fragment + pageQuery()
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
| `a2wave setup` | Install a local a2wave platform: reject unknown options before any preflight or write (an older CLI must never silently ignore a newer deployment flag), then docker/compose preflight + port bind-probe, generate a minimal public `docker-compose.yml` + `.env` (0600, auto `AUTH_SECRET`, **never an admin password**), `compose up -d`, poll `http://localhost:<port>/api/health` (crash-looping containers fail fast with logs), then save the instance URL into `~/.a2wave/config.json` — only after health passes, and the login token is kept only when the URL is unchanged. Requires a nonexistent or **empty** install dir (setup owns it; `--down` deletes it recursively) and writes a `.a2wave-install` ownership marker |
| `a2wave setup` (admin password) | Once healthy, **on a TTY and without `--yes`**, prompts for the admin password twice with the echo suppressed and POSTs it to `/api/auth/setup` on the local port. `--yes` suppresses it even on a TTY — that flag means "no prompting", and automation which allocates a PTY (expect, `ssh -t`, some CI runners) would otherwise block on a hidden prompt. The value never touches `.env`, the compose file, container env, argv or stdout — there is deliberately **no `--admin-password` flag**, since argv is visible in `ps` and lands in shell history. An empty first answer skips to the web setup screen; mismatches and policy violations (≥8 chars, upper + lower + digit, mirroring the server) re-prompt up to 3 times without an API call. Best-effort: a rejected or unreachable POST prints the reason and falls back to the web-screen hint rather than failing an install that already succeeded |
| `a2wave setup --yes` | Non-interactive with defaults (`~/a2wave`, port 3502). Required in CI/pipes — prompting without a TTY errors out |
| `a2wave setup --dir/--port/--image/--base-url/--health-timeout/--no-start` | Overrides. `--base-url` must be a pure origin (LAN/reverse-proxy installs; drives `CORS_ORIGIN` + cookie security; health still probes localhost). **`--image` defaults to `ghcr.io/lilithgames/a2wave:<cli-version>`** — the published GHCR image for this CLI's own version, since the platform and the CLI share one version line; a floating `latest` default would pair a CLI with a platform build it was never tested against, and the tag carries no leading `v` because `docker.yml` strips it. Pass the flag to install a locally built or mirrored ref; validated against the docker reference charset. The `.env` persists a unique `COMPOSE_PROJECT_NAME` and every compose invocation passes it explicitly via `-p` (shell env beats `.env` in Compose precedence, so `-p` is the only override-proof channel) — same-basename install dirs can never share Docker volumes. Generated installs also mount `a2wave-workspace:/data/workspace` and set `SCM_STORAGE_ROOT`/`SCM_WORKSPACES_ALLOWED_ROOTS`, keeping managed SCM files separate from database and CLI-home volumes. Health accepts only `status:"ok"` — HTTP 200 + `degraded` fails the install |
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
| `a2wave status` | One-stop self-check: URL / IDaaS cache / a2wave credentials / backend health / current user. First choice for diagnosing "why 401" or "is the token expired". `--json` emits the same `CheckReport` as `doctor` |
| `a2wave whoami` | "As whom, and against which instance, will my next command run?" **One request** (`/api/auth/me`) — cheap enough for an agent to call before a risky write. `--json` adds `isAdmin`, so a caller need not know the role string is spelled `admin` |
| `a2wave doctor` | The same probes as `status`, rendered as an addressable checklist. **Exits 1 on any `fail`** |

### Self-diagnosis: `status`, `whoami`, `doctor`

All three read from one probing layer, [src/lib/checks.ts](./src/lib/checks.ts),
so a probe can only be wrong in one place. What differs is the shape of the
answer, and each shape exists for a different caller:

| | Question | Cost |
|---|---|---|
| `whoami` | "Who am I acting as?" | 1 request |
| `status` | "Is everything set up?" — a narrative for a human | 4 probes |
| `doctor` | "Which precondition is broken?" — a checklist for a machine | 4 probes |

`runChecks()` returns `{ok, checks[]}` where each check has a stable
dot-separated `name` (`instance.url`, `instance.health`, `sso.cache`,
`credentials.token`, `user.identity`), a three-state `status`, an ANSI-free
`message`, a `hint` on every non-pass, and structured `detail`. An agent tests
one precondition by name or the whole thing by `ok`.

Three rules the model depends on:

- **`warn` does not flip `ok`.** Half of what this reports is optional (an SSO
  cache on a password-login install) or merely blocked on an earlier failure.
  Letting those read as failures is exactly the noise that teaches a caller to
  ignore a health signal — and `doctor`'s exit code with it.
- **A hint must be able to work.** A reachability failure is *not* fixed by
  `config set-url`: the URL is already set, which is how we got far enough to
  dial it. An agent acting on a hint that cannot work is worse off than one
  given none, so `instance.health` says to check the instance is running.
- **No ANSI and no cleartext credential in `checks.ts`.** Colour belongs to the
  renderer; an escape sequence inside a JSON payload is garbage to every
  non-terminal consumer. `detail` is emitted verbatim under `--json`, so tokens
  go through `maskToken` on the way in.

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
| `a2wave config add-profile <name> <url>` | Name an instance URL so it can be switched to |
| `a2wave config use <name>` | Point the default URL at a named profile |
| `a2wave config list` | List profiles, marking the current one (`--json` supported) |

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
| `a2wave skills files list <id\|name>` | List the files a Skill ships, as flat `dir/file` paths ready to pass to `files get` |
| `a2wave skills files get <id\|name> <file> [--full]` | Print one Skill file. Reading a Skill's contents is how you decide whether to attach it. **This route answers with the file body, not a JSON envelope** — the CLI wraps it as `{data:{path,content}}` under `--json`, and refuses a binary body rather than dumping it into a terminal |

### Skill Groups

`--group` and the yaml's `skillGroups:` have always resolved a group by name, but
nothing listed the valid values — an asymmetry worse than the feature being absent.

| Command | Description |
|------|------|
| `a2wave skill-groups list` | List groups. Flags any group holding a member its own owner cannot bind, since binding it to an Agent silently drops those Skills |
| `a2wave skill-groups get <id\|name>` | Show one group merged with its membership (two routes, one command) |
| `a2wave skill-groups create --name X [--skill <id\|name> ...]` | Create; each `--skill` is resolved by name |
| `a2wave skill-groups update <id\|name> [--name ...] [--skill ...] [--clear-skills]` | Update. `skillIds` **replaces** the membership server-side, so emptying it needs the explicit `--clear-skills` — a bare `--skill` with no value cannot express it |
| `a2wave skill-groups delete <id\|name> [--force]` | Delete the group; member Skills are released, not deleted |

### Agents

| Command | Description |
|------|------|
| `a2wave agents list` | List all Agents |
| `a2wave agents get <id\|name>` | View Agent details (incl. Skills, System Prompt). Prints a **Provider Chain** block — `<n>. <providerId>  model=…  effort=…  fastMode=true  [disabled]` — rendering the only part of the freeform `config` shown by value. The rest of `config` stays a bare key list because it can hold credentials, but that rule also hid the whole execution plan: which models run, in what order, at which reasoning depth. The four rendered fields are schema-declared (`providerChainItemSchema`) and carry no secret; the `providerApiKey` / `providerOauthToken` / `providerBaseUrl` sitting beside them in the same object are never read. An Agent with no chain shows its single `Model:` line instead |
| `a2wave agents update <id\|name> --name "..."` | Update name |
| `a2wave agents update <id\|name> --description "..."` | Update description |
| `a2wave agents update <id\|name> --system-prompt "..."` | Update System Prompt |
| `a2wave agents update <id\|name> --add-skill <name\|id>` | Add a Skill |
| `a2wave agents update <id\|name> --remove-skill <name\|id>` | Remove a Skill |
| `a2wave agents update <id\|name> --add-mcp <name\|id>` | Add an MCP Server |
| `a2wave agents update <id\|name> --remove-mcp <name\|id>` | Remove an MCP Server |
| `a2wave agents apply -f agent.yaml` | Idempotent apply: look up by name; POST if absent, otherwise PATCH only changed fields. **`config` is replaced wholesale, not merged** — a YAML naming only `providerChain` discards `timeoutMinutes`, `maxRetries` and every other key it did not repeat, so a partial config is a data loss dressed as an edit. `describeDestructiveDiff` walks nested objects and arrays for exactly this, upgrading such an apply to `high-risk-write` and naming what goes (`config: removes 6 keys (…)`, `config.providerChain: removes 1 (pc_codex)`). Array entries are matched by **identity** (`id`, else `name`, else `providerId`), so editing one binding's reasoning effort is an edit, not a removal — deep equality would have called every touched entry unmounted |
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
| `a2wave agents memory stats\|search\|reindex\|consolidate ...` | Memory aggregates: via `/api/memories/:agentId/*` (memoryAuthMiddleware). **File- and topic-level access lives under the top-level `memory` command** below |

### Memory

The most agent-native surface the platform has, and the one the CLI covered least
— four of thirteen endpoints. `agents memory` keeps the aggregate operations
(stats/search/reindex/consolidate); this command adds the per-file and per-topic
reads and writes an Agent actually performs.

| Command | Description |
|------|------|
| `a2wave memory files list <agent>` | List the Agent's memory files |
| `a2wave memory files get <agent> <file> [--full]` | Print one file. A nested path is sent verbatim (the route is a `/files/*` wildcard, so encoding the separators would address a file literally named `notes%2Fa.md`) |
| `a2wave memory files put <agent> <file> --content "..." \| --content-file ./x.md [--append]` | Write or append. **Exactly one** content source — silently ignoring the second is how you write the wrong body and cannot tell |
| `a2wave memory files delete <agent> <file> [--force]` | Delete one file (irreversible; confirms by default) |
| `a2wave memory topics list <agent> [--status active\|archived\|all]` | Topic metadata only; bodies are never included |
| `a2wave memory topics recall <agent> <query> [--full]` | Select and read the single best-matching active topic. **`data: null` is a successful "nothing matched"**, reported as a message rather than an error |
| `a2wave memory topics remember <agent> --title X --item "..." [--item ...]` | Record an insight into a topic |
| `a2wave memory topics remember <agent> --replace --topic <id> --content "..."` | Replace a whole topic body |

> `files get` and `topics recall` are **capped at 200 lines** in the human path with
> an explicit truncation marker; `--full` or `--json` returns everything. A memory
> file is agent-written and grows without bound, so an uncapped read is a context
> window hazard — but the `--json` payload is left WHOLE, because silently dropping
> lines from a machine payload corrupts it with no error.

### Channels

| Command | Description |
|------|------|
| `a2wave channels set <agent> <channel> --set k=v ...` | Save one channel's config. `true`/`false`/integers are typed, since every shell flag arrives as a string and zod rejects `"false"` |
| `a2wave channels set <agent> <channel> --config-file ./feishu.json` | Same, reading the whole config object from JSON |
| `a2wave channels chat-app <agent>` | Show the published chat page profile (404 when the channel is off) |

> **Configuring is not publishing.** `PATCH /channels/:channel` deliberately does
> *not* set `publishStatus`, rotate the API key, or restart other channels' sockets —
> a draft stays a draft until `agents publish`. The config object is **replaced**, so
> a partial `--set` drops the fields it omits; the CLI says so on every success.
> Configurable channels are `feishu`, `slack`, `discord`, `chat_app`, `schedule`,
> `glab`, `gh` — `api` / `a2a` / `oauth` carry no saveable config and are rejected
> client-side with the valid set named, rather than as a bare 400.

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
| `a2wave chat send <agent> -m "..." --attach ./a.png --attach ./b.md` | Attach local files to one turn. Two-step: each file is staged at `POST /api/attachments`, and the returned `{token,name,mimeType,size}` refs go on the chat body, which is what consumes them |

> **Attachments.** Capped at **10 per turn**, mirroring `attachmentsInputSchema`'s
> `.max(10)`, and checked **before any upload** — staging eleven files and then
> having the send rejected leaves eleven blobs on the server for the whole staging
> TTL. Uploads are sequential on purpose: the server enforces a size limit and an
> extension allowlist per file, and a parallel upload would report whichever file
> failed first while the others were already staged, leaving the caller unable to
> tell which argument was wrong. `--attach` requires `-m/--message`: an interactive
> session sends many turns and there is no single one the files belong to.

> Chat is available to **viewer** permission and up (debug access), matching `POST /api/agents/:id/chat`.
>
> **Full queue**: when the Agent has no free concurrency slot the server accepts the run and answers `queued` (a bare `{status, runId}` with no `data` wrapper on the sync path, a lone `queued` SSE event with no `done` on the streaming one). Both are reported as an accepted run with its `runId`, not as an error — follow it with `a2wave runs get <runId>`.
>
> The one-shot form lives under `chat send`, not bare `chat <agent>`: citty routes on the first non-flag argument, so a parent command owning both a positional and subcommands makes `chat my-agent` parse as an unknown subcommand name.

### citty argument pitfalls (enforced by tests)

Four structural rules are checked by [src/__tests__/command-structure.test.ts](./src/__tests__/command-structure.test.ts), because every one of these bug classes is invisible to unit tests that call a command's `run()` directly — they never exercise citty's parser, router or usage renderer:

| Rule | Why |
|------|------|
| A node with `subCommands` must declare **no positional** | citty resolves the first non-flag argument against `subCommands`; a positional on the same node is unreachable and errors with `Unknown command`. |
| Never declare an arg named `no-<x>` | citty parses `--no-x` as negation of `x`, setting `args.x = false` — it never populates an arg literally named `no-x`, so the flag is silently inert. Declare `x` with `default: true` and read `args.x === false`; the `--no-x` spelling still works and still shows up in `--help`. |
| **Every node must declare `meta.name`**, equal to its key in the parent's `subCommands` | citty builds the usage line as `` `${parentMeta.name} ` + (cmdMeta.name \|\| process.argv[1]) `` (`citty/dist/index.mjs:353`). With no `meta.name` it falls back to **`process.argv[1]`** — the absolute path of the running script — so the published binary printed `USAGE a2wave /usr/local/lib/node_modules/a2wave/dist/index.cjs list\|get\|...`. Wrong, unrunnable as printed, and ~87 wasted tokens on every `--help` an agent reads. |
| `meta.name` must be a **single segment**, never a full path | `runMain` resolves the name against the root command when building the prefix, so `name: 'a2wave agents'` renders a doubled `a2wave a2wave agents` **and stops the node routing at all**. |

**`runMain` is not used, on purpose.** It catches every error itself, prints it
through consola and calls `process.exit(1)` — so the idiomatic
`runMain(cmd).catch(handleError)` is dead code, and a plain `CliError` reached
the user as a stack trace with the message printed twice. `src/index.ts` owns
its own try/catch instead, reproducing citty's `--help` / `--version` branches
because they live inside the function being replaced. Two traps if you touch it:

- citty's `resolveSubCommand` is **internal** — absent from both the public type
  surface and the CJS bundle's exports, so importing it typechecks and then
  throws `is not a function` at runtime. `src/index.ts` walks the tree itself.
- A wrong command name arrives as citty's own `CLIError`. It must be reported as
  `validation`, not `internal` — a typo is not a crash in this CLI.

Because unit tests call `handleError` directly, none of this was observable from
them; `src/__tests__/dispatch.test.ts` runs the real entry point as a subprocess.
That file strips `TEST` / `VITEST` / `NODE_ENV` from the child environment:
consola suppresses output when it believes it is under test (std-env computes
`isTest` from `NODE_ENV === 'test' || !!env.TEST`), and a child inherits both, so
every help assertion would otherwise compare against `''` and pass for the wrong
reason.

Scope note on the last two: `resolveSubCommand` passes only the *immediate*
parent, so a depth-2 usage line reads `agents members list` without the leading
`a2wave`. That is a citty limitation, not a defect in our tree — widening
`meta.name` to compensate breaks routing, which is why the rule above exists.
The property the tests actually guarantee is that **no absolute path ever
reaches the user**, asserted behaviourally via `renderUsage()` on every node
against its real parent.

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

> Evaluations do **not** write to the `runs` table; auditability comes from an `evaluation_task.execute` audit entry. Verdicts are manual in v1. Each task freezes a provider/model/effort/fast-mode/prompt snapshot, printed by `eval tasks get` as `Snapshot: provider=… model=… effort=… fastMode=…`. The last two appear only when the task actually froze them — an absent effort means the CLI's own default was used, while `fastMode=false` is a deliberate off, so `n/a` would misreport both.

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
| `a2wave scm create --type git --name X --repo-url U [--local-path P]` | Create a managed git source by default; pass `--local-path` for custom storage |
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

# Free-form passthrough. The provider chain lives here, and reasoning effort /
# fast mode belong to a chain ENTRY rather than to the Agent: legal effort levels
# follow the model, so one Agent-wide value would be invalid for at least one
# entry. Omitting a control passes nothing and leaves the CLI's own default.
# Neither is validated client-side — `providerChainItemSchema` owns that.
config:
  providerChain:
    - providerId: prv_xxxxxxxx
      model: gpt-5.6-sol
      reasoningEffort: ultra            # Discovered per model; never a fixed list
      fastMode: true                    # Only requested — plan/model/endpoint each hold a veto
    - providerId: prv_yyyyyyyy          # Fallback entry
      model: claude-opus-4-8
      reasoningEffort: high

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
| `a2wave runs get <id>` | View Run details and execution logs. Prints **every** step of a multi-turn run, ordered by `order`. Log lines name what the run actually got, not only what was configured: `[init] model=…`, `[params] reasoningEffort=… fastMode=true` (the request), and `[done] … fastMode=<state>` (the verdict the engine served — `on` / `off` / `denied` / `requested`, printed verbatim, since "requested but refused" is exactly what someone debugging a slow run needs). `[params]` renders only those two named fields, never the whole params object, because every other value is a path or a redaction marker |
| `a2wave runs logs <id> [-o file]` | Download the NDJSON sidecar log; stdout by default. Not subject to the `MAX_STREAM_LOGS` cap that truncates the DB copy shown by `runs get`, but it has **its own** limits: the server stops at **256 MiB** and writes a cap marker, and can record `dropped` markers under sustained backpressure. Streamed to disk/stdout rather than buffered; `-o` writes to a temp file and renames on success, so an interrupted download never destroys a previous log |
| `a2wave runs cancel <id>` | Cancel a queued or running run (400 when it is already terminal) |
| `a2wave runs rerun <id> [--wait]` | Replay a run with its original intent and attachments. The server starts it, so the CLI **never** calls `/execute` afterwards. `--wait` polls to a terminal status and exits 1 on failure |
| `a2wave runs trigger <agent> --intent "..."` | Trigger Agent execution with real-time SSE streaming output |

### Update

| Command | Description |
|------|------|
| `a2wave update` | Check for and update the a2wave CLI to the latest published version. Queries the npm default registry unless `$A2WAVE_NPM_REGISTRY` points at a mirror |
| `a2wave upgrade` | Alias for `a2wave update` |

### `api` — the raw escape hatch

**Prefer a typed command when one exists.** It validates parameters, resolves
names to IDs, and carries usage guidance that `api` cannot. Reach for `api` only
for endpoints with no typed command yet — the CLI covers roughly 60 of the
platform's ~150 routes, and before this existed the alternative was hand-rolled
`curl` plus digging the token out of `~/.a2wave/config.json`.

```bash
a2wave api GET /api/settings
a2wave api GET /api/runs --query status=failed --query limit=5
a2wave api PATCH /api/agents/agt_x --body '{"name":"renamed"}' --yes
a2wave api POST /api/skills --body-file ./skill.json --yes
```

| Property | Behaviour |
|---|---|
| **Auth** | Goes through `createClient()`, so it inherits the IDaaS JWT exchange. An independent `fetch` would silently break every OIDC user, whose stored token needs exchanging first |
| **Path guard** | Must start with `/api/`. Anything containing `://`, or starting `//`, is refused — `api GET https://evil.example/x` would otherwise send the bearer token to that host. Use `--url` to target a different instance |
| **Writes** | Any method other than GET requires `--yes` (aliased to `--force`). The CLI cannot know what an arbitrary POST does, so it assumes the worst |
| **Output** | Always JSON, always through `emit()` — so redaction, `--fields` and `--show-secrets` all apply. This matters *more* here than for typed commands: `api` reaches endpoints the redaction denylist has never seen, and that denylist fails open by design |

## Design principle: the primary consumer is an Agent

Iron Rule 6 says the platform builds no convenience UI, so **the CLI and the API
*are* the surface a user's local Agent drives**. That makes an AI agent — not a
human at a terminal — this tool's main caller, and three properties follow:

| Property | What it means here |
|---|---|
| **Token-frugal** | Output is read into a context window. `--json` is compact; `--fields` projects; anything unbounded gets a cap and says so. |
| **Machine-parseable** | Every read command can answer in JSON. An agent should never have to scrape a column layout. |
| **Safe by construction** | The CLI is the last hop before terminal scrollback and CI logs, so it redacts rather than trusting every upstream route to have done it. |

Two rules fall out of this that are easy to get backwards:

- **Human-readable stays the DEFAULT.** Agent-first is not agent-only; a bare
  invocation still prints the table. JSON is opt-in, so nothing that scrapes
  today breaks.
- **Redaction runs BEFORE projection.** See `--fields` below — this ordering is
  a security property, not a style choice.

## Machine-readable output (`--json`)

Read-oriented commands accept `--json` and print the **raw API payload** instead of the human-formatted columns, so scripts and CI never have to scrape output:

```bash
a2wave agents list --json | jq -r '.data[] | select(.publishStatus=="published") | .id'
# --status narrows the CURRENT PAGE only; the payload carries a `filter` block
# ({status, scope:"page", matchedOnPage, scannedOnPage}) so a partial count is
# never mistaken for a total. Raise --limit to widen the window.
a2wave runs list --status failed --json | jq '.filter.matchedOnPage'
a2wave chat send my-bot -m "ping" --json | jq -r '.data.reply'

# Project to the fields you need — the single biggest token lever there is.
a2wave agents list --fields 'data[].id,data[].name'     # >90% smaller than --json
```

| Flag | Effect |
|------|--------|
| `--json` | Compact single-line JSON. The default JSON layout, because indentation is 9–25% of the bytes (highest on wide short-valued rows, lowest when a long `systemPrompt` dominates) and an agent gains nothing from it |
| `--json-pretty` | Same payload, indented for human reading. Implies `--json` |
| `--fields <paths>` | Comma-separated dot paths, `[]` to map over an array (`data[].id,data[].name`). Implies `--json` |
| `--show-secrets` | Print credentials verbatim instead of `********` |

### Bounded output

Anything that can grow without limit is capped in the **human** path and left
whole under `--json` — silently dropping entries from a machine payload would
corrupt it with no error, whereas a terminal or a context window genuinely
wants the cap. Every cap names the way to get everything:

| Command | Cap | Escape |
|---|---|---|
| `runs get` | 200 log entries per step, **tail kept** (a run's logs are read to find out how it ended, and the failure is at the bottom) | `--full`, `--max-log-lines N`, or `a2wave runs logs <id>` |
| `eval tasks get` / `eval run --wait` | Turn transcripts clipped at 200 chars; turn *errors* never clipped | `--verbose` |
| `memory files get` / `memory topics recall` / `skills files get` | 200 lines, **head kept** (a memory or Skill file is read top-down for what it says, unlike a run log read bottom-up for how it failed) | `--full` or `--json` |
| list commands | `--limit` / `--page`, clamped to the API's 1–100 window | `--limit 100` |

`--limit` on the six resource lists (`agents`/`skills`/`mcp`/`scm`/`kb`/
`providers`) defaults to the **100** they always fetched, not the 20 that
`runs list` uses: lowering it would silently truncate output for anyone already
relying on a bare `agents list` showing everything. The flag adds control
without changing what an existing call returns.

Rules:

- The flag comes from the shared `jsonArg` fragment in [src/lib/output.ts](./src/lib/output.ts); commands call `if (emit(args, result)) return` before their own formatting, so the two modes can never both print.
- **`--fields` projects AFTER redaction, never before** ([src/lib/fields.ts](./src/lib/fields.ts)). `redactSecrets` decides what is secret partly from *sibling* keys — an agent env var is `{value, sensitive: true}`, and the `sensitive` flag is the only marker that `value` needs masking. Projecting first would strip that sibling, so `--fields data.env.FOO.value` would hand the redactor a bare `{value: 'sk-live'}` and print the secret in clear. Redacting first is safe both ways: projection only removes keys, and `********` survives it. An invariant test in `src/lib/__tests__/fields.test.ts` pins this.
- A `--fields` path that matches nothing is **omitted, not fatal** — an agent composing paths from a schema will legitimately name a field that is optional and absent on this row. The misses come back under `_meta.unmatchedFields` so it can self-correct without another round-trip.
- **No `--jq`.** It would need either a `jq` binary or a vendored JS implementation; the published package ships only `citty` + `yaml`, and an agent that wants real jq still has `| jq` in its own shell.
- **Credentials are redacted by default.** The API returns secrets in plaintext to an owner/editor (the Web UI gates that behind a "click the eye" affordance), but CLI output lands in terminal scrollback, shell history and CI logs. Pass **`--show-secrets`** to print them verbatim; only do so when piping to a secure consumer. Four rules, because secrets arrive in four shapes:

  | Rule | Covers |
  |------|--------|
  | Key **name** looks like a credential | `appSecret`, `providerApiKey`, `providerOauthToken`, `endpointApiKey`, `providerBaseUrl`, `pat`, `p4passwd`, plus any key ending `secret` / `token` / `apikey` / `password` |
  | Key is an **env entry** `{value, sensitive: true}` | Agent env vars — the marker is the sibling flag, since var names are arbitrary |
  | Key is a **secret container** (`env`, `headers`) | MCP servers store credentials in free-form maps the operator names, so **every value** inside is masked regardless of name; the keys stay visible |
  | Key holds a **URL** (`url`, `repoUrl`, `endpoint`, `baseUrl`) | Only the credential-bearing *parts* are masked — userinfo, query, fragment, and opaque token-like path segments. Scheme, host and ordinary path survive, so links stay usable and the server's `********@host/path` sentinel still round-trips through `scm update --config-file` |
- `--json` prints exactly **one** JSON document to stdout. `a2wave chat --json` therefore implies `--no-stream` (streamed tokens would interleave) and requires `-m/--message` — an interactive session has no single payload.
- Errors always go to **stderr**, so a caller piping stdout into a parser never has the payload and the failure interleaved. Under a JSON flag they are an envelope; otherwise plain text. Either way the exit code is non-zero. See below.

## Error contract

An agent recovers from a failure by branching on it, and matching prose is a
brittle way to do that — `"Session expired"` breaks the moment someone rewords
it. So errors carry a stable `type`/`subtype` and, where one exists, a `hint`
that is a **runnable next step** rather than advice.

Under `--json` / `--json-pretty` / `--fields`, stderr gets one compact object:

```json
{"ok":false,"error":{"type":"auth","subtype":"expired","message":"Session expired or invalid.","hint":"a2wave login"}}
```

Absent fields are **omitted, not null** — `error.subtype` should read as
`undefined`, not something to special-case. Plain-text mode prints the message,
then `Hint: <hint>` on its own line when there is one.

| `type` | Means |
|---|---|
| `auth` | The caller's own credentials. HTTP 401 is intercepted in `client.ts` before it can become an `ApiError`, so this never gets confused with "the request was rejected" |
| `permission` | Authenticated, but not allowed (403) |
| `not_found` (404) · `conflict` (409) · `rate_limit` (429) | As named |
| `validation` | Bad input, caught client-side or as a 4xx |
| `server` | 5xx |
| `network` | Could not reach the instance at all |
| `confirmation` | Needs `--force` / `--yes`. The most likely error an agent hits, since it never has a TTY |
| `cli` | Any other deliberate CLI failure |
| `internal` | A bug in this CLI |

`ApiError` sets `subtype` to the numeric status, and **clips the server body at
2000 chars** — a 5xx can answer with a whole HTML error page, and untruncated
that lands in a CI log or a context window.

`internal` deserves its own note: an unexpected `TypeError` used to be
re-thrown, surfacing as a full Node stack dump. It is now reported in the same
shape as everything else, with the stack behind `A2WAVE_DEBUG=1` for whoever is
actually debugging it.

**Structured fields are additive.** `new CliError('...')` still works, so the
~60 existing throw sites needed no edit; enrich them as each is shown to matter.
When you do, keep the human sentence self-sufficient — the structured fields are
for the machine, and dropping the readable instruction to avoid repeating
yourself makes plain-text mode strictly worse.

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
  "url": "https://your-a2wave.com",        // the default instance
  "token": "eyJ...",                       // its credential (legacy shape, still read)
  "credentials": {                         // credentials keyed by instance URL
    "https://your-a2wave.com": { "token": "eyJ..." },
    "https://staging.example":  { "token": "eyJ..." }
  },
  "profiles": { "staging": { "url": "https://staging.example" } },
  "currentProfile": "staging"
}
```

`a2wave login` writes it automatically and `a2wave logout` clears it. All commands read this file at startup and prompt for re-login when it is missing or invalid.

### Credentials are keyed by URL

**The bug this fixes:** `requireToken()` took no URL argument, and `createClient`
called it alongside `resolveUrl(opts.url)` with nothing linking the two. So
`--url https://other` paired that host with the *stored* instance's token —
leaking it there, then failing as a 401 that blamed the user's login rather than
naming the cause. `client.ts` now resolves the URL **first** and asks for the
credential belonging to it.

Resolution order in `resolveCredential(url)`:

1. `credentials[url]` — the per-instance entry.
2. the legacy top-level `token`, **but only when `config.url` is that same URL**.
   That conditional is the entire fix; the fallback used to be unconditional.
3. otherwise throw `{type:'auth', subtype:'no_credential_for_url'}` with a
   `a2wave login --url <url>` hint. Never fall through to "some token we happen
   to have" — sending the wrong instance's credential is worse than failing.

**Migration is implicit and lazy: no version field, no rewrite-on-read.** An
existing flat `{url, token}` keeps working untouched, and because nothing is
rewritten on read, downgrading to an older CLI still works. `login` writes both
the legacy pair *and* the per-URL entry, so logging into a second deployment no
longer costs you the first one's token.

Profiles (`config add-profile` / `use` / `list`) are **named aliases over this**,
not a second mechanism. An agent almost never wants "a profile" — it wants "this
URL with the right token", which `--url` already gives it. Profiles are for a
human switching between deployments.

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
