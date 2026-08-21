/**
 * Route tests for evaluation sets + cases.
 *
 * Uses a real in-memory SQLite database (schema loaded from the generated
 * migration) rather than an ordered queue of db mocks: the CRUD here is mostly
 * SQL semantics — cascade deletes, ordering, agent scoping — so exercising real
 * SQL is both more faithful and less brittle than asserting call order.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const Database = (await import('better-sqlite3')).default
  const sqlite = new Database(':memory:')

  // Parent tables the evaluation FKs point at. `agents` is generated from the
  // real schema because agent-access issues `select()` over every column, so a
  // hand-trimmed fixture table would break whenever a column is added.
  const { getTableConfig } = await import('drizzle-orm/sqlite-core')
  // Import the SQLite tables directly, not the dialect-dispatching `schema.js`:
  // this factory emits SQLite DDL for the in-memory database below, so under a
  // PostgreSQL DATABASE_URL the dispatched schema would hand pg tables to
  // `getTableConfig` from sqlite-core and throw during module mocking.
  const { agents: agentsTable } = await import('../../db/schema.sqlite.js')
  const agentColumns = getTableConfig(agentsTable)
    .columns.map(
      (col) => `\`${col.name}\` ${col.getSQLType()}${col.primary ? ' PRIMARY KEY NOT NULL' : ''}`,
    )
    .join(', ')
  sqlite.exec(`CREATE TABLE agents (${agentColumns});`)
  sqlite.exec(`
    CREATE TABLE users (id text PRIMARY KEY NOT NULL, username text);
    CREATE TABLE agent_members (
      agent_id text NOT NULL,
      user_id text NOT NULL,
      role text DEFAULT 'viewer' NOT NULL,
      created_by text,
      created_at integer,
      updated_at integer,
      PRIMARY KEY (agent_id, user_id)
    );
  `)
  // Evaluation tables come straight from the generated migration so the tests
  // fail loudly if the schema and the migration ever drift apart.
  // Resolved inline rather than via the shared helper: this factory is hoisted
  // above the imports, so it cannot reference an outer binding. cwd is
  // `apps/api` under `pnpm test` there and the repo root under the root script.
  const migrationsDir = existsSync('drizzle') ? 'drizzle' : 'apps/api/drizzle'
  const migration = readFileSync(join(migrationsDir, '0078_magenta_rhodey.sql'), 'utf-8').replace(
    /-->\s*statement-breakpoint/g,
    '',
  )
  sqlite.exec(migration)

  // `isPostgres` / `sqliteDatabase` are read by db/transaction.ts, which the
  // route pulls in transitively. Omitting them makes the whole suite fail to
  // import rather than fail an assertion.
  return { db: drizzle(sqlite), isPostgres: false, sqliteDatabase: sqlite }
})

vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))

import { db } from '../../db/client.js'
import { evaluationCases, evaluationSets } from '../../db/schema.js'
import { AppError } from '../../lib/errors.js'
import evaluationRoutes from '../evaluation.js'

const OWNER = 'usr_owner'
const OTHER = 'usr_other'
const AGENT_ID = 'agt_1'
const OTHER_AGENT_ID = 'agt_2'

/** Builds an app with an injected identity, mirroring authMiddleware's context. */
function appAs(userId: string, role: 'admin' | 'user' = 'user') {
  const app = new Hono()
  app.use('*', async (c, next) => {
    // Keys must match what agent-access/owner-filter read: userId + userRole.
    c.set('userId' as never, userId as never)
    c.set('userRole' as never, role as never)
    await next()
  })
  app.route('/api/agents', evaluationRoutes)
  // Mirrors the global onError in index.ts, which turns AppError into its status.
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: err.message, code: err.code }, err.statusCode as never)
    }
    throw err
  })
  return app
}

// Raw SQL: drizzle's insert would emit every column of the full agents schema,
// but the fixture table only needs the three columns agent-access reads.
function seedAgents() {
  db.run(sql`INSERT INTO users (id, username) VALUES (${OWNER}, 'owner')`)
  db.run(sql`INSERT INTO users (id, username) VALUES (${OTHER}, 'other')`)
  db.run(sql`INSERT INTO agents (id, user_id, name) VALUES (${AGENT_ID}, ${OWNER}, 'A')`)
  db.run(sql`INSERT INTO agents (id, user_id, name) VALUES (${OTHER_AGENT_ID}, ${OTHER}, 'B')`)
}

async function createSet(app: Hono, agentId: string, body: unknown) {
  return app.request(`/api/agents/${agentId}/evaluation-sets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  db.delete(evaluationCases).run()
  db.delete(evaluationSets).run()
  db.run(sql`DELETE FROM agent_members`)
  db.run(sql`DELETE FROM agents`)
  db.run(sql`DELETE FROM users`)
  seedAgents()
})

describe('POST /:agentId/evaluation-sets', () => {
  it('creates a set owned by the agent', async () => {
    const res = await createSet(appAs(OWNER), AGENT_ID, {
      name: 'customer service',
      description: 'refund flows',
    })
    expect(res.status).toBe(201)

    const body = (await res.json()) as { data: { id: string; agentId: string; name: string } }
    expect(body.data.name).toBe('customer service')
    expect(body.data.agentId).toBe(AGENT_ID)
    expect(body.data.id).toMatch(/^evs_/)
  })

  it('rejects a blank name with 400', async () => {
    const res = await createSet(appAs(OWNER), AGENT_ID, { name: '' })
    expect(res.status).toBe(400)
  })

  it('returns 404 for an agent the caller cannot see', async () => {
    const res = await createSet(appAs(OTHER), AGENT_ID, { name: 'sneaky' })
    expect(res.status).toBe(404)
  })

  it('lets an admin create a set on any agent', async () => {
    const res = await createSet(appAs(OTHER, 'admin'), AGENT_ID, { name: 'by admin' })
    expect(res.status).toBe(201)
  })

  it('rejects a viewer with 403', async () => {
    db.run(
      sql`INSERT INTO agent_members (agent_id, user_id, role) VALUES (${AGENT_ID}, ${OTHER}, 'viewer')`,
    )
    const res = await createSet(appAs(OTHER), AGENT_ID, { name: 'nope' })
    expect(res.status).toBe(403)
  })

  it('lets an editor create a set', async () => {
    db.run(
      sql`INSERT INTO agent_members (agent_id, user_id, role) VALUES (${AGENT_ID}, ${OTHER}, 'editor')`,
    )
    const res = await createSet(appAs(OTHER), AGENT_ID, { name: 'by editor' })
    expect(res.status).toBe(201)
  })
})

describe('GET /:agentId/evaluation-sets', () => {
  it('lists only sets belonging to the requested agent', async () => {
    await createSet(appAs(OWNER), AGENT_ID, { name: 'mine' })
    await createSet(appAs(OTHER), OTHER_AGENT_ID, { name: 'theirs' })

    const res = await appAs(OWNER).request(`/api/agents/${AGENT_ID}/evaluation-sets`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: { name: string }[] }
    expect(body.data.map((s) => s.name)).toEqual(['mine'])
  })
})

describe('PATCH /:agentId/evaluation-sets/:setId', () => {
  it('renames a set', async () => {
    const created = (await (await createSet(appAs(OWNER), AGENT_ID, { name: 'old' })).json()) as {
      data: { id: string }
    }

    const res = await appAs(OWNER).request(
      `/api/agents/${AGENT_ID}/evaluation-sets/${created.data.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new' }),
      },
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe('new')
  })

  it('404s when the set belongs to a different agent', async () => {
    const created = (await (
      await createSet(appAs(OTHER), OTHER_AGENT_ID, { name: 'theirs' })
    ).json()) as { data: { id: string } }

    const res = await appAs(OWNER).request(
      `/api/agents/${AGENT_ID}/evaluation-sets/${created.data.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hijack' }),
      },
    )
    expect(res.status).toBe(404)
  })
})

describe('DELETE /:agentId/evaluation-sets/:setId', () => {
  it('deletes the set and cascades its cases', async () => {
    const app = appAs(OWNER)
    const created = (await (await createSet(app, AGENT_ID, { name: 'doomed' })).json()) as {
      data: { id: string }
    }
    const setId = created.data.id

    await app.request(`/api/agents/${AGENT_ID}/evaluation-sets/${setId}/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'c1', turns: [{ request: 'hi', expectedResponse: 'hello' }] }),
    })

    const res = await app.request(`/api/agents/${AGENT_ID}/evaluation-sets/${setId}`, {
      method: 'DELETE',
    })
    expect(res.status).toBe(200)
    expect(db.select().from(evaluationSets).all()).toHaveLength(0)
    expect(db.select().from(evaluationCases).all()).toHaveLength(0)
  })
})

describe('cases', () => {
  async function setup() {
    const app = appAs(OWNER)
    const created = (await (await createSet(app, AGENT_ID, { name: 'set' })).json()) as {
      data: { id: string }
    }
    return { app, setId: created.data.id }
  }

  function casesUrl(setId: string, suffix = '') {
    return `/api/agents/${AGENT_ID}/evaluation-sets/${setId}/cases${suffix}`
  }

  it('creates a single-turn case', async () => {
    const { app, setId } = await setup()
    const res = await app.request(casesUrl(setId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'greeting',
        turns: [{ request: 'hello', expectedResponse: 'a friendly greeting' }],
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { id: string; turns: unknown[] } }
    expect(body.data.id).toMatch(/^evc_/)
    expect(body.data.turns).toHaveLength(1)
  })

  it('creates a multi-turn case preserving turn order', async () => {
    const { app, setId } = await setup()
    const res = await app.request(casesUrl(setId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'escalation',
        turns: [
          { request: 'refund please', expectedResponse: 'ask for date' },
          { request: '40 days ago', expectedResponse: 'decline politely' },
        ],
      }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { turns: { request: string }[] } }
    expect(body.data.turns.map((t) => t.request)).toEqual(['refund please', '40 days ago'])
  })

  it('rejects a case with no turns', async () => {
    const { app, setId } = await setup()
    const res = await app.request(casesUrl(setId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'empty', turns: [] }),
    })
    expect(res.status).toBe(400)
  })

  it('lists cases ordered by sortOrder', async () => {
    const { app, setId } = await setup()
    for (const [name, sortOrder] of [
      ['third', 2],
      ['first', 0],
      ['second', 1],
    ] as const) {
      await app.request(casesUrl(setId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          sortOrder,
          turns: [{ request: 'x', expectedResponse: '' }],
        }),
      })
    }

    const res = await app.request(casesUrl(setId))
    const body = (await res.json()) as { data: { name: string }[] }
    expect(body.data.map((c) => c.name)).toEqual(['first', 'second', 'third'])
  })

  it('updates a case', async () => {
    const { app, setId } = await setup()
    const created = (await (
      await app.request(casesUrl(setId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'before', turns: [{ request: 'a', expectedResponse: '' }] }),
      })
    ).json()) as { data: { id: string } }

    const res = await app.request(casesUrl(setId, `/${created.data.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'after' }),
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { name: string } }).data.name).toBe('after')
  })

  it('deletes a case', async () => {
    const { app, setId } = await setup()
    const created = (await (
      await app.request(casesUrl(setId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'doomed', turns: [{ request: 'a', expectedResponse: '' }] }),
      })
    ).json()) as { data: { id: string } }

    const res = await app.request(casesUrl(setId, `/${created.data.id}`), { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(db.select().from(evaluationCases).all()).toHaveLength(0)
  })

  it('404s when the set is not reachable from the given agent', async () => {
    const { setId } = await setup()
    const res = await appAs(OTHER).request(
      `/api/agents/${OTHER_AGENT_ID}/evaluation-sets/${setId}/cases`,
    )
    expect(res.status).toBe(404)
  })
})
