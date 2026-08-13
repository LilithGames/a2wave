/**
 * Covers the "existing row" update branches in bootstrapScmP4 / bootstrapScmGit
 * and the localPath-conflict skip branch — the parts bootstrap.test.ts doesn't
 * reach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const envMock = {
  SCM_P4_PORT: '',
  SCM_P4_USER: '',
  SCM_P4_PASSWD: '',
  SCM_P4_CLIENT: '',
  SCM_P4_DEPOT_PATH: '',
  SCM_P4_AUTO_SYNC: true,
  SCM_P4_SYNC_INTERVAL: 30,
  SCM_P4_LOCAL_PATH: '/var/p4',
  SCM_GIT_REPO_URL: '',
  SCM_GIT_BRANCH: 'main',
  SCM_GIT_USERNAME: '',
  SCM_GIT_PAT: '',
  SCM_GIT_AUTO_SYNC: true,
  SCM_GIT_SYNC_INTERVAL: 30,
  SCM_GIT_LOCAL_PATH: '/var/git',
  // Read by the shared path planner both bootstrap paths now go through.
  SCM_STORAGE_ROOT: '/data/workspace',
  SCM_WORKSPACES_ALLOWED_ROOTS: '/data/workspace/workspaces',
  DATABASE_URL: '/app/data/a2wave.db',
  A2WAVE_SKILLS_STORAGE: '/app/data/skills',
  A2WAVE_KB_STORAGE: '/app/data/kb',
  A2WAVE_MEMORY_STORAGE: '/app/data/memory',
  LOG_FILE_PATH: '/app/data/logs/a2wave.log',
}

vi.mock('../../env.js', () => ({
  get env() {
    return envMock
  },
}))

const dbSelect = vi.fn()
const dbInsertRun = vi.fn()
const dbUpdateRun = vi.fn()
// Production awaits `db.insert(t).values(...)` / `db.update(t).set(...).where(...)`,
// so the write is recorded on the awaited terminator instead of a `.run()` call.
const insertChain = {
  values: vi.fn(async (...a: unknown[]) => {
    dbInsertRun(...a)
    return []
  }),
}
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn(async (...a: unknown[]) => {
    dbUpdateRun(...a)
    return []
  }),
}

vi.mock('../../db/client.js', () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    insert: () => insertChain,
    update: () => updateChain,
  },
}))

vi.mock('../../db/schema.js', () => ({
  scmSources: {
    id: 'scmSources.id',
    name: 'scmSources.name',
    localPath: 'scmSources.localPath',
    workspacesPath: 'scmSources.workspacesPath',
    syncStatus: 'scmSources.syncStatus',
    codegraphStatus: 'scmSources.codegraphStatus',
  },
  scmWorkloadLeases: {
    id: 'scmWorkloadLeases.id',
    workloadType: 'scmWorkloadLeases.workloadType',
    workloadId: 'scmWorkloadLeases.workloadId',
    agentId: 'scmWorkloadLeases.agentId',
    scmSourceId: 'scmWorkloadLeases.scmSourceId',
  },
  scmWorkspaceRemovals: {
    id: 'scmWorkspaceRemovals.id',
    scmSourceId: 'scmWorkspaceRemovals.scmSourceId',
    workspaceName: 'scmWorkspaceRemovals.workspaceName',
  },
  runs: { id: 'runs.id', workDir: 'runs.workDir', status: 'runs.status' },
  settings: { category: 'settings.category', key: 'settings.key' },
}))

vi.mock('../id.js', () => ({ createId: vi.fn((p) => `${p}_test`) }))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { bootstrapFromEnv } from '../bootstrap.js'

// `bootstrapFromEnv()` returns void but its body kicks off async upserts, so the
// tests must let the microtask queue drain before asserting on the db mock.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function makeChain() {
  const c: Record<string, ReturnType<typeof vi.fn>> = {}
  for (const k of [
    'from',
    'where',
    'limit',
    'orderBy',
    'offset',
    'groupBy',
    'having',
    'returning',
  ]) {
    c[k] = vi.fn((): unknown => __chain)
  }
  c.get = vi.fn()
  c.all = vi.fn()

  // Awaiting the chain yields what `.get()`/`.all()` was configured to return,
  // as an array — production code destructures `[row]` from `.limit(1)` now.
  // The original mock fns stay reachable, so existing assertions are unaffected.
  let __settled: Promise<unknown[]> | undefined
  const __rows = (): unknown[] => {
    // `get` before `all`: mocks often define both, with `all` a placeholder.
    const get = c.get as undefined | (() => unknown)
    if (get) {
      const row = get()
      if (row != null) return [row]
    }
    const all = c.all as undefined | (() => unknown)
    if (all) {
      const v = all()
      return Array.isArray(v) ? v : v == null ? [] : [v]
    }
    if (get) return []
    const run = c.run as undefined | (() => unknown)
    if (run) {
      const res = run() as { changes?: number } | undefined
      const changes = typeof res?.changes === 'number' ? res.changes : 1
      return Array.from({ length: changes }, () => ({}))
    }
    return []
  }
  const __chain = Object.assign(
    {
      // Lazy: resolving eagerly would consume a queued `get` per intermediate
      // node while the chain is still being built.
      // biome-ignore lint/suspicious/noThenProperty: intentionally a thenable — it stands in for drizzle's awaitable query builder.
      then: (f?: (v: unknown[]) => unknown, r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.then(f, r)
      },
      catch: (r?: (e: unknown) => unknown) => {
        __settled ??= Promise.resolve().then(__rows)
        return __settled.catch(r)
      },
    },
    c,
  )
  for (const k of Object.keys(c)) {
    const fn = c[k] as unknown
    if (typeof fn === 'function' && !['get', 'all', 'run'].includes(k)) {
      ;(__chain as Record<string, unknown>)[k] = fn
    }
  }
  return __chain as unknown as typeof c
}

function queueSelects(...returns: Array<{ get?: unknown; all?: unknown }>) {
  let i = 0
  dbSelect.mockImplementation(() => {
    const cfg = returns[i++] ?? {}
    const c = makeChain()
    if ('get' in cfg) c.get.mockReturnValue(cfg.get)
    // The gateway token back-fill reads every jwtSigner row; an empty array
    // means no existing signer, so the back-fill is skipped.
    c.all.mockReturnValue('all' in cfg ? cfg.all : [])
    return c
  })
}

beforeEach(() => {
  dbSelect.mockReset()
  dbInsertRun.mockReset()
  dbUpdateRun.mockReset()
  insertChain.values.mockClear()
  updateChain.set.mockClear()
  updateChain.where.mockClear()
  for (const key of Object.keys(envMock)) {
    if (typeof envMock[key as keyof typeof envMock] === 'string') {
      // @ts-expect-error reset string fields
      envMock[key] = ''
    }
  }
  envMock.SCM_P4_LOCAL_PATH = '/var/p4'
  envMock.SCM_GIT_LOCAL_PATH = '/var/git'
  envMock.SCM_STORAGE_ROOT = '/data/workspace'
  envMock.SCM_WORKSPACES_ALLOWED_ROOTS = '/data/workspace/workspaces'
  envMock.DATABASE_URL = '/app/data/a2wave.db'
  envMock.A2WAVE_SKILLS_STORAGE = '/app/data/skills'
  envMock.A2WAVE_KB_STORAGE = '/app/data/kb'
  envMock.A2WAVE_MEMORY_STORAGE = '/app/data/memory'
  envMock.LOG_FILE_PATH = '/app/data/logs/a2wave.log'
  envMock.SCM_GIT_BRANCH = 'main'
  envMock.SCM_P4_AUTO_SYNC = true
  envMock.SCM_P4_SYNC_INTERVAL = 30
  envMock.SCM_GIT_AUTO_SYNC = true
  envMock.SCM_GIT_SYNC_INTERVAL = 30
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('bootstrapScmP4 — update path', () => {
  it('does not mutate an env:p4 row reserved for deletion', async () => {
    envMock.SCM_P4_PORT = '1666'
    envMock.SCM_P4_USER = 'admin'
    envMock.SCM_P4_CLIENT = 'workspace'

    queueSelects({
      get: {
        id: 'scm_deleting',
        localPath: '/legacy/p4-client',
        workspacesPath: '/legacy/p4-worktrees',
        deletionRequestedAt: new Date('2026-08-13T00:00:00Z'),
      },
    })

    await bootstrapFromEnv()

    expect(updateChain.set).not.toHaveBeenCalled()
    expect(dbInsertRun).not.toHaveBeenCalled()
  })

  it('updates the existing env:p4 row in place (no insert)', async () => {
    envMock.SCM_P4_PORT = '1666'
    envMock.SCM_P4_USER = 'admin'
    envMock.SCM_P4_CLIENT = 'workspace'

    queueSelects(
      { get: { id: 'scm_existing', localPath: '/var/p4' } },
      // For SCM_GIT_REPO_URL empty path, no further selects expected.
    )

    bootstrapFromEnv()
    await flush()
    expect(dbUpdateRun).toHaveBeenCalledTimes(1)
    expect(dbInsertRun).not.toHaveBeenCalled()
  })

  it('keeps an existing P4 path when the env override is removed', async () => {
    envMock.SCM_P4_PORT = '1666'
    envMock.SCM_P4_USER = 'admin'
    envMock.SCM_P4_CLIENT = 'workspace'
    envMock.SCM_P4_LOCAL_PATH = ''
    queueSelects({ get: { id: 'scm_existing', localPath: '/legacy/p4-client' } })

    bootstrapFromEnv()
    await flush()

    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ localPath: '/legacy/p4-client' }),
    )
    expect(dbInsertRun).not.toHaveBeenCalled()
  })

  /**
   * The update branch keeps the row's stored `workspacesPath`, so the planner
   * has to be told about it — otherwise it allocates a *default* root, checks
   * the new checkout path against that, and passes, while the write persists a
   * different root entirely. A new SCM_P4_LOCAL_PATH sitting inside the root the
   * row actually keeps therefore slipped straight through, and the next sync
   * force-discards the worktrees underneath it.
   */
  it('rejects a new P4 path that overlaps the row own stored workspaces root', async () => {
    envMock.SCM_P4_PORT = '1666'
    envMock.SCM_P4_USER = 'admin'
    envMock.SCM_P4_CLIENT = 'workspace'
    envMock.SCM_P4_LOCAL_PATH = '/srv/worktrees/nested-checkout'
    queueSelects({
      get: {
        id: 'scm_existing',
        localPath: '/old/path',
        workspacesPath: '/srv/worktrees',
      },
    })

    bootstrapFromEnv()
    await flush()

    expect(updateChain.set).not.toHaveBeenCalled()
  })

  it('rejects a new Git path that overlaps the row own stored workspaces root', async () => {
    envMock.SCM_GIT_REPO_URL = 'https://example/repo.git'
    envMock.SCM_GIT_LOCAL_PATH = '/srv/git-worktrees/nested-checkout'
    queueSelects({
      get: {
        id: 'scm_g',
        localPath: '/old/path',
        workspacesPath: '/srv/git-worktrees',
      },
    })

    bootstrapFromEnv()
    await flush()

    expect(updateChain.set).not.toHaveBeenCalled()
  })

  it('skips when local path conflict points to a different existing row', async () => {
    envMock.SCM_P4_PORT = '1666'
    envMock.SCM_P4_USER = 'admin'
    envMock.SCM_P4_CLIENT = 'workspace'
    envMock.SCM_P4_LOCAL_PATH = '/new/path'

    queueSelects(
      { get: { id: 'scm_existing', localPath: '/old/path' } }, // find by name
      // Path planner peer scan: every row, unfiltered. The conflicting peer owns
      // the requested path, so the plan is rejected and no update is issued.
      {
        all: [{ id: 'scm_conflict', name: 'other', localPath: '/new/path', workspacesPath: null }],
      },
    )

    bootstrapFromEnv()
    await flush()
    expect(dbUpdateRun).not.toHaveBeenCalled()
  })

  it('skips on insert path when the localPath is already used by another source', async () => {
    envMock.SCM_P4_PORT = '1666'
    envMock.SCM_P4_USER = 'admin'
    envMock.SCM_P4_CLIENT = 'workspace'

    queueSelects(
      { get: undefined }, // no existing env:p4
      {
        all: [{ id: 'scm_conflict', name: 'other', localPath: '/var/p4', workspacesPath: null }],
      },
    )

    bootstrapFromEnv()
    await flush()
    expect(dbInsertRun).not.toHaveBeenCalled()
  })
})

describe('bootstrapScmGit — update path', () => {
  it('does not mutate an env:git row reserved for deletion', async () => {
    envMock.SCM_GIT_REPO_URL = 'https://example/repo.git'
    queueSelects({
      get: {
        id: 'scm_deleting',
        localPath: '/legacy/git',
        workspacesPath: '/legacy/git-worktrees',
        deletionRequestedAt: new Date('2026-08-13T00:00:00Z'),
      },
    })

    await bootstrapFromEnv()

    expect(updateChain.set).not.toHaveBeenCalled()
    expect(dbInsertRun).not.toHaveBeenCalled()
  })

  it('updates the existing env:git row in place', async () => {
    envMock.SCM_GIT_REPO_URL = 'https://example/repo.git'
    queueSelects({ get: { id: 'scm_g', localPath: '/var/git' } })

    bootstrapFromEnv()
    await flush()
    expect(dbUpdateRun).toHaveBeenCalledTimes(1)
    expect(dbInsertRun).not.toHaveBeenCalled()
  })

  /**
   * Every replica runs bootstrap at boot, and the update branch used to reset
   * syncStatus/initialSyncCompletedAt unconditionally. On PostgreSQL that let
   * replica B's boot release the sync busy-guard of a sync replica A was
   * mid-flight on, then start a second initial checkout into the same
   * directory. A row that already matches the environment gets no write at all.
   */
  it('leaves an env:git row untouched when config and paths already match the environment', async () => {
    envMock.SCM_GIT_REPO_URL = 'https://example/repo.git'
    queueSelects({
      get: {
        id: 'scm_g',
        localPath: '/var/git',
        workspacesPath: '/data/workspace/workspaces/scm_g',
        syncStatus: 'idle',
        codegraphStatus: 'idle',
        initialSyncCompletedAt: new Date(),
        config: {
          repoUrl: 'https://example/repo.git',
          branch: 'main',
          autoSync: true,
          syncIntervalMin: 30,
          initialSyncTimeoutMin: 60,
        },
      },
    })

    bootstrapFromEnv()
    await flush()

    expect(dbUpdateRun).not.toHaveBeenCalled()
    expect(dbInsertRun).not.toHaveBeenCalled()
  })

  /**
   * Flatten a drizzle SQL object to its raw text chunks. With this file's
   * string-mocked schema the bound values are not observable, but operators
   * are: the busy guard contributes exactly two `<>` comparisons
   * (`syncStatus <> 'syncing'`, `codegraphStatus <> 'indexing'`), and an
   * unguarded `eq(id)` where clause contributes none.
   */
  function sqlText(node: unknown, seen = new Set<object>()): string {
    if (!node || typeof node !== 'object' || seen.has(node as object)) return ''
    seen.add(node as object)
    let out = ''
    const value = (node as { value?: unknown }).value
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      out += value.join('')
    }
    for (const child of Object.values(node)) {
      out += sqlText(child, seen)
    }
    return out
  }

  // A workspacesPath-only pin skips the sync-state reset, but it must still
  // carry the busy predicate: another replica can begin a sync between this
  // replica's pre-read and its UPDATE, and an unguarded write would rewrite
  // the row underneath that sync. Pre-read and update predicate protect
  // together, or the invariant does not hold.
  it('guards a workspacesPath-only env:git update against a concurrent sync', async () => {
    envMock.SCM_GIT_REPO_URL = 'https://example/repo.git'
    queueSelects(
      {
        get: {
          id: 'scm_g',
          localPath: '/var/git',
          workspacesPath: null, // legacy row: the planner pins the default
          syncStatus: 'idle',
          codegraphStatus: 'idle',
          initialSyncCompletedAt: new Date(),
          config: {
            repoUrl: 'https://example/repo.git',
            branch: 'main',
            autoSync: true,
            syncIntervalMin: 30,
            initialSyncTimeoutMin: 60,
          },
        },
      },
      { all: [] }, // planner peers
      { all: [] }, // no durable workload lease
    )

    bootstrapFromEnv()
    await flush()

    expect(dbUpdateRun).toHaveBeenCalledTimes(1)
    // No sync-state reset for a pure path pin...
    expect(updateChain.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ syncStatus: 'idle' }),
    )
    // ...but the where clause still refuses a row a peer replica acquired:
    // both busy predicates (`syncStatus <> ...`, `codegraphStatus <> ...`).
    const whereArg = dbUpdateRun.mock.calls[0][0]
    expect(sqlText(whereArg).match(/<>/g)?.length ?? 0).toBe(2)
  })

  // A durable workload lease means a Run or Evaluation still has this
  // source's checkout as cwd — possibly on another replica. Re-pointing the
  // env source's paths in that window leaves the lease protecting the old
  // directory while sync and cleanup operate on the new one.
  it('defers an env:git update while a durable workload lease pins the source', async () => {
    envMock.SCM_GIT_REPO_URL = 'https://example/repo.git'
    envMock.SCM_GIT_LOCAL_PATH = '/var/git-moved'
    queueSelects(
      {
        get: {
          id: 'scm_g',
          localPath: '/var/git',
          workspacesPath: '/data/workspace/workspaces/scm_g',
          syncStatus: 'idle',
          codegraphStatus: 'idle',
          config: {
            repoUrl: 'https://example/repo.git',
            branch: 'main',
            autoSync: true,
            syncIntervalMin: 30,
            initialSyncTimeoutMin: 60,
          },
        },
      },
      { all: [] }, // planner peers
      { get: { type: 'run', id: 'run_active', agentId: 'agt_1' } }, // durable lease
    )

    bootstrapFromEnv()
    await flush()

    expect(dbUpdateRun).not.toHaveBeenCalled()
  })

  it('defers an env:git update while another replica is syncing the row', async () => {
    envMock.SCM_GIT_REPO_URL = 'https://changed.example/repo.git'
    queueSelects({
      get: {
        id: 'scm_g',
        localPath: '/var/git',
        workspacesPath: '/data/workspace/workspaces/scm_g',
        syncStatus: 'syncing',
        codegraphStatus: 'idle',
        config: {
          repoUrl: 'https://example/repo.git',
          branch: 'main',
          autoSync: true,
          syncIntervalMin: 30,
          initialSyncTimeoutMin: 60,
        },
      },
    })

    bootstrapFromEnv()
    await flush()

    // The env change waits for the next boot rather than resetting the state
    // of a checkout another process is actively writing.
    expect(dbUpdateRun).not.toHaveBeenCalled()
  })

  it('leaves an env:p4 row untouched when config and paths already match the environment', async () => {
    envMock.SCM_P4_PORT = '1666'
    envMock.SCM_P4_USER = 'admin'
    envMock.SCM_P4_CLIENT = 'workspace'
    queueSelects({
      get: {
        id: 'scm_p',
        localPath: '/var/p4',
        workspacesPath: '/data/workspace/workspaces/scm_p',
        syncStatus: 'idle',
        codegraphStatus: 'idle',
        initialSyncCompletedAt: new Date(),
        config: {
          p4port: '1666',
          p4user: 'admin',
          p4passwd: '',
          p4client: 'workspace',
          autoSync: true,
          syncIntervalMin: 30,
          initialSyncTimeoutMin: 60,
        },
      },
    })

    bootstrapFromEnv()
    await flush()

    expect(dbUpdateRun).not.toHaveBeenCalled()
    expect(dbInsertRun).not.toHaveBeenCalled()
  })

  it('skips when local path conflict points to a different row', async () => {
    envMock.SCM_GIT_REPO_URL = 'https://example/repo.git'
    envMock.SCM_GIT_LOCAL_PATH = '/new/path'

    queueSelects(
      { get: { id: 'scm_g', localPath: '/old/path' } },
      {
        all: [{ id: 'scm_other', name: 'other', localPath: '/new/path', workspacesPath: null }],
      },
    )

    bootstrapFromEnv()
    await flush()
    expect(dbUpdateRun).not.toHaveBeenCalled()
  })

  it('skips on insert path when localPath is taken', async () => {
    envMock.SCM_GIT_REPO_URL = 'https://example/repo.git'
    queueSelects(
      { get: undefined },
      {
        all: [{ id: 'scm_other', name: 'other', localPath: '/var/git', workspacesPath: null }],
      },
    )

    bootstrapFromEnv()
    await flush()
    expect(dbInsertRun).not.toHaveBeenCalled()
  })
})
