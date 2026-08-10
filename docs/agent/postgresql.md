# PostgreSQL Backend (Experimental)

> ⚠️ **PostgreSQL support is EXPERIMENTAL.** It is not yet recommended for
> production. **SQLite remains the supported default**, and is what every
> released deployment has run on.
>
> What "experimental" means here, concretely:
>
> - The backend passes the full unit suite and an end-to-end smoke test (boot,
>   migrations, setup, login, agent CRUD, settings, audit), but it has **no
>   production soak time** — no long-running deployment, no load testing, no
>   failover or connection-drop testing.
> - There is **no SQLite → PostgreSQL data migration path** (see below), so
>   adopting it means starting from an empty database.
> - The dual-backend abstraction is young. Expect the sharp edges to be in
>   dialect-specific SQL (JSON operators, LIKE collation, time bucketing) and in
>   transaction semantics, which differ genuinely between the two drivers.
>
> Use it to evaluate multi-instance deployment, or on a non-critical instance.
> Report issues rather than assuming a behaviour difference is intended.

a2wave runs on **SQLite (default, supported)** or **PostgreSQL ≥ 9.6
(experimental)**. The backend is chosen by `DATABASE_URL` alone — a `postgres://`
or `postgresql://` scheme selects PostgreSQL, anything else is treated as a
SQLite file path. There is no separate driver switch to keep in sync.

```bash
# SQLite (default) — a file path, relative to the API working directory
DATABASE_URL=./data/a2wave.db

# PostgreSQL
DATABASE_URL=postgres://a2wave:a2wave@localhost:5432/a2wave
DATABASE_POOL_MAX=10   # optional, default 10
```

## When to choose which

**SQLite is the right default, and the only one currently supported.** One
container, one file, no external dependency, and it comfortably handles a
single-instance deployment. Unless you specifically need what PostgreSQL offers
below, stay on SQLite.

**PostgreSQL targets multi-instance deployments.** SQLite is a single file on a
single filesystem, so two API replicas cannot share it safely. If you run more
than one replica behind a load balancer — or you want your existing database
backup, replication and monitoring to cover a2wave — PostgreSQL is the direction,
with the experimental caveat above.

### ⚠️ Startup recovery is not replica-aware — read this before running replicas

**A second replica starting up will fail every run the first one is executing.**
`recoverInterruptedRuns()` in `engine/task-queue.ts` marks *all* `running` rows as
`SERVER_RESTART_DURING_EXEC`, with no filter for which instance owns them — the run
queue was written for a single process, where every `running` row really was orphaned
by the restart. With replicas that assumption is false: during a rolling update,
replica B boots and kills the work still executing on replica A, which then finishes
and writes the same rows back.

This is worse than a stale cache: it does not serve an outdated value, it destroys
in-flight work. Until runs carry an owning-instance id and recovery filters on it,
treat multi-replica PostgreSQL as **unsuitable for long-running Agent work**. If you
run replicas anyway, drain runs before rolling, or accept that a deploy cancels
whatever is executing.

### ⚠️ Caches are per-process — read this before running replicas

PostgreSQL makes shared *state* correct; it does **not** make in-memory caches
cluster-aware. Three of them matter, in descending order of impact:

**1. The settings cache (`lib/settings-cache.ts`) — the big one.** Settings reads
are served from an in-process snapshot, and only the replica that *handles* the
write calls `refreshSettingsCache()`. So after an admin saves on replica A,
replicas B..N keep serving the old values **until they restart**. That covers the
auth policy, SSO config, retention windows, attachment limits, and security
switches such as `settings.artifacts.requireAuthForDownload`.

This is a **behaviour change introduced by the async migration** — settings used
to be read from the database on every access. It is the single strongest reason
not to run multiple replicas in production yet, and a large part of why the
backend is labelled experimental. A short TTL or `LISTEN`/`NOTIFY` invalidation is
the obvious fix and is not implemented.

**2. The OIDC config cache** invalidates only on the process that handled the
save; the 1s TTL in `src/lib/oidc.ts` bounds the divergence.

**3. Feishu long-connection status** (`GET /api/agents/feishu-connections`)
reflects only the instance answering the request — the response's `meta.scope`
says so explicitly.

**4. In-process locks are per-replica.** Every `withKeyedLock` key — the SQLite
transaction boundary, skill reupload, and the evaluation slot acquire — serialises
callers *within one process only*. On a single replica that is sufficient; across
replicas two callers can hold the "same" lock simultaneously.

The one with a user-visible consequence is the evaluation slot: two submissions
landing on different replicas can both start a task for the same Agent, and a
**P4-backed Agent has no per-task workspace isolation**, so they would share one
checkout. Closing this properly needs the database to hold the invariant — a
partial unique index on `(agent_id) WHERE status = 'running'` — which means a
migration on both lineages and is not implemented.

## Installing with the CLI

`a2wave setup` can select the PostgreSQL backend at install time:

```bash
# External server (validated as a postgres:// / postgresql:// URL)
a2wave setup --yes --database-url postgres://a2wave:pw@db.internal:5432/a2wave

# Bundled postgres:16-alpine sidecar; the password is generated into the
# install's .env (0600) and wired into DATABASE_URL
a2wave setup --yes --with-postgres
```

The generated compose file reads `DATABASE_URL=${DATABASE_URL:-/app/data/a2wave.db}`
from the install's `.env`, so switching an existing install is a one-line `.env`
edit followed by `docker compose up -d`. The two flags are mutually exclusive,
and both are rejected with `--upgrade` (an upgrade never rewrites `.env`).
Remember that inside the container `localhost` is the container itself — an
external database on the host machine is reached as `host.docker.internal`
(Docker Desktop) or the host IP. On a PostgreSQL install, `setup --upgrade`'s
data-volume backup does **not** cover the database; take a `pg_dump` first.

## Running with Docker Compose

The bundled PostgreSQL service sits behind a compose profile, so the default
`docker compose up` stays a single container:

```bash
# PostgreSQL requires an explicit AUTH_SECRET: a generated one is private to the
# instance that made it, and the entrypoint refuses to start rather than hand
# replicas keys they cannot share. Generate a real 64-character value — pasting
# the command text itself yields 22 characters and fails the 32-character floor.
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
echo "DATABASE_URL=postgres://a2wave:a2wave@postgres:5432/a2wave" >> .env

docker compose --profile postgres up -d
```

The service is pinned to `postgres:16-alpine` (override with `POSTGRES_VERSION`).
16 is the version a *new* deployment should choose; 9.6 is merely the oldest
server a2wave still runs against, for operators stuck on a legacy instance.

### Running Docker PostgreSQL alongside a local SQLite instance

`postgres` in that URL is the **compose service name** — it resolves on the
compose network and nowhere else. But `.env` is loaded by *every* a2wave process,
containerised or not, so a `DATABASE_URL` committed there is also what
`pnpm run dev` and `pnpm db:migrate` read on the host, where the name does not
resolve. One variable cannot hold both correct values:

| Consumer | Correct value |
|:--|:--|
| Container | `postgres://a2wave:a2wave@postgres:5432/a2wave` |
| Host process | `./data/a2wave.db` (the built-in default) |

Compose reads `.env` only to *forward* the value inward, and already falls back
(`${DATABASE_URL:-/app/data/a2wave.db}`). So leave the variable out of `.env`
and set it where only the container sees it:

```bash
# .env — leave DATABASE_URL commented out; host commands then use the SQLite default

# Pass it per command … (AUTH_SECRET must come along; see above)
DATABASE_URL=postgres://a2wave:a2wave@postgres:5432/a2wave \
AUTH_SECRET="$(openssl rand -hex 32)" \
  docker compose --profile postgres up -d
```

```yaml
# … or once, in docker-compose.override.yml, which host commands never read
services:
  api:
    environment:
      - DATABASE_URL=postgres://a2wave:a2wave@postgres:5432/a2wave
      # Same value on every replica — see "Startup recovery is not replica-aware".
      - AUTH_SECRET=<a real 64-character value from `openssl rand -hex 32`>
```

Host runs then fall through to `./data/a2wave.db` — a per-worktree SQLite file,
matching the worktree isolation the repo already assumes.

> Shell exports take precedence over `.env` (`process.loadEnvFile` does not
> overwrite an already-set variable), so `export DATABASE_URL=...` leaks into
> host commands in the same shell. Prefer the per-command prefix or the override
> file.

To point a *host* process at the containerised database instead, publish the
port (the compose file deliberately does not) and use `localhost` — never the
service name.

The database port is deliberately **not** published to the host — the API reaches
it over the compose network. Binding 5432 would expose the database, with its
default password, to anything that can reach the machine. Change
`POSTGRES_PASSWORD` before using this outside a local trial.

## Migrations

The two dialects keep **separate migration lineages**, and this is deliberate:

| Backend | Directory | Config |
|---|---|---|
| SQLite | `apps/api/drizzle/` | `drizzle.config.ts` |
| PostgreSQL | `apps/api/drizzle-pg/` | `drizzle.pg.config.ts` |

They cannot share a folder. The generated DDL genuinely differs (`jsonb` vs
`text`, `timestamptz` vs integer epochs, `bigint` for the 64-bit columns), and
the SQLite lineage carries ~100 migrations of history that a fresh PostgreSQL
database must never replay. **A PostgreSQL deployment starts from the current
schema as migration 0.**

`pnpm db:migrate` reads `DATABASE_URL` and applies the matching lineage
automatically. Both directories ship in the Docker image.

Adding a schema change means regenerating **both**:

```bash
# 1. edit apps/api/src/db/schema.sqlite.ts
pnpm db:generate              # SQLite migration
pnpm db:generate:pg           # regenerate schema.pg.ts from the SQLite schema
pnpm db:generate:pg:migration # PostgreSQL migration
pnpm db:migrate               # apply to whichever backend DATABASE_URL points at
```

`schema.pg.ts` is **generated, not hand-written** — that is what keeps the two
dialects from drifting. Do not edit it directly.

## There is no data migration between backends

a2wave ships **no SQLite → PostgreSQL data migration tool**. Pointing
`DATABASE_URL` at a PostgreSQL server gives you an empty a2wave, not a copy of
your SQLite data. Choose the backend when you deploy; moving an existing
installation means exporting and re-importing your Agents (agent export/import
round-trips through the API) or writing a one-off migration yourself.

## Writing dialect-neutral code

Most application code is already dialect-neutral, because every query goes
through Drizzle and every DB call is `async`. Four things still need care:

1. **Transactions must use `withTransaction`** (`src/db/transaction.ts`), never
   `db.transaction()` directly. better-sqlite3 is synchronous and rejects an
   async callback outright with `Transaction function cannot return a promise`,
   so a raw `db.transaction(async …)` is a guaranteed runtime failure on the
   default backend. The helper branches on the dialect and documents its
   atomicity argument.

   **A write issued outside any transaction, on a path that can run concurrently
   with one, must go through `runExclusive`** (same module). SQLite shares one
   connection process-wide, so a plain `db.insert(...)` that happens to run while
   another request holds a `BEGIN` joins that transaction and is erased if it
   rolls back — after the write's own request already returned success. Every
   `await` yields the event loop (`await db.insert(...)` included, since drizzle
   settles through the microtask queue), so this window is ordinary, not exotic.
   `runExclusive` serialises on the transaction key and waits instead of joining.
   `logAudit` / `logBackgroundAudit` already do this; dropping an audit entry this
   way breaches Iron Rule 5. On PostgreSQL it is a pass-through — each caller has
   its own pooled client.

2. **Never read driver-specific result fields.** better-sqlite3 reports
   `changes`, node-postgres reports `rowCount`. Use `.returning()` and count the
   rows instead — this is what every compare-and-set guard in the codebase does.

3. **JSON, LIKE and time bucketing go through the dialect helpers**
   (`src/db/dialect-runtime.ts`): `jsonExtract`, `jsonSet`, `jsonPathIsAbsent`,
   the case-insensitive LIKE wrapper, and the time-bucket builder. Raw
   `json_extract(...)` SQL is SQLite-only.

4. **Unique-violation detection is dialect-aware** — use the shared helper
   rather than matching on `UNIQUE constraint failed`, which is SQLite's wording.

## Verifying a deployment

```bash
curl localhost:3502/api/health/ready   # {"status":"ready"} once seeding finished
curl localhost:3502/api/health         # checks.database.ok must be true
```

`/api/health/ready` returns 503 `starting` until boot-time seeding completes.
Point your `readinessProbe` at it so a rolling update never routes traffic into
the window where the port is bound but settings have not been written yet.
