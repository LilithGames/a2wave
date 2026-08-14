import { Hono } from 'hono'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'

/**
 * `withTransaction`'s SQLite branch drives BEGIN/COMMIT on the raw handle and
 * hands the callback the shared `db` — it never calls `db.transaction`. The
 * transaction boundary is therefore observed through this `exec` spy.
 */
const sqliteExec = vi.hoisted(() => vi.fn())

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
  sqliteDatabase: { inTransaction: false, exec: sqliteExec },
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
    deletionRequestedAt: 'scmSources.deletionRequestedAt',
    deletionRequestedBy: 'scmSources.deletionRequestedBy',
  },
  runs: { id: 'runs.id', workDir: 'runs.workDir', status: 'runs.status' },
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
    ownerInstanceId: 'scmWorkspaceRemovals.ownerInstanceId',
    attemptToken: 'scmWorkspaceRemovals.attemptToken',
    createdAt: 'scmWorkspaceRemovals.createdAt',
  },
  users: { id: 'users.id', role: 'users.role', isActive: 'users.isActive' },
  auditLogs: { id: 'auditLogs.id' },
}))

const { mockCreateScmSource } = vi.hoisted(() => ({
  mockCreateScmSource: vi.fn(),
}))
vi.mock('../../lib/scm-source.js', () => ({
  createScmSource: mockCreateScmSource,
}))

vi.mock('../../lib/scm-storage-reclaim.js', () => ({
  isolateManagedScmStorage: vi.fn().mockResolvedValue({
    isolated: [],
    blocked: [],
    commit: vi.fn().mockResolvedValue([]),
  }),
}))

vi.mock('../../lib/owner-filter.js', () => ({
  getOwnerFilter: vi.fn(() => undefined),
  getCurrentUserId: vi.fn(() => 'usr_admin'),
}))

vi.mock('../../lib/audit.js', () => ({
  logAudit: vi.fn(),
  writeAudit: vi.fn().mockResolvedValue(undefined),
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
  cancelInitialScmSync: vi.fn().mockResolvedValue(false),
  checkP4Connection: vi.fn().mockResolvedValue({ ok: true, message: 'Connected' }),
  startAutoSync: vi.fn(),
  startInitialScmSync: vi.fn().mockResolvedValue({ ok: true }),
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

function makeDeleteChain(result: unknown = { id: 'scm_test1' }) {
  return {
    where: vi.fn().mockReturnValue(
      asyncQuery({
        returning: vi.fn().mockReturnValue(
          asyncQuery({
            get: vi.fn().mockReturnValue(result),
          }),
        ),
      }),
    ),
  }
}

import { db } from '../../db/client.js'
import { logAudit, writeAudit } from '../../lib/audit.js'
import {
  cancelInitialScmSync,
  isCheckoutBusy,
  releaseCheckout,
  startInitialScmSync,
  syncScmSource,
  tryAcquireCheckout,
} from '../../lib/p4-sync.js'
import { isolateManagedScmStorage } from '../../lib/scm-storage-reclaim.js'

import { asyncQuery } from '../../test/async-query.js'

describe('SCM Sources routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    // clearAllMocks drops the factory's resolved value, and DELETE always awaits
    // this handle — without a default every delete test would reject on `commit`.
    ;(isolateManagedScmStorage as Mock).mockResolvedValue({
      isolated: [],
      blocked: [],
      commit: vi.fn().mockResolvedValue([]),
    })
    ;(writeAudit as Mock).mockResolvedValue(undefined)
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

    /**
     * A source whose deletion has been reserved is gone from the list and
     * rejects every write, so serving it here presents a live source that
     * 409s on any edit. The list filters it; this route must agree.
     *
     * Asserted on the predicate rather than the response because the db mock
     * returns its canned row regardless of the WHERE clause.
     */
    it('excludes a source reserved for deletion', async () => {
      const chain = makeDbChain({ id: 'scm_1', name: 'Source1' })
      const wherePredicates: unknown[] = []
      const from = chain.from as Mock
      const query = from()
      const originalWhere = query.where as Mock
      query.where = vi.fn((predicate: unknown) => {
        wherePredicates.push(predicate)
        return originalWhere(predicate)
      })
      from.mockReturnValue(query)
      ;(db.select as Mock).mockReturnValue(chain)

      await app.request('/api/scm-sources/scm_1')

      expect(JSON.stringify(wherePredicates)).toContain('deletionRequestedAt')
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

  it.each([
    ['POST', '/api/scm-sources/scm_1/check'],
    ['GET', '/api/scm-sources/scm_1/status'],
    ['GET', '/api/scm-sources/scm_1/workspaces'],
    ['DELETE', '/api/scm-sources/scm_1/workspaces/feature'],
  ])('%s %s excludes deletion-pending sources', async (method, url) => {
    const chain = makeDbChain({
      id: 'scm_1',
      type: 'unsupported',
      localPath: '/data/workspace/sources/1',
      config: {},
    })
    const wherePredicates: unknown[] = []
    const query = (chain.from as Mock)()
    const originalWhere = query.where as Mock
    query.where = vi.fn((predicate: unknown) => {
      wherePredicates.push(predicate)
      return originalWhere(predicate)
    })
    ;(chain.from as Mock).mockReturnValue(query)
    ;(db.select as Mock).mockReturnValueOnce(chain)

    await app.request(url, { method })

    expect(JSON.stringify(wherePredicates)).toContain('deletionRequestedAt')
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
    beforeEach(() => {
      ;(db.select as Mock).mockReturnValue(makeDbChain([]))
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({
          id: 'scm_1',
          name: 'Source',
          localPath: '/data/workspace/sources/1',
          workspacesPath: null,
          deletionRequestedAt: new Date(),
        }),
      )
    })
    it('deletes a source with no agent references', async () => {
      // First select: find source; Second select: find referencing agents (empty)
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', name: 'Source' }))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain())

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })
      expect(res.status).toBe(200)
    })

    // The Agent-reference scan is row state; the lease is the workload
    // authority, and they disagree exactly when a workload was admitted under a
    // binding that has since been released. The checkout is still that
    // process's cwd, so the source must refuse to die.
    it('returns 409 while a durable workload lease pins the source', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', name: 'Source' }))
        .mockReturnValueOnce(makeDbChain([])) // no referencing agents
        .mockReturnValueOnce(makeDbChain({ type: 'evaluation', id: 'evt_9', agentId: 'agt_1' }))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toMatch(/evaluation "evt_9"/)
      expect(isolateManagedScmStorage).not.toHaveBeenCalled()
      expect(db.delete).not.toHaveBeenCalled()
    })

    // A peer-blocked managed path must keep the reservation row. Deleting the
    // row anyway orphans a directory whose only name was derived from that
    // row's id — nothing can ever find or reclaim it again.
    it('keeps the deletion reservation when a managed path is blocked by a surviving peer', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ ...source, deletionRequestedAt: new Date() }),
      )
      const commit = vi.fn().mockResolvedValue([])
      ;(isolateManagedScmStorage as Mock).mockResolvedValueOnce({
        isolated: [],
        blocked: [{ path: source.localPath, peerId: 'scm_peer' }],
        commit,
      })

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: string; retryable: boolean }
      expect(body.retryable).toBe(true)
      expect(body.error).toMatch(/scm_peer/)
      // Neither the parked directories nor the row may be finalized: the
      // reservation is what lets a later retry name the blocked path.
      expect(commit).not.toHaveBeenCalled()
      expect(db.delete).not.toHaveBeenCalled()
    })

    it('cancels an automatic initial checkout before deleting the source', async () => {
      ;(cancelInitialScmSync as Mock).mockResolvedValueOnce(true)
      ;(db.select as Mock)
        .mockReturnValueOnce(
          makeDbChain({
            id: 'scm_1',
            name: 'Source',
            initialSyncCompletedAt: null,
            syncStatus: 'syncing',
          }),
        )
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain())

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(200)
      expect(cancelInitialScmSync).toHaveBeenCalledWith('scm_1')
    })

    // A managed checkout is named after the source id, so leaving it behind on
    // delete strands a clone nothing can identify or clean up afterwards.
    it('reclaims managed storage for the deleted source', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ ...source, deletionRequestedAt: new Date() }),
      )
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain(source))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(200)
      expect(isolateManagedScmStorage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'scm_1' }),
        expect.anything(),
      )
    })

    /**
     * The audit entry must be queued the moment the row is gone, not after the
     * reclaim. Reclaim recursively removes a whole checkout — seconds to minutes
     * on a large repository — and the row it describes no longer exists. A crash,
     * SIGKILL, or pod eviction inside that window left the source deleted with
     * nothing in the audit log ever recording it, which is an Iron Rule 5 breach:
     * "who deleted this" becomes permanently unanswerable.
     */
    it('writes the audit entry before reclaiming storage', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      const order: string[] = []
      ;(writeAudit as Mock).mockImplementationOnce(async () => {
        order.push('audit')
      })
      ;(isolateManagedScmStorage as Mock).mockImplementationOnce(async () => ({
        isolated: [],
        blocked: [],
        commit: async () => {
          order.push('reclaim')
          return []
        },
      }))
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain(source))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(200)
      expect(order).toEqual(['audit', 'reclaim'])
    })

    /**
     * The reported race. Reclaiming after the commit left the row deleted while
     * its directory still stood: a concurrent create could take the path
     * mutation lock, observe no peer, allocate the freed path and clone into it
     * — and the pending recursive delete then removed the NEW source's checkout.
     *
     * The reservation must commit before vacating, while the row still blocks
     * every allocator. Only after the parked copy is removed may phase two
     * delete the row and release its path reservation.
     */
    it('commits the deletion reservation before vacating the allocated path', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      const order: string[] = []
      sqliteExec.mockImplementation((sql: string) => {
        order.push(sql)
      })
      ;(db.delete as Mock).mockImplementation(() => {
        order.push('delete')
        return makeDeleteChain(source)
      })
      ;(db.update as Mock).mockImplementation(() => {
        order.push('reserve')
        return makeUpdateChain({ ...source, deletionRequestedAt: new Date() })
      })
      ;(isolateManagedScmStorage as Mock).mockImplementationOnce(async () => {
        order.push('isolate')
        return {
          isolated: [{ originalPath: source.localPath, isolatedPath: '/data/workspace/.r/x' }],
          blocked: [],
          commit: async () => {
            order.push('commit-delete')
            return [source.localPath]
          },
        }
      })
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(200)
      const firstCommit = order.indexOf('COMMIT')
      expect(order.indexOf('reserve')).toBeGreaterThanOrEqual(0)
      expect(firstCommit).toBeGreaterThan(order.indexOf('reserve'))
      expect(order.indexOf('isolate')).toBeGreaterThan(firstCommit)
      expect(order.indexOf('commit-delete')).toBeGreaterThan(order.indexOf('isolate'))
      expect(order.indexOf('delete')).toBeGreaterThan(order.indexOf('commit-delete'))
    })

    /**
     * Vacating must be judged against the rows that survive the delete, read
     * under the same lock. A legacy row can hold a worktree root nested inside
     * a peer's checkout; renaming it blindly would move the peer's live
     * directory out from under it.
     */
    it('passes the surviving peers to the isolation scan', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      const peer = {
        id: 'scm_2',
        name: 'Peer',
        localPath: '/data/workspace/sources/2',
        workspacesPath: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain([])) // no durable workload lease
        .mockReturnValueOnce(makeDbChain([])) // no pending workspace removal
        .mockReturnValueOnce(makeDbChain([peer]))
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain(source))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(200)
      expect(isolateManagedScmStorage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'scm_1' }),
        expect.objectContaining({ peers: [peer] }),
      )
    })

    /**
     * Ordering the audit before the reclaim shrank the loss window but did not
     * close it: the row delete and the audit insert were still two independent
     * writes, so a crash between them left the source gone with nothing
     * recording it. They must commit or roll back together — which is what
     * `withTransaction` gives, and what makes "who deleted this" always
     * answerable (Iron Rule 5).
     */
    it('commits each deletion state transition with its audit entry', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      const order: string[] = []
      sqliteExec.mockImplementation((sql: string) => {
        order.push(sql)
      })
      ;(db.delete as Mock).mockImplementation(() => {
        order.push('delete')
        return makeDeleteChain(source)
      })
      ;(db.update as Mock).mockImplementation(() => {
        order.push('reserve')
        return makeUpdateChain({ ...source, deletionRequestedAt: new Date() })
      })
      ;(writeAudit as Mock).mockImplementation(async (_context, entry) => {
        order.push(`audit:${entry.action}`)
      })
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(200)
      const begins = order.flatMap((step, index) => (step === 'BEGIN' ? [index] : []))
      const commits = order.flatMap((step, index) => (step === 'COMMIT' ? [index] : []))
      expect(begins).toHaveLength(2)
      expect(commits).toHaveLength(2)
      for (const [step, transaction] of [
        ['reserve', 0],
        ['audit:scm_source.request_deletion', 0],
        ['delete', 1],
        ['audit:scm_source.delete', 1],
      ] as const) {
        expect(order.indexOf(step)).toBeGreaterThan(begins[transaction] ?? -1)
        expect(order.indexOf(step)).toBeLessThan(commits[transaction] ?? Number.MAX_SAFE_INTEGER)
      }
    })

    it('rolls back the terminal row deletion when its audit insert fails', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
        deletionRequestedBy: 'usr_requester',
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ ...source, deletionRequestedAt: new Date() }),
      )
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain(source))
      ;(writeAudit as Mock)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('audit disk full'))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(500)
      expect(sqliteExec.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT', 'BEGIN'])
      expect(writeAudit).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'scm_source.delete',
          userId: 'usr_requester',
        }),
        expect.anything(),
      )
    })

    it('does not delete or reclaim storage when the durable audit insert fails', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain(source))
      ;(writeAudit as Mock).mockRejectedValueOnce(new Error('audit disk full'))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(500)
      expect(isolateManagedScmStorage).not.toHaveBeenCalled()
    })

    it('reports a retryable failure when storage isolation must be retried', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ ...source, deletionRequestedAt: new Date() }),
      )
      ;(isolateManagedScmStorage as Mock).mockRejectedValueOnce(
        new Error('Reclaim destination already exists'),
      )

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({
        error: 'SCM source deletion is pending; retry deletion later',
        retryable: true,
      })
      expect(db.delete).not.toHaveBeenCalled()
    })

    it('reports a retryable failure when recursive storage removal must be retried', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ ...source, deletionRequestedAt: new Date() }),
      )
      ;(isolateManagedScmStorage as Mock).mockResolvedValueOnce({
        isolated: [{ originalPath: source.localPath, isolatedPath: '/parked/source' }],
        blocked: [],
        commit: vi.fn().mockRejectedValue(new Error('EBUSY')),
      })

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({
        error: 'SCM source deletion is pending; retry deletion later',
        retryable: true,
      })
      expect(db.delete).not.toHaveBeenCalled()
    })

    /**
     * The reservation transaction is what makes deletion crash-safe, but the
     * audit entry inside it asserts a deletion that has not happened yet. When
     * reclaim then fails the route answers 503 and the row survives, so an
     * operator who never retries is left with a log entry claiming the source
     * was deleted. Record the reservation, and let the terminal entry follow the
     * row delete.
     */
    it('audits the reservation rather than the deletion when reclaim must be retried', async () => {
      const source = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(source))
        .mockReturnValueOnce(makeDbChain([]))
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ ...source, deletionRequestedAt: new Date() }),
      )
      ;(isolateManagedScmStorage as Mock).mockRejectedValueOnce(new Error('EBUSY'))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(503)
      const actions = (writeAudit as Mock).mock.calls.map((call) => call[1].action)
      expect(actions).toContain('scm_source.request_deletion')
      expect(actions).not.toContain('scm_source.delete')
    })

    it('hides sources reserved for deletion from the list', async () => {
      const pending = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/workspace/sources/1',
        workspacesPath: null,
        deletionRequestedAt: new Date(),
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain([{ count: 1 }]))
        .mockReturnValueOnce(makeDbChain([pending]))

      const res = await app.request('/api/scm-sources')
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.data).toHaveLength(0)
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

    it('returns 409 while the checkout is being synced or indexed', async () => {
      ;(db.select as Mock).mockReturnValueOnce(makeDbChain({ id: 'scm_1', name: 'Source' }))
      ;(isCheckoutBusy as Mock).mockReturnValueOnce(true)

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(409)
      expect(db.delete).not.toHaveBeenCalled()
    })

    it('returns 409 when a sync wins the atomic delete race', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', name: 'Source' }))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain([]))
      // The status change wins before phase-one can reserve the source.
      ;(db.update as Mock).mockReturnValueOnce(makeUpdateChain(null))

      const res = await app.request('/api/scm-sources/scm_1', { method: 'DELETE' })

      expect(res.status).toBe(409)
    })
  })

  describe('PATCH /:id', () => {
    it('refuses to mutate a source with a durable deletion reservation', async () => {
      ;(db.select as Mock).mockReturnValueOnce(
        makeDbChain({
          id: 'scm_1',
          name: 'Source',
          deletionRequestedAt: new Date(),
        }),
      )

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Changed while deleting' }),
      })

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'SCM source deletion is pending' })
      expect(db.update).not.toHaveBeenCalled()
    })

    it('cancels and waits for an automatic initial sync before repairing its config', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/repo',
        workspacesPath: null,
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://bad.example/repo.git', branch: 'main' },
        initialSyncCompletedAt: null,
        syncStatus: 'syncing',
      }
      ;(cancelInitialScmSync as Mock).mockResolvedValueOnce(true)
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain([])) // planner path peers
        // The stored-root backstop scans peers too, so it consumes its own read.
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain({ ...existingSource, syncStatus: 'error' }))
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({
          ...existingSource,
          config: { type: 'git', repoUrl: 'https://good.example/repo.git', branch: 'main' },
          syncStatus: 'idle',
        }),
      )

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { type: 'git', repoUrl: 'https://good.example/repo.git', branch: 'main' },
        }),
      })

      expect(res.status).toBe(200)
      expect(cancelInitialScmSync).toHaveBeenCalledWith('scm_1')
    })

    // Disabling a source must actually stop its background checkout. Cancelling
    // only inside the resetsSyncState branch left the clone running against a
    // source the operator believes is off, and re-enabling then started another.
    it('cancels a running initial checkout when the source is disabled', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        type: 'git',
        localPath: '/data/repo',
        workspacesPath: null,
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://slow.example/repo.git', branch: 'main' },
        initialSyncCompletedAt: null,
        syncStatus: 'syncing',
      }
      ;(cancelInitialScmSync as Mock).mockResolvedValueOnce(true)
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain([existingSource])) // planner path peers
        // The stored-root backstop scans peers too, so it consumes its own read.
        .mockReturnValueOnce(makeDbChain([existingSource]))
        .mockReturnValueOnce(makeDbChain({ ...existingSource, syncStatus: 'idle' }))
      ;(db.update as Mock).mockReturnValue(
        makeUpdateChain({ ...existingSource, isEnabled: false, syncStatus: 'idle' }),
      )

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: false }),
      })

      expect(res.status).toBe(200)
      expect(cancelInitialScmSync).toHaveBeenCalledWith('scm_1')
      // A disabled source must not be handed straight back to the scheduler.
      expect(startInitialScmSync).not.toHaveBeenCalled()
    })

    // DELETE refuses atomically while CodeGraph indexing holds the row; PATCH
    // must too. isCheckoutBusy is per-process in-memory state, so on a second
    // replica only the DB predicate stands between a localPath rewrite and an
    // indexer still reading the old tree.
    it('refuses a sync-state reset while CodeGraph indexing holds the row', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        type: 'git',
        localPath: '/old/path',
        workspacesPath: null,
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        initialSyncCompletedAt: new Date(),
        syncStatus: 'idle',
        codegraphStatus: 'indexing',
      }
      // The owner lookup is skipped: the route is admin, so the stored-root
      // backstop resolves without a users query. Queue only what is consumed —
      // a leftover Once would leak into the next test.
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain([existingSource])) // path peers
      // The atomic predicate matches no row, exactly as it would in the DB when
      // codegraphStatus is 'indexing'. An empty `all` models that; a `get`
      // returning undefined would fall through to the run-count placeholder.
      const updateChain = {
        set: vi.fn().mockReturnValue(
          asyncQuery({
            where: vi
              .fn()
              .mockReturnValue(
                asyncQuery({ returning: vi.fn().mockReturnValue(asyncQuery({ all: () => [] })) }),
              ),
          }),
        ),
      }
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: '/new/path' }),
      })

      expect(res.status).toBe(409)
    })

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

    // The sync/index busy guards cannot see an admitted Run or Evaluation —
    // and a lease deliberately outlives the workload's terminal status until
    // cleanup. Moving localPath in that window re-points the next sync at a
    // fresh checkout while the old process still writes the old directory.
    it('returns 409 for a path change while a durable workload lease pins the source', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/old/path',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        initialSyncCompletedAt: new Date(),
        syncStatus: 'idle',
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain([])) // planner peers
        .mockReturnValueOnce(makeDbChain([])) // stored-root validator peers
        .mockReturnValueOnce(makeDbChain({ type: 'run', id: 'run_active', agentId: 'agt_1' }))
      const updateChain = makeUpdateChain()
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath: '/new/path' }),
      })

      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toMatch(/run "run_active"/)
      expect(updateChain.set).not.toHaveBeenCalled()
    })

    it('returns 409 for a config-only topology change while a durable workload lease pins the source', async () => {
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        type: 'git',
        localPath: '/old/path',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
        initialSyncCompletedAt: new Date(),
        syncStatus: 'idle',
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain([])) // planner peers
        .mockReturnValueOnce(makeDbChain([])) // stored-root validator peers
        .mockReturnValueOnce(makeDbChain({ type: 'run', id: 'run_active', agentId: 'agt_1' }))
      const updateChain = makeUpdateChain()
      ;(db.update as Mock).mockReturnValue(updateChain)

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: {
            type: 'git',
            repoUrl: '',
            branch: 'main',
            repos: [
              {
                repoUrl: 'https://github.com/org/frontend.git',
                branch: 'main',
                directory: 'frontend',
              },
            ],
          },
        }),
      })

      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toMatch(/run "run_active"/)
      expect(updateChain.set).not.toHaveBeenCalled()
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
      // cancelInitialScmSync resolves false by default, so the post-cancel row
      // re-read never runs: row, then path peers, then the owner lookup.
      ;(cancelInitialScmSync as Mock).mockResolvedValueOnce(false)
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain([existingSource])) // path peers
        .mockReturnValueOnce(makeDbChain({ role: 'admin', isActive: true }))
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
      const where = vi.fn().mockReturnValue(
        asyncQuery({
          returning: vi
            .fn()
            .mockReturnValue(
              asyncQuery({ get: vi.fn().mockReturnValue({ ...existingSource, name: 'New Name' }) }),
            ),
        }),
      )
      const set = vi.fn().mockReturnValue(asyncQuery({ where }))
      ;(db.update as Mock).mockReturnValue({ set })

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Name' }),
      })

      expect(res.status).toBe(200)
      const setCall = set.mock.calls[0][0] as Record<string, unknown>
      expect(setCall.initialSyncCompletedAt).toBeUndefined()
      expect(JSON.stringify(where.mock.calls)).toContain('deletionRequestedAt')
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
        .mockReturnValueOnce(makeDbChain([existingSource])) // path peers
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
        .mockReturnValueOnce(makeDbChain([existingSource])) // path peers
        .mockReturnValueOnce(makeDbChain({ role: 'admin', isActive: true }))
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

    it('validates the default path when workspacesPath is cleared, so cross-source overlap still applies', async () => {
      // At runtime PATCH { workspacesPath: null } resolves to
      // defaultWorkspacesPath(id). If another source already occupies that
      // directory the clear must be rejected with 409 — turning the field null
      // is not a way to skip the overlap check.
      const { defaultWorkspacesPath } = await import('../../lib/git-workspace.js')
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/repos',
        workspacesPath: '/ws/explicit', // the current explicit path
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
      }
      const otherSource = {
        id: 'scm_2',
        name: 'Squatter',
        localPath: '/data/repos-2',
        workspacesPath: defaultWorkspacesPath('scm_1'), // another source squats on scm_1's default root
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

    /**
     * Clearing the field must persist the path the planner just resolved, not
     * NULL. A stored NULL is re-resolved at every use by `defaultWorkspacesPath`,
     * which prefers the legacy `~/.a2wave/workspaces` directory *while it still
     * exists on disk* — so the effective root silently changes the moment that
     * directory goes away. That is precisely the ambiguity the boot back-fill
     * exists to remove; letting PATCH write NULL back re-introduces it, and the
     * overlap checks above then compare against a path the runtime is no longer
     * using.
     */
    it('pins the resolved default when workspacesPath is cleared', async () => {
      const { defaultWorkspacesPath } = await import('../../lib/git-workspace.js')
      const existingSource = {
        id: 'scm_1',
        name: 'Source',
        localPath: '/data/repos',
        workspacesPath: '/ws/explicit',
        isEnabled: true,
        config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
      }
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain(existingSource))
        .mockReturnValueOnce(makeDbChain([]))
      const setSpy = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: () => [existingSource] }),
      })
      ;(db.update as Mock).mockReturnValue({ set: setSpy })

      const res = await app.request('/api/scm-sources/scm_1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspacesPath: null }),
      })

      expect(res.status).toBe(200)
      expect(setSpy).toHaveBeenCalledWith(
        expect.objectContaining({ workspacesPath: defaultWorkspacesPath('scm_1') }),
      )
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
        // The stored-root backstop scans peer sources for overlap.
        .mockReturnValueOnce(makeDbChain([]))
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
    /**
     * Mirrors the lib contract (removeGitWorkspace): `beforeRemove` runs
     * inside the workspace mutex before any filesystem work, and a throw
     * aborts with nothing touched. `removed` records that the mock reached
     * actual removal.
     */
    function makeRemoveWorkspace(removed: () => void) {
      return vi.fn(async (_name: string, options?: { beforeRemove?: () => Promise<void> }) => {
        await options?.beforeRemove?.()
        removed()
      })
    }

    /**
     * Row the protocol's occupancy decision re-reads. Its paths must agree
     * with the scm mock, or the decision reports "paths changed".
     */
    const pathRow = { id: 'scm_1', workspacesPath: '/workspaces/scm_1' }

    beforeEach(() => {
      // The protocol writes and releases a durable removal reservation.
      ;(db.insert as Mock).mockReturnValue(makeInsertChain({ id: 'scm_1:fix-bug' }))
      ;(db.delete as Mock).mockReturnValue(makeDeleteChain({ id: 'scm_1:fix-bug' }))
    })

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
        .mockReturnValueOnce(makeDbChain([])) // stored-root validator peers
        .mockReturnValueOnce(makeDbChain([])) // no bound agents
        .mockReturnValueOnce(makeDbChain(pathRow)) // occupancy decision row re-read
        .mockReturnValueOnce(makeDbChain({ id: 'run_running' })) // occupied
      const removed = vi.fn()
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/workspaces/scm_1',
        removeWorkspace: makeRemoveWorkspace(removed),
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })
      expect(res.status).toBe(409)
      // Pin the reason: a drifted mock queue also yields 409 (via "paths
      // changed"), which would let this assertion pass without ever exercising
      // the occupancy branch it exists to cover.
      expect(((await res.json()) as { error: string }).error).toMatch(/occupied/)
      expect(removed).not.toHaveBeenCalled()
      // Blocked before the reservation was ever written.
      expect(db.insert).not.toHaveBeenCalled()
    })

    it('keeps the branch when deleting a per-agent worktree, drops it otherwise', async () => {
      // The entry an operator actually clicks: an idle `agent-*` row must not
      // take the Agent's accumulated unmerged commits with it. The judgement is
      // an exact match against an Agent bound to this source, so a legacy
      // explicit workspace named `agent-refactor` keeps delete-branch semantics.
      const removed = vi.fn()
      const removeWorkspace = makeRemoveWorkspace(removed)
      const runWithName = async (name: string) => {
        removeWorkspace.mockClear()
        // One full pass of the removal protocol per invocation. The queue is
        // primed inside the helper — `mockReturnValueOnce` entries survive
        // `clearAllMocks`, so leaving any unconsumed here would poison the
        // second call and every later test.
        ;(db.select as Mock)
          .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' })) // source
          .mockReturnValueOnce(makeDbChain([])) // stored-root validator peers
          .mockReturnValueOnce(makeDbChain([{ id: 'agt_abc123def456ghi7' }])) // bound agents
          // reservation-transaction decision
          .mockReturnValueOnce(makeDbChain(pathRow))
          .mockReturnValueOnce(makeDbChain(undefined))
          .mockReturnValueOnce(makeDbChain([]))
          // beforeRemove re-check inside the workspace mutex
          .mockReturnValueOnce(makeDbChain(pathRow))
          .mockReturnValueOnce(makeDbChain(undefined))
          .mockReturnValueOnce(makeDbChain([]))
        mockCreateScmSource.mockReturnValue({ wsRoot: '/workspaces/scm_1', removeWorkspace })
        const res = await app.request(`/api/scm-sources/scm_1/workspaces/${name}`, {
          method: 'DELETE',
        })
        expect(res.status).toBe(200)
        return removeWorkspace.mock.calls[0]
      }

      // `beforeRemove` rides along on the same options object, so the branch
      // decision is asserted on its own key rather than by whole-object equality.
      expect(await runWithName('agent-abc123def456ghi7')).toEqual([
        'agent-abc123def456ghi7',
        expect.objectContaining({ keepBranches: true }),
      ])
      expect(await runWithName('agent-refactor')).toEqual([
        'agent-refactor',
        expect.objectContaining({ keepBranches: false }),
      ])
    })

    it('keeps the branch of an orphaned per-agent worktree whose agent row is gone', async () => {
      // Agent deletion leaves an occupied worktree behind on purpose, so the
      // operator reclaims it here — after the row it would have matched against
      // is already deleted. Falling back to the shape test is what stops that
      // click from taking the unpushed commits with it.
      const removed = vi.fn()
      const removeWorkspace = makeRemoveWorkspace(removed)
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' })) // source
        .mockReturnValueOnce(makeDbChain([])) // stored-root validator peers
        .mockReturnValueOnce(makeDbChain([])) // no bound agents left
        // reservation-transaction decision
        .mockReturnValueOnce(makeDbChain(pathRow))
        .mockReturnValueOnce(makeDbChain(undefined))
        .mockReturnValueOnce(makeDbChain([]))
        // beforeRemove re-check inside the workspace mutex
        .mockReturnValueOnce(makeDbChain(pathRow))
        .mockReturnValueOnce(makeDbChain(undefined))
        .mockReturnValueOnce(makeDbChain([]))
      mockCreateScmSource.mockReturnValue({ wsRoot: '/workspaces/scm_1', removeWorkspace })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/agent-abc123def456ghi7', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      expect(removeWorkspace).toHaveBeenCalledWith(
        'agent-abc123def456ghi7',
        expect.objectContaining({ keepBranches: true }),
      )
      expect(removed).toHaveBeenCalled()
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
      // One select only: the validator rejects the root before any peer scan.
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

    // Evaluations write no `runs` row, so the run-status check cannot see
    // them — yet their `eval-<taskId>` worktree is a perfectly legal name
    // here. The durable lease is the only record that the directory is a live
    // process's cwd.
    it('returns 409 when the workspace belongs to an evaluation holding a durable lease', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' }))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain([])) // no bound agents
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', workspacesPath: '/workspaces/scm_1' }))
        .mockReturnValueOnce(makeDbChain(undefined)) // no active-status run
        .mockReturnValueOnce(makeDbChain([{ workloadType: 'evaluation', workloadId: 'evt_7' }]))
      const removed = vi.fn()
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/workspaces/scm_1',
        removeWorkspace: makeRemoveWorkspace(removed),
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/eval-evt_7', {
        method: 'DELETE',
      })

      expect(res.status).toBe(409)
      expect(removed).not.toHaveBeenCalled()
    })

    // A run's lease deliberately outlives its terminal status until process
    // exit and cleanup settle, so "no running/pending/queued row" is not "the
    // directory is free".
    it('returns 409 when a leased run still holds the workspace through cleanup', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' }))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain([])) // no bound agents
        .mockReturnValueOnce(makeDbChain(pathRow))
        .mockReturnValueOnce(makeDbChain(undefined)) // status-based check sees nothing
        .mockReturnValueOnce(makeDbChain([{ workloadType: 'run', workloadId: 'run_9' }]))
        .mockReturnValueOnce(
          makeDbChain({ id: 'run_9', workDir: '/workspaces/scm_1/fix-bug' }), // holds this one
        )
      const removed = vi.fn()
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/workspaces/scm_1',
        removeWorkspace: makeRemoveWorkspace(removed),
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })

      expect(res.status).toBe(409)
      expect(removed).not.toHaveBeenCalled()
    })

    // Admission reserves the lease before resolveWorkDir writes runs.workDir,
    // so a leased run with a NULL workDir may still resolve to this very
    // worktree. Matching on workDir alone waves the deletion through in
    // exactly that window.
    it('returns 409 while a leased run has not resolved its workDir yet', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' }))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain([])) // no bound agents
        .mockReturnValueOnce(makeDbChain(pathRow))
        .mockReturnValueOnce(makeDbChain(undefined))
        .mockReturnValueOnce(makeDbChain([{ workloadType: 'run', workloadId: 'run_new' }]))
        .mockReturnValueOnce(makeDbChain({ id: 'run_new', workDir: null }))
      const removed = vi.fn()
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/workspaces/scm_1',
        removeWorkspace: makeRemoveWorkspace(removed),
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })

      expect(res.status).toBe(409)
      expect(removed).not.toHaveBeenCalled()
    })

    // The occupancy decision re-reads the row inside the reservation
    // transaction and compares its paths against the removal target; a PATCH
    // that moved the source between the route's read and the reservation
    // makes this wsPath potentially another source's directory.
    it('returns 409 when the source paths changed before the reservation', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' }))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain([])) // no bound agents
        .mockReturnValueOnce(
          makeDbChain({ id: 'scm_1', workspacesPath: '/moved/workspaces/scm_1' }),
        )
      const removed = vi.fn()
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/workspaces/scm_1',
        removeWorkspace: makeRemoveWorkspace(removed),
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })

      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toMatch(/paths changed/)
      expect(removed).not.toHaveBeenCalled()
    })

    // Two removers (a second admin, another replica, or TTL cleanup) must not
    // interleave on one worktree. The durable reservation's primary-key
    // conflict is the cross-replica arbiter.
    it('returns 409 when a removal of the same workspace is already in progress', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' }))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain([])) // no bound agents
        .mockReturnValueOnce(makeDbChain(pathRow))
        .mockReturnValueOnce(makeDbChain(undefined))
        .mockReturnValueOnce(makeDbChain([]))
      // onConflictDoNothing().returning() yields no row: someone else holds it.
      ;(db.insert as Mock).mockReturnValue({
        values: vi.fn().mockReturnValue(asyncQuery({ get: () => undefined })),
      })
      const removed = vi.fn()
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/workspaces/scm_1',
        removeWorkspace: makeRemoveWorkspace(removed),
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })

      expect(res.status).toBe(409)
      expect(((await res.json()) as { error: string }).error).toMatch(/already in progress/)
      expect(removed).not.toHaveBeenCalled()
      expect(logAudit).not.toHaveBeenCalled()
    })

    it('removes a workspace no lease or run occupies, then releases the reservation', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' }))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain([])) // no bound agents
        // reservation-transaction decision
        .mockReturnValueOnce(makeDbChain(pathRow))
        .mockReturnValueOnce(makeDbChain(undefined))
        .mockReturnValueOnce(makeDbChain([]))
        // beforeRemove re-check inside the workspace mutex
        .mockReturnValueOnce(makeDbChain(pathRow))
        .mockReturnValueOnce(makeDbChain(undefined))
        .mockReturnValueOnce(makeDbChain([]))
      const removed = vi.fn()
      const removeWorkspace = makeRemoveWorkspace(removed)
      mockCreateScmSource.mockReturnValue({ wsRoot: '/workspaces/scm_1', removeWorkspace })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })

      expect(res.status).toBe(200)
      expect(removeWorkspace).toHaveBeenCalledWith(
        'fix-bug',
        expect.objectContaining({ beforeRemove: expect.any(Function) }),
      )
      expect(removed).toHaveBeenCalled()
      // Reservation written before the removal, released after it.
      expect(db.insert).toHaveBeenCalled()
      expect(db.delete).toHaveBeenCalled()
      expect(logAudit).toHaveBeenCalledWith(expect.anything(), {
        action: 'scm_source.workspace.delete',
        resource: 'scm_source',
        resourceId: 'scm_1',
        details: { workspaceName: 'fix-bug' },
      })
    })

    // The DB transaction must never span the git/filesystem removal: on the
    // shared SQLite connection an unrelated bare write landing mid-removal
    // would join the transaction and be erased if the removal failed and
    // rolled back. The occupancy decision instead commits the durable
    // reservation first, and re-runs as `beforeRemove` inside the workspace
    // mutex immediately before the filesystem work.
    it('removes the worktree outside every database transaction', async () => {
      ;(db.select as Mock)
        .mockReturnValueOnce(makeDbChain({ id: 'scm_1', type: 'git' }))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain([])) // no bound agents
        .mockReturnValueOnce(makeDbChain(pathRow))
        .mockReturnValueOnce(makeDbChain(undefined))
        .mockReturnValueOnce(makeDbChain([]))
        .mockReturnValueOnce(makeDbChain(pathRow))
        .mockReturnValueOnce(makeDbChain(undefined))
        .mockReturnValueOnce(makeDbChain([]))
      const removed = vi.fn()
      mockCreateScmSource.mockReturnValue({
        wsRoot: '/workspaces/scm_1',
        removeWorkspace: makeRemoveWorkspace(removed),
      })

      const res = await app.request('/api/scm-sources/scm_1/workspaces/fix-bug', {
        method: 'DELETE',
      })
      expect(res.status).toBe(200)

      // The removal must sit outside every BEGIN..COMMIT window this request
      // opened (reservation, re-check, release).
      const windows: Array<{ begin: number; commit?: number }> = []
      sqliteExec.mock.calls.forEach(([stmt], index) => {
        const order = sqliteExec.mock.invocationCallOrder[index]
        if (stmt === 'BEGIN') windows.push({ begin: order })
        if (stmt === 'COMMIT') {
          const open = [...windows].reverse().find((w) => w.commit === undefined)
          if (open) open.commit = order
        }
      })
      expect(windows.length).toBeGreaterThanOrEqual(2)
      const removeOrder = removed.mock.invocationCallOrder[0]
      for (const window of windows) {
        const insideWindow =
          removeOrder > window.begin && window.commit !== undefined && removeOrder < window.commit
        expect(insideWindow).toBe(false)
      }
    })
  })
})
