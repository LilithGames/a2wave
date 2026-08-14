import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as pgSchema from '../schema.pg.js'
import * as sqliteSchema from '../schema.sqlite.js'
import { PG_SCHEMA_PATH, renderPgSchema } from '../schema-transform.js'

/**
 * The guard that makes generation trustworthy.
 *
 * Generating `schema.pg.ts` only prevents drift if the checked-in file is
 * actually regenerated. Without this test, a `schema.sqlite.ts` edit that forgets
 * `pnpm db:generate:pg` leaves a stale PostgreSQL schema that typechecks fine
 * and fails only at runtime, on the backend fewer developers run locally.
 */
/**
 * Import members are compared as a set, not a sequence.
 *
 * The generator copies the import block from schema.sqlite.ts verbatim, and the
 * checked-in file is then formatted — so the member order is whatever the local
 * biome produces. A byte comparison therefore turns a formatter difference
 * between environments into "the schema is stale", which is a claim about the
 * tables and was false every time it fired. Sorting the members keeps the
 * assertion pointed at what it exists to catch: an edit to schema.sqlite.ts
 * that was never regenerated.
 */
function normalizeImportOrder(source: string): string {
  return source.replace(/import \{\n([^}]*)\n\} from/g, (_match, members: string) => {
    const sorted = members
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort()
      .join('\n')
    return `import {\n${sorted}\n} from`
  })
}

describe('schema.pg.ts is in sync with schema.sqlite.ts', () => {
  it('matches a fresh generation from the current sqlite schema', async () => {
    const checkedIn = readFileSync(PG_SCHEMA_PATH, 'utf-8')
    expect(
      normalizeImportOrder(checkedIn),
      'schema.pg.ts is stale — run `pnpm db:generate:pg` after editing schema.sqlite.ts',
    ).toBe(normalizeImportOrder(renderPgSchema()))
  })
})

/**
 * Exported-name parity is a separate question from textual parity: a table added
 * to schema.ts but dropped by a translation bug would still regenerate
 * byte-identically, so the textual test above cannot catch it.
 */
describe('both dialects export the same set of tables', () => {
  const tableNames = (mod: Record<string, unknown>) =>
    Object.keys(mod)
      .filter((k) => {
        const v = mod[k] as Record<symbol, unknown> | null
        return typeof v === 'object' && v !== null
      })
      .sort()

  it('exports identical top-level names', async () => {
    expect(tableNames(pgSchema)).toEqual(tableNames(sqliteSchema))
  })

  it('re-exports every table through the dispatcher', async () => {
    // schema.ts hand-lists each table, so a new table added to schema.sqlite.ts
    // regenerates into schema.pg.ts (keeping the two tests above green) while
    // silently never reaching consumers — they would import `undefined` and fail
    // at the first query. Nothing else checks this list.
    const dispatcher = await import('../schema.js')
    expect(tableNames(dispatcher)).toEqual(tableNames(sqliteSchema))
  })

  it('covers every table the application relies on', async () => {
    // A spot-check of the tables whose absence would be caught late and hurt:
    // auth, execution, and the permission model.
    for (const name of ['users', 'agents', 'runs', 'runSteps', 'agentMembers', 'settings']) {
      expect(pgSchema, `pg schema is missing ${name}`).toHaveProperty(name)
    }
  })
})
