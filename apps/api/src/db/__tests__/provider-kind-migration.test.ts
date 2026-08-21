import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveMigrationDir } from '../migration-directory.js'

const MIGRATIONS = [
  '0081_add_provider_kind.sql',
  '0082_backfill_provider_kind.sql',
  '0083_constrain_provider_kind.sql',
]
const PROVIDER_KIND_START_TAG = MIGRATIONS[0].replace('.sql', '')

const LEGACY_PROVIDERS = [
  ['prv_cursor', 'Cursor CLI', 'cursor'],
  ['prv_claude', 'Claude Code', 'claude-code'],
  ['prv_codex', 'Codex CLI', 'codex'],
  ['prv_opencode', 'OpenCode CLI', 'opencode'],
] as const

const NEW_UPSTREAM_PROVIDERS = [
  ['prv_qoder', 'Qoder CLI', 'qoder'],
  ['prv_trae', 'Trae CLI', 'trae'],
  ['prv_copilot', 'Copilot CLI', 'copilot'],
] as const

type ProviderFixture = readonly [id: string, name: string, expectedKind: string]

function applyMigrationsBeforeProviderKind(db: Database.Database): void {
  const drizzleDir = resolveMigrationDir('drizzle')
  const journal = JSON.parse(readFileSync(resolve(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  let reachedProviderKindMigration = false

  for (const entry of journal.entries) {
    if (entry.tag === PROVIDER_KIND_START_TAG) {
      reachedProviderKindMigration = true
      break
    }
    const sql = readFileSync(resolve(drizzleDir, `${entry.tag}.sql`), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim()) db.exec(statement)
    }
  }

  if (!reachedProviderKindMigration) {
    throw new Error(`Migration journal does not contain ${PROVIDER_KIND_START_TAG}`)
  }
}

function insertProviderFixtures(db: Database.Database, fixtures: readonly ProviderFixture[]): void {
  db.prepare('DELETE FROM providers').run()
  const insert = db.prepare(`
    INSERT INTO providers (
      id, name, is_preset, models, enabled_models, created_at, updated_at
    ) VALUES (?, ?, 1, '[]', '[]', 1, 1)
  `)
  for (const [id, name] of fixtures) insert.run(id, name)
}

function applyProviderKindMigrations(db: Database.Database): void {
  for (const filename of MIGRATIONS) {
    const sql = readFileSync(resolve(resolveMigrationDir('drizzle'), filename), 'utf8').replaceAll(
      '--> statement-breakpoint',
      '',
    )
    db.exec(sql)
  }
}

function applyProviderKindMigrationsInDrizzleTransaction(db: Database.Database): void {
  db.exec('BEGIN')
  try {
    applyProviderKindMigrations(db)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function readProviderIdentities(db: Database.Database) {
  return db.prepare('SELECT id, name, kind FROM providers ORDER BY id').all() as Array<{
    id: string
    name: string
    kind: string
  }>
}

function expectedIdentities(fixtures: readonly ProviderFixture[]) {
  return fixtures
    .map(([id, name, kind]) => ({ id, name, kind }))
    .sort((left, right) => left.id.localeCompare(right.id))
}

describe('provider kind migrations', () => {
  const databases: Database.Database[] = []

  afterEach(() => {
    for (const db of databases) db.close()
    databases.length = 0
  })

  function databaseWith(fixtures: readonly ProviderFixture[]) {
    const db = new Database(':memory:')
    databases.push(db)
    applyMigrationsBeforeProviderKind(db)
    insertProviderFixtures(db, fixtures)
    return db
  }

  it('upgrades a legacy database containing the original four providers', async () => {
    const db = databaseWith(LEGACY_PROVIDERS)

    applyProviderKindMigrations(db)

    expect(readProviderIdentities(db)).toEqual(expectedIdentities(LEGACY_PROVIDERS))
  })

  it('upgrades an upstream database where all seven providers were already seeded', async () => {
    const fixtures = [...LEGACY_PROVIDERS, ...NEW_UPSTREAM_PROVIDERS]
    const db = databaseWith(fixtures)

    applyProviderKindMigrations(db)

    expect(readProviderIdentities(db)).toEqual(expectedIdentities(fixtures))
    const kindColumn = db
      .prepare("SELECT [notnull] FROM pragma_table_info('providers') WHERE name = 'kind'")
      .get() as { notnull: number }
    expect(kindColumn.notnull).toBe(1)
    expect(() =>
      db
        .prepare(
          `INSERT INTO providers (
            id, kind, name, models, enabled_models, created_at, updated_at
          ) VALUES ('prv_duplicate', 'cursor', 'Duplicate', '[]', '[]', 1, 1)`,
        )
        .run(),
    ).toThrow(/UNIQUE constraint failed: providers.kind/)
  })

  it('preserves unmatched historical Providers with a unique diagnostic kind', async () => {
    const fixtures = [
      ...LEGACY_PROVIDERS,
      ['prv_gemini', 'Gemini CLI', 'legacy:prv_gemini'],
      ['prv_unknown', 'Legacy Unknown', 'legacy:prv_unknown'],
    ] as const
    const db = databaseWith(fixtures)

    applyProviderKindMigrations(db)

    expect(readProviderIdentities(db)).toEqual(expectedIdentities(fixtures))
  })

  it('keeps only one duplicate preset row on the built-in kind', async () => {
    const fixtures = [
      ['prv_cursor_a', 'Cursor CLI', 'cursor'],
      ['prv_cursor_b', 'Cursor CLI', 'legacy:prv_cursor_b'],
    ] as const
    const db = databaseWith(fixtures)

    applyProviderKindMigrations(db)

    expect(readProviderIdentities(db)).toEqual(expectedIdentities(fixtures))
  })

  it('keeps dispatch identity unchanged after the display name is renamed', async () => {
    const db = databaseWith(LEGACY_PROVIDERS)
    applyProviderKindMigrations(db)

    db.prepare("UPDATE providers SET name = 'Renamed Coding Engine' WHERE id = 'prv_cursor'").run()

    expect(db.prepare("SELECT name, kind FROM providers WHERE id = 'prv_cursor'").get()).toEqual({
      name: 'Renamed Coding Engine',
      kind: 'cursor',
    })
  })

  it('upgrades a Provider that is referenced by an Agent inside the Drizzle transaction', async () => {
    const db = databaseWith(LEGACY_PROVIDERS)
    db.pragma('foreign_keys = ON')
    db.exec(`
      INSERT INTO agents (
        id, name, skills, mcp_server_ids, provider_id, created_at, updated_at
      ) VALUES ('agt_1', 'Migration fixture', '[]', '[]', 'prv_cursor', 1, 1);
    `)

    applyProviderKindMigrationsInDrizzleTransaction(db)

    expect(db.prepare("SELECT provider_id FROM agents WHERE id = 'agt_1'").get()).toEqual({
      provider_id: 'prv_cursor',
    })
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('preserves an Agent reference to an unmatched historical Provider', async () => {
    const fixtures = [['prv_unknown', 'Legacy Unknown', 'legacy:prv_unknown']] as const
    const db = databaseWith(fixtures)
    db.pragma('foreign_keys = ON')
    db.exec(`
      INSERT INTO agents (
        id, name, skills, mcp_server_ids, provider_id, created_at, updated_at
      ) VALUES ('agt_1', 'Migration fixture', '[]', '[]', 'prv_unknown', 1, 1);
    `)

    applyProviderKindMigrationsInDrizzleTransaction(db)

    expect(readProviderIdentities(db)).toEqual(expectedIdentities(fixtures))
    expect(db.prepare("SELECT provider_id FROM agents WHERE id = 'agt_1'").get()).toEqual({
      provider_id: 'prv_unknown',
    })
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
})
