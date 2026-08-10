---
name: a2wave-cli
version: "1.0.0"
description: "Use when you need to operate a2wave from the command line: install or uninstall a local platform (a2wave setup / setup --down), login / status check / config, manage Agent / Skill / MCP Server / SCM Source / Knowledge Base (KB) / Provider, apply agent.yaml, trigger Runs, diagnose Agents, view stats / artifacts / memory, import / export Agents, manage members, or update the a2wave CLI and its companion skill."
metadata:
  requires:
    bins: ["a2wave"]
  cliHelp: "a2wave --help; a2wave setup --help; a2wave status; a2wave agents --help; a2wave chat --help; a2wave eval --help; a2wave mcp --help; a2wave scm --help; a2wave kb --help; a2wave providers --help; a2wave runs --help; a2wave skills --help"
---

# a2wave CLI

Use the `a2wave` command-line tool to manage the a2wave Agent orchestration platform.

## Checks Before You Start

1. Before debugging authentication, URL, token, or backend connectivity issues, run `a2wave status` first.
2. If the URL is not yet configured, set it with `a2wave config set-url <url>`; you can also pass `--url <url>` on a single command, or set `A2WAVE_URL`.
3. Login and URL configuration are two separate things: `a2wave login` runs OAuth SSO via your identity provider (IdP) and writes local credentials.
4. For resource arguments that accept `<id|name>`, you can pass an ID or an exact name; an ID is used directly, while a name is resolved via the list API.

## Platform Install (setup)

```bash
a2wave setup --image a2wave:latest          # interactive: dir + port prompts, then docker compose up + health wait
a2wave setup --yes --image a2wave:latest    # non-interactive with defaults (~/a2wave, port 3502)
a2wave setup --yes --image a2wave:latest --dir /srv/a2wave --port 3510 --base-url http://192.168.1.10:3510
a2wave setup --no-start --image a2wave:latest  # generate .env + docker-compose.yml only
a2wave setup --yes --database-url postgres://a2wave:pw@db.internal:5432/a2wave  # EXPERIMENTAL: external PostgreSQL backend
a2wave setup --yes --with-postgres          # EXPERIMENTAL: bundle a postgres:16-alpine sidecar (password generated into .env)
a2wave setup --upgrade --image a2wave:1.4.0 # move an existing install to a new image, keeping its data
a2wave setup --down                         # uninstall: requires typing the install dir path to confirm
a2wave setup --reset-password               # forgot the admin password: reset it from a running install
```

- `--upgrade` is the **only** supported way to move an install to a new image — never tell a user to hand-edit `docker-compose.yml`. The image lives in `.env` as `A2WAVE_IMAGE` (the compose file reads it via `${A2WAVE_IMAGE:-...}`), so the upgrade rewrites one env key, **backs the data volume up** to `a2wave-data-<stamp>.tar.gz` in the install dir first (`--no-backup` skips it), then pulls and recreates **only the a2wave service** and waits for liveness *and* readiness. It never deletes the data volume, and everything else in `.env` survives byte-for-byte. A legacy install with a hardcoded image line is migrated to the variable automatically **when the file still matches the generated layout**; a hand-edited compose file is refused with the exact edit to make rather than guessed at. If the new image fails to start or fails its checks, the previous image is restored, brought back up, **and health-verified** before the rollback is reported as successful. Cannot be combined with `--down`, `--reset-password`, `--base-url`, `--port`, or `--no-start`.

- `--image` is **optional**: it defaults to `ghcr.io/lilithgames/a2wave:<cli-version>`, the published image matching the CLI's own version (the platform and the CLI share one version line). Pass it only to install a locally built or mirrored ref. Never invent a registry URL.

- Requires Docker + Compose v2, and a **nonexistent or empty** install directory (setup owns the whole dir; `--down` deletes it recursively). The generated `.env` holds `AUTH_SECRET` (mode 0600); no admin password is generated — the first web visit asks to set it.
- Once healthy, and only **on a TTY without `--yes`**, `setup` also offers to set the admin password itself (prompted twice, echo suppressed, POSTed to `/api/auth/setup` on localhost) instead of leaving it to the first web visit. `--yes` always skips this, even on a TTY.
- `--reset-password` recovers a forgotten admin password from an existing install: it runs the in-image recovery script via `docker compose exec` against the running container, so the new password is typed **inside the container**, never through the CLI process, argv, or the environment — there is deliberately no `--admin-password` flag. Takes effect immediately, no restart. Mutually exclusive with `--down`. **Do not** try to recover via the `ADMIN_PASSWORD` env var — it only bootstraps an admin that has no password yet and is silently ignored once one is set.
- The CLI config is saved only after the health check passes, and the login token is kept only when the instance URL is unchanged (a token is never sent to a different host).
- `--database-url` / `--with-postgres` select the **EXPERIMENTAL PostgreSQL backend** (SQLite stays the default; there is **no SQLite → PostgreSQL data migration** — the install starts from an empty database). `--database-url` must be a `postgres://`/`postgresql://` URL and points at an external server; `--with-postgres` instead adds a `postgres:16-alpine` sidecar to the generated compose file and derives `DATABASE_URL` with a generated hex password kept only in the 0600 `.env`. The two flags are mutually exclusive, and both are rejected with `--upgrade` (an upgrade never rewrites `.env`). To switch an existing install, edit `DATABASE_URL` in `.env` and `docker compose up -d` — the generated compose reads `${DATABASE_URL:-/app/data/a2wave.db}`. Warn users that a localhost database URL is unreachable from inside the container (use `host.docker.internal` or the host IP), and that on a PostgreSQL install the pre-upgrade backup covers only the data volume, **not** the database — suggest `pg_dump` first.
- `--base-url` is for LAN/reverse-proxy access (drives `CORS_ORIGIN` and cookie security); the health check always probes `http://localhost:<port>`.
- `--down` destroys the container, the data volume, and the install directory irreversibly. Interactive confirmation demands typing the directory path; non-interactive use demands the explicit `--yes-destroy-all-data` flag (`--yes` alone never bypasses it). It refuses directories missing the `.a2wave-install` marker.
- `--reset-password` recovers a forgotten admin password from an existing install: it runs the in-image recovery script via `docker compose exec --user appuser`, so the new password is typed **inside the container**, never through the CLI process, argv, or the environment — there is deliberately no `--admin-password` flag. It bumps the admin's `tokenVersion`, so every existing session/token is revoked and everyone must log in again. Takes effect immediately, no restart. Requires an interactive terminal; rejects `--yes` and is mutually exclusive with `--down`. **Do not** try to recover via the `ADMIN_PASSWORD` env var — it only bootstraps an admin that has no password yet and is silently ignored once one is set.
- Never suggest raw `docker compose down -v` / `rm -rf` for uninstalling an a2wave install — the setup command's gates exist to prevent destroying unrelated projects.

## Authentication and Configuration

```bash
a2wave login
a2wave status
a2wave config set-url http://localhost:3502
a2wave config get
a2wave logout
```

- Prefer OAuth login. Only use `a2wave login --password` for older username/password instances.
- Do not print tokens, API keys, appSecret, or `endpointApiKey` unless the user explicitly asks to view a newly generated value and needs to save it.

## Agent Management

Common read/update commands:

```bash
a2wave agents list
a2wave agents get <agent-id-or-name>
a2wave agents diagnose <agent-id-or-name>
a2wave agents update <agent-id-or-name> --system-prompt "..."
a2wave agents update <agent-id-or-name> --add-skill <skill-id-or-name>
a2wave agents update <agent-id-or-name> --add-mcp <mcp-id-or-name>
```

Lifecycle commands:

```bash
a2wave agents publish <agent-id-or-name> --channels api,feishu --auth-type api_key
a2wave agents stop <agent-id-or-name>
a2wave agents resume <agent-id-or-name>
a2wave agents clone <agent-id-or-name>
a2wave agents delete <agent-id-or-name>
a2wave agents regenerate-api-key <agent-id-or-name>
```

Stats, artifacts, and memory:

```bash
a2wave agents stats <agent-id-or-name>                       # KPI / number of askers / channel distribution

a2wave agents artifacts list <agent-id-or-name>              # List artifacts
a2wave agents artifacts download <artifact-id> --out ./x.zip # Download an artifact
a2wave agents artifacts delete <artifact-id>

a2wave agents memory stats <agent-id-or-name>
a2wave agents memory search <agent-id-or-name> --query "..."
a2wave agents memory reindex <agent-id-or-name>
a2wave agents memory consolidate <agent-id-or-name>
```

> "Publish settings" are done via `agents publish` + `agents update`; run records use the `runs` commands and conversations use the `chat` commands (see below).

Member management commands:

```bash
a2wave agents members list <agent-id-or-name>
a2wave agents members add <agent-id-or-name> --user <user-id-or-username-or-email> --role viewer
a2wave agents members update <agent-id-or-name> --user <user-id-or-username-or-email> --role editor
a2wave agents members remove <agent-id-or-name> --user <user-id-or-username-or-email>
```

Only the owner can manage members. Valid member roles are `viewer` and `editor`.

## Declarative Agent Apply

For reproducible Agent configuration and CI scenarios, prefer `agents apply`:

```bash
a2wave agents apply --example > agent.yaml
a2wave agents apply -f agent.yaml --dry-run
a2wave agents apply -f agent.yaml
```

Key rules:

- `name` is the idempotent identity key.
- Reference fields can use an ID or a name: `provider`, `skills`, `skillGroups`, `mcpServers`, `kbDocuments`, `workspace.source`.
- Sensitive values can be written as `${ENV_VAR}` or `${ENV_VAR:-default}`; the CLI expands them from environment variables at apply time.
- If the YAML includes a `publish` block, apply creates/updates the Agent and then publishes it. Use `--no-publish` to keep it in draft state.
- When the YAML involves publish channels, Feishu configuration, scheduled configuration, Provider authentication, or environment variables, use `--dry-run` before making production changes.

## Skill Management

```bash
a2wave skills list
a2wave skills get <skill-id-or-name>
a2wave skills create --name my-skill --content-file ./SKILL.md --group <group-id-or-name>
a2wave skills create --file ./skill.zip          # Upload .md/.zip to create
a2wave skills create --url https://skills.sh/owner/repo/skill
a2wave skills install https://skills.sh/owner/repo/skill
a2wave skills install https://github.com/owner/repo --skill path/to/my-skill
a2wave skills install https://github.com/owner/repo --all --group <group-id-or-name>
a2wave skills check-update <skill-id-or-name>
a2wave skills update-remote <skill-id-or-name> --strategy preserve-local
a2wave skills update <skill-id-or-name> --content-file ./SKILL.md
a2wave skills update <skill-id-or-name> --file ./skill.zip
a2wave skills delete <skill-id-or-name>
```

Use `--file` for full-package replacement/upload (`.md` or `.zip`). When you only need to modify the `SKILL.md` instruction body, use `--content-file`. Remote updates are always explicit: run `check-update` first, then choose `abort`, `preserve-local`, or `overwrite` if the three-way comparison reports conflicts.

## MCP Server Management

```bash
a2wave mcp list
a2wave mcp get <mcp-id-or-name>
a2wave mcp create --name fs --type stdio --command npx --arg -y --arg @modelcontextprotocol/server-filesystem --env KEY=val
a2wave mcp create --name remote --type http --endpoint https://host/mcp --header "Authorization=Bearer x"
a2wave mcp update <mcp-id-or-name> --enabled
a2wave mcp delete <mcp-id-or-name>
a2wave mcp tools <mcp-id-or-name>                # Connect and list the tools exposed by this server (troubleshooting)
```

> `--arg` / `--header` / `--env` can be repeated. Use `--endpoint` for the sse/http service address (to avoid the global `--url`). For the `group` type, provide groupConfig with `--config-file <json>`.

## SCM Source Management

```bash
a2wave scm list
a2wave scm get <scm-id-or-name>
a2wave scm create --name repo --type git --local-path /data/repo --repo-url https://git/x.git --branch main
a2wave scm create --name p4src --type p4 --local-path /data/p4 --p4port host:1666 --p4user u --p4client ws
a2wave scm update <scm-id-or-name> --enabled
a2wave scm delete <scm-id-or-name>
a2wave scm sync <scm-id-or-name>                 # Trigger a background sync
a2wave scm check <scm-id-or-name>                # Check connectivity
a2wave scm status <scm-id-or-name>               # Sync / CodeGraph status
```

> For complex structures such as git multi-repo, fall back to `--config-file <json>`.

## Knowledge Base (KB Document) Management

```bash
a2wave kb list
a2wave kb get <kb-id-or-name>
a2wave kb create --name doc --feishu-url <url> --feishu-app-id <id> --feishu-app-secret <secret>
a2wave kb create --name doc --notion-url <url> --notion-token <token>   # Notion source (mutually exclusive with --feishu-url)
a2wave kb upload --file ./notes.md               # Upload a local .md/.txt (document name taken from the file name)
a2wave kb update <kb-id-or-name> --auto-sync
a2wave kb update <kb-id-or-name> --notion-url <url> --notion-token <token>
a2wave kb delete <kb-id-or-name>
a2wave kb sync <kb-id-or-name>                    # Re-fetch the Feishu / Notion document
a2wave kb content <kb-id-or-name>                 # Print the cached body (troubleshooting)
```

## Provider Management

Providers are preset entities (cannot be created or deleted) and are entirely read-only:

```bash
a2wave providers list
a2wave providers get <provider-id-or-name>
a2wave providers login-status pi                  # Kind: cursor | claude-code | codex | opencode | qoder | trae | kimi | pi
a2wave providers dependents <provider-id-or-name>  # Agents that depend on this Provider
```

> There is no `set-models`: Providers store no model catalog. The list of models
> an Agent may pick is probed from the CLI against that Agent's own credentials,
> so it always matches what the account can actually run. `PATCH /api/providers/:id`
> answers 403.

## Run

```bash
a2wave runs list
a2wave runs list --agent <agent-id-or-name>
a2wave runs list --status failed --page 2 --limit 50
a2wave runs get <run-id>
a2wave runs trigger <agent-id-or-name> --intent "..."
a2wave runs cancel <run-id>
a2wave runs rerun <run-id> [--wait]
a2wave runs logs <run-id> [-o run.ndjson]
```

`runs trigger` creates a Run and streams the execution logs. If a Run fails, first check `a2wave runs get <run-id>`, then run `a2wave agents diagnose <agent>`, and only then modify the Agent configuration.

`runs cancel` stops a queued or running Run. `runs rerun` replays one with its original intent and attachments — the server starts it, so never follow it with an execute call; `--wait` polls to a terminal status and exits 1 on failure. `runs logs` fetches the NDJSON sidecar — not subject to the `MAX_STREAM_LOGS` cap that truncates the DB copy shown by `runs get`, though the sidecar has its own 256 MiB cap and may carry `dropped` markers under sustained backpressure.

`--status` narrows the **current page only** (the API has no status filter); with `--json` the payload carries a `filter` block so a partial count is not mistaken for a total.

## Chat

```bash
a2wave chat send <agent-id-or-name> -m "your question"
a2wave chat send <agent-id-or-name> -m "follow-up" --chat-id <chat-id>
a2wave chat send <agent-id-or-name>            # interactive session (needs a TTY)
a2wave chat list <agent-id-or-name>
a2wave chat messages <agent-id-or-name> <run-id>
```

The one-shot form is `chat send`, **not** bare `chat <agent>`. `chat list` prints two different ids: the `run_xxx` (pass to `chat messages`) and the `chat-id` (pass to `--chat-id`) — giving `--chat-id` a run id silently starts a new conversation instead of resuming it.

When the Agent has no free concurrency slot the run is **accepted and queued**, not rejected; the CLI reports the `runId` so you can follow it with `runs get`.

## Evaluation

```bash
a2wave eval sets list <agent-id-or-name>
a2wave eval sets create <agent-id-or-name> --name regression
a2wave eval cases add <agent> <set> --name greeting --request "hi" --expected "hello"
a2wave eval cases import <agent> <set> -f cases.yaml
a2wave eval run <agent> --set <set> --wait --fail-on-fail
a2wave eval tasks get <agent> <task-id>
a2wave eval tasks verdict <agent> <task-id> <result-id> --verdict pass
```

Replays an evaluation set against the Agent's current config and freezes a provider/model/prompt snapshot. `--fail-on-fail` exits 1 when a case carries a `fail` verdict **or** errored during replay, which makes it usable as a CI regression gate. Verdicts are manual in v1.

`eval cases import` has no bulk endpoint and no transaction: a mid-way failure leaves a partial import, and the CLI names the cases that landed so a retry does not duplicate them.

## Machine-readable output

Read commands accept `--json` and print the raw API payload, so scripts never scrape columns:

```bash
a2wave agents list --json | jq -r '.data[] | select(.publishStatus=="published") | .id'
a2wave chat send my-bot -m "ping" --json | jq -r '.data.reply'
```

Credentials are **redacted by default** (`********`). The API returns secrets in plaintext to an owner/editor, but CLI output lands in terminal scrollback, shell history and CI logs — pass `--show-secrets` only when piping to a secure consumer.

## Import and Export

```bash
a2wave agents export <agent-id-or-name> -o agent.zip
a2wave agents import ./agent.zip
a2wave agents import-url <remote-export-url>
```

Use import/export to migrate an Agent package and its dependent MCP Servers and Skills between different a2wave instances.

## Update

Always use:

```bash
a2wave update
```

`a2wave update` updates the `a2wave-cli` npm package. It queries the npm default registry unless `$A2WAVE_NPM_REGISTRY` is set, which lets you point it at a mirror. It does not install or update this companion skill — do that through whatever mechanism distributes skills on your machine.

After the Skill is updated, if the update needs to be reloaded into the model context, remind the user to restart the AI Agent application.

## Security Rules

- For destructive or broad-impact changes, run a read command or `--dry-run` first, and show the target to the user.
- Do not bypass platform authentication, and do not suggest anonymous invocation.
- Maintain a2wave's product boundary: a2wave orchestrates mature agent CLIs and extensions; it does not implement a new execution engine, sandbox runtime, or third-party trigger adapter.
