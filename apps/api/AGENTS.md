# apps/api — Agent Guide

Hono + Drizzle ORM API service, running on SQLite (the supported default) or
PostgreSQL ≥ 9.6 (**experimental** — see below). The backend is selected by
`DATABASE_URL` alone. See the root [AGENTS.md](../../AGENTS.md) for global
conventions and [docs/agent/postgresql.md](../../docs/agent/postgresql.md) for the
dual-backend rules (separate migration lineages, `withTransaction`, no
driver-specific result fields).

> ⚠️ **PostgreSQL is EXPERIMENTAL** and not yet recommended for production — no
> production soak time, and no SQLite → PostgreSQL data migration path. Code
> changes must still keep both dialects working: the CI suite covers both, and
> the process warns on boot when PostgreSQL is selected.

> **Trust model (read before touching auth / permissions / credential handling).**
> a2wave targets **internal enterprise teams** and assumes **Agent authors and
> users are all trusted colleagues acting in good faith**. The API's security
> controls — authentication, per-Agent owner/editor/viewer permissions, audit
> logging, rate limiting, per-run credential injection — enforce **accountability
> and least privilege among cooperating teammates**, not defense against a
> malicious insider or untrusted Agent configurations. Don't file/fix "issues"
> that only arise from a hostile authenticated author; that's outside the design.
> Full statement: root [SECURITY.md](../../SECURITY.md) and [PRODUCT.md](../../docs/PRODUCT.md).

## Directory Structure

```
src/
├── a2a/          # A2A protocol implementation
├── db/           # Drizzle schema, client, migrate
├── engine/       # Execution engines (cursor-agent, claude-code, etc.)
├── lib/          # Utility functions (id generation, logger, schedule-trigger, etc.)
├── mcp-servers/  # MCP Server management (connections, tool discovery)
├── middleware/    # Hono middleware (auth, rate limiting, etc.)
├── routes/       # Hono routes (agents, providers, skills, runs, etc.)
├── types/        # Type definitions
├── worker/       # Agent execution layer (executeInWorker)
├── env.ts        # Zod environment variable validation
├── index.ts      # Application entry point
└── openapi.ts    # OpenAPI definitions
```

## Key References

| File | Description |
|------|------|
| [src/db/schema.ts](./src/db/schema.ts) | Database table definitions (agents, providers, waves, wave_steps) |
| [drizzle.config.ts](./drizzle.config.ts) | Drizzle Kit configuration |
| [.env.example](./.env.example) | Environment variable template |
| [package.json](./package.json) | Available scripts |

## Database Migrations (Drizzle ORM)

### Standard Workflow

**Every schema change must be generated for both dialects.** They keep separate
lineages (`drizzle/` for SQLite, `drizzle-pg/` for PostgreSQL) because the DDL
genuinely differs and a fresh PostgreSQL database must never replay the SQLite
history. Generating only one leaves the other backend broken at boot.

1. Edit `src/db/schema.sqlite.ts` (the source of truth for both dialects)
2. `pnpm run db:generate` — SQLite migration into `drizzle/`
3. `pnpm run db:generate:pg` — regenerate `src/db/schema.pg.ts` from the SQLite schema
4. `pnpm run db:generate:pg:migration` — PostgreSQL migration into `drizzle-pg/`
5. `pnpm run db:migrate` — apply to whichever backend `DATABASE_URL` points at

`schema.pg.ts` is **generated, never hand-edited** — that is what keeps the two
dialects from drifting.

### Command Cheatsheet

| Command | Description |
|:--|:--|
| `pnpm run db:generate` | Diff the schema and generate a new SQLite migration |
| `pnpm run db:generate:pg` | Regenerate `schema.pg.ts` from the SQLite schema |
| `pnpm run db:generate:pg:migration` | Generate a new PostgreSQL migration |
| `pnpm run db:migrate` | Apply pending migrations (dialect from `DATABASE_URL`) |
| `pnpm run db:studio` | Drizzle Studio visual browser |

## Admin Password Recovery

When nobody can log in as admin, two operator scripts under `src/scripts/` exist. Both
reuse the app's own `hashPassword` / `validatePassword` rather than touching SQLite by
hand, and both tolerate a missing `.env` (they never sign tokens) — that being the exact
situation they exist for. Both also bump `tokenVersion` and write an
`admin.password_reset` audit entry (`logBackgroundAudit`, since a script has no Hono
request context): a credential reset that leaves outstanding sessions/tokens valid, or
leaves no trail, defeats the point of the reset.

| Command | Effect |
|:--|:--|
| `pnpm set-admin-password` | Prompt for a new password (masked, twice, policy-checked), write it, revoke every outstanding admin token. Effective immediately, **no restart** |
| `pnpm reset-admin` | Clear the admin's `passwordHash` and revoke tokens, so the platform immediately serves the setup screen — **dev/source-checkout only, see below** |

`set-admin-password` is **compiled into `dist/scripts/`** by `pnpm build`, so it also
works in the production image, where no `src/` or `tsx` exists:

```bash
docker exec -it --user appuser <container> node /app/apps/api/dist/scripts/set-admin-password.js
# or, for a `a2wave setup` install, let the CLI find the container:
a2wave setup --reset-password
```

`--user appuser` matters: `docker exec` bypasses `docker-entrypoint.sh` (and the `gosu`
privilege drop it performs), so it defaults to **root** even though the server process
itself runs as `appuser` — pin it back to parity. `docker exec -it` supplies the TTY the
masked prompt requires; the script refuses to run without one rather than echoing the
password in the clear. Neither script accepts the password on argv, keeping it out of
shell history and `ps`.

**`reset-admin` is deliberately excluded from the production build/image.** Clearing the
hash reopens unauthenticated `POST /auth/setup` **immediately** — `isSetupRequired()`
reads the DB live, so no restart is needed — and shipping that script in an image
reachable via `docker exec` turns a local convenience into a live attack surface. It
stays available only via `pnpm reset-admin` against a source checkout; `set-admin-password`
is the only recovery path in the image, and is strictly preferable in every case since it
never opens that window.

`ADMIN_PASSWORD` is **not** a recovery mechanism: `ensureAdminExists()` applies it only
when `passwordHash === null`, so setting it while a password already exists is silently
ignored. That is deliberate — an env var that could overwrite a live password would be a
backdoor — but it means editing it while locked out does nothing.

### Rules

- **Always use `db:generate` + `db:migrate`**; never use `db:push` on a database with existing data
- **Never create migration files manually** (`drizzle/0xxx_*.sql`) or hand-edit `drizzle/meta/_journal.json` — they must be generated via `pnpm db:generate`. Manually created files get incorrect `when` timestamps, causing Drizzle to misjudge migration order and skip execution.
- Do not manipulate the `__drizzle_migrations` table manually
- New `NOT NULL` columns must include a `DEFAULT` — verify the generated SQL contains it
- Both `drizzle/` and `drizzle-pg/` (SQL + `meta/`) **must be committed to Git** — the Docker image copies both
- **Never call `db.transaction()` directly** — use `withTransaction` from `src/db/transaction.ts`. better-sqlite3 rejects an async callback outright (`Transaction function cannot return a promise`), so a raw async `db.transaction()` is a guaranteed runtime failure on the default backend
- **A non-transactional write that can race a transaction must go through `runExclusive`** (same module). One shared SQLite connection means a plain `db.insert(...)` running while another request holds a `BEGIN` joins that transaction and is erased if it rolls back — after its own request already returned success. Every `await` yields the event loop, so the window is routine. `logAudit` uses it; losing an audit entry this way breaches Iron Rule 5
- **Never read `changes` / `rowCount`** off a write result — the two drivers disagree. Use `.returning()` and count rows, as every compare-and-set guard here does
- **JSON / LIKE / time-bucket queries go through `src/db/dialect-runtime.ts`**; raw `json_extract(...)` is SQLite-only
- The `data/` directory is gitignored; database files are not committed
- **Production service**: data changes must follow the backup-migrate-verify workflow; never run migrations directly on an unbacked-up production database

### Production Migration Procedure

The service is live; any schema change can affect production data. **All three steps below are mandatory**:

**① Backup**

```bash
# SQLite
cp data/db.sqlite data/db.sqlite.bak.$(date +%Y%m%d%H%M%S)

# PostgreSQL
pg_dump "$DATABASE_URL" > a2wave.bak.$(date +%Y%m%d%H%M%S).sql
```

Must be done before migrating; confirm the backup file exists before continuing.

**② Migrate**

```bash
pnpm run db:migrate
```

Watch the output and proceed only if there are no errors. If anything fails, stop and restore from the backup.

**③ Verify**

- Check that key tables' row counts and field values match expectations
- Confirm the service responds normally (`GET /api/health`)
- Spot-check business data integrity

**Rollback**: if a migration fails, restore from the backup file; never retry repeatedly against the production database.

```bash
cp data/db.sqlite.bak.<timestamp> data/db.sqlite
```

**High-risk operations** (require extra review; write data compensation scripts when necessary):

- Dropping a column
- Renaming a column
- Changing a column type
- Dropping a table

## Audit Logging

**Every route that creates, updates, or deletes state must write an audit entry.** Use `logAudit(c, {...})` from [`src/lib/audit.ts`](./src/lib/audit.ts); background work with no Hono context uses `logBackgroundAudit({...})` and takes its identity from the row that scheduled it. A write with no audit trail makes "who deleted this" permanently unanswerable — it is an Iron Rule 5 (auditability) violation, not a follow-up task.

Security-sensitive reads are audited too (`agent.diagnose`, `scm_source.probe`, `mcp_server.probe_stdio`, and **failed** auth attempts).

**`details` must never carry secrets.** It is stored as plaintext JSON and rendered verbatim on the audit page to every admin. No passwords, PATs, `p4passwd`, API keys, JWTs, cookies, private keys, or raw config objects. Mask with `maskScmConfig()`, hash with `hashEmail()`, or simply omit — `{ hasPat: true }` beats `{ pat }`.

Each new `action` / `resource` also needs zh + en copy in `apps/web/src/locales/*.json` under `auditLogs.actions` / `auditLogs.resources`; **arch gate R7 fails the commit** without it.

Full conventions, examples, and a pre-merge checklist: [docs/agent/audit-logging.md](../../docs/agent/audit-logging.md).

## SCM Storage Changes

SCM paths are a cross-cutting persistence boundary, not a route-local detail.
Before changing source creation, bootstrap, sync, deletion, workspace cleanup,
or container ownership, read and preserve the complete invariant set in
[SCM Storage Invariants](../../docs/agent/scm-storage-invariants.md). Every
affected create/PATCH/DELETE/startup/bootstrap and Git/P4 path must be checked;
the SQLite/PostgreSQL and volume/bind integration gate is
`pnpm test:scm-storage`.

Two rules that catch most mistakes in this area:

- **Every recovery decision has two semantics, not one.** SQLite is a single
  process, so a restart proves its predecessor is dead and it may clean up
  synchronously. PostgreSQL cannot infer that — a booting replica says nothing
  about a peer — so recovery there waits on `instance_heartbeats`. Code that
  reclaims anything must be correct under both; `if (!isPostgres)` guards mark
  the places where they genuinely differ.
- **A liveness verdict must be re-checked inside the transaction that acts on
  it.** Reading the heartbeat table before taking the lock is a check-then-act:
  the owner can resume beating in between, and the reclaim would then evict a
  live process. Anything long-running that touches a checkout (sync, indexing,
  an evaluation's per-case loop, workspace removal) also consults
  `hasLostHeartbeatOwnership()` itself — admission-time checks alone do not
  make the fail-stop guarantee true.

## Testing Conventions

Framework: **Vitest**; test files live in a `__tests__/` directory next to the file under test.

| Command | Description |
|------|------|
| `pnpm test` | Run all unit tests (CI gate) |
| `pnpm test:watch` | Watch mode during development |

### Coverage Requirements

- `src/lib/` utility functions: 100% coverage
- `src/middleware/`: cover the core logic
- `src/routes/`: every route needs at least a happy-path + error-case integration test
- Run `pnpm test` locally before committing; zero failures required

## Documentation Sync

| Change Type | Update Required |
|----------|--------|
| Add/modify API routes | `src/openapi.ts`. Root `AGENTS.md` only if the change alters permission derivation or a cross-cutting invariant |
| Add/modify data models | Core Concepts in the root `AGENTS.md` |
| Environment variable changes | Keep `.env.example` + `src/env.ts` in sync |
| Core business rule changes | Root `PRODUCT.md` |
