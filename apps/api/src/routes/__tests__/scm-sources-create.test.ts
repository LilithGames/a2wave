/**
 * Route tests for POST /scm-sources — specifically that the create path runs
 * credential normalization before persisting.
 *
 * Deliberately a separate file from `scm-sources.test.ts`, which is waived
 * wholesale in `SUITE_BASELINE` (`scripts/gates/check-api-tests.mjs`) over a
 * partial `createScmSource` mock. Per the root guide, "a file waived there has
 * no regression protection at all" — so an assertion placed there would not
 * gate CI, which is exactly what these tests exist to do.
 *
 * These assert on the payload actually handed to `db.insert(...).values(...)`.
 * A test that only checks the response status passes even if the route stops
 * normalizing, because the sentinel is stripped from reads either way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../test/test-app.js'

const { insertedValues, updatedValues, existingRows, storedRow, transactionEvents } = vi.hoisted(
  () => ({
    /** The row `POST /` handed to Drizzle, captured for assertion. */
    insertedValues: { current: undefined as Record<string, unknown> | undefined },
    /** The payload `PATCH /:id` handed to Drizzle, captured for assertion. */
    updatedValues: { current: undefined as Record<string, unknown> | undefined },
    existingRows: { current: [] as Record<string, unknown>[] },
    /** The row a by-id lookup resolves to; undefined means "not found". */
    storedRow: { current: undefined as Record<string, unknown> | undefined },
    transactionEvents: [] as string[],
  }),
)

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      // The durable workload lease / pending-removal checks read their own
      // tables before the path write; answering them with the stored source
      // row would make every path PATCH here look blocked. Only the sources
      // table has a row.
      from: (table?: { workloadType?: unknown; workspaceName?: unknown }) =>
        table && ('workloadType' in table || 'workspaceName' in table)
          ? asyncQuery({ where: () => asyncQuery({ all: () => [], get: () => undefined }) })
          : asyncQuery({
              where: () =>
                asyncQuery({ get: () => storedRow.current, all: () => existingRows.current }),
              all: () => existingRows.current,
              get: () => storedRow.current,
            }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        transactionEvents.push('insert')
        insertedValues.current = values
        return { returning: () => asyncQuery({ get: () => ({ ...values }) }) }
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        transactionEvents.push('update')
        updatedValues.current = values
        return {
          where: () =>
            asyncQuery({
              returning: () => asyncQuery({ get: () => ({ ...storedRow.current, ...values }) }),
            }),
        }
      },
    }),
  },
  // `db/transaction.js` reads these at module load to pick a backend, and its
  // SQLite branch drives BEGIN/COMMIT on the raw handle. Without a stand-in
  // handle every transactional route throws before its own mocks are consulted.
  dialect: 'sqlite',
  isPostgres: false,
  sqliteDatabase: { inTransaction: false, exec: (sql: string) => transactionEvents.push(sql) },
}))

vi.mock('../../lib/git-sync.js', () => ({ checkGitConnection: vi.fn() }))
vi.mock('../../lib/p4-sync.js', () => ({
  cancelInitialScmSync: vi.fn(() => Promise.resolve(false)),
  checkP4Connection: vi.fn(),
  isCheckoutBusy: vi.fn(() => false),
  releaseCheckout: vi.fn(),
  startAutoSync: vi.fn(),
  startInitialScmSync: vi.fn(() => Promise.resolve()),
  stopAutoSync: vi.fn(),
  syncScmSource: vi.fn(() => Promise.resolve()),
  tryAcquireCheckout: vi.fn(() => true),
}))
vi.mock('../../lib/codegraph-index.js', () => ({
  isCodegraphEnabled: vi.fn(() => false),
  runCodegraphIndex: vi.fn(),
}))
vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/scm-source.js', () => ({ createScmSource: vi.fn() }))
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { logAudit } from '../../lib/audit.js'
import { startAutoSync, startInitialScmSync, stopAutoSync } from '../../lib/p4-sync.js'

import { asyncQuery } from '../../test/async-query.js'

async function buildApp() {
  const app = createTestApp({ role: 'admin' })
  const mod = await import('../scm-sources.js')
  app.route('/scm-sources', mod.default)
  return app
}

function create(app: Awaited<ReturnType<typeof buildApp>>, body: unknown) {
  return app.request('/scm-sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function insertedConfig(): Record<string, unknown> {
  return insertedValues.current?.config as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
  insertedValues.current = undefined
  updatedValues.current = undefined
  existingRows.current = []
  transactionEvents.length = 0
  // Create's localPath-uniqueness lookup must miss; PATCH tests set this to the
  // row they are editing.
  storedRow.current = undefined
})

describe('POST /scm-sources — credential normalization', () => {
  const SENTINEL = '********'

  it('allocates managed local and worktree paths when localPath is omitted', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'managed repo',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git' },
    })

    expect(res.status).toBe(201)
    expect(insertedValues.current?.localPath).toMatch(/sources\//)
    expect(insertedValues.current?.workspacesPath).toMatch(/workspaces\//)
    expect(insertedValues.current?.localPath).not.toBe(insertedValues.current?.workspacesPath)
  })

  it('holds the SCM path mutation transaction from peer planning through insert', async () => {
    const app = await buildApp()

    const res = await create(app, {
      name: 'serialized repo',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git' },
    })

    expect(res.status).toBe(201)
    expect(transactionEvents).toEqual(['BEGIN', 'insert', 'COMMIT'])
  })

  it('requires P4 sources to use a client-root-covered local path', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'P4 depot',
      type: 'p4',
      config: {
        type: 'p4',
        p4port: 'ssl:p4.example.com:1666',
        p4user: 'builder',
        p4client: 'builder-client',
      },
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({
      error: 'P4 sources require a localPath covered by the client Root or AltRoots',
    })
    expect(insertedValues.current).toBeUndefined()
  })

  it('starts the initial sync immediately when auto-sync is enabled', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'auto-sync repo',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo.git',
        autoSync: true,
        syncIntervalMin: 30,
      },
    })

    expect(res.status).toBe(201)
    expect(startAutoSync).toHaveBeenCalledOnce()
    expect(startInitialScmSync).toHaveBeenCalledOnce()
    expect(startInitialScmSync).toHaveBeenCalledWith(insertedValues.current?.id)
  })

  it('starts the initial sync even when recurring auto-sync is disabled', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'manual-sync repo',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo.git',
        autoSync: false,
        syncIntervalMin: 30,
      },
    })

    expect(res.status).toBe(201)
    expect(startAutoSync).not.toHaveBeenCalled()
    expect(startInitialScmSync).toHaveBeenCalledOnce()
  })

  it('does not sync or schedule a disabled source', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'disabled repo',
      type: 'git',
      isEnabled: false,
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo.git',
        autoSync: true,
        syncIntervalMin: 30,
      },
    })

    expect(res.status).toBe(201)
    expect(startAutoSync).not.toHaveBeenCalled()
    expect(startInitialScmSync).not.toHaveBeenCalled()
  })

  it('rejects the retired setupScript field instead of silently discarding it', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'legacy repo',
      type: 'git',
      localPath: '/tmp/scm-create-legacy',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo.git',
        autoSync: true,
        syncIntervalMin: 5,
      },
      setupScript: 'pnpm install',
    })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'setupScript is no longer supported' })
    expect(insertedValues.current).toBeUndefined()
    expect(startAutoSync).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  /**
   * The first-party form starts blank and would not submit a sentinel, but the
   * route is a public API surface a legacy or hand-rolled client can reach, and
   * a stored sentinel becomes a literal credential: `buildAuthUrlFromParts`
   * embeds it as the HTTPS password on every later sync.
   */
  it('strips a sentinel git pat instead of persisting it as a credential', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'repo',
      type: 'git',
      localPath: '/tmp/scm-create-git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', pat: SENTINEL },
    })

    expect(res.status).toBe(201)
    expect(insertedConfig().pat).not.toBe(SENTINEL)
    expect(insertedConfig().pat).toBeUndefined()
  })

  it('strips a sentinel p4 password instead of persisting it as a credential', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'depot',
      type: 'p4',
      localPath: '/tmp/scm-create-p4',
      config: {
        type: 'p4',
        p4port: 'perforce:1666',
        p4user: 'alice',
        p4client: 'client',
        p4passwd: SENTINEL,
      },
    })

    expect(res.status).toBe(201)
    expect(insertedConfig().p4passwd).not.toBe(SENTINEL)
    expect(insertedConfig().p4passwd).toBe('')
  })

  /**
   * A sentinel-bearing URL has no stored row to resolve against at create time,
   * so it cannot be recovered — refusing beats persisting `********@host`,
   * which would silently break every later clone.
   */
  it('rejects a sentinel-bearing repo URL rather than persisting it', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'repo',
      type: 'git',
      localPath: '/tmp/scm-create-url',
      config: { type: 'git', repoUrl: `https://${SENTINEL}@github.com/org/repo.git` },
    })

    expect(res.status).toBe(400)
    expect(insertedValues.current).toBeUndefined()
  })

  /**
   * `/probe` already rejects a config whose `type` disagrees with the request's,
   * but create did not: the row's `type` column came from `type` while the config
   * was normalized down the other branch. The row then lies about its own shape,
   * and `POST /:id/check` hands a P4 config to `checkGitConnection`.
   */
  it('rejects a config whose type disagrees with the declared source type', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'mismatch',
      type: 'git',
      localPath: '/tmp/scm-create-mismatch',
      config: {
        type: 'p4',
        p4port: 'perforce:1666',
        p4user: 'alice',
        p4client: 'client',
        p4passwd: 'pw',
      },
    })

    expect(res.status).toBe(400)
    expect(insertedValues.current).toBeUndefined()
  })

  it('persists a genuinely typed credential untouched', async () => {
    const app = await buildApp()
    const res = await create(app, {
      name: 'repo',
      type: 'git',
      localPath: '/tmp/scm-create-real',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_real' },
    })

    expect(res.status).toBe(201)
    expect(insertedConfig().pat).toBe('ghp_real')
  })
})

describe('PATCH /scm-sources/:id — config type must match the row', () => {
  function patch(app: Awaited<ReturnType<typeof buildApp>>, body: unknown) {
    return app.request('/scm-sources/scm_1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('rejects a legacy setupScript-only update without producing side effects', async () => {
    storedRow.current = {
      id: 'scm_1',
      name: 'repo',
      type: 'git',
      localPath: '/tmp/git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git' },
    }
    const app = await buildApp()
    const res = await patch(app, { setupScript: '' })

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'setupScript is no longer supported' })
    expect(updatedValues.current).toBeUndefined()
    expect(stopAutoSync).not.toHaveBeenCalled()
    expect(startAutoSync).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  /**
   * `updateScmSourceInput` carries no `type`, and the route never compared the
   * submitted config against the row's — so a git config could be written onto a
   * P4 row. That is not merely a shape mismatch: `rehydrateScmConfigSecrets`
   * ignores a stored config of a different type, so the submitted credential
   * resolves against nothing. It is the one first-party path into the sentinel
   * bypass this MR exists to close.
   */
  it('rejects a git config submitted against a p4 row', async () => {
    storedRow.current = {
      id: 'scm_1',
      name: 'depot',
      type: 'p4',
      localPath: '/tmp/p4',
      config: { type: 'p4', p4port: 'perforce:1666', p4user: 'alice', p4client: 'c' },
    }
    const app = await buildApp()
    const res = await patch(app, {
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_x' },
    })

    expect(res.status).toBe(400)
    expect(updatedValues.current).toBeUndefined()
  })

  it('accepts a config of the same type as the row', async () => {
    storedRow.current = {
      id: 'scm_1',
      name: 'repo',
      type: 'git',
      localPath: '/tmp/git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git' },
    }
    const app = await buildApp()
    const res = await patch(app, {
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_new' },
    })

    expect(res.status).toBe(200)
    expect((updatedValues.current?.config as Record<string, unknown>).pat).toBe('ghp_new')
  })

  it('holds the SCM path mutation transaction from peer planning through update', async () => {
    storedRow.current = {
      id: 'scm_1',
      name: 'repo',
      type: 'git',
      localPath: '/tmp/git',
      workspacesPath: '/data/workspace/workspaces/scm_1',
      isEnabled: true,
      syncStatus: 'idle',
      codegraphStatus: 'idle',
      userId: 'usr_admin',
      role: 'admin',
      isActive: true,
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git' },
    }
    const app = await buildApp()

    const res = await patch(app, {
      workspacesPath: '/data/workspace/workspaces/scm_1-new',
    })

    expect(res.status).toBe(200)
    expect(transactionEvents).toEqual(['BEGIN', 'update', 'COMMIT'])
  })
})
