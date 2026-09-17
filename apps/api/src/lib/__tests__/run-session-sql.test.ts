import Database from 'better-sqlite3'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'

const { mockIsPostgresRuntime } = vi.hoisted(() => ({
  mockIsPostgresRuntime: vi.fn(() => false),
}))
vi.mock('../../db/dialect-runtime.js', () => ({ isPostgresRuntime: mockIsPostgresRuntime }))

import { runs } from '../../db/schema.js'
import { runSessionActivityCondition } from '../run-session-sql.js'

describe('Run session activity filtering', () => {
  it.each([
    ['start', new Date(1_786_050_000 * 1000), [{ key: 'conv_1' }]] as const,
    ['end', new Date(1_786_050_000 * 1000), []] as const,
  ])('executes the %s aggregate boundary against real SQLite', async (boundary, date, expected) => {
    mockIsPostgresRuntime.mockReturnValue(false)
    const sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE runs (
        id text PRIMARY KEY NOT NULL,
        conversation_id text,
        initiator_agent_id text,
        trigger_source text,
        updated_at integer NOT NULL
      )
    `)
    sqlite
      .prepare(
        'INSERT INTO runs (id, conversation_id, initiator_agent_id, trigger_source, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('run_old', 'conv_1', 'agt_1', 'oauth', 1_786_000_000)
    sqlite
      .prepare(
        'INSERT INTO runs (id, conversation_id, initiator_agent_id, trigger_source, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('run_new', 'conv_1', 'agt_1', 'oauth', 1_786_100_000)

    const db = drizzle(sqlite)
    const rows = await db
      .select({ key: sql<string>`COALESCE(${runs.conversationId}, ${runs.id})` })
      .from(runs)
      .groupBy(runs.initiatorAgentId, runs.triggerSource, runs.conversationId)
      .having(runSessionActivityCondition(boundary, date))

    expect(rows).toEqual(expected)
    sqlite.close()
  })

  it('binds a Date for PostgreSQL aggregate comparisons', () => {
    mockIsPostgresRuntime.mockReturnValue(true)
    const value = new Date('2026-08-08T01:02:03.000Z')
    const query = new PgDialect().sqlToQuery(runSessionActivityCondition('start', value))

    expect(query.sql).toContain('MAX("runs"."updated_at") >= $1')
    expect(query.params).toEqual([value])
  })
})
