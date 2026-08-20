/**
 * The shared merge both metadata writers use, against real SQLite.
 *
 * `executionMetadata` has several concurrent writers, and the consume-once
 * handoff in execute-chat-run *clears* fields on purpose. Any writer that
 * merges onto a stale snapshot resurrects them and replays a user message the
 * platform already consumed.
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
  return { db: drizzle(sqlite, { schema }), sqlite, sqliteDatabase: sqlite, isPostgres: false }
})

const { db } = await import('../../db/client.js')
const { runs } = await import('../../db/schema.js')
const { mergeExecutionMetadata } = await import('../merge-execution-metadata.js')

const NOW = new Date('2026-08-20T10:00:00Z')

async function seedRun(metadata: Record<string, unknown> | null = null) {
  await db.insert(runs).values({
    id: 'run_1',
    intent: 'review',
    status: 'running',
    initiatorAgentId: 'agt_1',
    executionMetadata: metadata,
    createdAt: NOW,
    updatedAt: NOW,
  } as never)
}

async function loadRow() {
  return (await db.select().from(runs))[0]
}

describe('mergeExecutionMetadata', () => {
  beforeEach(async () => {
    await db.delete(runs)
  })

  it('adds the field and reports that it wrote', async () => {
    await seedRun()
    expect(await mergeExecutionMetadata('run_1', () => ({ liveChatId: 'sess_a' }))).toBe(true)
    expect((await loadRow())?.executionMetadata).toEqual({ liveChatId: 'sess_a' })
  })

  it('preserves fields owned by other writers', async () => {
    await seedRun({ queuedTurn: { prompt: 'hi' }, oauthPreviousChatId: 'sess_prev' })
    await mergeExecutionMetadata('run_1', () => ({ liveChatId: 'sess_a' }))
    expect((await loadRow())?.executionMetadata).toEqual({
      queuedTurn: { prompt: 'hi' },
      oauthPreviousChatId: 'sess_prev',
      liveChatId: 'sess_a',
    })
  })

  it('does not resurrect fields a concurrent writer cleared mid-merge', async () => {
    await seedRun({ queuedTurn: { prompt: 'hi' }, runtimeAdminRequesterUserId: 'usr_1' })
    await mergeExecutionMetadata('run_1', () => ({ liveChatId: 'sess_a' }), {
      beforeWrite: async () => {
        await db
          .update(runs)
          .set({ executionMetadata: { runtimeAdminRequesterUserId: 'usr_1' } })
          .where(eq(runs.id, 'run_1'))
      },
    })
    expect((await loadRow())?.executionMetadata).toEqual({
      runtimeAdminRequesterUserId: 'usr_1',
      liveChatId: 'sess_a',
    })
  })

  it('computes the update from the fresh value, not the stale snapshot', async () => {
    // A counter must increment from what is actually stored, or two racing
    // resumes both read 0 and the budget never converges.
    await seedRun({ resumeAttempts: 1 })
    await mergeExecutionMetadata(
      'run_1',
      (current) => ({ resumeAttempts: ((current.resumeAttempts as number) ?? 0) + 1 }),
      {
        beforeWrite: async () => {
          await db
            .update(runs)
            .set({ executionMetadata: { resumeAttempts: 5 } })
            .where(eq(runs.id, 'run_1'))
        },
      },
    )
    expect((await loadRow())?.executionMetadata).toEqual({ resumeAttempts: 6 })
  })

  it('reports false for a run that no longer exists', async () => {
    expect(await mergeExecutionMetadata('run_missing', () => ({ liveChatId: 'x' }))).toBe(false)
  })

  it('leaves updatedAt alone so it cannot vouch for a stalled run', async () => {
    await seedRun()
    const before = (await loadRow())?.updatedAt
    await mergeExecutionMetadata('run_1', () => ({ liveChatId: 'sess_a' }))
    expect((await loadRow())?.updatedAt).toEqual(before)
  })
})
