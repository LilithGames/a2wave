/**
 * Integration tests for the resume lookup, against real SQLite.
 *
 * The point of this path is that a run interrupted by a restart continues from
 * the session it already opened instead of replaying its prompt, so the tests
 * assert against real rows rather than a fake that could agree with a wrong
 * predicate.
 */
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
const { resolveResumeChatId, recordResumeAttempt } = await import('../resume-chat-id.js')

const NOW = new Date('2026-08-20T10:00:00Z')

async function seedRun(overrides: Record<string, unknown> = {}) {
  await db.insert(runs).values({
    id: 'run_1',
    intent: 'review',
    status: 'queued',
    initiatorAgentId: 'agt_1',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as never)
}

describe('resolveResumeChatId', () => {
  beforeEach(async () => {
    await db.delete(runs)
  })

  it('returns the recorded session for a run interrupted by a restart', async () => {
    await seedRun({
      executionMetadata: { liveChatId: 'sess_a' },
      result: { error: { code: 'SERVER_RESTART_DURING_EXEC' } },
    })
    expect(await resolveResumeChatId('run_1')).toBe('sess_a')
  })

  it('returns the session for a run whose instance died', async () => {
    await seedRun({
      executionMetadata: { liveChatId: 'sess_b' },
      result: { error: { code: 'INSTANCE_STOPPED_DURING_EXEC' } },
    })
    expect(await resolveResumeChatId('run_1')).toBe('sess_b')
  })

  it('returns null when the run never announced a session', async () => {
    await seedRun({ result: { error: { code: 'SERVER_RESTART_DURING_EXEC' } } })
    expect(await resolveResumeChatId('run_1')).toBeNull()
  })

  it('refuses a run that failed on its own merits', async () => {
    // Its side effects were not interrupted — they simply failed, and resuming
    // would continue a session the user never asked to continue.
    await seedRun({
      executionMetadata: { liveChatId: 'sess_c' },
      result: { error: 'the model returned an error' },
    })
    expect(await resolveResumeChatId('run_1')).toBeNull()
  })

  it('stops resuming once the attempt budget is spent', async () => {
    await seedRun({
      executionMetadata: { liveChatId: 'sess_d', resumeAttempts: 3 },
      result: { error: { code: 'SERVER_RESTART_DURING_EXEC' } },
    })
    expect(await resolveResumeChatId('run_1')).toBeNull()
  })

  it('returns null for a run that no longer exists', async () => {
    expect(await resolveResumeChatId('run_missing')).toBeNull()
  })

  it('resumes a still-running row whose interruption code has not been written yet', async () => {
    // What startup recovery actually sees. The previous process was killed, so
    // the row is still 'running' with no failure code — nothing has settled it
    // yet. Requiring a code here made the whole feature dead code: every
    // candidate read as 'not-interrupted' and took the fail path.
    await seedRun({ status: 'running', executionMetadata: { liveChatId: 'sess_live' } })
    expect(await resolveResumeChatId('run_1', 'SERVER_RESTART_DURING_EXEC')).toBe('sess_live')
  })

  it('still refuses a running row that never recorded a session', async () => {
    await seedRun({ status: 'running' })
    expect(await resolveResumeChatId('run_1', 'SERVER_RESTART_DURING_EXEC')).toBeNull()
  })

  it('honours an explicit session reset over an automatic resume', async () => {
    // oauthResetSession is the user saying "start clean". An automatic resume
    // that ignored it would put them back in the session they just discarded.
    await seedRun({
      status: 'running',
      triggerSource: 'oauth',
      executionMetadata: { liveChatId: 'sess_live', oauthResetSession: true },
    })
    expect(await resolveResumeChatId('run_1', 'SERVER_RESTART_DURING_EXEC')).toBeNull()
  })
})

describe('the interrupted-run scenario end to end', () => {
  beforeEach(async () => {
    await db.delete(runs)
  })

  it('resumes a run the container restart killed, and converges after the budget', async () => {
    // Exactly what startup recovery holds: still 'running', no failure code,
    // owned by the process that just died, with a session recorded mid-flight.
    await seedRun({
      status: 'running',
      ownerInstanceId: 'dead-instance',
      executionMetadata: { liveChatId: 'sess_live' },
    })

    const code = 'SERVER_RESTART_DURING_EXEC'
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await resolveResumeChatId('run_1', code)).toBe('sess_live')
      await recordResumeAttempt('run_1')
    }
    // Four restarts in a row stop resuming rather than looping forever.
    expect(await resolveResumeChatId('run_1', code)).toBeNull()
  })
})

describe('recordResumeAttempt', () => {
  beforeEach(async () => {
    await db.delete(runs)
  })

  it('increments the counter so the budget actually converges', async () => {
    await seedRun({ executionMetadata: { liveChatId: 'sess_a' } })
    await recordResumeAttempt('run_1')
    await recordResumeAttempt('run_1')
    const row = (await db.select().from(runs))[0]
    expect((row?.executionMetadata as { resumeAttempts?: number })?.resumeAttempts).toBe(2)
  })

  it('keeps the session id it is counting attempts against', async () => {
    await seedRun({ executionMetadata: { liveChatId: 'sess_a' } })
    await recordResumeAttempt('run_1')
    const row = (await db.select().from(runs))[0]
    expect(row?.executionMetadata).toMatchObject({ liveChatId: 'sess_a', resumeAttempts: 1 })
  })
})
