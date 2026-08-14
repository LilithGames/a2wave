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

PostgreSQL shares database state only. SCM checkouts and Git worktrees remain
filesystem state: the Compose `a2wave-workspace` named volume is appropriate for
one API container, while replicas must mount the same RWX-capable PVC at the same
`SCM_STORAGE_ROOT` path. Node-local volumes would give each replica a different
checkout even though they share the same SCM Source row.

### ⚠️ Upgrading to this release is non-rolling

**Stop every API replica before applying these migrations, then start only the
upgraded version.** Two independent reasons, either of which is sufficient:

1. An older remover deletes workspace-removal reservations by stable id alone
   and can erase a newer attempt's `attempt_token` fence.
2. A pre-heartbeat replica writes no `instance_heartbeats` row. Upgraded peers
   read a missing row as "dead" once past their startup grace window, so they
   would reclaim leases and worktrees out from under a replica that is very
   much alive.

Both failure modes are silent, so mixed-version operation is unsupported even
briefly.

### How recovery works

Run and Evaluation admission persists an SCM workload lease in the same
transaction that snapshots the Agent binding. This prevents another replica from
unbinding the Agent or reclaiming its checkout while the workload is queued,
executing, cancelled-but-exiting, or cleaning up. Queue capacity decisions are also
made under the same cross-replica transaction lock.

**Liveness comes from heartbeats, never from age.** Every process renews an
`instance_heartbeats` row every 30s and deletes it during graceful shutdown. A
mark's owner counts as dead only when it has no row, stopped beating past five
minutes, or booted *after* the mark was written (a reused instance id — the same
`HOSTNAME` across container restarts). Age alone proves nothing: multi-repository
Git work and filesystem cleanup routinely outlive any per-command timeout.

Three guards keep this honest, and they are the reason manual reconciliation is
now the exception rather than the routine:

- **Recovery of peers is withheld for one staleness window after boot**, so the
  empty heartbeat table right after an upgrade is not read as "everyone died".
- **A process fail-stops before peers may reclaim it.** Four minutes without a
  successful renewal irreversibly pauses admission/promotion and starts global
  graceful shutdown; active CLIs are terminated and the process exits before
  peers use the five-minute death threshold. A late renewal cannot revive the
  old ownership. The one-minute margin, rather than a distributed epoch on
  every filesystem call, is the deliberate operational trade-off.
- **Recovery re-checks liveness immediately before its guarded claim.** Once an
  owner reaches the five-minute peer threshold, the earlier fail-stop deadline
  makes that stale verdict monotonic for the old process lifetime; status and
  removal-token CAS still arbitrate concurrent recovery replicas.

On that basis a surviving replica automatically:

- fails workloads abandoned by a stopped instance (the Run gets a retryable
  `INSTANCE_STOPPED_DURING_EXEC`, its A2A task is synced, the Evaluation task
  fails with an `evaluation_task.execute` audit entry), then releases their
  leases. Run status/result/steps and Evaluation task/results/audit settle in
  one database transaction, so a failed write leaves the workload retryable on
  the next tick rather than terminal-but-incomplete;
- adopts workspace-removal reservations with no live owner, re-runs the same
  occupancy decision every remover runs, and either finishes the removal or
  releases the row as obsolete. A failed attempt is disowned again so the next
  tick retries — that periodic tick *is* the retry loop.

A starting PostgreSQL replica still does **not** fail `running`/`pending`
workloads or reset `syncing`/`indexing` SCM rows on boot: another replica
starting says nothing about a peer. Recovering a peer's work is the
heartbeat-driven reaper's job, not startup's. SQLite keeps automatic restart
recovery because it has only one API process, where a restart does prove the
predecessor is gone.

Draining workloads before intentionally removing a replica is still the clean
path — graceful shutdown releases leases and removes the heartbeat row
immediately, instead of leaving peers to wait out the staleness window.

### Manual reconciliation (last resort)

With the reconciler in place this should not be needed; reach for it only when a
reservation is visibly stuck past several sweep intervals **and** you have
confirmed no replica is still working on it. Never delete by age or by source.
Record both values first:

```sql
SELECT id, attempt_token, owner_instance_id, attempt_started_at
FROM scm_workspace_removals
ORDER BY attempt_started_at;
```

Check the owner against live processes before touching anything:

```sql
SELECT id, started_at, heartbeat_at, now() - heartbeat_at AS since_beat
FROM instance_heartbeats
ORDER BY heartbeat_at DESC;
```

A row whose `owner_instance_id` still appears here with a recent `heartbeat_at`
is **live** — leave it alone. Otherwise release only the exact observed attempt:

```sql
DELETE FROM scm_workspace_removals
WHERE id = '<observed id>' AND attempt_token = '<observed attempt_token>';
```

If zero rows are affected, the reservation changed after inspection; stop and
re-investigate instead of broadening the predicate.

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

**4. In-process locks are per-replica.** Every remaining `withKeyedLock` key — for
example skill reupload — serialises callers *within one process only*. SCM workload
admission, Agent binding mutation, and Run/Evaluation queue claims are the important
exceptions: they use the cross-dialect SCM mutation transaction, backed by a
PostgreSQL transaction-scoped advisory lock. A queued or active workload also holds
a durable source lease until its process and workspace cleanup finish.

## Installing with the CLI

`a2wave setup` can select the PostgreSQL backend at install time:

```bash
# External server (validated as a postgres:// / postgresql:// URL)
a2wave setup --yes --database-url postgres://a2wave:pw@db.internal:5432/a2wave

# Bundled postgres:16-alpine sidecar; the password is generated into the
# install's .env (0600) and wired into DATABASE_URL
a2wave setup --yes --with-postgres
```

> [!NOTE]
> These setup flags were added after CLI v0.7.2 and are not present in the
> published `a2wave@0.7.2` package. Confirm that `a2wave setup --help` lists
> `--with-postgres` before using them.

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
