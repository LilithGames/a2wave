/**
 * Route tests for POST /scm-sources/probe — the stateless connectivity probe.
 *
 * Unlike POST /:id/check (which reads the stored config), probe validates the
 * config carried in the request body, so it works before a source exists. These
 * tests pin the two properties that make it safe: masked credentials resolve
 * from the stored row (never dialed out as `********`), and probing someone
 * else's source id cannot be used to borrow their credentials.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../test/test-app.js'

import { asyncQuery } from '../../test/async-query.js'

const { mockCheckGit, mockCheckP4, mockSourceRow, lastWhere } = vi.hoisted(() => ({
  mockCheckGit: vi.fn(),
  mockCheckP4: vi.fn(),
  mockSourceRow: { current: undefined as Record<string, unknown> | undefined },
  /**
   * The condition the route handed to `.where()`. Captured rather than ignored:
   * a mock that drops it makes the ownership check untestable — deleting
   * `getOwnerFilter` from the route would leave every "404 for someone else's
   * source" case green, because those cases only ever assert on a row the test
   * itself set to undefined.
   */
  lastWhere: { current: undefined as unknown },
}))

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () =>
        asyncQuery({
          where: (condition: unknown) => {
            lastWhere.current = condition
            return { get: () => mockSourceRow.current }
          },
        }),
    }),
  },
}))

/**
 * Every column a captured Drizzle condition compares against, by name.
 *
 * Asserting on the columns — rather than on how many comparisons there are —
 * is what makes this pin ownership specifically. A count only shows the
 * condition got *bigger*, so `and(eq(id), eq(type))` would satisfy it just as
 * well as `and(eq(id), eq(userId))`, and swapping the owner filter for any
 * other second predicate would go unnoticed.
 */
function conditionColumns(condition: unknown): string[] {
  if (!condition || typeof condition !== 'object') return []
  const node = condition as { queryChunks?: unknown[]; name?: unknown }
  if (typeof node.name === 'string' && !Array.isArray(node.queryChunks)) return [node.name]
  if (!Array.isArray(node.queryChunks)) return []
  return node.queryChunks.flatMap(conditionColumns)
}

vi.mock('../../lib/git-sync.js', () => ({ checkGitConnection: mockCheckGit }))

vi.mock('../../lib/p4-sync.js', () => ({
  cancelInitialScmSync: vi.fn(() => Promise.resolve(false)),
  checkP4Connection: mockCheckP4,
  isCheckoutBusy: vi.fn(() => false),
  releaseCheckout: vi.fn(),
  startAutoSync: vi.fn(),
  startInitialScmSync: vi.fn(),
  stopAutoSync: vi.fn(),
  syncScmSource: vi.fn(),
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

async function buildApp(options?: { userId?: string; role?: 'admin' | 'user' }) {
  const app = createTestApp(options)
  const mod = await import('../scm-sources.js')
  app.route('/scm-sources', mod.default)
  return app
}

function probe(app: Awaited<ReturnType<typeof buildApp>>, body: unknown) {
  return app.request('/scm-sources/probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const GIT_BODY = {
  type: 'git',
  config: {
    type: 'git',
    repoUrl: 'https://github.com/org/repo.git',
    branch: 'main',
    pat: 'ghp_typed',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSourceRow.current = undefined
  mockCheckGit.mockResolvedValue({ ok: true, message: '1/1 repos connected', repos: [] })
  mockCheckP4.mockResolvedValue({ ok: true, message: 'P4 connection is healthy' })
})

describe('POST /scm-sources/probe', () => {
  it('probes a git config with no sourceId (create mode)', async () => {
    const app = await buildApp()
    const res = await probe(app, GIT_BODY)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ data: { ok: true } })
    expect(mockCheckGit).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_typed' }),
    )
  })

  it('probes a p4 config with no sourceId', async () => {
    const app = await buildApp()
    const res = await probe(app, {
      type: 'p4',
      localPath: '/data/p4/client-a',
      config: {
        type: 'p4',
        p4port: 'ssl:perforce:1666',
        p4user: 'alice',
        p4passwd: 'pw',
        p4client: 'client-a',
      },
    })

    expect(res.status).toBe(200)
    expect(mockCheckP4).toHaveBeenCalledWith(
      expect.objectContaining({ p4user: 'alice' }),
      '/data/p4/client-a',
    )
  })

  /**
   * The P4 Root/AltRoots coverage check is the whole point of probing a P4
   * source before saving it: syncing into a directory the client Root does not
   * cover fails at `p4 sync` time, after the source looks healthy. That check
   * needs `localPath`, and an absent one was passed through as `''`, which the
   * verifier cannot compare — so the probe reported a clean bill of health for a
   * path it never examined. The web form always sends it; the route is a public
   * API surface a hand-rolled client reaches directly.
   */
  it('rejects a p4 probe with no localPath rather than skipping the root check', async () => {
    // Distinct user: the probe rate limit is keyed per user and this file is
    // already close to the 20/min cap, so a shared identity turns an unrelated
    // later test red with a 429.
    const app = await buildApp({ userId: 'usr_p4_root_check', role: 'user' })
    const res = await probe(app, {
      type: 'p4',
      config: {
        type: 'p4',
        p4port: 'ssl:perforce:1666',
        p4user: 'alice',
        p4passwd: 'pw',
        p4client: 'client-a',
      },
    })

    expect(res.status).toBe(400)
    expect(mockCheckP4).not.toHaveBeenCalled()
  })

  it('still allows a git probe with no localPath', async () => {
    const app = await buildApp({ userId: 'usr_git_no_path', role: 'user' })
    const res = await probe(app, GIT_BODY)

    expect(res.status).toBe(200)
  })

  it('resolves a masked pat from the stored source instead of dialing "********"', async () => {
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://alice:ghp_real@github.com/org/repo.git',
        branch: 'main',
        pat: 'ghp_real',
      },
    }
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: {
        type: 'git',
        repoUrl: 'https://********@github.com/org/repo.git',
        branch: 'main',
        pat: '********',
      },
    })

    expect(res.status).toBe(200)
    expect(mockCheckGit).toHaveBeenCalledWith(
      expect.objectContaining({
        pat: 'ghp_real',
        repoUrl: 'https://alice:ghp_real@github.com/org/repo.git',
      }),
    )
  })

  it('uses a newly typed credential rather than the stored one', async () => {
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', pat: 'ghp_old' },
    }
    const app = await buildApp()
    await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'main',
        pat: 'ghp_brand_new',
      },
    })

    expect(mockCheckGit).toHaveBeenCalledWith(expect.objectContaining({ pat: 'ghp_brand_new' }))
  })

  it('never echoes a resolved secret back to the client', async () => {
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://alice:ghp_real@github.com/org/repo.git' },
    }
    mockCheckGit.mockResolvedValue({ ok: false, message: 'Git connection failed', repos: [] })
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: { type: 'git', repoUrl: 'https://********@github.com/org/repo.git', branch: 'main' },
    })

    expect(JSON.stringify(await res.json())).not.toContain('ghp_real')
  })

  it('rejects a masked url that matches no stored credential', async () => {
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://alice:tok@github.com/org/original.git' },
    }
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: {
        type: 'git',
        repoUrl: 'https://********@github.com/org/renamed.git',
        branch: 'main',
      },
    })

    expect(res.status).toBe(400)
    expect(mockCheckGit).not.toHaveBeenCalled()
  })

  it('404s when sourceId is not visible to the caller, without probing', async () => {
    mockSourceRow.current = undefined // owner filter excluded the row
    const app = await buildApp({ userId: 'usr_other', role: 'user' })
    const res = await probe(app, {
      type: 'git',
      sourceId: 'scm_someone_else',
      config: { type: 'git', repoUrl: 'https://********@github.com/org/repo.git', branch: 'main' },
    })

    expect(res.status).toBe(404)
    expect(mockCheckGit).not.toHaveBeenCalled()
  })

  it('constrains the sourceId lookup by owner for a non-admin caller', async () => {
    // Pins the ownership filter itself, not just its effect on a row the test
    // pre-emptied: without it any authenticated user could probe an arbitrary id
    // with `pat: '********'` and read pass/fail as an oracle for someone else's
    // credential. Asserts the userId column specifically, so substituting some
    // other second predicate fails just as loudly as dropping the filter.
    lastWhere.current = undefined
    mockSourceRow.current = undefined
    const app = await buildApp({ userId: 'usr_alice', role: 'user' })
    await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
    })

    const { scmSources } = await import('../../db/schema.js')
    const columns = conditionColumns(lastWhere.current)
    expect(columns).toContain(scmSources.userId.name)
    expect(columns).toContain(scmSources.id.name)
  })

  it('does not constrain by owner for an admin caller', async () => {
    // The complement of the test above: getOwnerFilter returns undefined for
    // admins by design, so this documents that the userId predicate is absent
    // there — and keeps the assertion above honest about what it is detecting.
    lastWhere.current = undefined
    mockSourceRow.current = undefined
    const app = await buildApp({ userId: 'usr_admin', role: 'admin' })
    await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
    })

    const { scmSources } = await import('../../db/schema.js')
    expect(conditionColumns(lastWhere.current)).not.toContain(scmSources.userId.name)
  })

  /**
   * Endpoint binding. A restored credential belongs to the endpoint it was
   * stored against; probe dials a caller-supplied address, so resolving a stored
   * secret against a *different* one would send a colleague's PAT / P4 password
   * wherever the request points — silently, writing no row. `getOwnerFilter`
   * returns undefined for admins and the mask hides secrets from admins too, so
   * without this an admin could read out any user's credential.
   */
  describe('credential/endpoint binding', () => {
    it('refuses to dial a different git host with a stored pat', async () => {
      mockSourceRow.current = {
        id: 'scm_victim',
        type: 'git',
        config: {
          type: 'git',
          repoUrl: 'https://github.com/org/repo.git',
          branch: 'main',
          pat: 'ghp_VICTIM_SECRET',
        },
      }
      const app = await buildApp({ userId: 'usr_admin', role: 'admin' })
      const res = await probe(app, {
        type: 'git',
        sourceId: 'scm_victim',
        config: {
          type: 'git',
          repoUrl: 'https://attacker.example/x.git',
          branch: 'main',
          pat: '********',
        },
      })

      expect(res.status).toBe(400)
      expect(mockCheckGit).not.toHaveBeenCalled()
    })

    it('refuses to dial a different p4port with a stored password', async () => {
      mockSourceRow.current = {
        id: 'scm_victim',
        type: 'p4',
        config: {
          type: 'p4',
          p4port: 'ssl:perforce.internal:1666',
          p4user: 'victim',
          p4passwd: 'VICTIM_PASSWORD',
          p4client: 'ws',
        },
      }
      const app = await buildApp({ userId: 'usr_admin', role: 'admin' })
      const res = await probe(app, {
        type: 'p4',
        sourceId: 'scm_victim',
        config: {
          type: 'p4',
          p4port: 'attacker.example:1666',
          p4user: 'victim',
          p4passwd: '********',
          p4client: 'ws',
        },
      })

      expect(res.status).toBe(400)
      expect(mockCheckP4).not.toHaveBeenCalled()
    })

    it('still probes the unchanged endpoint with the stored credential', async () => {
      mockSourceRow.current = {
        id: 'scm_1',
        type: 'git',
        config: {
          type: 'git',
          repoUrl: 'https://github.com/org/repo.git',
          branch: 'main',
          pat: 'ghp_real',
        },
      }
      const app = await buildApp()
      const res = await probe(app, {
        type: 'git',
        sourceId: 'scm_1',
        config: {
          type: 'git',
          repoUrl: 'https://github.com/org/repo.git',
          branch: 'develop',
          pat: '********',
        },
      })

      expect(res.status).toBe(200)
      expect(mockCheckGit).toHaveBeenCalledWith(expect.objectContaining({ pat: 'ghp_real' }))
    })
  })

  /**
   * Iron Rule 5 (auditability). Probe makes an outbound connection on the user's
   * behalf, and when a `sourceId` is supplied it does so with a stored
   * credential — while writing no row and no run record. The audit entry is the
   * only trace such a request leaves, so it is a hard requirement rather than a
   * nicety. The endpoint is recorded redacted; the entry must never become
   * another place a credential is written down.
   */
  it('audits a probe that used a stored credential, with the endpoint redacted', async () => {
    const { logAudit } = await import('../../lib/audit.js')
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://alice:ghp_real@github.com/org/repo.git',
        branch: 'main',
        pat: 'ghp_real',
      },
    }
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: {
        type: 'git',
        repoUrl: 'https://alice:ghp_real@github.com/org/repo.git',
        branch: 'main',
        pat: '********',
      },
    })

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'scm_source.probe', resourceId: 'scm_1' }),
    )
    const serialized = JSON.stringify(vi.mocked(logAudit).mock.calls)
    expect(serialized).not.toContain('ghp_real')
  })

  /**
   * `redactRepoUrlCredential` only strips URL userinfo, so a token carried in a
   * query string (`?access_token=`, which git hosts do accept) survived it and
   * would be written verbatim into `audit_logs.details`. The audit trail must
   * not become one more place a credential is stored.
   */
  it('keeps a query-string token out of the audit entry', async () => {
    const { logAudit } = await import('../../lib/audit.js')
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://git.example/repo.git?access_token=QUERY_SECRET',
        branch: 'main',
      },
    })

    expect(res.status).toBe(200)
    expect(JSON.stringify(vi.mocked(logAudit).mock.calls)).not.toContain('QUERY_SECRET')
  })

  it('does not claim a stored credential when the user typed a fresh one', async () => {
    // `usedStoredCredential` answers "whose credential left this instance", so
    // deriving it from the presence of a sourceId alone would misreport an edit
    // where the user supplied their own PAT.
    const { logAudit } = await import('../../lib/audit.js')
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'main',
        pat: 'ghp_stored',
      },
    }
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'main',
        pat: 'ghp_freshly_typed',
      },
    })

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ usedStoredCredential: false }),
      }),
    )
  })

  /**
   * The counterpart to the test above: a source with NO stored credential.
   * The form round-trips the mask sentinel for those too, and stripping it is
   * not the same event as pulling a credential out of the row — reporting
   * `true` here would point an auditor at a credential that does not exist.
   */
  it('does not claim a stored credential when the row has none to pull', async () => {
    const { logAudit } = await import('../../lib/audit.js')
    const { SCM_SECRET_MASK } = await import('../../lib/scm-secret-mask.js')
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
    }
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo.git',
        branch: 'main',
        pat: SCM_SECRET_MASK,
      },
    })

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ usedStoredCredential: false }),
      }),
    )
  })

  it('does not claim a stored p4 password when the row has none to pull', async () => {
    const { logAudit } = await import('../../lib/audit.js')
    const { SCM_SECRET_MASK } = await import('../../lib/scm-secret-mask.js')
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'p4',
      config: { type: 'p4', p4port: 'perforce:1666', p4user: 'alice', p4client: 'c', p4passwd: '' },
    }
    const app = await buildApp()
    const res = await probe(app, {
      type: 'p4',
      sourceId: 'scm_1',
      localPath: '/data/p4/c',
      config: {
        type: 'p4',
        p4port: 'perforce:1666',
        p4user: 'alice',
        p4client: 'c',
        p4passwd: SCM_SECRET_MASK,
      },
    })

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ usedStoredCredential: false }),
      }),
    )
  })

  /**
   * The URL arm has to ask whether the restored URL carries a *password*, not
   * merely whether it changed. `redactRepoUrlCredential` masks userinfo whether
   * or not a password is present, so a stored `https://alice@host/r` round-trips
   * as `https://********@host/r` and restores to a URL that differs from what
   * was submitted while carrying no secret at all — and both that helper and
   * `storedHasGitSecret` explicitly treat a bare username as not a credential.
   */
  it('does not claim a stored credential when the restored URL carries only a username', async () => {
    const { logAudit } = await import('../../lib/audit.js')
    const { SCM_SECRET_MASK } = await import('../../lib/scm-secret-mask.js')
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://alice@github.com/org/repo.git', branch: 'main' },
    }
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: {
        type: 'git',
        repoUrl: `https://${SCM_SECRET_MASK}@github.com/org/repo.git`,
        branch: 'main',
      },
    })

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ usedStoredCredential: false }),
      }),
    )
  })

  it('does claim a stored credential when the restored URL carries a password', async () => {
    const { logAudit } = await import('../../lib/audit.js')
    const { SCM_SECRET_MASK } = await import('../../lib/scm-secret-mask.js')
    mockSourceRow.current = {
      id: 'scm_1',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://alice:ghp_real@github.com/org/repo.git' },
    }
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      sourceId: 'scm_1',
      config: {
        type: 'git',
        repoUrl: `https://${SCM_SECRET_MASK}@github.com/org/repo.git`,
        branch: 'main',
      },
    })

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        details: expect.objectContaining({ usedStoredCredential: true }),
      }),
    )
  })

  it('rejects a probe covering more repos than the fan-out bound', async () => {
    const { MAX_GIT_REPOS } = await import('@a2wave/shared')
    const app = await buildApp()
    const res = await probe(app, {
      type: 'git',
      config: {
        type: 'git',
        repoUrl: '',
        branch: 'main',
        repos: Array.from({ length: MAX_GIT_REPOS + 1 }, (_, i) => ({
          repoUrl: `https://gitlab.com/org/r${i}.git`,
          branch: 'main',
          directory: `r${i}`,
        })),
      },
    })

    expect(res.status).toBe(400)
    expect(mockCheckGit).not.toHaveBeenCalled()
  })

  it('rejects a body whose config fails validation', async () => {
    const app = await buildApp()
    const res = await probe(app, { type: 'p4', config: { type: 'p4', p4port: '' } })

    expect(res.status).toBe(400)
    expect(mockCheckP4).not.toHaveBeenCalled()
  })

  it('surfaces a failed probe as 200 with ok:false, not an HTTP error', async () => {
    mockCheckGit.mockResolvedValue({
      ok: false,
      message: '1/2 repos connected, failed: repo-b',
      repos: [
        { directory: 'repo-a', repoUrl: 'https://x/a.git', ok: true, message: 'ok' },
        { directory: 'repo-b', repoUrl: 'https://x/b.git', ok: false, message: 'auth failed' },
      ],
    })
    const app = await buildApp()
    const res = await probe(app, GIT_BODY)

    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { ok: boolean; repos: unknown[] } }
    expect(body.data.ok).toBe(false)
    expect(body.data.repos).toHaveLength(2)
  })
})
