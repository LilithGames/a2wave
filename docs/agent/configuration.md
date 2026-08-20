# Configuration

All configuration is read from `.env` (see [`.env.example`](../../.env.example)).

**Nothing is required for the default SQLite setup.** `cp .env.example .env` and go —
every variable below has a working default. Running more than one replica is the one
exception; see `AUTH_SECRET`.

## Core

| Variable | Default | Description |
|------|------|------|
| `AUTH_SECRET` | auto-generated | Signing secret for sessions and tokens. Left empty, `pnpm dev` writes one into `.env` and the container persists one in its data volume, so restarts keep you logged in. Set it explicitly (`openssl rand -hex 32`) to control the value — an explicit secret is never overwritten. **Required when running more than one replica** (see below) |
| `DATABASE_URL` | `./data/a2wave.db` | A `postgres://` scheme selects PostgreSQL; anything else is a SQLite file path. See [PostgreSQL](./postgresql.md) |
| `SCM_STORAGE_ROOT` | `~/.a2wave` (`/data/workspace` in Docker) | Root for managed SCM checkouts under `sources/` and Git worktrees under `workspaces/` |

> [!IMPORTANT]
> **Multi-replica deployments must set `AUTH_SECRET` explicitly, to the same value on
> every replica.** A generated secret is private to the instance that made it, so
> replicas would sign tokens the others reject and encrypt SSO settings the others
> cannot read. Because PostgreSQL is the multi-instance backend, the container refuses
> to start rather than generate one when `DATABASE_URL` points at PostgreSQL.

> **Provider API keys** (`CURSOR_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) are
> **not** configured here — set them per Agent, on the Agent detail page → Environment
> Variables.

## Auth, networking and trusted hosts

| Variable | Default | Description |
|------|--------|------|
| `A2WAVE_HOST_PORT` | `3502` | Host port the Docker deployment publishes on. Remaps the **host** side only — the container always listens on 3502, because the image's `EXPOSE`, `PORT` default and `HEALTHCHECK` all hardcode it |
| `ADMIN_PASSWORD` | empty | Optional initial admin password, applied on first boot only and never overwritten. **Left empty, the first person to reach the setup page claims the admin account — no token guards it.** Set it if you cannot accept that window |
| `AUTH_SESSION_TTL_DAYS` | `7` | Login session lifetime (days) for browser cookies and login-issued bearer tokens, range `1~365`. A working week, so an ordinary user signs in about weekly. Not the lifetime of a [CLI token](./cli-tokens.md), which is chosen per token |
| `CORS_ORIGIN` | `http://localhost:3501` | Frontend origin, when it is served from a **different** origin than the API (the dev two-port setup). It grants both cross-origin reads and cookie-authenticated writes. The single-container deployment serves the frontend from the API itself, so same-origin requests are always allowed and this needs no change |
| `TRUSTED_PROXY` | `false` | Trust `X-Forwarded-For` only when the direct TCP peer is allowlisted below |
| `TRUSTED_PROXY_ADDRESSES` | empty | Comma-separated exact proxy IPv4/IPv6 addresses or CIDRs; proxies must overwrite XFF or append each hop |
| `TRUSTED_IMPORT_HOSTS` | empty | Exact Agent-export DNS hostnames allowed to resolve to controlled enterprise-private addresses during URL import |
| `TRUSTED_MCP_HOSTS` | empty | Exact remote MCP DNS hostnames allowed to resolve to controlled enterprise-private addresses |
| `TRUSTED_A2A_ROUTE_HOSTS` | empty | Exact remote A2A DNS hostnames allowed as private-address exceptions when public-only mode is enabled |
| `SCM_WORKSPACES_ALLOWED_ROOTS` | empty | Comma-separated absolute roots approved for non-admin custom Git workspaces; `SCM_STORAGE_ROOT/workspaces` is always allowed, while `SCM_STORAGE_ROOT/sources` is always rejected to protect managed checkouts |
| `ALLOW_PRIVATE_ROUTE_TARGETS` | `true` | Allow ordinary private/CGNAT/ULA remote A2A targets with per-hop validation and DNS pinning; set `false` for public-only mode (exact hostname exceptions remain available) |

> Adjusting `AUTH_SESSION_TTL_DAYS` only affects new logins / newly issued tokens; to
> immediately tighten already-issued tokens, combine it with logout, password change,
> or `tokenVersion` revocation.

## macOS Docker Desktop

CLI-generated installs use a Docker named volume and need no macOS file-sharing
setup. The repository-root `docker-compose.yml` keeps its historical host bind default
for upgrade compatibility; on macOS, point it at a directory under `/Users`.

| Variable | Description |
|------|------|
| `A2WAVE_WORKSPACE_DIR` | Host directory used by the repository-root Compose deployment, e.g. `$HOME/a2wave-workspace` |
| `A2WAVE_RUN_AS_UID` | UID the container process runs as, e.g. `10001` |
| `A2WAVE_RUN_AS_GID` | GID the container process runs as, e.g. `10001` |

## SCM sources

Bootstrap a Git or Perforce checkout from the environment on first boot.

### P4 SCM source (created automatically once all fields are filled in)

| Variable | Description |
|------|------|
| `SCM_P4_PORT` | P4 server address (Perforce native protocol, not HTTP). Plaintext: `host:1666`, SSL: `ssl:host:1666` |
| `SCM_P4_USER` | P4 username |
| `SCM_P4_PASSWD` | P4 password |
| `SCM_P4_CLIENT` | P4 Workspace name |
| `SCM_P4_DEPOT_PATH` | Depot path, e.g. `//depot/main/...` |
| `SCM_P4_LOCAL_PATH` | Required for a new env-seeded P4 source; absolute mounted path covered by the P4 Client `Root` or `AltRoots` (repository-root Compose defaults it to `/data/workspace/main`). Existing `env:p4` rows retain their saved path when this is empty |
| `SCM_P4_AUTO_SYNC` | Whether to auto-sync, defaults to `true` |

### Git SCM source (created automatically once the URL is set)

| Variable | Description |
|------|------|
| `SCM_GIT_REPO_URL` | Repository address |
| `SCM_GIT_BRANCH` | Branch, defaults to `main` |
| `SCM_GIT_USERNAME` | Username (HTTPS authentication) |
| `SCM_GIT_PAT` | Personal Access Token |
| `SCM_GIT_LOCAL_PATH` | Optional clone directory; empty allocates a managed path under `SCM_STORAGE_ROOT/sources` |
| `SCM_GIT_AUTO_SYNC` | Whether to auto-sync, defaults to `true` |

## Settings overrides (optional)

| Variable | Description |
|------|------|
| `SETTINGS_GENERAL_WORKSPACE_PATH` | Workspace path |
| `SETTINGS_GENERAL_TIMEOUT_MINUTES` | Global timeout (minutes) |
| `SETTINGS_BRANDING_SUBTITLE` | Branding subtitle |
| `SETTINGS_BRANDING_FAVICON_URL` | Favicon address |
