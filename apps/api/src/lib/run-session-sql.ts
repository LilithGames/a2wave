import { gte, lte, type SQL, sql } from 'drizzle-orm'
import { isPostgresRuntime } from '../db/dialect-runtime.js'
import { runs } from '../db/schema.js'

/**
 * Build a HAVING predicate for the latest activity in a Run conversation.
 *
 * A raw aggregate expression has no column encoder. PostgreSQL accepts Date,
 * while SQLite timestamp columns store epoch seconds and better-sqlite3 rejects
 * Date parameters. Encode explicitly so the same expression is executable on
 * both supported databases.
 */
export function runSessionActivityCondition(boundary: 'start' | 'end', value: Date): SQL<unknown> {
  const encoded = isPostgresRuntime() ? value : Math.floor(value.getTime() / 1000)
  const latestActivity = sql<Date | number>`MAX(${runs.updatedAt})`
  return boundary === 'start' ? gte(latestActivity, encoded) : lte(latestActivity, encoded)
}
