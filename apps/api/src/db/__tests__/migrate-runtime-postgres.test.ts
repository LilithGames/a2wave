import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The PostgreSQL migration path.
 *
 * Everything the SQLite path does around `migrate()` — file-copy backup, WAL
 * checkpoint, `__drizzle_migrations` timestamp fixups, the skipped-migration
 * repair — is SQLite-specific machinery built for a single-file database with
 * ~97 migrations of accumulated history. On PostgreSQL each of those either
 * cannot work (there is no file to copy) or must not run (a fresh database
 * starts at migration 0, so there is no gap to repair). These tests pin that
 * they are skipped rather than attempted and silently swallowed.
 */
const callOrder: string[] = []

const pgMigrateMock = vi.fn(async () => {
  callOrder.push('pg-migrate')
})
vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: (...args: unknown[]) => pgMigrateMock(...(args as [])),
}))

const sqliteMigrateMock = vi.fn(() => {
  callOrder.push('sqlite-migrate')
})
vi.mock('drizzle-orm/better-sqlite3/migrator', () => ({
  migrate: () => sqliteMigrateMock(),
}))

const backupMock = vi.fn(() => {
  callOrder.push('backup')
  return { skipped: false, target: '/tmp/backup.db' }
})
vi.mock('../db-backup.js', () => ({
  backupDatabaseBeforeMigrate: () => backupMock(),
}))

const repairMock = vi.fn(() => {
  callOrder.push('repair')
  return 0
})
vi.mock('../migration-gap-repair.js', () => ({
  repairSkippedMigrations: () => repairMock(),
}))

/**
 * A fake pool whose `connect()` hands back one client that records every
 * statement into `callOrder`. The advisory lock is a *session* lock, so the
 * lock, the migration and the unlock must be observable as an ordered sequence
 * on a connection this module owns for the duration.
 */
const lockClientQuery = vi.fn(async (text: string) => {
  callOrder.push(text.includes('pg_advisory_unlock') ? 'unlock' : 'lock')
  return { rows: [] }
})
const lockClientRelease = vi.fn(() => {
  callOrder.push('release')
})
const poolConnect = vi.fn(async () => {
  callOrder.push('connect')
  return { query: lockClientQuery, release: lockClientRelease }
})

// The PostgreSQL client exposes no raw sqlite handle; touching it would throw.
vi.mock('../client.js', () => ({
  db: { __mockDb: true },
  sqliteDatabase: null,
  isPostgres: true,
  postgresPool: { connect: () => poolConnect() },
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { runMigrations } from '../migrate-runtime.js'

let tmp: string
let cwdBackup: string
// The migration failure path calls process.exit(1). Stubbed so the test can
// observe it instead of tearing down the worker mid-assertion.
const exitMock = vi.fn()

beforeEach(() => {
  callOrder.length = 0
  pgMigrateMock.mockClear()
  sqliteMigrateMock.mockClear()
  backupMock.mockClear()
  repairMock.mockClear()
  poolConnect.mockClear()
  lockClientQuery.mockClear()
  lockClientRelease.mockClear()
  exitMock.mockClear()
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitMock(code)
  }) as never)

  tmp = mkdtempSync(path.join(os.tmpdir(), 'migrate-pg-'))
  // runMigrations resolves the folder relative to cwd.
  mkdirSync(path.join(tmp, 'drizzle-pg', 'meta'), { recursive: true })
  writeFileSync(
    path.join(tmp, 'drizzle-pg', 'meta', '_journal.json'),
    JSON.stringify({ entries: [{ tag: '0000_init', when: 1 }] }),
  )
  writeFileSync(path.join(tmp, 'drizzle-pg', '0000_init.sql'), 'CREATE TABLE x (id text);')
  cwdBackup = process.cwd()
  process.chdir(tmp)
})

afterEach(() => {
  vi.restoreAllMocks()
  process.chdir(cwdBackup)
  rmSync(tmp, { recursive: true, force: true })
})

describe('runMigrations on PostgreSQL', () => {
  it('runs the node-postgres migrator, not the better-sqlite3 one', async () => {
    await runMigrations()

    expect(pgMigrateMock).toHaveBeenCalledTimes(1)
    expect(sqliteMigrateMock).not.toHaveBeenCalled()
  })

  it('migrates from the postgres lineage, never the sqlite drizzle/ folder', async () => {
    // Replaying the ~97-migration SQLite history against PostgreSQL would fail
    // on the first dialect-specific statement.
    await runMigrations()

    const [, opts] = pgMigrateMock.mock.calls[0] as unknown as [
      unknown,
      { migrationsFolder: string },
    ]
    expect(opts.migrationsFolder).toContain('drizzle-pg')
    expect(path.basename(opts.migrationsFolder)).not.toBe('drizzle')
  })

  it('skips the file-copy backup, which has no meaning for a server database', async () => {
    await runMigrations()

    expect(backupMock).not.toHaveBeenCalled()
  })

  it('skips the skipped-migration repair, which is SQLite journal history', async () => {
    await runMigrations()

    expect(repairMock).not.toHaveBeenCalled()
  })

  it('holds a session advisory lock across the migration and releases it after', async () => {
    // Three replicas rolling out together all run this at boot. drizzle's
    // PostgreSQL migrator takes no lock of its own and a2wave elects no leader,
    // so without this the losers replay the same DDL, hit "relation already
    // exists", and exit(1) with a message telling the operator never to retry —
    // i.e. a rollout that half-fails and refuses to self-heal.
    await runMigrations()

    expect(callOrder).toEqual(['connect', 'lock', 'pg-migrate', 'unlock', 'release'])
  })

  it('takes the lock on the same connection it later unlocks', async () => {
    await runMigrations()

    const [lock] = lockClientQuery.mock.calls[0] as unknown as [string]
    const [unlock] = lockClientQuery.mock.calls[1] as unknown as [string]
    // Session-scoped, so both must ride the one dedicated client — a lock taken
    // on a pooled connection and released on another does nothing at all.
    expect(lock).toContain('pg_advisory_lock')
    expect(unlock).toContain('pg_advisory_unlock')
    expect(poolConnect).toHaveBeenCalledTimes(1)
  })

  it('uses one fixed lock key, so every replica contends on the same lock', async () => {
    await runMigrations()

    const [lock] = lockClientQuery.mock.calls[0] as unknown as [string]
    const [unlock] = lockClientQuery.mock.calls[1] as unknown as [string]
    const keyOf = (sql: string) => sql.match(/\((-?\d+)\)/)?.[1]
    expect(keyOf(lock)).toBeDefined()
    expect(keyOf(unlock)).toBe(keyOf(lock))
  })

  it('releases the lock when the migration fails', async () => {
    // The failure path is the one that matters: a lock leaked by a crashed
    // migration would block every future boot until the session is reaped.
    pgMigrateMock.mockImplementationOnce(async () => {
      callOrder.push('pg-migrate')
      throw new Error('relation "users" already exists')
    })

    await runMigrations()

    expect(callOrder).toEqual(['connect', 'lock', 'pg-migrate', 'unlock', 'release'])
    expect(exitMock).toHaveBeenCalledWith(1)
  })

  it('awaits the migrator before returning', async () => {
    // The pg migrator is async; returning without awaiting would let the server
    // start serving requests against a half-migrated schema.
    let settled = false
    pgMigrateMock.mockImplementationOnce(
      () =>
        new Promise<void>((done) =>
          setTimeout(() => {
            settled = true
            done()
          }, 10),
        ),
    )

    await runMigrations()

    expect(settled).toBe(true)
  })
})
