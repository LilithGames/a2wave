import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const { getTableConfig } = await import('drizzle-orm/sqlite-core')
  const Database = (await import('better-sqlite3')).default
  const sqlite = new Database(':memory:')
  // Schema-derived DDL so a future runs column cannot silently diverge here.
  const { runs: runsTable } = await import('../../db/schema.sqlite.js')
  const columns = getTableConfig(runsTable)
    .columns.map(
      (col) => `\`${col.name}\` ${col.getSQLType()}${col.primary ? ' PRIMARY KEY NOT NULL' : ''}`,
    )
    .join(', ')
  sqlite.exec(`CREATE TABLE runs (${columns});`)
  const schema = await import('../../db/schema.js')
  return { db: drizzle(sqlite, { schema }), sqlite, sqliteDatabase: sqlite, isPostgres: false }
})

const { db } = await import('../../db/client.js')
const { runs } = await import('../../db/schema.js')
const { consumeRunQueueWait } = await import('../run-queue-wait.js')

const QUEUED_AT = new Date('2026-08-20T10:00:00Z')
const NOW = new Date('2026-08-20T10:00:42Z')

async function seedRun(queuedAt: Date | null) {
  await db.insert(runs).values({
    id: 'run_1',
    intent: 'review',
    status: 'running',
    queuedAt,
    createdAt: QUEUED_AT,
    updatedAt: QUEUED_AT,
  } as never)
}

async function loadQueuedAt() {
  return (await db.select({ queuedAt: runs.queuedAt }).from(runs))[0]?.queuedAt
}

describe('consumeRunQueueWait', () => {
  beforeEach(async () => {
    await db.delete(runs)
  })

  it('returns the elapsed wait and clears the mark in one pass', async () => {
    await seedRun(QUEUED_AT)
    expect(await consumeRunQueueWait(db, 'run_1', NOW)).toBe(42_000)
    expect(await loadQueuedAt()).toBeNull()
  })

  it('reports 0 for a turn that was dispatched without queueing', async () => {
    // Option-A semantics: immediate turns are real samples with wait 0, so
    // the wait chart's median reflects every turn, not only the queued ones.
    await seedRun(null)
    expect(await consumeRunQueueWait(db, 'run_1', NOW)).toBe(0)
  })

  it('clamps a clock-skewed mark to 0 rather than reporting a negative wait', async () => {
    await seedRun(new Date(NOW.getTime() + 60_000))
    expect(await consumeRunQueueWait(db, 'run_1', NOW)).toBe(0)
  })

  it('reports 0 for a missing run instead of throwing', async () => {
    expect(await consumeRunQueueWait(db, 'run_missing', NOW)).toBe(0)
  })

  it('consumes exactly once: a second read after consumption reports 0', async () => {
    // The mark is per-turn. Were it left in place, an immediate follow-up
    // turn on the same conversation row would inherit the previous turn's
    // wait wholesale.
    await seedRun(QUEUED_AT)
    await consumeRunQueueWait(db, 'run_1', NOW)
    expect(await consumeRunQueueWait(db, 'run_1', NOW)).toBe(0)
  })
})
