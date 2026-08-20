/**
 * Integration tests for the live session-id write, against real SQLite.
 *
 * The write is a read-modify-write on a JSON column that other code paths also
 * own, so the risk is not "does it store a string" but "does it destroy a
 * neighbouring field". A fake would happily hide exactly that.
 */
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const Database = (await import('better-sqlite3')).default
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE runs (
      id text PRIMARY KEY NOT NULL,
      intent text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      result text,
      execution_metadata text,
      trigger_source text,
      trigger_session_id text,
      trigger_event_id text,
      work_dir text,
      owner_instance_id text,
      worktree_config text,
      initiator_agent_id text,
      user_id text,
      trigger_user_name text,
      trigger_agent_name text,
      input_tokens integer,
      output_tokens integer,
      reasoning_tokens integer,
      cache_read_tokens integer,
      cache_write_tokens integer,
      created_at integer NOT NULL,
      updated_at integer NOT NULL
    );
  `)
  const schema = await import('../../db/schema.js')
  // `sqliteDatabase` is the name resolveDeps reads; exporting only `sqlite`
  // leaves withTransaction on its unwrapped fallback, which would silently
  // stop these tests from exercising real isolation.
  return { db: drizzle(sqlite, { schema }), sqlite, sqliteDatabase: sqlite, isPostgres: false }
})

const { db } = await import('../../db/client.js')
const { runs } = await import('../../db/schema.js')
const { persistLiveSessionId, readLiveSessionId } = await import('../persist-live-session-id.js')

const NOW = new Date('2026-08-20T10:00:00Z')

async function seedRun(overrides: Record<string, unknown> = {}) {
  await db.insert(runs).values({
    id: 'run_1',
    intent: 'review',
    status: 'running',
    initiatorAgentId: 'agt_1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never)
}

async function loadMetadata(runId = 'run_1') {
  const row = (await db.select().from(runs))[0]
  expect(row?.id).toBe(runId)
  return row?.executionMetadata as Record<string, unknown> | null
}

describe('persistLiveSessionId', () => {
  beforeEach(async () => {
    await db.delete(runs)
  })

  it('stores the session id so a crashed run can name its resume target', async () => {
    await seedRun()
    await persistLiveSessionId('run_1', 'sess_a')
    expect(await loadMetadata()).toMatchObject({ liveChatId: 'sess_a' })
  })

  it('preserves neighbouring metadata written by the preparation path', async () => {
    // queuedTurn and oauthPreviousChatId are owned by execute-chat-run; a
    // blind overwrite here would silently drop a queued user message.
    await seedRun({
      executionMetadata: { queuedTurn: { prompt: 'hello' }, oauthPreviousChatId: 'sess_prev' },
    })
    await persistLiveSessionId('run_1', 'sess_a')
    expect(await loadMetadata()).toEqual({
      queuedTurn: { prompt: 'hello' },
      oauthPreviousChatId: 'sess_prev',
      liveChatId: 'sess_a',
    })
  })

  it('overwrites a stale id from an earlier turn of the same conversation row', async () => {
    await seedRun({ executionMetadata: { liveChatId: 'sess_old' } })
    await persistLiveSessionId('run_1', 'sess_new')
    expect(await loadMetadata()).toMatchObject({ liveChatId: 'sess_new' })
  })

  it('does not create a row for a run that no longer exists', async () => {
    await persistLiveSessionId('run_missing', 'sess_a')
    expect(await db.select().from(runs)).toHaveLength(0)
  })

  it('reports whether it wrote, so a caller can stop retrying a vanished run', async () => {
    await seedRun()
    expect(await persistLiveSessionId('run_1', 'sess_a')).toBe(true)
    // The reaper can settle and archive a run while its CLI is still
    // streaming; re-querying for every remaining output line is pure waste.
    expect(await persistLiveSessionId('run_missing', 'sess_a')).toBe(false)
  })

  it('does not resurrect metadata a concurrent writer cleared mid-flight', async () => {
    // The consume-once handoff in execute-chat-run strips queuedTurn and the
    // attachment fields once they are materialized into a step. A
    // read-modify-write that read before that commit and wrote after would put
    // them back, replaying a user message the platform already consumed.
    await seedRun({
      executionMetadata: { queuedTurn: { prompt: 'hello' }, runtimeAdminRequesterUserId: 'usr_1' },
    })
    await persistLiveSessionId('run_1', 'sess_a', {
      beforeWrite: async () => {
        await db
          .update(runs)
          .set({ executionMetadata: { runtimeAdminRequesterUserId: 'usr_1' } })
          .where(eq(runs.id, 'run_1'))
      },
    })
    const metadata = await loadMetadata()
    expect(metadata).not.toHaveProperty('queuedTurn')
    expect(metadata).toEqual({ runtimeAdminRequesterUserId: 'usr_1', liveChatId: 'sess_a' })
  })

  it('leaves updatedAt alone so it cannot vouch for a stalled run', async () => {
    // The orphaned-run reaper compares updatedAt against the owner's boot
    // instant. Bumping it here would let a wedged CLI that still prints
    // output look freshly active to that fence.
    await seedRun()
    const before = (await db.select().from(runs))[0]?.updatedAt
    await persistLiveSessionId('run_1', 'sess_a')
    expect((await db.select().from(runs))[0]?.updatedAt).toEqual(before)
  })
})

describe('readLiveSessionId', () => {
  beforeEach(async () => {
    await db.delete(runs)
  })

  it('returns the recorded id', async () => {
    await seedRun({ executionMetadata: { liveChatId: 'sess_a' } })
    expect(await readLiveSessionId('run_1')).toBe('sess_a')
  })

  it('returns null when the run never announced a session', async () => {
    await seedRun()
    expect(await readLiveSessionId('run_1')).toBeNull()
  })

  it('returns null for a missing run', async () => {
    expect(await readLiveSessionId('run_missing')).toBeNull()
  })

  it('ignores a non-string value rather than handing back a bad resume target', async () => {
    await seedRun({ executionMetadata: { liveChatId: 42 } })
    expect(await readLiveSessionId('run_1')).toBeNull()
  })
})
