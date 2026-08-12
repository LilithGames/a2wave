import { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  // `db/transaction.js` reads these at module load to pick a backend, and its
  // SQLite branch drives BEGIN/COMMIT on the raw handle. Without a stand-in
  // handle every transactional route throws before its own mocks are consulted.
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  agents: { id: 'agents.id', name: 'agents.name', scmSourceId: 'agents.scmSourceId' },
  scmSources: {
    id: 'scmSources.id',
    localPath: 'scmSources.localPath',
    isEnabled: 'scmSources.isEnabled',
    userId: 'scmSources.userId',
    createdAt: 'scmSources.createdAt',
    syncStatus: 'scmSources.syncStatus',
    codegraphStatus: 'scmSources.codegraphStatus',
  },
  runs: { id: 'runs.id', workDir: 'runs.workDir', status: 'runs.status' },
  users: { id: 'users.id', role: 'users.role', isActive: 'users.isActive' },
  auditLogs: { id: 'auditLogs.id' },
}))

const { mockCreateScmSource } = vi.hoisted(() => ({
  mockCreateScmSource: vi.fn(),
}))
vi.mock('../../lib/scm-source.js', () => ({
  createScmSource: mockCreateScmSource,
}))

vi.mock('../../lib/owner-filter.js', () => ({
  getOwnerFilter: vi.fn(() => undefined),
  getCurrentUserId: vi.fn(() => 'usr_admin'),
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
}))

vi.mock('../../lib/id.js', () => ({
  createId: vi.fn(() => 'scm_test1'),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

vi.mock('../../lib/git-sync.js', () => ({
  checkGitConnection: vi.fn().mockResolvedValue({ ok: true, message: 'Connected' }),
}))

const { mockRunCodegraphIndex } = vi.hoisted(() => ({
  mockRunCodegraphIndex: vi.fn().mockResolvedValue({ ok: true, message: 'indexed' }),
}))
vi.mock('../../lib/codegraph-index.js', () => ({
  isCodegraphEnabled: (config: unknown) =>
    Boolean((config as { codegraphEnabled?: boolean } | null | undefined)?.codegraphEnabled),
  runCodegraphIndex: mockRunCodegraphIndex,
}))

vi.mock('../../lib/p4-sync.js', () => ({
  checkP4Connection: vi.fn().mockResolvedValue({ ok: true, message: 'Connected' }),
  startAutoSync: vi.fn(),
  stopAutoSync: vi.fn(),
  syncScmSource: vi.fn().mockResolvedValue({ ok: true }),
  isCheckoutBusy: vi.fn().mockReturnValue(false),
  tryAcquireCheckout: vi.fn().mockReturnValue(true),
  releaseCheckout: vi.fn(),
}))

vi.mock('@a2wave/shared', async () => {
  const actual = await vi.importActual<typeof import('@a2wave/shared')>('@a2wave/shared')
  return { ...actual }
})

function makeDbChain(result: unknown) {
  // An array result models a multi-row query, so it must NOT also expose `get`:
  // `asyncQuery` consults `get` first and would wrap the whole array as one row
  // — making an empty "no referencing agents" result read as a single hit.
  const whereResult = Array.isArray(result)
    ? { all: vi.fn().mockReturnValue(result) }
    : {
        get: vi.fn().mockReturnValue(result),
        all: vi.fn().mockReturnValue(result ? [result] : []),
      }
  return {
    from: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            ...whereResult,
            where: vi.fn().mockReturnValue(whereResult),
          }),
        ),
        all: vi.fn().mockReturnValue(Array.isArray(result) ? result : result ? [result] : []),
      }),
    ),
  }
}

function makeInsertChain(result?: unknown) {
  return {
    values: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi
              .fn()
              .mockReturnValue(result ?? { id: 'scm_test1', name: 'Test SCM', type: 'git' }),
          }),
        ),
        run: vi.fn(),
      }),
    ),
  }
}

function makeUpdateChain(
  result: unknown = { id: 'scm_test1', name: 'Updated', isEnabled: true, config: {} },
) {
  return {
    set: vi.fn().mockReturnValue(
      asyncQuery({
        where: vi.fn().mockReturnValue(
          asyncQuery({
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue(result),
              }),
            ),
            run: vi.fn(),
          }),
        ),
      }),
    ),
  }
}

function makeDeleteChain(result?: unknown) {
  return {
    where: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result ?? { id: 'scm_test1' }),
          }),
        ),
      }),
    ),
  }
}

import { db } from '../../db/client.js'
import { logAudit } from '../../lib/audit.js'
import {
  isCheckoutBusy,
  releaseCheckout,
  syncScmSource,
  tryAcquireCheckout,
} from '../../lib/p4-sync.js'

import { asyncQuery } from '../../test/async-query.js'

describe('SCM Sources routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../scm-sources.js')
    app = new Hono()
    // Production authMiddleware injects userRole; tests default to admin so
    // path-validation behavior matches the privileged route branch.
    app.use('*', async (c, next) => {
      c.set('userRole' as never, (c.req.header('x-test-role') ?? 'admin') as never)
      await next()
    })
    app.route('/api/scm-sources', mod.default)
  })

  describe('GET /', () => {
    it('returns all SCM sources', async () => {
      const sources = [{ id: 'scm_1', name: 'Source1' }]
      ;(db.select as Mock)
        .mockReturnValueOnce(
          asyncQuery({
            from: vi.fn().mockReturnValue({
              where: vi
                .fn()
                .mockReturnValue(
                  asyncQuery({ get: vi.fn().mockReturnValue({ count: sources.length }) }),
                ),
            }),
          }),
        )
        .mockReturnValueOnce(
          asyncQuery({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi
                      .fn()
                      .mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(sources) })),
                  }),
                }),
              }),
            }),
          }),
        )

      const res = await app.request('/api/scm-sources')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data).toEqual(sources)
    })

    it('masks credentials for every row in the list (admin dump protection)', async () => {
      const sources = [
        {
          id: 'scm_1',
          name: 'P4',
          type: 'p4',
          config: { type: 'p4', p4port: 'h:1666', p4user: 'u', p4passwd: 'pw1', p4client: 'c' },
        },
        {
          id: 'scm_2',
          name: 'Git',
          type: 'git',
          config: { type: 'git', repoUrl: 'https://github.com/o/r.git', pat: 'ghp_tok' },
        },
      ]
      ;(db.select as Mock)
        .mockReturnValueOnce(
          asyncQuery({
            from: vi.fn().mockReturnValue({
              where: vi
                .fn()
                .mockReturnValue(
                  asyncQuery({ get: vi.fn().mockReturnValue({ count: sources.length }) }),
                ),
            }),
          }),
        )
        .mockReturnValueOnce(
          asyncQuery({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockReturnValue({
                  limit: vi.fn().mockReturnValue({
                    offset: vi
                      .fn()
                      .mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue(sources) })),
                  }),
                }),
              }),
            }),
          }),
        )

      const res = await app.request('/api/scm-sources')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: Array<{ config: Record<string, string> }> }
      expect(body.data[0].config.p4passwd).toBe('********')
      expect(body.data[1].config.pat).toBe('********')
    })
  })

  describe('GET /:id', () => {
    it('returns a source by id', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'scm_1', name: 'Source1' }))

      const res = await app.request('/api/scm-sources/scm_1')
      expect(res.status).toBe(200)
    })

    it('masks git pat and repoUrl credentials on read (even for admin)', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'scm_1',
          name: 'Repo',
          type: 'git',
          config: {
            type: 'git',
            repoUrl: 'https://alice:ghp_secret@github.com/org/repo.git',
            branch: 'main',
            pat: 'ghp_realtoken',
          },
        }),
      )

      const res = await app.request('/api/scm-sources/scm_1')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { config: { pat: string; repoUrl: string } } }
      expect(body.data.config.pat).toBe('********')
      expect(body.data.config.repoUrl).not.toContain('ghp_secret')
    })

    it('masks p4passwd on read (even for admin)', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'scm_1',
          name: 'P4',
          type: 'p4',
          config: {
            type: 'p4',
            p4port: 'localhost:1666',
            p4user: 'admin',
            p4passwd: 'super-secret',
            p4client: 'ws',
          },
        }),
      )

      const res = await app.request('/api/scm-sources/scm_1')
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { config: { p4passwd: string; p4user: string } } }
      expect(body.data.config.p4passwd).toBe('********')
      // Non-secret fields survive.
      expect(body.data.config.p4user).toBe('admin')
    })

    it('returns 404 for non-existent source', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/scm-sources/scm_none')
      expect(res.status).toBe(404)
    })
  })

  describe('POST /', () => {
    it('creates a git source with valid input', async () => {
      // Mock localPath uniqueness check returning no conflict
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))
      ;(db.insert as Mock).mockReturnValue(makeInsertChain())

      const res = await app.request('/api/scm-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'My Repo',
          type: 'git',
          localPath: '/data/repos/my-repo',
          config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        }),
      })

      expect(res.status).toBe(201)
    })

    it('returns 400 for relative localPath', async () => {
      const res = await app.request('/api/scm-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad Path',
          type: 'git',
          localPath: 'relative/path',
          config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        }),
      })

      expect(res.status).toBe(400)
    })

    it('returns 400 when a custom workspacesPath is outside operator-approved roots', async () => {
      const res = await app.request('/api/scm-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-role': 'user' },
        body: JSON.stringify({
          name: 'Unsafe Workspaces Root',
          type: 'git',
          localPath: '/data/repos/unsafe-root',
          workspacesPath: '/opt/unapproved-worktrees/source-a',
          config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        }),
      })

      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringContaining('SCM_WORKSPACES_ALLOWED_ROOTS'),
      })
    })

    it('preserves admin ability to select a dedicated custom root outside the allowlist', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))
      ;(db.insert as Mock).mockReturnValue(makeInsertChain())

      const res = await app.request('/api/scm-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Admin Custom Root',
          type: 'git',
          localPath: '/data/repos/admin-custom-root',
          workspacesPath: '/srv/admin-selected-worktrees/source-a',
          config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        }),
      })

      expect(res.status).toBe(201)
    })

    it('returns 400 for invalid input', async () => {
      const res = await app.request('/api/scm-sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      expect(res.status).toBe(400)
    })
  })

  describe('DELETE /:id', () => {
    it('deletes a source with no agent references', async () => {
      // First select: find source; Second select: find referencing agents (empty)
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', name: 'Source' }))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain())

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })
      expect(res.status).toBe(200)
    })

    it('returns 404 for non-existent source', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/scm-sources/scm_none', { method: 'DELETE' })
      expect(res.status).toBe(404)
    })

    it('returns 409 when agents reference the source', async () => {
      const agents = [{ id: 'agt_1', name: 'Agent1' }]
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', name: 'Source' }))
        .mockReturnValueOnce(
          asyncQuery({
            from: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue(
                asyncQuery({
                  all: vi.fn().mockReturnValue(agents),
                  get: vi.fn().mockReturnValue(agents[0]),
                }),
              ),
            }),
          }),
        )

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })
      expect(res.status).toBe(409)
    })
  })

  describe('PATCH /:id', () => {
    it('resets sync state when localPath changes', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/old/path',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        initialSyncCompletedAt: new Date(),
        syncStatus: 'idle',
        lastSyncAt: new Date(),
        lastSyncError: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain(undefined))
      const updateChain = makeUpdateChain({
        ...existingSource,
        localPath: '/new/path',
        initialSyncCompletedAt: null,
        syncStatus: 'idle',
        lastSyncAt: null,
        lastSyncError: null,
      })
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: '/new/path' }),
      })

      expect(res.status).toBe(200)
      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>
      expect(setCall.initialSyncCompletedAt).toBeNull()
      expect(setCall.syncStatus).toBe('idle')
      expect(setCall.lastSyncAt).toBeNull()
      expect(setCall.lastSyncError).toBeNull()
    })

    it('refuses to reset sync state while a sync is in progress', async () => {
      // Resetting syncStatus to 'idle' here would release a lock this request
      // does not hold, letting POST /:id/sync acquire and start a second sync
      // against the same working directory.
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/old/path',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        initialSyncCompletedAt: null,
        syncStatus: 'syncing',
        lastSyncAt: new Date(),
        lastSyncError: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain(undefined))
      const updateChain = makeUpdateChain(existingSource)
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: '/new/path' }),
      })

      expect(res.status).toBe(409)
      expect(updateChain.set).not.toHaveBeenCalled()
    })

    it('returns 409 when the checkout is busy with post-sync work even though syncStatus is idle', async () => {
      // Finding #2: syncStatus returned to idle but setup/index still writes the
      // old localPath. Changing localPath/config now would let that job finish
      // writing the wrong tree — PATCH must refuse via isCheckoutBusy.
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/old/path',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        initialSyncCompletedAt: new Date(),
        syncStatus: 'idle',
        lastSyncAt: new Date(),
        lastSyncError: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValue(makeDbChain(undefined))
      const updateChain = makeUpdateChain(existingSource)
      ;(db.update as Mock).mockReturnValue(updateChain)
      ;(isCheckoutBusy as Mock).mockReturnValueOnce(true)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: '/new/path' }),
      })

      expect(res.status).toBe(409)
      expect(updateChain.set).not.toHaveBeenCalled()
    })

    it('returns 409 when a sync acquires the row between the guard read and the update', async () => {
      // TOCTOU: `existing` is read as idle (fast-path guard passes), but a
      // concurrent sync flips the row to syncing during `await c.req.json()`.
      // The atomic UPDATE (ne syncStatus 'syncing') then matches no row and
      // .returning().get() yields undefined — the route must still 409 rather
      // than silently drop the write and reopen the concurrent-sync gap.
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/old/path',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        initialSyncCompletedAt: null,
        syncStatus: 'idle', // stale read — the guard's fast-path lets it through
        lastSyncAt: new Date(),
        lastSyncError: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValue(makeDbChain(undefined))
      // Atomic UPDATE matches nothing because the row is now 'syncing'.
      // Pass null (not undefined, which would trigger makeUpdateChain's default).
      const updateChain = makeUpdateChain(null)
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: '/new/path' }),
      })

      expect(res.status).toBe(409)
    })

    it('resets sync state when config changes', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/repos',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/old.git', branch: 'main' },
        initialSyncCompletedAt: new Date(),
      }
      ;(db.select as Mock).mockReturnValueOnce(makeDbChain(existingSource))
      const updateChain = makeUpdateChain({
        ...existingSource,
        config: { type: 'git', repoUrl: 'https://github.com/org/new.git', branch: 'main' },
      })
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { type: 'git', repoUrl: 'https://github.com/org/new.git', branch: 'main' },
        }),
      })

      expect(res.status).toBe(200)
      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>
      expect(setCall.initialSyncCompletedAt).toBeNull()
      expect(setCall.syncStatus).toBe('idle')
    })

    it('keeps the stored p4passwd when the masked sentinel is submitted back', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'P4',
        localPath: '/data/p4',
        isEnabled: true,
        // Realistic stored config: went through schema parse on create, so it
        // carries the same default keys the PATCH parse will produce.
        config: {
          type: 'p4',
          p4port: 'h:1666',
          p4user: 'u',
          p4passwd: 'real-pw',
          p4client: 'c',
          autoSync: false,
          syncIntervalMin: 30,
          initialSyncTimeoutMin: 60,
        },
        initialSyncCompletedAt: new Date(),
        syncStatus: 'idle',
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain(undefined))
      const updateChain = makeUpdateChain(existingSource)
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            type: 'p4',
            p4port: 'h:1666',
            p4user: 'u',
            p4passwd: '********',
            p4client: 'c',
          },
        }),
      })

      expect(res.status).toBe(200)
      const setCall = updateChain.set.mock.calls[0][0] as { config: { p4passwd: string } }
      // The masked round-trip must restore the real secret, never persist '********'.
      expect(setCall.config.p4passwd).toBe('real-pw')
      // And it must not read as a config change → no sync-state reset.
      expect((setCall as Record<string, unknown>).initialSyncCompletedAt).toBeUndefined()
    })

    it('masks credentials in the PATCH response (no plaintext exfil via update)', async () => {
      // P2 regression: admin reads another user's masked SCM, PATCHes it back
      // unchanged, and must NOT get the real pat/p4passwd in the response.
      const existingSource = {
        id: 'scm_1',
        name: 'Git',
        localPath: '/data/git',
        isEnabled: true,
        config: {
          type: 'git',
          repoUrl: 'https://github.com/o/r.git',
          branch: 'main',
          pat: 'real-tok',
          autoSync: false,
          syncIntervalMin: 30,
          initialSyncTimeoutMin: 60,
        },
        syncStatus: 'idle',
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain(undefined))
      // The DB returns the row with the rehydrated real secret; the response must mask it.
      ;(db.update as Mock).mockReturnValue(makeUpdateChain({ ...existingSource }))

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      })

      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { config: { pat: string } } }
      expect(body.data.config.pat).toBe('********')
    })

    it('keeps the stored git pat when the masked sentinel is submitted back', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Git',
        localPath: '/data/git',
        isEnabled: true,
        config: {
          type: 'git',
          repoUrl: 'https://github.com/o/r.git',
          branch: 'main',
          pat: 'real-tok',
          autoSync: false,
          syncIntervalMin: 30,
          initialSyncTimeoutMin: 60,
        },
        initialSyncCompletedAt: new Date(),
        syncStatus: 'idle',
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain(undefined))
      const updateChain = makeUpdateChain(existingSource)
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            type: 'git',
            repoUrl: 'https://github.com/o/r.git',
            branch: 'main',
            pat: '********',
          },
        }),
      })

      expect(res.status).toBe(200)
      const setCall = updateChain.set.mock.calls[0][0] as { config: { pat: string } }
      expect(setCall.config.pat).toBe('real-tok')
      expect((setCall as Record<string, unknown>).initialSyncCompletedAt).toBeUndefined()
    })

    it('restores a masked repoUrl even after the directory was renamed (Codex P1)', async () => {
      // Directory-keyed matching would drop the credential; value matching keeps it.
      const existingSource = {
        id: 'scm_1',
        name: 'Git',
        localPath: '/data/git',
        isEnabled: true,
        config: {
          type: 'git',
          repoUrl: 'https://github.com/o/main.git',
          branch: 'main',
          autoSync: false,
          syncIntervalMin: 30,
          initialSyncTimeoutMin: 60,
          repos: [
            { repoUrl: 'https://u:realtok@github.com/o/a.git', branch: 'main', directory: 'old' },
          ],
        },
        initialSyncCompletedAt: new Date(),
        syncStatus: 'idle',
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain(undefined))
      const updateChain = makeUpdateChain(existingSource)
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            type: 'git',
            repoUrl: 'https://github.com/o/main.git',
            branch: 'main',
            repos: [
              // masked URL of repo 'old', directory renamed to 'renamed'
              {
                repoUrl: 'https://********@github.com/o/a.git',
                branch: 'main',
                directory: 'renamed',
              },
            ],
          },
        }),
      })

      expect(res.status).toBe(200)
      const setCall = updateChain.set.mock.calls[0][0] as {
        config: { repos: Array<{ repoUrl: string; directory: string }> }
      }
      expect(setCall.config.repos[0].repoUrl).toBe('https://u:realtok@github.com/o/a.git')
      expect(setCall.config.repos[0].directory).toBe('renamed')
    })

    it('rejects a masked repoUrl that matches no stored URL (Codex P1 — no corrupt persist)', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Git',
        localPath: '/data/git',
        isEnabled: true,
        config: {
          type: 'git',
          repoUrl: 'https://github.com/o/main.git',
          branch: 'main',
          autoSync: false,
          syncIntervalMin: 30,
          initialSyncTimeoutMin: 60,
        },
        syncStatus: 'idle',
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain(undefined))
      const updateChain = makeUpdateChain(existingSource)
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            type: 'git',
            // Sentinel URL for a host that isn't the stored one → unrecoverable.
            repoUrl: 'https://********@elsewhere.com/o/x.git',
            branch: 'main',
          },
        }),
      })

      expect(res.status).toBe(400)
      // Must NOT have persisted the corrupt sentinel.
      expect(updateChain.set).not.toHaveBeenCalled()
    })

    it('does not reset sync state when only name changes', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Old Name',
        localPath: '/data/repos',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        initialSyncCompletedAt: new Date(),
      }
      ;(db.select as Mock).mockReturnValueOnce(makeDbChain(existingSource))
      const updateChain = makeUpdateChain({ ...existingSource, name: 'New Name' })
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      })

      expect(res.status).toBe(200)
      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>
      expect(setCall.initialSyncCompletedAt).toBeUndefined()
    })

    it('rejects an unrelated update on a legacy non-admin unsafe workspace root', async () => {
      const existingSource = {
        id: 'scm_legacy',
        name: 'Legacy',
        localPath: '/data/repos/legacy',
        workspacesPath: '/legacy/custom/workspaces',
        userId: 'usr_user',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain({ role: 'user', isActive: true }))

      const updateChain = makeUpdateChain(existingSource)
      ;(db.update as Mock).mockReturnValue(updateChain)
      const res = await app.request('/api/scm-sources/scm_legacy', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Still legacy' }),
      })

      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/Unsafe saved workspacesPath/)
      expect(updateChain.set).not.toHaveBeenCalled()
    })

    it('keeps an active admin-owned custom workspace root compatible on unrelated updates', async () => {
      const existingSource = {
        id: 'scm_admin',
        name: 'Admin source',
        localPath: '/data/repos/admin',
        workspacesPath: '/srv/admin-selected/workspaces',
        userId: 'usr_admin',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain({ role: 'admin', isActive: true }))
        .mockReturnValueOnce(makeDbChain([existingSource]))
      const updateChain = makeUpdateChain({ ...existingSource, name: 'Renamed' })
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_admin', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed' }),
      })

      expect(res.status).toBe(200)
      expect(updateChain.set).toHaveBeenCalled()
    })

    it('清空 workspacesPath 时也用默认路径校验 — 不能绕过跨源 overlap', async () => {
      // PATCH { workspacesPath: null } 运行时会落到 defaultWorkspacesPath(id)。
      // 如果另一 source 已经占住这个默认目录，清空操作必须被 409 挡住，
      // 不能因为字段变成 null 就跳过 overlap 检查。
      const { defaultWorkspacesPath } = await import('../../lib/git-workspace.js')
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/repos',
        workspacesPath: '/ws/explicit', // 当前显式路径
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
      }
      const otherSource = {
        id: 'scm_2',
        name: 'Squatter',
        workspacesPath: defaultWorkspacesPath('scm_1'), // 另一 source 占住了 scm_1 的默认目录
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource)) // by id
        .mockReturnValueOnce(makeDbChain([otherSource])) // allSources for overlap

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacesPath: null }),
      })

      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string }
      expect(body.error).toMatch(/Squatter/)
    })

    it('does not reset sync state when localPath is same', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/repos',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        initialSyncCompletedAt: new Date(),
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain(existingSource))
      const updateChain = makeUpdateChain(existingSource)
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: '/data/repos' }),
      })

      expect(res.status).toBe(200)
      const setCall = updateChain.set.mock.calls[0][0] as Record<string, unknown>
      expect(setCall.initialSyncCompletedAt).toBeUndefined()
    })
  })

  describe('POST /:id/sync', () => {
    it('returns 404 for non-existent source', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/scm-sources/scm_none/sync', { method: 'POST' })
      expect(res.status).toBe(404)
    })

    it('returns 409 when already syncing', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'scm_1', syncStatus: 'syncing' }))
      ;(db.update as Mock).mockReturnValueOnce(
        asyncQuery({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockReturnValue(
                asyncQuery({
                  get: vi.fn().mockReturnValue(undefined),
                }),
              ),
            }),
          }),
        }),
      )

      const res = await app.request('/api/scm-sources/scm_1/sync', { method: 'POST' })
      expect(res.status).toBe(409)
    })

    it('starts sync for a saved custom root without requiring the path to be changed', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'scm_1',
          syncStatus: 'idle',
          workspacesPath: '/legacy/custom/workspaces',
        }),
      )
      ;(db.update as Mock).mockReturnValue(makeUpdateChain())

      const res = await app.request('/api/scm-sources/scm_1/sync', { method: 'POST' })
      expect(res.status).toBe(202)
      // The route holds both the status CAS and the checkout lock; syncScmSource
      // must re-acquire neither.
      expect(syncScmSource).toHaveBeenCalledWith('scm_1', {
        statusAlreadyAcquired: true,
        checkoutAlreadyAcquired: true,
      })
    })

    it('rolls back the status and 409s when the checkout is still busy with post-sync work', async () => {
      // syncStatus has returned to idle, but CodeGraph indexing
      // is still writing the checkout — a manual sync must not start, and the
      // status CAS it just did must be rolled back.
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'scm_1', syncStatus: 'idle' }))
      const updateChain = makeUpdateChain({ id: 'scm_1' })
      ;(db.update as Mock).mockReturnValue(updateChain)
      ;(tryAcquireCheckout as Mock).mockReturnValueOnce(false)

      const res = await app.request('/api/scm-sources/scm_1/sync', { method: 'POST' })
      expect(res.status).toBe(409)
      expect(syncScmSource).not.toHaveBeenCalled()
      // Rolled the syncStatus CAS back to idle.
      const rollback = updateChain.set.mock.calls.at(-1)?.[0] as Record<string, unknown>
      expect(rollback.syncStatus).toBe('idle')
    })
  })

  describe('POST /:id/check', () => {
    it('checks git connection', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'scm_1',
          type: 'git',
          config: { repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        }),
      )

      const res = await app.request('/api/scm-sources/scm_1/check', { method: 'POST' })
      expect(res.status).toBe(200)
    })

    it('checks p4 connection', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'scm_1',
          type: 'p4',
          config: { p4port: 'localhost:1666', p4user: 'admin', p4client: 'ws' },
        }),
      )

      const res = await app.request('/api/scm-sources/scm_1/check', { method: 'POST' })
      expect(res.status).toBe(200)
    })

    it('returns 400 for unsupported type', async () => {
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'scm_1',
          type: 'svn',
          config: {},
        }),
      )

      const res = await app.request('/api/scm-sources/scm_1/check', { method: 'POST' })
      expect(res.status).toBe(400)
    })
  })

  describe('GET /:id/status', () => {
    it('returns sync status', async () => {
      const initialSyncCompletedAt = new Date()
      const codegraphLastIndexedAt = new Date()
      ;(db.select as Mock).mockReturnValue(
        makeDbChain({
          id: 'scm_1',
          syncStatus: 'idle',
          lastSyncAt: null,
          lastSyncError: null,
          initialSyncCompletedAt,
          codegraphStatus: 'idle',
          codegraphLastIndexedAt,
          codegraphLastError: null,
        }),
      )

      const res = await app.request('/api/scm-sources/scm_1/status')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.data.syncStatus).toBe('idle')
      expect(body.data.initialSyncCompletedAt).toBe(initialSyncCompletedAt.toISOString())
      expect(body.data.codegraphStatus).toBe('idle')
      expect(body.data.codegraphLastIndexedAt).toBe(codegraphLastIndexedAt.toISOString())
      expect(body.data.codegraphLastError).toBeNull()
    })

    it('returns 404 for non-existent source', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/scm-sources/scm_none/status')
      expect(res.status).toBe(404)
    })

    it('rejects status reads for a legacy non-admin unsafe workspace root', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(
          makeDbChain({
            id: 'scm_legacy',
            type: 'git',
            userId: 'usr_owner',
            workspacesPath: '/legacy/custom/workspaces',
            syncStatus: 'idle',
          }),
        )
        .mockReturnValueOnce(makeDbChain({ role: 'user', isActive: true }))

      const res = await app.request('/api/scm-sources/scm_legacy/status')

      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/Unsafe saved workspacesPath/)
    })

    describe('POST /:id/codegraph/reindex', () => {
      it('starts CodeGraph indexing for an enabled source', async () => {
        ;(db.select as Mock).mockReturnValue(
          makeDbChain({
            id: 'scm_1',
            type: 'git',
            config: {
              type: 'git',
              repoUrl: 'https://github.com/org/repo.git',
              codegraphEnabled: true,
            },
            codegraphStatus: 'idle',
          }),
        )
        ;(db.update as Mock).mockReturnValue(makeUpdateChain({ id: 'scm_1' }))
        mockRunCodegraphIndex.mockReturnValueOnce(new Promise(() => {}))

        const res = await app.request('/api/scm-sources/scm_1/codegraph/reindex', {
          method: 'POST',
        })

        expect(res.status).toBe(202)
        expect(logAudit).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            action: 'scm_source.codegraph.reindex',
            resource: 'scm_source',
            resourceId: 'scm_1',
          }),
        )
        expect(mockRunCodegraphIndex).toHaveBeenCalledWith('scm_1', { alreadyAcquired: true })
      })

      it('returns 400 when CodeGraph is disabled', async () => {
        ;(db.select as Mock).mockReturnValue(
          makeDbChain({
            id: 'scm_1',
            type: 'git',
            config: { type: 'git', repoUrl: 'https://github.com/org/repo.git' },
            codegraphStatus: 'idle',
          }),
        )

        const res = await app.request('/api/scm-sources/scm_1/codegraph/reindex', {
          method: 'POST',
        })

        expect(res.status).toBe(400)
        expect(mockRunCodegraphIndex).not.toHaveBeenCalled()
      })

      it('returns 409 when the atomic CodeGraph lock is already held', async () => {
        ;(db.select as Mock).mockReturnValue(
          makeDbChain({
            id: 'scm_1',
            type: 'git',
            config: {
              type: 'git',
              repoUrl: 'https://github.com/org/repo.git',
              codegraphEnabled: true,
            },
            codegraphStatus: 'idle',
          }),
        )
        ;(db.update as Mock).mockReturnValue(makeUpdateChain(null))

        const res = await app.request('/api/scm-sources/scm_1/codegraph/reindex', {
          method: 'POST',
        })

        expect(res.status).toBe(409)
        expect(mockRunCodegraphIndex).not.toHaveBeenCalled()
      })

      it('returns 409 when a sync is currently using the checkout', async () => {
        // A sync (or its post-sync work) holds the checkout even though
        // codegraphStatus is idle — indexing must not run over a moving tree.
        ;(db.select as Mock).mockReturnValue(
          makeDbChain({
            id: 'scm_1',
            type: 'git',
            config: {
              type: 'git',
              repoUrl: 'https://github.com/org/repo.git',
              codegraphEnabled: true,
            },
            codegraphStatus: 'idle',
          }),
        )
        ;(isCheckoutBusy as Mock).mockReturnValueOnce(true)

        const res = await app.request('/api/scm-sources/scm_1/codegraph/reindex', {
          method: 'POST',
        })

        expect(res.status).toBe(409)
        expect(mockRunCodegraphIndex).not.toHaveBeenCalled()
      })

      it('holds and releases the checkout lock around the index run', async () => {
        ;(db.select as Mock).mockReturnValue(
          makeDbChain({
            id: 'scm_1',
            type: 'git',
            config: {
              type: 'git',
              repoUrl: 'https://github.com/org/repo.git',
              codegraphEnabled: true,
            },
            codegraphStatus: 'idle',
          }),
        )
        ;(db.update as Mock).mockReturnValue(makeUpdateChain({ id: 'scm_1' }))
        mockRunCodegraphIndex.mockResolvedValueOnce({ ok: true, message: 'indexed' })

        const res = await app.request('/api/scm-sources/scm_1/codegraph/reindex', {
          method: 'POST',
        })

        expect(res.status).toBe(202)
        expect(tryAcquireCheckout).toHaveBeenCalledWith('scm_1')
        // The .finally() releasing the lock runs after the fire-and-forget job.
        await vi.waitFor(() => expect(releaseCheckout).toHaveBeenCalledWith('scm_1'))
      })

      it('rolls back the DB status and 409s when the checkout is grabbed between acquires', async () => {
        // codegraphStatus CAS succeeds, but a sync takes the checkout before
        // tryAcquireCheckout — the route must not start indexing, and must
        // release the DB status it just set.
        ;(db.select as Mock).mockReturnValue(
          makeDbChain({
            id: 'scm_1',
            type: 'git',
            config: {
              type: 'git',
              repoUrl: 'https://github.com/org/repo.git',
              codegraphEnabled: true,
            },
            codegraphStatus: 'idle',
          }),
        )
        const updateChain = makeUpdateChain({ id: 'scm_1' })
        ;(db.update as Mock).mockReturnValue(updateChain)
        ;(tryAcquireCheckout as Mock).mockReturnValueOnce(false)

        const res = await app.request('/api/scm-sources/scm_1/codegraph/reindex', {
          method: 'POST',
        })

        expect(res.status).toBe(409)
        expect(mockRunCodegraphIndex).not.toHaveBeenCalled()
        // Rollback wrote codegraphStatus back to idle.
        const rollback = updateChain.set.mock.calls.at(-1)?.[0] as Record<string, unknown>
        expect(rollback.codegraphStatus).toBe('idle')
      })

      it('releases the checkout lock and resets status when audit logging throws', async () => {
        // logAudit does a synchronous insert that can fail. If it throws after
        // the checkout lock is held, the lock must still be released and the
        // status rolled back — otherwise the source is stuck in busyCheckouts.
        ;(db.select as Mock).mockReturnValue(
          makeDbChain({
            id: 'scm_1',
            type: 'git',
            config: {
              type: 'git',
              repoUrl: 'https://github.com/org/repo.git',
              codegraphEnabled: true,
            },
            codegraphStatus: 'idle',
          }),
        )
        const updateChain = makeUpdateChain({ id: 'scm_1' })
        ;(db.update as Mock).mockReturnValue(updateChain)
        ;(logAudit as Mock).mockImplementationOnce(() => {
          throw new Error('SQLITE_BUSY')
        })

        const res = await app.request('/api/scm-sources/scm_1/codegraph/reindex', {
          method: 'POST',
        })

        expect(res.status).toBe(500)
        expect(mockRunCodegraphIndex).not.toHaveBeenCalled()
        expect(releaseCheckout).toHaveBeenCalledWith('scm_1')
        const rollback = updateChain.set.mock.calls.at(-1)?.[0] as Record<string, unknown>
        expect(rollback.codegraphStatus).toBe('idle')
      })
    })
  })

  describe('GET /:id/workspaces', () => {
    it('returns 404 when source does not exist', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/scm-sources/scm_none/workspaces')
      expect(res.status).toBe(404)
    })

    it('returns 400 when source type does not support workspaces', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'scm_1', type: 'p4' }))
      mockCreateScmSource.mockReturnValue(null)

      const res = await app.request('/api/scm-sources/scm_1/workspaces')
      expect(res.status).toBe(400)
    })

    it('rejects listing workspaces for a legacy non-admin custom root until it is migrated', async () => {
      const source = {
        id: 'scm_1',
        type: 'git',
        localPath: '/data/repos',
        workspacesPath: '/legacy/custom/workspaces',
      }
      const workspaces = [
        {
          name: 'fix-bug',
          path: '/ws/fix-bug',
          repos: [{ directory: '', branch: 'feature', commit: 'abc123' }],
        },
        {
          name: 'review',
          path: '/ws/review',
          repos: [{ directory: '', branch: null, commit: 'def456' }],
        },
      ]
      ;(db.select as Mock).mockReturnValueOnce(makeDbChain(source))
      mockCreateScmSource.mockReturnValue({
        listWorkspaces: vi.fn().mockResolvedValue(workspaces),
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces')
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/Unsafe saved workspacesPath/)
      expect(mockCreateScmSource).not.toHaveBeenCalled()
    })

    it('lists workspaces for an active admin-owned custom root', async () => {
      const source = {
        id: 'scm_admin',
        type: 'git',
        localPath: '/data/repos',
        workspacesPath: '/srv/admin-selected/workspaces',
        userId: 'usr_admin',
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain({ role: 'admin', isActive: true }))
      mockCreateScmSource.mockReturnValue({ listWorkspaces: vi.fn().mockResolvedValue([]) })

      const res = await app.request('/api/scm-sources/scm_admin/workspaces')
      expect(res.status).toBe(200)
      expect((await res.json()).data).toEqual([])
    })

    /**
     * Regression: the occupancy lookup per workspace is async, and the handler
     * used to return the raw `.map(async …)` array. Serialising an array of
     * Promises yields `[{}, {}]` — every workspace field vanished and the
     * `occupied` flag the delete guard depends on was never present at all.
     */
    it('resolves the occupied flag for every workspace instead of serialising promises', async () => {
      const source = {
        id: 'scm_admin',
        type: 'git',
        localPath: '/data/repos',
        workspacesPath: '/srv/admin-selected/workspaces',
        userId: 'usr_admin',
      }
      const workspaces = [
        { name: 'fix-bug', path: '/ws/fix-bug', repos: [] },
        { name: 'review', path: '/ws/review', repos: [] },
      ]
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain({ role: 'admin', isActive: true }))
        // One run holds /ws/fix-bug; /ws/review is free.
        .mockReturnValueOnce(makeDbChain({ id: 'run_1' }))
        .mockReturnValueOnce(makeDbChain(undefined))
      mockCreateScmSource.mockResolvedValue({
        listWorkspaces: vi.fn().mockResolvedValue(workspaces),
      })

      const res = await app.request('/api/scm-sources/scm_admin/workspaces')
      expect(res.status).toBe(200)

      const { data } = (await res.json()) as {
        data: Array<{ name: string; path: string; occupied: boolean }>
      }
      expect(data).toEqual([
        { name: 'fix-bug', path: '/ws/fix-bug', repos: [], occupied: true },
        { name: 'review', path: '/ws/review', repos: [], occupied: false },
      ])
    })
  })

  describe('removed Setup Script route', () => {
    it('is no longer exposed', async () => {
      const res = await app.request('/api/scm-sources/scm_1/setup-script/run', { method: 'POST' })
      expect(res.status).toBe(404)
    })
  })

  describe('DELETE /:id/workspaces/:name', () => {
    it('returns 404 when source does not exist', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain(undefined))

      const res = await app.request('/api/scm-sources/scm_none/workspaces/fix-bug', {
        method: 'DELETE',
      })
      expect(res.status).toBe(404)
    })

    it('returns 400 when source type does not support workspaces', async () => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'scm_1', type: 'p4' }))
      mockCreateScmSource.mockReturnValue(null)

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })
      expect(res.status).toBe(400)
    })

    it('returns 409 when workspace is occupied', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' }))
        .mockReturnValueOnce(makeDbChain({ id: 'run_running' }))
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/workspaces/scm_1',
        removeWorkspace: vi.fn(),
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })
      expect(res.status).toBe(409)
    })

    it('keeps the branch when deleting a per-agent worktree, drops it otherwise', async () => {
      // The entry an operator actually clicks: an idle `agent-*` row must not
      // take the Agent's accumulated unmerged commits with it. The judgement is
      // an exact match against an Agent bound to this source, so a legacy
      // explicit workspace named `agent-refactor` keeps delete-branch semantics.
      const removeWorkspace = vi.fn()
      const runWithName = async (name: string) => {
        removeWorkspace.mockClear()
        ;(db.select as Mock)
          .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' })) // source
          .mockReturnValueOnce(makeDbChain(undefined)) // occupancy probe
          .mockReturnValueOnce(makeDbChain([{ id: 'agt_abc123def456ghi7' }])) // bound agents
        mockCreateScmSource.mockReturnValue({ wsRoot: '/workspaces/scm_1', removeWorkspace })
        const res = await app.request(`/api/scm-sources/scm_1/workspaces/${name}`, {
          method: 'DELETE',
        })
        expect(res.status).toBe(200)
        return removeWorkspace.mock.calls[0]
      }

      expect(await runWithName('agent-abc123def456ghi7')).toEqual([
        'agent-abc123def456ghi7',
        { keepBranches: true },
      ])
      expect(await runWithName('agent-refactor')).toEqual([
        'agent-refactor',
        { keepBranches: false },
      ])
    })

    it('keeps the branch of an orphaned per-agent worktree whose agent row is gone', async () => {
      // Agent deletion leaves an occupied worktree behind on purpose, so the
      // operator reclaims it here — after the row it would have matched against
      // is already deleted. Falling back to the shape test is what stops that
      // click from taking the unpushed commits with it.
      const removeWorkspace = vi.fn()
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' })) // source
        .mockReturnValueOnce(makeDbChain(undefined)) // occupancy probe
        .mockReturnValueOnce(makeDbChain([])) // no bound agents left
      mockCreateScmSource.mockReturnValue({ wsRoot: '/workspaces/scm_1', removeWorkspace })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/agent-abc123def456ghi7', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      expect(removeWorkspace).toHaveBeenCalledWith('agent-abc123def456ghi7', { keepBranches: true })
    })

    it.each([
      ['encoded-slash traversal', '/api/scm-sources/scm_1/workspaces/..%2Fevil'],
      ['encoded-slash absolute', '/api/scm-sources/scm_1/workspaces/%2Fetc%2Fpasswd'],
      ['whitespace', '/api/scm-sources/scm_1/workspaces/foo%20bar'],
      ['shell metachar', '/api/scm-sources/scm_1/workspaces/foo%3Bbar'],
    ])('returns 400 and does not remove for invalid name (%s)', async (_desc, url) => {
      ;(db.select as Mock).mockReturnValue(makeDbChain({ id: 'scm_1', type: 'git' }))
      const removeWorkspace = vi.fn()
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/workspaces/scm_1',
        removeWorkspace,
      })

      const res = await app.request(url, { method: 'DELETE' })
      expect(res.status).toBe(400)
      expect(removeWorkspace).not.toHaveBeenCalled()
    })

    it('rejects removing a workspace from a legacy non-admin custom root until migration', async () => {
      ;(db.select as Mock).mockReturnValueOnce(
        makeDbChain({
          id: 'scm_1',
          type: 'git',
          workspacesPath: '/legacy/custom/workspaces',
        }),
      )
      const removeWorkspace = vi.fn().mockResolvedValue(undefined)
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/legacy/custom/workspaces',
        removeWorkspace,
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/Unsafe saved workspacesPath/)
      expect(removeWorkspace).not.toHaveBeenCalled()
    })
  })
})
