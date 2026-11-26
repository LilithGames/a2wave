import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

let sqlite: Database.Database
let testDb: ReturnType<typeof drizzle>

vi.mock('../../db/client.js', () => ({
  get db() {
    return testDb
  },
}))
vi.mock('../../lib/scm-workload-lifecycle.js', () => ({
  withScmWorkloadAdmission: (
    _input: unknown,
    write: (tx: typeof testDb, lease: object) => unknown,
  ) => write(testDb, { leaseId: null }),
  activateScmWorkloadInMutation: () => false,
}))
vi.mock('../../lib/scm-path-plan.js', () => ({
  withScmPathMutation: (write: (tx: typeof testDb) => unknown) => write(testDb),
}))

beforeEach(() => {
  sqlite = new Database(':memory:')
  testDb = drizzle(sqlite)
  sqlite.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, workspace_type TEXT);
    INSERT INTO agents VALUES ('agt_1', 'temp');
    CREATE TABLE runs (id TEXT PRIMARY KEY, initiator_agent_id TEXT, trigger_source TEXT,
      trigger_session_id TEXT, status TEXT, owner_instance_id TEXT, queued_at INTEGER,
      created_at INTEGER, updated_at INTEGER);
    CREATE TABLE scm_workload_leases (agent_id TEXT, workload_type TEXT, workload_id TEXT, phase TEXT);
  `)
})
afterEach(() => sqlite.close())

it('serializes turns in one Feishu group topic while other topics use free slots', async () => {
  const { taskQueueDb } = await import('../task-queue-db.js')
  const insert = sqlite.prepare(
    "INSERT INTO runs (id, initiator_agent_id, trigger_source, trigger_session_id, status, created_at) VALUES (?, 'agt_1', 'feishu', ?, 'pending', ?)",
  )
  insert.run('opening', 'group-topic:A', 1)
  insert.run('followup', 'group-topic:A', 2)
  insert.run('other', 'group-topic:B', 3)

  expect((await taskQueueDb.admitRun?.('agt_1', 'opening', 2))?.slot).toBe('acquired')
  expect((await taskQueueDb.admitRun?.('agt_1', 'followup', 2))?.slot).toBe('queued')
  expect(await taskQueueDb.promoteQueuedRun?.('agt_1', 'followup', 2)).toBe(false)
  expect(await taskQueueDb.getOldestQueuedRun('agt_1')).toBeUndefined()
  expect((await taskQueueDb.admitRun?.('agt_1', 'other', 2))?.slot).toBe('acquired')

  sqlite.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run('opening')
  expect(await taskQueueDb.getOldestQueuedRun('agt_1')).toMatchObject({ id: 'followup' })
  expect(await taskQueueDb.promoteQueuedRun?.('agt_1', 'followup', 2)).toBe(true)
})
