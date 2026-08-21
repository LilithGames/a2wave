import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveMigrationDir } from '../migration-directory.js'

/**
 * Regression cover for the copilot retirement migration (see RETIRE_MIGRATION).
 *
 * An Agent can reach a Provider through two independent paths — the legacy
 * `agents.provider_id` column and `config.providerChain[*].providerId` — and the
 * chain one is easy to forget, because nothing fails loudly when it is missed:
 * `resolveProviderBinding` silently drops a dangling entry, so a half-cleaned
 * mixed chain keeps running on a *different* Provider than configured. That is
 * precisely the defect this migration exists to prevent, so it is pinned here
 * rather than left to manual verification.
 */

const RETIRE_MIGRATION = '0097_retire_copilot_provider'

function drizzleDir(): string {
  return resolveMigrationDir('drizzle')
}

function execStatements(db: Database.Database, sql: string): void {
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

/** Applies every migration up to (but excluding) the copilot retirement. */
function applyMigrationsBeforeRetirement(db: Database.Database): void {
  const journal = JSON.parse(readFileSync(resolve(drizzleDir(), 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>
  }

  let reachedRetirement = false
  for (const entry of journal.entries) {
    if (entry.tag === RETIRE_MIGRATION) {
      reachedRetirement = true
      break
    }
    execStatements(db, readFileSync(resolve(drizzleDir(), `${entry.tag}.sql`), 'utf8'))
  }

  if (!reachedRetirement) {
    throw new Error(`Migration journal does not contain ${RETIRE_MIGRATION}`)
  }
}

function applyRetirement(db: Database.Database): void {
  execStatements(db, readFileSync(resolve(drizzleDir(), `${RETIRE_MIGRATION}.sql`), 'utf8'))
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
    config?: unknown
    publishStatus?: 'draft' | 'published' | 'stopped'
    providerApiKey?: string | null
    authMode?: 'apiKey' | 'oauth' | 'localSession'
  } = {},
): void {
  db.prepare(
    `INSERT INTO agents (id, name, skills, mcp_server_ids, provider_id, provider_api_key, auth_mode, publish_status, config, created_at, updated_at)
     VALUES (?, ?, '[]', '[]', ?, ?, ?, ?, ?, 1, 1)`,
  ).run(
    id,
    id,
    options.providerId ?? null,
    options.providerApiKey ?? null,
    options.authMode ?? 'apiKey',
    options.publishStatus ?? 'draft',
    options.config === undefined ? null : JSON.stringify(options.config),
  )
}

function readAgent(db: Database.Database, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown>
}

function readConfig(db: Database.Database, id: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT config FROM agents WHERE id = ?').get(id) as
    | { config: string | null }
    | undefined
  return row?.config ? (JSON.parse(row.config) as Record<string, unknown>) : null
}

function readChain(db: Database.Database, id: string): Array<Record<string, unknown>> {
  return (readConfig(db, id)?.providerChain ?? []) as Array<Record<string, unknown>>
}

describe(RETIRE_MIGRATION, () => {
  let db: Database.Database | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function seed(): Database.Database {
    const database = new Database(':memory:')
    applyMigrationsBeforeRetirement(database)
    insertProvider(database, 'prv_copilot', 'copilot')
    insertProvider(database, 'prv_claude', 'claude-code')
    return database
  }

  it('drops the retired Provider row', () => {
    db = seed()
    applyRetirement(db)

    const remaining = db.prepare('SELECT id, kind FROM providers').all()
    expect(remaining).toEqual([{ id: 'prv_claude', kind: 'claude-code' }])
  })

  it('removes only the copilot entry from a mixed chain, keeping siblings and surrounding config', () => {
    db = seed()
    insertAgent(db, 'agt_mixed', {
      config: {
        systemPrompt: 'keep me',
        providerChain: [
          { providerId: 'prv_copilot', enabled: true, model: 'auto' },
          { providerId: 'prv_claude', enabled: true, model: 'claude-sonnet-4-6' },
        ],
      },
    })

    applyRetirement(db)

    expect(readChain(db, 'agt_mixed')).toEqual([
      { providerId: 'prv_claude', enabled: true, model: 'claude-sonnet-4-6' },
    ])
    // Sibling config outside providerChain must survive untouched.
    expect(readConfig(db, 'agt_mixed')?.systemPrompt).toBe('keep me')
  })

  it('preserves null-providerId draft slots that share a chain with copilot', () => {
    // `providerId: null` is an explicitly legal draft state, and SQL evaluates
    // `NULL NOT IN (...)` to NULL rather than TRUE — so without an explicit
    // IS NULL arm these slots would be dropped along with the copilot entry.
    db = seed()
    insertAgent(db, 'agt_draft', {
      config: {
        providerChain: [
          { providerId: 'prv_copilot', enabled: true },
          { providerId: null, enabled: true },
          { providerId: 'prv_claude', enabled: true },
        ],
      },
    })

    applyRetirement(db)

    expect(readChain(db, 'agt_draft')).toEqual([
      { providerId: null, enabled: true },
      { providerId: 'prv_claude', enabled: true },
    ])
  })

  it('reduces an all-copilot chain to an empty array rather than NULL', () => {
    // An empty chain is the repairable "no Provider chosen yet" draft state; a
    // NULL here would instead break the config shape the editor loads.
    db = seed()
    insertAgent(db, 'agt_all', {
      config: { providerChain: [{ providerId: 'prv_copilot', enabled: true }] },
    })

    applyRetirement(db)

    expect(readConfig(db, 'agt_all')?.providerChain).toEqual([])
  })

  it('stops a PUBLISHED agent whose chain is emptied by the retirement', () => {
    // An empty chain does NOT throw in buildAgentConfig — it reads as an unbound
    // draft — so a still-published Agent would keep serving its channels and land
    // on the default `cursor` engine with no credentials. Stopping is the honest
    // state and is reversible once a new Provider is bound.
    db = seed()
    insertAgent(db, 'agt_pub', {
      publishStatus: 'published',
      config: { providerChain: [{ providerId: 'prv_copilot', enabled: true }] },
    })
    insertAgent(db, 'agt_pub_ok', {
      publishStatus: 'published',
      config: { providerChain: [{ providerId: 'prv_claude', enabled: true }] },
    })

    applyRetirement(db)

    expect(readAgent(db, 'agt_pub').publish_status).toBe('stopped')
    // An Agent that still has a usable chain must keep serving.
    expect(readAgent(db, 'agt_pub_ok').publish_status).toBe('published')
  })

  it('keeps a published Agent whose chain survives, even when copilot was primary', () => {
    // The web client mirrors the PRIMARY chain entry into the top-level columns,
    // so a chain-based Agent led by copilot also matches the legacy-unbind
    // statement. Its credentials must still be cleared, but stopping it would
    // contradict the whole point of a fallback chain: two Agents that both end up
    // on the same [claude] chain must not differ in fate purely by which slot
    // copilot happened to occupy.
    db = seed()
    insertAgent(db, 'agt_cop_primary', {
      providerId: 'prv_copilot', // mirrored primary
      providerApiKey: 'github_pat_secret',
      publishStatus: 'published',
      config: {
        providerChain: [
          { providerId: 'prv_copilot', enabled: true },
          { providerId: 'prv_claude', enabled: true },
        ],
      },
    })

    applyRetirement(db)

    const row = readAgent(db, 'agt_cop_primary')
    expect(readChain(db, 'agt_cop_primary')).toEqual([{ providerId: 'prv_claude', enabled: true }])
    // Credentials of the retired Provider go regardless.
    expect(row.provider_api_key).toBeNull()
    // ...but the Agent keeps serving on its surviving fallback.
    expect(row.publish_status).toBe('published')
  })

  it('clears the whole legacy binding, not just the provider_id pointer', () => {
    // With only provider_id nulled, buildAgentConfig matches neither the chain
    // branch nor the legacy branch, so nothing clears the stale credentials or
    // model — and the run reaches the default `cursor` engine holding the Copilot
    // GitHub PAT.
    db = seed()
    insertAgent(db, 'agt_legacy_full', {
      providerId: 'prv_copilot',
      providerApiKey: 'github_pat_secret',
      publishStatus: 'published',
      config: { model: 'claude-sonnet-4.6', systemPrompt: 'keep me' },
    })

    applyRetirement(db)

    const row = readAgent(db, 'agt_legacy_full')
    expect(row.provider_id).toBeNull()
    expect(row.provider_api_key).toBeNull()
    expect(row.publish_status).toBe('stopped')
    // The stale model must not survive to be handed to a substitute engine.
    expect(readConfig(db, 'agt_legacy_full')).toEqual({ systemPrompt: 'keep me' })
  })

  it('does not abort when a chain holds a non-object entry', () => {
    // Only reachable through a hand-edited or corrupted row, but `json()` would
    // raise "malformed JSON" and take the whole migration — and therefore the
    // instance startup — down with it.
    db = seed()
    insertAgent(db, 'agt_weird', {
      config: {
        providerChain: [{ providerId: 'prv_copilot' }, 'weird', { providerId: 'prv_claude' }],
      },
    })

    expect(() => applyRetirement(db as Database.Database)).not.toThrow()
    expect(readChain(db, 'agt_weird')).toEqual(['weird', { providerId: 'prv_claude' }])
  })

  it('writes updated_at in seconds, matching the column mode', () => {
    // schema.ts declares updated_at as mode:'timestamp' (seconds); drizzle
    // multiplies by 1000 on read, so a millisecond value here surfaces as a date
    // tens of thousands of years in the future.
    db = seed()
    insertAgent(db, 'agt_ts', { providerId: 'prv_copilot' })

    applyRetirement(db)

    const updatedAt = readAgent(db, 'agt_ts').updated_at as number
    const nowSeconds = Math.floor(Date.now() / 1000)
    expect(Math.abs(updatedAt - nowSeconds)).toBeLessThan(120)
  })

  it('forgets the orphaned copilot CLI installation row', () => {
    // The uninstall route resolves the kind from provider-cli-lock.json, which no
    // longer lists copilot, so the row could never be acted on again.
    db = seed()
    const addCli = db.prepare(
      'INSERT INTO cli_installations (kind, status, updated_at) VALUES (?, ?, 1)',
    )
    addCli.run('copilot', 'idle')
    addCli.run('claude-code', 'idle')

    applyRetirement(db)

    const kinds = db
      .prepare('SELECT kind FROM cli_installations ORDER BY kind')
      .all()
      .map((row) => (row as { kind: string }).kind)
    expect(kinds).toEqual(['claude-code'])
  })

  it('leaves chains without any copilot reference untouched', () => {
    db = seed()
    const chain = [{ providerId: 'prv_claude', enabled: true, model: 'claude-sonnet-4-6' }]
    insertAgent(db, 'agt_other', { config: { providerChain: chain } })

    applyRetirement(db)

    expect(readChain(db, 'agt_other')).toEqual(chain)
  })

  it('unbinds the legacy provider_id column without touching the rest of the config', () => {
    db = seed()
    insertAgent(db, 'agt_legacy', { providerId: 'prv_copilot', config: { systemPrompt: 'keep' } })
    insertAgent(db, 'agt_kept', { providerId: 'prv_claude' })

    applyRetirement(db)

    const legacy = db.prepare('SELECT provider_id FROM agents WHERE id = ?').get('agt_legacy') as {
      provider_id: string | null
    }
    expect(legacy.provider_id).toBeNull()
    expect(readConfig(db, 'agt_legacy')?.systemPrompt).toBe('keep')

    const kept = db.prepare('SELECT provider_id FROM agents WHERE id = ?').get('agt_kept') as {
      provider_id: string | null
    }
    expect(kept.provider_id).toBe('prv_claude')
  })

  it('stops a published Agent whose surviving chain entries are all disabled', () => {
    // enabledChain, not array length, is what the runtime resolves. A chain of
    // only disabled entries yields the same empty enabledChain as an empty array,
    // so buildAgentConfig does not throw and the Agent lands on default `cursor`.
    db = seed()
    insertAgent(db, 'agt_disabled_only', {
      providerId: 'prv_copilot',
      publishStatus: 'published',
      config: {
        providerChain: [
          { providerId: 'prv_copilot', enabled: true },
          { providerId: 'prv_claude', enabled: false },
        ],
      },
    })

    applyRetirement(db)

    expect(readChain(db, 'agt_disabled_only')).toEqual([
      { providerId: 'prv_claude', enabled: false },
    ])
    expect(readAgent(db, 'agt_disabled_only').publish_status).toBe('stopped')
  })

  it('treats an entry with no explicit `enabled` flag as enabled', () => {
    // providerChainItemSchema defaults enabled to true, so an entry that simply
    // omits the flag is usable and must NOT trigger a stop.
    db = seed()
    insertAgent(db, 'agt_implicit', {
      providerId: 'prv_copilot',
      publishStatus: 'published',
      config: {
        providerChain: [{ providerId: 'prv_copilot' }, { providerId: 'prv_claude' }],
      },
    })

    applyRetirement(db)

    expect(readAgent(db, 'agt_implicit').publish_status).toBe('published')
  })

  it('does not abort on an agent whose config is not valid JSON', () => {
    // SQLite does not short-circuit AND inside a scalar CASE, so an unguarded
    // json_type/json_array_length call here would raise "malformed JSON" and
    // abort the migration — leaving 0097 unrecorded and the instance unable to
    // start on every subsequent boot.
    db = seed()
    db.prepare(
      `INSERT INTO agents (id, name, skills, mcp_server_ids, provider_id, publish_status, config, created_at, updated_at)
       VALUES ('agt_corrupt', 'agt_corrupt', '[]', '[]', 'prv_copilot', 'published', 'not json', 1, 1)`,
    ).run()

    expect(() => applyRetirement(db as Database.Database)).not.toThrow()

    const row = readAgent(db, 'agt_corrupt')
    expect(row.provider_id).toBeNull()
    expect(row.publish_status).toBe('stopped')
    // The retirement must still complete its remaining statements.
    expect(db.prepare("SELECT count(*) c FROM providers WHERE kind = 'copilot'").get()).toEqual({
      c: 0,
    })
  })

  it('tolerates agents with no config at all', () => {
    db = seed()
    insertAgent(db, 'agt_null')

    expect(() => applyRetirement(db as Database.Database)).not.toThrow()
    expect(readConfig(db, 'agt_null')).toBeNull()
  })
})
