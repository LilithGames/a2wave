import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveMigrationDir } from '../migration-directory.js'

const MIGRATION = '0103_normalize_pi_auth_mode'

function drizzleDir(): string {
  return resolveMigrationDir('drizzle')
}

function execStatements(db: Database.Database, sql: string): void {
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

function applyMigrationsBeforeTarget(db: Database.Database): void {
  const journal = JSON.parse(readFileSync(resolve(drizzleDir(), 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  for (const entry of journal.entries) {
    if (entry.tag === MIGRATION) return
    execStatements(db, readFileSync(resolve(drizzleDir(), `${entry.tag}.sql`), 'utf8'))
  }
  throw new Error(`Migration journal does not contain ${MIGRATION}`)
}

function applyTarget(db: Database.Database): void {
  execStatements(db, readFileSync(resolve(drizzleDir(), `${MIGRATION}.sql`), 'utf8'))
}

function insertProvider(db: Database.Database, id: string, kind: string): void {
  db.prepare(
    'INSERT INTO providers (id, name, kind, is_preset, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 1)',
  ).run(id, `${kind} CLI`, kind)
}

function insertAgent(
  db: Database.Database,
  id: string,
  options: {
    providerId?: string | null
    authMode?: 'apiKey' | 'oauth' | 'localSession'
    providerApiKey?: string | null
    config?: unknown
    rawConfig?: string
    updatedAt?: number
  } = {},
): void {
  const config =
    options.rawConfig !== undefined
      ? options.rawConfig
      : options.config === undefined
        ? null
        : JSON.stringify(options.config)
  db.prepare(
    `INSERT INTO agents
       (id, name, skills, mcp_server_ids, provider_id, provider_api_key, auth_mode, config, created_at, updated_at)
     VALUES (?, ?, '[]', '[]', ?, ?, ?, ?, 1, ?)`,
  ).run(
    id,
    id,
    options.providerId ?? null,
    options.providerApiKey ?? null,
    options.authMode ?? 'apiKey',
    config,
    options.updatedAt ?? 1,
  )
}

function row(db: Database.Database, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>
}

function config(db: Database.Database, id: string): Record<string, unknown> | null {
  const value = row(db, id).config
  return typeof value === 'string' && value ? (JSON.parse(value) as Record<string, unknown>) : null
}

describe(MIGRATION, () => {
  let db: Database.Database | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it('preserves every pre-feature Pi binding as localSession without changing other data', () => {
    db = new Database(':memory:')
    applyMigrationsBeforeTarget(db)
    insertProvider(db, 'prv_pi', 'pi')
    insertProvider(db, 'prv_codex', 'codex')

    insertAgent(db, 'agt_legacy_pi', {
      providerId: 'prv_pi',
      authMode: 'apiKey',
      providerApiKey: 'stale-key',
      config: { model: 'anthropic/claude-sonnet-4-6', keep: true },
      updatedAt: 10,
    })
    insertAgent(db, 'agt_chain', {
      providerId: 'prv_codex',
      config: {
        keep: { nested: true },
        providerChain: [
          {
            id: 'missing-mode',
            providerId: 'prv_pi',
            model: 'anthropic/claude-sonnet-4-6',
          },
          {
            id: 'stale-api-key',
            providerId: 'prv_pi',
            authMode: 'apiKey',
            providerApiKey: 'stale-chain-key',
            enabled: false,
          },
          { id: 'old-oauth', providerId: 'prv_pi', authMode: 'oauth' },
          { id: 'codex', providerId: 'prv_codex', authMode: 'apiKey' },
          'draft-scalar',
          true,
          false,
          null,
          7,
          ['nested-array'],
        ],
      },
      updatedAt: 20,
    })
    insertAgent(db, 'agt_already_normalized', {
      providerId: 'prv_pi',
      authMode: 'localSession',
      config: {
        providerChain: [
          { providerId: 'prv_pi', authMode: 'localSession', providerApiKey: 'keep-me' },
        ],
      },
      updatedAt: 30,
    })
    insertAgent(db, 'agt_unrelated', {
      providerId: 'prv_codex',
      authMode: 'apiKey',
      config: { providerChain: [{ providerId: 'prv_codex' }], keep: 'exact' },
      updatedAt: 40,
    })
    insertAgent(db, 'agt_invalid_json', {
      providerId: 'prv_codex',
      rawConfig: '{not-json',
      updatedAt: 50,
    })

    applyTarget(db)

    expect(row(db, 'agt_legacy_pi')).toMatchObject({
      auth_mode: 'localSession',
      provider_api_key: 'stale-key',
    })
    expect(config(db, 'agt_legacy_pi')).toEqual({
      model: 'anthropic/claude-sonnet-4-6',
      keep: true,
    })

    expect(config(db, 'agt_chain')).toEqual({
      keep: { nested: true },
      providerChain: [
        {
          id: 'missing-mode',
          providerId: 'prv_pi',
          model: 'anthropic/claude-sonnet-4-6',
          authMode: 'localSession',
        },
        {
          id: 'stale-api-key',
          providerId: 'prv_pi',
          authMode: 'localSession',
          providerApiKey: 'stale-chain-key',
          enabled: false,
        },
        { id: 'old-oauth', providerId: 'prv_pi', authMode: 'localSession' },
        { id: 'codex', providerId: 'prv_codex', authMode: 'apiKey' },
        'draft-scalar',
        true,
        false,
        null,
        7,
        ['nested-array'],
      ],
    })
    expect(row(db, 'agt_chain')).toMatchObject({
      auth_mode: 'apiKey',
      provider_id: 'prv_codex',
    })

    expect(row(db, 'agt_already_normalized').updated_at).toBe(30)
    expect(row(db, 'agt_unrelated')).toMatchObject({ auth_mode: 'apiKey', updated_at: 40 })
    expect(config(db, 'agt_unrelated')).toEqual({
      providerChain: [{ providerId: 'prv_codex' }],
      keep: 'exact',
    })
    expect(row(db, 'agt_invalid_json')).toMatchObject({ config: '{not-json', updated_at: 50 })

    const firstPass = db
      .prepare('SELECT id, auth_mode, config, updated_at FROM agents ORDER BY id')
      .all()
    applyTarget(db)
    expect(
      db.prepare('SELECT id, auth_mode, config, updated_at FROM agents ORDER BY id').all(),
    ).toEqual(firstPass)
  })
})
