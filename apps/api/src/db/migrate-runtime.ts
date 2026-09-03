import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { PoolClient } from 'pg'
import { env } from '../env.js'
import { logger } from '../lib/logger.js'
import { db, isPostgres, postgresPool, sqliteDatabase } from './client.js'
import { backupDatabaseBeforeMigrate } from './db-backup.js'
import { repairSkippedMigrations } from './migration-gap-repair.js'

/**
 * Drizzle's SQLite migrator decides which migrations to apply by comparing
 * `migration.when` (from _journal.json) against the MAX(created_at) in
 * `__drizzle_migrations`. If a journal entry's `when` was changed after the
 * migration was already applied (e.g. timestamp reorder fix), drizzle may
 * try to re-apply it — causing "duplicate column" errors and rolling back
 * all pending migrations.
 *
 * This fixup recomputes each journal entry's SHA-256 hash (same algorithm
 * drizzle uses) and patches any stale created_at values in the DB.
 */
function fixStaleMigrationTimestamps(migrationsFolder: string) {
  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json')
  if (!existsSync(journalPath)) return

  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    entries: Array<{ tag: string; when: number }>
  }

  const dbRows = sqliteDatabase
    .prepare('SELECT hash, created_at FROM __drizzle_migrations')
    .all() as Array<{ hash: string; created_at: number }>

  const dbByHash = new Map(dbRows.map((r) => [r.hash, r.created_at]))

  const update = sqliteDatabase.prepare(
    'UPDATE __drizzle_migrations SET created_at = ? WHERE hash = ?',
  )

  for (const entry of journal.entries) {
    const sqlPath = path.join(migrationsFolder, `${entry.tag}.sql`)
    if (!existsSync(sqlPath)) continue
    const sql = readFileSync(sqlPath, 'utf-8')
    const hash = createHash('sha256').update(sql).digest('hex')
    const dbTimestamp = dbByHash.get(hash)
    if (dbTimestamp !== undefined && dbTimestamp !== entry.when) {
      logger.info(
        { tag: entry.tag, old: dbTimestamp, new: entry.when },
        'Patching stale migration timestamp',
      )
      update.run(entry.when, hash)
    }
  }
}

/**
 * True when the journal declares more migrations than the DB has applied, i.e.
 * `migrate()` is about to change the schema. Used to gate the pre-migration
 * backup so a plain restart (no pending migrations) does not churn a backup on
 * every boot. Fails OPEN (returns true) on any uncertainty — a missing table or
 * an unreadable journal means we cannot prove the schema is current, so we back
 * up to be safe. First boot (no __drizzle_migrations) counts as pending, but
 * there is no DB file to copy yet so the backup step simply no-ops.
 */
function hasPendingMigrations(migrationsFolder: string): boolean {
  try {
    const journalPath = path.join(migrationsFolder, 'meta', '_journal.json')
    if (!existsSync(journalPath)) return false // no journal → nothing drizzle would apply
    const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
      entries: Array<{ tag: string; when: number }>
    }
    const appliedRows = sqliteDatabase
      .prepare('SELECT count(*) AS n FROM __drizzle_migrations')
      .get() as { n: number } | undefined
    const applied = appliedRows?.n ?? 0
    return journal.entries.length > applied
  } catch {
    return true // cannot prove the schema is current → back up defensively
  }
}

/**
 * Locate a migrations folder, tolerating both cwd conventions (Docker runs from
 * /app, local dev from apps/api).
 */
function findMigrationsFolder(dirName: string): string | undefined {
  const candidates = [path.resolve('apps/api', dirName), path.resolve(dirName)]
  const found = candidates.find((p) => existsSync(p))
  if (!found) {
    logger.warn({ candidates }, `No ${dirName} migrations folder found, skipping migrations`)
  }
  return found
}

/**
 * Key for the migration advisory lock.
 *
 * Any fixed 64-bit integer works; what matters is that every a2wave replica uses
 * the *same* one and that nothing else in this database picks it. Derived from
 * the ASCII of "a2wvmigr" so it is recognisable in `pg_locks` when an operator
 * is asking why a boot is waiting.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 0x6132_7776_6d69_6772n

/**
 * Serialise the PostgreSQL migration across replicas.
 *
 * drizzle's PostgreSQL migrator takes no lock, and a2wave elects no leader, so a
 * three-replica rollout has all three replaying the same DDL concurrently. The
 * losers fail on "relation already exists" and `process.exit(1)` carrying a
 * message that tells the operator never to retry against a database in an
 * unknown state — a half-failed rollout that refuses to self-heal, from a
 * database that was in fact perfectly fine.
 *
 * `pg_advisory_lock` is **session** scoped, so the lock and the work it guards
 * must share one connection. That is why this checks a client out of the pool
 * and keeps it for the duration instead of issuing the lock through `db`, which
 * would route the two statements to arbitrary pooled connections and protect
 * nothing. The transaction-scoped variant is not usable here: drizzle's migrator
 * opens and commits its own transactions, so an `xact` lock would be released at
 * the first commit, mid-migration.
 *
 * The locked client is handed to `run` because the guarded work must go through
 * it too, not merely be serialised by it. `DATABASE_POOL_MAX` accepts 1 (see
 * env.ts), and at that size the lock holder *is* the pool: a migrator issuing
 * DDL through the shared `db` would queue for a connection the lock holder only
 * returns once the migration finishes. Boot then hangs forever, with no error
 * and no timeout to explain it.
 *
 * The unlock and the release both run in `finally`. A leaked session lock would
 * block every subsequent boot until PostgreSQL reaps the backend — the failure
 * path is exactly the one that must not strand it.
 */
async function withMigrationLock<T>(run: (client: PoolClient | null) => Promise<T>): Promise<T> {
  if (!postgresPool) return await run(null)

  const client = await postgresPool.connect()
  try {
    logger.info('Waiting for the PostgreSQL migration advisory lock...')
    await client.query(`SELECT pg_advisory_lock(${MIGRATION_ADVISORY_LOCK_KEY})`)
    return await run(client)
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock(${MIGRATION_ADVISORY_LOCK_KEY})`)
    } catch (err) {
      // Losing the unlock is survivable — the lock dies with the session — but
      // it is never expected, so say so rather than swallowing it.
      logger.warn({ err }, 'Failed to release the migration advisory lock')
    }
    client.release()
  }
}

/**
 * Apply the PostgreSQL lineage.
 *
 * Deliberately none of the SQLite ceremony runs here:
 * - the pre-migration backup copies a *file*, which a server database is not.
 *   Backups are the operator's `pg_dump`, and pretending otherwise would give a
 *   false sense of having a rollback point.
 * - `fixStaleMigrationTimestamps` and `repairSkippedMigrations` both repair
 *   accumulated `drizzle/` journal history. PostgreSQL deployments start at
 *   migration 0 with no such history, and both reach for the raw better-sqlite3
 *   handle, which is null here.
 */
async function runPostgresMigrations(): Promise<void> {
  const migrationsFolder = findMigrationsFolder('drizzle-pg')
  if (!migrationsFolder) return

  const { migrate: migratePg } = await import('drizzle-orm/node-postgres/migrator')
  const { drizzle: drizzlePg } = await import('drizzle-orm/node-postgres')

  logger.info({ migrationsFolder }, 'Running PostgreSQL migrations...')
  try {
    await withMigrationLock(async (client) => {
      // Bind the migrator to the client holding the advisory lock: the DDL then
      // runs in the very session that took the lock, and needs no second
      // connection — which a pool sized 1 could not hand out anyway.
      //
      // Without a pool there is no lock either; `db` is statically typed as the
      // SQLite handle (see db/client.ts), but under a postgres:// URL the
      // runtime object is the node-postgres one, which is what this branch has
      // already established.
      const handle = client ? drizzlePg(client) : db
      await migratePg(handle as unknown as Parameters<typeof migratePg>[0], { migrationsFolder })
    })
  } catch (err) {
    logger.error(
      { err },
      '✗ PostgreSQL migration failed. Check that the role in DATABASE_URL can CREATE in this database, and that no partially-applied migration was left behind — never retry against a database in an unknown state.',
    )
    process.exit(1)
  }
  logger.info('Database migrations complete!')
}

export async function runMigrations() {
  if (isPostgres) {
    await runPostgresMigrations()
    return
  }

  const migrationsFolder = findMigrationsFolder('drizzle')
  if (!migrationsFolder) return

  // Back up the DB BEFORE any schema/journal-mutating step (fixStaleMigrationTimestamps
  // rewrites __drizzle_migrations rows; repairSkippedMigrations below actually applies
  // missing migrations and inserts journal rows). Deciding pendingness here — while the
  // applied-count still reflects the pre-repair state — is essential: doing it after the
  // repair would see applied === journal length and skip the backup, leaving a
  // just-migrated DB with no rollback point. The runtime startup migration (every
  // container boot) previously skipped the backup that the standalone `db:migrate` CLI
  // performs, leaving named-volume upgrades unprotected. Best-effort: a backup failure
  // is logged loudly but does NOT abort startup (a backup hiccup must not become an
  // outage), and it is skippable via A2WAVE_DB_BACKUP_SKIP for CI/tests.
  if (hasPendingMigrations(migrationsFolder)) {
    try {
      const result = backupDatabaseBeforeMigrate()
      if (!result.skipped) {
        logger.info({ target: result.target }, 'Backed up database before migration')
      }
    } catch (err) {
      logger.error(
        { err },
        '⚠ Pre-migration DB backup failed — proceeding with migration WITHOUT a fresh backup. ' +
          'If this migration corrupts the DB there is no automatic rollback point.',
      )
    }
  }

  try {
    fixStaleMigrationTimestamps(migrationsFolder)
  } catch (err) {
    // 首次启动时 __drizzle_migrations 表尚未创建属于预期情况，debug 级即可；
    // 其它错误（journal 损坏、权限、磁盘异常等）不能静默吞掉，必须留下排障线索。
    const msg = err instanceof Error ? err.message : String(err)
    if (/no such table:\s*__drizzle_migrations/i.test(msg)) {
      logger.debug('__drizzle_migrations table not present yet — skipping timestamp fixup')
    } else {
      logger.warn({ err }, 'fixStaleMigrationTimestamps failed, continuing to migrate()')
    }
  }

  try {
    const repairedCount = repairSkippedMigrations(sqliteDatabase, migrationsFolder)
    if ((await repairedCount) > 0) {
      logger.warn({ repairedCount }, 'Applied migrations skipped by a newer journal timestamp')
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/no such table:\s*__drizzle_migrations/i.test(msg)) throw err
  }

  logger.info({ migrationsFolder }, 'Running database migrations...')
  try {
    migrate(db, { migrationsFolder })
  } catch (err) {
    // A raw SqliteError ("duplicate column name: …") gives no hint that the fix
    // is a stale/hand-modified DB file, not the code.
    const dbPath = path.resolve(env.DATABASE_URL)
    logger.error(
      { err, dbPath },
      `✗ Database migration failed against ${dbPath}. The DB file is likely stale or was modified outside the migration flow. In dev, delete the file to start fresh; in production, restore the pre-migration backup — never retry against a broken DB.`,
    )
    process.exit(1)
  }
  logger.info('Database migrations complete!')
}
