import BetterSqlite3 from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let sqlite: BetterSqlite3.Database
let database: ReturnType<typeof drizzle>
let failuresRemaining = 0

vi.mock('../../db/client.js', () => ({
  get db() {
    return database
  },
  get sqliteDatabase() {
    return sqlite
  },
  isPostgres: false,
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../engine/execution-lease-registry.js', () => ({ completeExecutionLease: vi.fn() }))
vi.mock('../../engine/task-queue.js', () => ({ scheduleNext: vi.fn() }))
vi.mock('../../engine/task-queue-db.js', () => ({ taskQueueDb: {} }))
vi.mock('../execute-chat-run.js', () => ({ executeChatRun: vi.fn() }))
vi.mock('../scm-source.js', () => ({ createScmSource: vi.fn() }))
vi.mock('../git-workspace.js', () => ({ isPerAgentWorkspaceName: vi.fn() }))
vi.mock('../scm-workspace-removal.js', () => ({ removeOwnedSourceWorkspaceGuarded: vi.fn() }))
vi.mock('../workspace-cleanup-retry.js', () => ({ cleanupWorkspaceOrHandOff: vi.fn() }))
vi.mock('../webhook-notifier.js', () => ({ notifyRunError: vi.fn() }))
vi.mock('../artifact-storage.js', () => ({
  scanAndRegisterArtifacts: vi.fn(),
  discardRunArtifactsDir: vi.fn(),
}))
vi.mock('../artifact-links.js', () => ({ buildArtifactLinkLines: vi.fn() }))
vi.mock('../worklog-generator.js', () => ({ generateWorkLog: vi.fn() }))

import { completeExecutionLease } from '../../engine/execution-lease-registry.js'
import { logger } from '../logger.js'
import { finishRunSuccess } from '../run-lifecycle.js'

const params = {
  runId: 'run_1',
  stepId: 'rst_1',
  taskId: 'run_1/rst_1',
  agentId: 'agt_1',
  startTime: 0,
}
const result = { success: true, output: 'done', durationMs: 1 }

function states() {
  return {
    run: sqlite.prepare('SELECT status, result FROM runs WHERE id = ?').get('run_1'),
    step: sqlite.prepare('SELECT status, output FROM run_steps WHERE id = ?').get('rst_1'),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  failuresRemaining = 0
  sqlite = new BetterSqlite3(':memory:')
  database = drizzle(sqlite)
  sqlite.function('fail_step_write', () => {
    if (failuresRemaining-- > 0) throw new Error('injected step write failure')
    return 0
  })
  sqlite.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT, result TEXT, updated_at INTEGER);
    CREATE TABLE run_steps (id TEXT PRIMARY KEY, run_id TEXT, status TEXT, output TEXT, duration_ms INTEGER);
    INSERT INTO runs VALUES ('run_1', 'running', NULL, 0);
    INSERT INTO run_steps VALUES ('rst_1', 'run_1', 'running', NULL, NULL);
    CREATE TRIGGER fail_step BEFORE UPDATE ON run_steps BEGIN SELECT fail_step_write(); END;
  `)
})

afterEach(() => sqlite.close())

describe('terminal recovery with real SQLite rollback', () => {
  it('settles the running step with its run after the first step write rolls back', async () => {
    failuresRemaining = 1
    await finishRunSuccess(params, result)
    const state = states()
    expect(state.run).toMatchObject({ status: 'failed' })
    expect(state.step).toMatchObject({ status: 'failed' })
    expect(JSON.parse((state.step as { output: string }).output)).toHaveProperty('error')
    expect(completeExecutionLease).toHaveBeenCalledWith('run_1')
  })

  it('leaves both rows recoverable and logs the error if the recovery write also fails', async () => {
    failuresRemaining = 2
    await expect(finishRunSuccess(params, result)).resolves.toEqual([])
    expect(states()).toEqual({
      run: { status: 'running', result: null },
      step: { status: 'running', output: null },
    })
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run_1' }),
      'Run-level terminal recovery failed',
    )
    expect(completeExecutionLease).toHaveBeenCalledWith('run_1')
    failuresRemaining = 1
    await finishRunSuccess(params, result)
    expect(states().step).toMatchObject({ status: 'failed' })
  })

  it('does not overwrite an already completed run or step', async () => {
    sqlite.exec(
      'UPDATE runs SET status = \'completed\', result = \'{"output":"original"}\'; UPDATE run_steps SET status = \'completed\', output = \'{"result":"original"}\';',
    )
    const before = states()
    await finishRunSuccess(params, result)
    expect(states()).toEqual(before)
  })

  it('preserves a step that already reached a terminal state when settling the run', async () => {
    sqlite.exec('UPDATE run_steps SET status = \'cancelled\', output = \'{"error":"cancelled"}\';')
    const before = states().step
    await finishRunSuccess(params, result)
    expect(states().run).toMatchObject({ status: 'failed' })
    expect(states().step).toEqual(before)
  })
})
