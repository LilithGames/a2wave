/**
 * E2E: 真 SQLite + 真 drizzle 迁移 + 真 git 仓库 + 真 HTTP 路由。
 * 只 mock 执行引擎层（executeWithRetry）与外部通知，避免真跑 cursor-agent。
 *
 * 覆盖：invoke → resolveWorkDir → git worktree add → DB 回写 → ephemeral 清理
 */
import { vi } from 'vitest'

// ============================================================
// 关键：在任何 import 解析前，先设置 DATABASE_URL
// ============================================================
const DB_PATH = vi.hoisted(() => {
  const path = `/tmp/wt-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
  process.env.DATABASE_URL = path
  process.env.NODE_ENV = 'test'
  process.env.AUTH_SECRET = 'x'.repeat(32)
  return path
})

// ============================================================
// Mock：只打桩执行引擎 + 外部副作用，其余全部跑真实代码
// ============================================================

vi.mock('../../lib/execute-with-retry.js', () => ({
  executeWithRetry: vi.fn().mockResolvedValue({
    result: { success: true, output: 'E2E mock engine output', chatId: null },
    retries: [],
    logs: [],
  }),
}))

vi.mock('../../middleware/gateway-auth.js', () => ({
  validateGatewayAuth: vi.fn().mockResolvedValue({}),
  normalizeAuthType: vi.fn().mockReturnValue('none'),
}))

vi.mock('../../lib/webhook-notifier.js', () => ({
  notifyRunError: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/artifact-storage.js', () => ({
  scanAndRegisterArtifacts: vi.fn().mockResolvedValue([]),
}))

// ============================================================
// Imports（此时 db/client 会用到 hoisted 的 DATABASE_URL）
// ============================================================

import { execFile } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { Hono } from 'hono'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDatabaseConnection, db } from '../../db/client.js'
import { agents, runs, scmSources, users } from '../../db/schema.js'
import { setDurableExecutionLeaseReleaseHandler } from '../../engine/execution-lease-registry.js'
import { processInstanceId } from '../../lib/process-instance.js'
import { releaseScmWorkload } from '../../lib/scm-workload-lifecycle.js'

const execFileAsync = promisify(execFile)

// ============================================================
// 常量 + 工具
// ============================================================

let E2E_ROOT: string
let REPO_DIR: string
let WS_ROOT: string

const USER_ID = 'usr_e2e'
const SCM_ID = 'scm_e2e'
const AGENT_ID = 'agt_e2e'

let gatewayApp: Hono

async function setupGitRepo(repoDir: string): Promise<void> {
  mkdirSync(repoDir, { recursive: true })
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: repoDir })
  await execFileAsync('git', ['config', 'user.email', 't@e2e.local'], { cwd: repoDir })
  await execFileAsync('git', ['config', 'user.name', 'e2e'], { cwd: repoDir })
  writeFileSync(join(repoDir, 'README.md'), '# e2e\n')
  await execFileAsync('git', ['add', '.'], { cwd: repoDir })
  await execFileAsync('git', ['commit', '-m', 'init'], { cwd: repoDir })
  // 给个本地 bare origin：生产的 scm-source 都是 clone 出来的一定有 origin，
  // resolveBranchForCheckout 会走 ls-remote 探测远端分支，没 origin 会当网络故障抛出。
  const originDir = `${repoDir}.origin.git`
  mkdirSync(originDir, { recursive: true })
  await execFileAsync('git', ['init', '--bare', '-b', 'main'], { cwd: originDir })
  await execFileAsync('git', ['remote', 'add', 'origin', originDir], { cwd: repoDir })
  await execFileAsync('git', ['push', 'origin', 'main'], { cwd: repoDir })
}

function seedBaseRows(): void {
  db.insert(users)
    .values({
      id: USER_ID,
      username: 'e2e-user',
      role: 'admin',
      isActive: true,
    })
    .run()

  db.insert(scmSources)
    .values({
      id: SCM_ID,
      name: 'e2e-source',
      type: 'git',
      config: { repoUrl: 'https://example.invalid/e2e.git', branch: 'main' },
      localPath: REPO_DIR,
      workspacesPath: WS_ROOT,
      userId: USER_ID,
    })
    .run()

  db.insert(agents)
    .values({
      id: AGENT_ID,
      name: 'e2e-agent',
      type: 'cursor',
      publishStatus: 'published',
      publishAuthType: 'none',
      publishIpWhitelist: [],
      workspaceType: 'scm',
      scmSourceId: SCM_ID,
      config: {},
      skills: [],
      mcpServerIds: [],
      kbDocumentIds: [],
      userId: USER_ID,
      maxConcurrency: 1,
    })
    .run()
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`)
}

// ============================================================
// Lifecycle
// ============================================================

beforeAll(async () => {
  E2E_ROOT = mkdtempSync(join(tmpdir(), 'wt-e2e-root-'))
  REPO_DIR = join(E2E_ROOT, 'repo')
  WS_ROOT = join(E2E_ROOT, 'workspaces')

  // 1. 跑真 drizzle 迁移（cwd 需要是 apps/api）
  const migrationsFolder = existsSync('drizzle')
    ? 'drizzle'
    : existsSync('apps/api/drizzle')
      ? 'apps/api/drizzle'
      : (() => {
          throw new Error('drizzle folder not found')
        })()
  migrate(db, { migrationsFolder })

  // 2. 初始化真 git 仓库
  await setupGitRepo(REPO_DIR)

  // 3. 种 DB 基础行
  seedBaseRows()

  // 4. 挂载真 gateway 路由
  const mod = await import('../../routes/gateway.js')
  gatewayApp = new Hono().route('/api/gateway', mod.default)

  // 5. Match index.ts: release the durable SCM workload lease when the
  //    execution lease ends. Admission counts active durable leases, so
  //    omitting this handler would leave every later invocation queued (202).
  setDurableExecutionLeaseReleaseHandler(async (runId) => {
    await releaseScmWorkload({ type: 'run', workloadId: runId, ownerInstanceId: processInstanceId })
  })
})

afterAll(async () => {
  setDurableExecutionLeaseReleaseHandler(undefined)
  await closeDatabaseConnection()
  if (E2E_ROOT) rmSync(E2E_ROOT, { recursive: true, force: true })
  if (existsSync(DB_PATH)) rmSync(DB_PATH, { force: true })
  // WAL / SHM 副产物
  const walDir = dirname(DB_PATH)
  for (const suffix of ['-wal', '-shm']) {
    const f = DB_PATH + suffix
    if (existsSync(f)) rmSync(f, { force: true })
    void walDir
  }
})

beforeEach(() => {
  // 清空 runs，避免跨用例污染 slot / workDir 占用检查
  db.delete(runs).run()
})

// ============================================================
// Tests
// ============================================================

describe('E2E: worktree — invoke → DB → filesystem → cleanup', () => {
  it('ephemeral: 真 git worktree 创建 + runs 回写 + 完成后清理', async () => {
    const res = await gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'hello e2e',
        async: false,
        stream: false,
        worktree: { name: 'feat-e2e', cleanup: 'ephemeral' },
      }),
    })

    expect(res.status).toBe(200)
    const json = (await res.json()) as { data: { runId: string; reply: string } }
    const runId = json.data.runId
    expect(runId).toBeTruthy()
    expect(json.data.reply).toBe('E2E mock engine output')

    // 真 DB 断言：workDir + worktreeConfig 写入了 runs
    const run = db.select().from(runs).where(eq(runs.id, runId)).get()
    expect(run?.workDir).toBe(join(WS_ROOT, 'feat-e2e'))
    expect(run?.worktreeConfig).toEqual({ name: 'feat-e2e', cleanup: 'ephemeral' })

    // 真文件系统：等待 fire-and-forget 的 ephemeral 清理完成
    await waitFor(() => !existsSync(join(WS_ROOT, 'feat-e2e')), 3000)
    expect(existsSync(join(WS_ROOT, 'feat-e2e'))).toBe(false)
  })

  it('persistent: 真 git worktree 创建后不清理', async () => {
    const res = await gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'hello e2e',
        async: false,
        stream: false,
        worktree: { name: 'keep-e2e', cleanup: 'persistent' },
      }),
    })

    expect(res.status).toBe(200)

    // 等 finishRunSuccess (fire-and-forget) 的后台 DB 写入完成
    const wsPath = join(WS_ROOT, 'keep-e2e')
    expect(existsSync(wsPath)).toBe(true)
    expect(existsSync(join(wsPath, 'README.md'))).toBe(true)

    // 给 fire-and-forget 足够时间跑完 cleanup 判断（应该 no-op）
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(wsPath)).toBe(true) // persistent，不应被删除

    // 手动清理以免污染下一用例
    rmSync(wsPath, { recursive: true, force: true })
  })

  it('409: 同名 worktree 被 running run 占用时拒绝', async () => {
    const sharedName = 'shared-e2e'
    const sharedPath = join(WS_ROOT, sharedName)

    // 提升并发度以直达 resolveWorkDir（否则会先命中 'queued' 202）。
    // 本用例只验证 409 占用分支；queued 分支下 worktreeConfig 持久化 + 出队时
    // worktree 不可用的场景见：
    //   - apps/api/src/routes/__tests__/worktree-lifecycle.test.ts（入队持久化）
    //   - apps/api/src/lib/__tests__/execute-chat-run.test.ts（出队时 409）
    db.update(agents).set({ maxConcurrency: 5 }).where(eq(agents.id, AGENT_ID)).run()

    // 种一个占用中的 run
    db.insert(runs)
      .values({
        id: 'run_occupy',
        intent: 'occupying',
        status: 'running',
        initiatorAgentId: AGENT_ID,
        workDir: sharedPath,
        worktreeConfig: { name: sharedName, cleanup: 'persistent' },
        triggerSource: 'api',
      })
      .run()

    const res = await gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'hello',
        async: false,
        stream: false,
        worktree: { name: sharedName, cleanup: 'ephemeral' },
      }),
    })

    expect(res.status).toBe(409)
    const json = (await res.json()) as { error: { code: string; message: string } }
    expect(json.error.code).toBe('EXECUTION_ERROR')
    expect(json.error.message).toContain(sharedPath)

    // 恢复
    db.update(agents).set({ maxConcurrency: 1 }).where(eq(agents.id, AGENT_ID)).run()
  })

  it('concurrent: 同名并发 invoke 恰好一个 409（原子占用）', async () => {
    // 提升并发度以绕过 queue、直达 resolveWorkDir
    db.update(agents).set({ maxConcurrency: 5 }).where(eq(agents.id, AGENT_ID)).run()

    const body = JSON.stringify({
      message: 'race',
      async: false,
      stream: false,
      worktree: { name: 'race-e2e', cleanup: 'ephemeral' },
    })

    const results = await Promise.all([
      gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    ])

    const statuses = results.map((r) => r.status).sort()
    // 原子占用保证：两个并发请求恰好一个 200（获得资源）、一个 409（被拒）
    expect(statuses).toEqual([200, 409])

    db.update(agents).set({ maxConcurrency: 1 }).where(eq(agents.id, AGENT_ID)).run()
  })

  it('ttl: 状态文件落盘，mtime 对应 lastActivityAt', async () => {
    const res = await gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'hello ttl',
        async: false,
        stream: false,
        worktree: { name: 'ttl-e2e', cleanup: 'ttl' },
      }),
    })
    expect(res.status).toBe(200)

    const wsPath = join(WS_ROOT, 'ttl-e2e')
    const stateFile = join(wsPath, '.a2wave-workspace.json')
    expect(existsSync(stateFile)).toBe(true)

    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
    expect(parsed.cleanup).toBe('ttl')

    const mtimeMs = statSync(stateFile).mtimeMs
    expect(Date.now() - mtimeMs).toBeLessThan(10_000)

    // ttl 不清理
    await new Promise((r) => setTimeout(r, 200))
    expect(existsSync(wsPath)).toBe(true)

    rmSync(wsPath, { recursive: true, force: true })
  })

  it('400: 非法 worktree name 被 schema 拒绝', async () => {
    const res = await gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'x',
        async: false,
        stream: false,
        worktree: { name: 'bad name!', cleanup: 'ttl' },
      }),
    })
    expect(res.status).toBe(400)
  })

  it('ttl 清理闭环: 陈旧 worktree 被下一次 invoke 触发的后台清理删除', async () => {
    const { _resetTtlCleanupDebounce } = await import('../../lib/agent-helpers.js')
    _resetTtlCleanupDebounce()

    // 1. 创建陈旧 worktree（ttl 模式）
    const r1 = await gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'first',
        async: false,
        stream: false,
        worktree: { name: 'stale', cleanup: 'ttl' },
      }),
    })
    expect(r1.status).toBe(200)
    const stalePath = join(WS_ROOT, 'stale')
    const staleState = join(stalePath, '.a2wave-workspace.json')
    expect(existsSync(staleState)).toBe(true)

    // 2. 把状态文件 mtime 往前调 10 天（> TTL_IDLE_DAYS=7）
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    await utimes(staleState, past, past)

    // 3. 第一次 invoke 已消耗 debounce，重置后触发第二次
    _resetTtlCleanupDebounce()

    const r2 = await gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'trigger',
        async: false,
        stream: false,
        worktree: { name: 'new-ttl', cleanup: 'ttl' },
      }),
    })
    expect(r2.status).toBe(200)

    // 4. 等 fire-and-forget 的 cleanupStale 完成
    await waitFor(() => !existsSync(stalePath), 3000)
    expect(existsSync(stalePath)).toBe(false)
    expect(existsSync(join(WS_ROOT, 'new-ttl'))).toBe(true)

    rmSync(join(WS_ROOT, 'new-ttl'), { recursive: true, force: true })
  })

  it('409: 同分支被其他 worktree 锁定时拒绝', async () => {
    // 先占个 name=a 的 worktree 走 branch=feature-lock
    const res1 = await gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'first',
        async: false,
        stream: false,
        worktree: { name: 'lock-a', branch: 'feature-lock', cleanup: 'persistent' },
      }),
    })
    expect(res1.status).toBe(200)
    expect(existsSync(join(WS_ROOT, 'lock-a'))).toBe(true)

    // 再用另一个 name 复用同 branch → git worktree add 会拒绝
    const res2 = await gatewayApp.request(`/api/gateway/${AGENT_ID}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'second',
        async: false,
        stream: false,
        worktree: { name: 'lock-b', branch: 'feature-lock', cleanup: 'persistent' },
      }),
    })
    expect(res2.status).toBe(409)
    const json = (await res2.json()) as { error: { code: string; message: string } }
    expect(json.error.message).toMatch(/feature-lock/)

    rmSync(join(WS_ROOT, 'lock-a'), { recursive: true, force: true })
  })
})
