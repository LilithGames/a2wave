import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: {
    SCM_STORAGE_ROOT: '/data/workspace',
    SCM_WORKSPACES_ALLOWED_ROOTS: '/data/workspace/workspaces',
    DATABASE_URL: '/app/data/a2wave.db',
    A2WAVE_SKILLS_STORAGE: '/app/data/skills',
    A2WAVE_KB_STORAGE: '/app/data/kb',
    A2WAVE_MEMORY_STORAGE: '/app/data/memory',
    LOG_FILE_PATH: '/app/data/logs/a2wave.log',
  },
}))

// Path planning is pure; the db import is transitive via scm-workspace-safety.
vi.mock('../../db/client.js', () => ({ db: {} }))

import { env } from '../../env.js'
import { defaultWorkspacesPath } from '../git-workspace.js'
import { acquireScmPathMutationLock, pathsOverlap, resolveScmPathPlan } from '../scm-path-plan.js'
import { legacyScmReclaimRoot } from '../scm-storage.js'

/**
 * One source row as the planner sees it. Kept minimal on purpose: the planner
 * must not need the whole row, or callers start passing partially-updated rows.
 */
function row(overrides: {
  id: string
  name?: string
  localPath: string
  workspacesPath?: string | null
}) {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    localPath: overrides.localPath,
    workspacesPath: overrides.workspacesPath ?? null,
  }
}

describe('resolveScmPathPlan', () => {
  const managedA = '/data/workspace/sources/aBcD'
  const wsA = '/data/workspace/workspaces/aBcD'

  let others: ReturnType<typeof row>[]

  beforeEach(() => {
    others = [row({ id: 'scm_aBcD', name: 'source-a', localPath: managedA, workspacesPath: wsA })]
  })

  it('allocates the managed defaults when neither path is supplied', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      existingSources: others,
      isAdmin: false,
    })

    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.localPath).toBe('/data/workspace/sources/zZzZ')
    expect(plan.workspacesPath).toBe('/data/workspace/workspaces/zZzZ')
  })

  // The round-4 P0: localPath was only ever checked for exact-string equality,
  // so a checkout could be created nested inside another source's checkout.
  it('rejects a localPath nested inside another source checkout', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: `${managedA}/vendor`,
      existingSources: others,
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(409)
    expect(plan.error).toContain('source-a')
  })

  it('rejects a localPath that is an ancestor of another source checkout', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: '/mnt/repos',
      existingSources: [row({ id: 'scm_aBcD', name: 'source-a', localPath: '/mnt/repos/team-a' })],
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(409)
    expect(plan.error).toContain('source-a')
  })

  // The shared allocation roots are rejected outright, before any peer scan:
  // claiming one as a checkout is wrong even in an empty database.
  it('rejects a localPath equal to the managed checkout root', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: '/data/workspace/sources',
      existingSources: [],
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(400)
    expect(plan.error).toContain('shared storage root')
  })

  it('rejects a localPath overlapping another source workspaces root', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: `${wsA}/nested`,
      existingSources: others,
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(409)
  })

  it('rejects a localPath equal to the shared worktree root', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: '/data/workspace/workspaces',
      existingSources: [],
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(400)
  })

  // The mirror of the localPath rule above. Claiming a shared allocation root as
  // a *worktree* root is worse than claiming it as a checkout: every later
  // source's default allocation is a descendant of it, so the peer scan then
  // rejects each one with a 409 and managed allocation stops platform-wide.
  it.each(['/data/workspace/workspaces', '/data/workspace/sources'])(
    'rejects a workspacesPath equal to the shared storage root %s',
    (sharedRoot) => {
      const plan = resolveScmPathPlan({
        sourceId: 'scm_zZzZ',
        type: 'git',
        localPath: '/data/workspace/sources/zZzZ',
        workspacesPath: sharedRoot,
        existingSources: [],
        isAdmin: true,
        platform: 'linux',
      })

      expect(plan.ok).toBe(false)
      if (plan.ok) return
      expect(plan.status).toBe(400)
      expect(plan.error).toContain('shared storage root')
    },
  )

  // The consequence the rule above prevents: an ordinary managed source must
  // never make the next source's default allocation unreachable.
  it('keeps the managed default allocatable for a later source', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_bbb',
      type: 'git',
      existingSources: [
        row({
          id: 'scm_aaa',
          name: 'squatter',
          localPath: '/data/workspace/sources/aaa',
          workspacesPath: '/data/workspace/workspaces/aaa',
        }),
      ],
      isAdmin: true,
      platform: 'linux',
    })

    expect(plan.ok).toBe(true)
  })

  it.each(['localPath', 'workspacesPath'] as const)(
    'rejects %s anywhere inside the private reclaim root',
    (field) => {
      const plan = resolveScmPathPlan({
        sourceId: 'scm_zZzZ',
        type: 'git',
        [field]: '/data/workspace/.a2wave-scm-reclaim-v1/operator-data',
        existingSources: [],
        isAdmin: true,
      })

      expect(plan.ok).toBe(false)
      if (plan.ok) return
      expect(plan.status).toBe(400)
      expect(plan.error).toContain('reclaim')
    },
  )

  it.each(['localPath', 'workspacesPath'] as const)(
    'rejects %s inside the legacy-volume reclaim root',
    (field) => {
      const plan = resolveScmPathPlan({
        sourceId: 'scm_zZzZ',
        type: 'git',
        [field]: join(legacyScmReclaimRoot(), 'operator-data'),
        existingSources: [],
        isAdmin: true,
      })

      expect(plan.ok).toBe(false)
      if (plan.ok) return
      expect(plan.status).toBe(400)
      expect(plan.error).toContain('reclaim')
    },
  )

  it('still rejects an exactly duplicated localPath', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: managedA,
      existingSources: others,
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(409)
  })

  it('rejects a relative localPath', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: 'data/workspace/sources/rel',
      existingSources: [],
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(400)
    expect(plan.error).toContain('absolute')
  })

  it('rejects a workspacesPath overlapping the requested localPath', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: '/mnt/repo',
      workspacesPath: '/mnt/repo/worktrees',
      existingSources: [],
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(400)
    expect(plan.error).toContain('overlap')
  })

  it('rejects a workspacesPath overlapping another source checkout', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: '/mnt/repo',
      workspacesPath: `${managedA}/wt`,
      existingSources: others,
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(409)
  })

  // P4 cannot use managed storage: the checkout path must be one the P4 client
  // Root already covers, and a2wave never edits a client spec.
  it('requires an explicit localPath for p4', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'p4',
      existingSources: [],
      isAdmin: true,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(400)
    expect(plan.error).toMatch(/localPath/)
  })

  it('excludes the source being updated from its own conflict checks', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_aBcD',
      type: 'git',
      localPath: managedA,
      workspacesPath: wsA,
      existingSources: others,
      excludeId: 'scm_aBcD',
      isAdmin: true,
    })

    expect(plan.ok).toBe(true)
  })

  it('rejects a non-admin workspacesPath outside the approved roots', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_zZzZ',
      type: 'git',
      localPath: '/mnt/repo',
      workspacesPath: '/mnt/elsewhere',
      existingSources: [],
      isAdmin: false,
    })

    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(400)
  })
})

describe('acquireScmPathMutationLock', () => {
  it('takes a transaction-scoped PostgreSQL advisory lock before path planning', async () => {
    const execute = vi.fn().mockResolvedValue(undefined)

    await acquireScmPathMutationLock({ execute } as never, true)

    expect(execute).toHaveBeenCalledOnce()
    expect(JSON.stringify(execute.mock.calls[0][0])).toContain('pg_advisory_xact_lock')
  })
})

/**
 * Moved here from routes/__tests__/scm-sources-ws-overlap.test.ts: these
 * exercise `resolveScmPathPlan` / `pathsOverlap` directly, with no HTTP layer
 * involved, so they belong beside the module they test.
 */
describe('pathsOverlap', () => {
  it('detects exact match', () => {
    expect(pathsOverlap('/a/b', '/a/b')).toBe(true)
  })
  it('detects ancestor relation', () => {
    expect(pathsOverlap('/a', '/a/b')).toBe(true)
    expect(pathsOverlap('/a/b', '/a')).toBe(true)
  })
  it('does not false-match sibling with shared prefix', () => {
    expect(pathsOverlap('/a/bcd', '/a/b')).toBe(false)
  })

  /**
   * Case folding is a filesystem property, not a universal one. On Linux
   * `/srv/Repo` and `/srv/repo` are two independent directories, so folding
   * case there rejects a legitimate second source with a bogus "overlaps"
   * conflict. macOS and Windows really are case-insensitive, so the same two
   * strings there name one directory and must still collide.
   */
  it('treats case-differing paths as distinct on Linux', () => {
    expect(pathsOverlap('/srv/Repo', '/srv/repo', 'linux')).toBe(false)
    expect(pathsOverlap('/srv/Repo/sub', '/srv/repo', 'linux')).toBe(false)
  })

  it('treats case-differing paths as overlapping on macOS and Windows', () => {
    expect(pathsOverlap('/srv/Repo', '/srv/repo', 'darwin')).toBe(true)
    expect(pathsOverlap('/srv/Repo/sub', '/srv/repo', 'darwin')).toBe(true)
    expect(pathsOverlap('/srv/Repo', '/srv/repo', 'win32')).toBe(true)
  })
})

/**
 * Cross-source conflict detection, exercised through the planner both routes
 * call. Admin mode isolates these cases to overlap: an allowed-roots rejection
 * would otherwise mask the conflict the case is about.
 */
describe('resolveScmPathPlan cross-source conflicts', () => {
  const existingSources = [
    { id: 'scm_1', name: 'one', localPath: '/repos/one', workspacesPath: '/ws/one' },
    { id: 'scm_2', name: 'two', localPath: '/repos/two', workspacesPath: '/ws/two' },
    { id: 'scm_3', name: 'three', localPath: '/repos/three', workspacesPath: null },
  ]

  function planWorkspaces(candidate: string, excludeId?: string) {
    return resolveScmPathPlan({
      sourceId: excludeId ?? 'scm_new',
      type: 'git',
      localPath: '/repos/brand-new',
      workspacesPath: candidate,
      existingSources,
      excludeId,
      isAdmin: true,
    })
  }

  it('accepts a workspaces path with no overlap', () => {
    expect(planWorkspaces('/ws/three').ok).toBe(true)
  })

  it('flags exact-match conflict', () => {
    const plan = planWorkspaces('/ws/one')
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('one')
    expect(plan.status).toBe(409)
  })

  it('flags when candidate is child of existing', () => {
    const plan = planWorkspaces('/ws/one/sub')
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('one')
  })

  it('flags when candidate is parent of existing', () => {
    expect(planWorkspaces('/ws').ok).toBe(false)
  })

  it('flags overlap with another source checkout', () => {
    const plan = planWorkspaces('/repos/one/worktrees')
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('one')
  })

  it('excludes self by id', () => {
    expect(planWorkspaces('/ws/one', 'scm_1').ok).toBe(true)
  })

  it('ignores unrelated paths', () => {
    expect(planWorkspaces('/nonexistent').ok).toBe(true)
  })

  it('expands null workspacesPath to defaultWorkspacesPath(id) and flags overlap', () => {
    // scm_3 stores NULL, so at runtime it resolves to the default root. A new
    // source aimed inside that implicit root must still be rejected.
    const defaultRoot = defaultWorkspacesPath('scm_3')
    const plan = planWorkspaces(`${defaultRoot}/sub`)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('three')
  })

  /**
   * The shared-root guard is a collision check, so it must fold case wherever
   * the filesystem does. `samePath` was routed through `isSameOrDescendant`,
   * which is the *containment* comparator and folds only on win32 — so on a
   * default macOS volume an upper-cased `SOURCES` named the very same directory
   * as the protected `sources` root and walked straight past the guard, making
   * one source's working tree the parent of every other source's checkout.
   */
  it('rejects a case-differing shared storage root on macOS', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_new',
      type: 'git',
      localPath: '/data/workspace/SOURCES',
      workspacesPath: '/ws/brand-new',
      existingSources: [],
      isAdmin: true,
      platform: 'darwin',
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(400)
    expect(plan.error).toMatch(/shared storage root/)
  })

  it('allows a case-differing shared storage root on Linux', () => {
    // Case-sensitive filesystem: /data/workspace/SOURCES is a genuinely
    // different directory from the managed sources/ root.
    const plan = resolveScmPathPlan({
      sourceId: 'scm_new',
      type: 'git',
      localPath: '/data/workspace/SOURCES',
      workspacesPath: '/ws/brand-new',
      existingSources: [],
      isAdmin: true,
      platform: 'linux',
    })
    expect(plan.ok).toBe(true)
  })

  /**
   * The planner must inherit the platform rule rather than fold case
   * unconditionally: on Linux a second source under `/REPOS/one` is a real,
   * separate directory and rejecting it locks the operator out of a valid path.
   */
  it('does not flag a case-differing peer path on Linux', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_new',
      type: 'git',
      localPath: '/REPOS/one',
      workspacesPath: '/ws/brand-new',
      existingSources,
      isAdmin: true,
      platform: 'linux',
    })
    expect(plan.ok).toBe(true)
  })

  it('flags a case-differing peer path on macOS', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_new',
      type: 'git',
      localPath: '/REPOS/one',
      workspacesPath: '/ws/brand-new',
      existingSources,
      isAdmin: true,
      platform: 'darwin',
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.error).toContain('one')
  })

  it('rejects a checkout that reaches an existing source through a symlink alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'a2wave-scm-plan-'))
    const originalRoot = env.SCM_STORAGE_ROOT
    try {
      env.SCM_STORAGE_ROOT = root
      const realCheckout = join(root, 'operator-repos', 'one')
      const aliasRoot = join(root, 'repo-alias')
      await mkdir(realCheckout, { recursive: true })
      await symlink(join(root, 'operator-repos'), aliasRoot, 'dir')

      const plan = resolveScmPathPlan({
        sourceId: 'scm_new',
        type: 'git',
        localPath: join(aliasRoot, 'one'),
        workspacesPath: join(root, 'workspaces', 'new'),
        existingSources: [
          row({
            id: 'scm_existing',
            name: 'existing',
            localPath: realCheckout,
            workspacesPath: join(root, 'workspaces', 'existing'),
          }),
        ],
        isAdmin: true,
      })

      expect(plan.ok).toBe(false)
      if (plan.ok) return
      expect(plan.status).toBe(409)
      expect(plan.error).toContain('existing')
    } finally {
      env.SCM_STORAGE_ROOT = originalRoot
      await rm(root, { recursive: true, force: true })
    }
  })

  // The round-4 P0: the same conflict scan must apply to localPath, which was
  // previously only compared for exact string equality.
  it('flags a localPath nested inside another source checkout', () => {
    const plan = resolveScmPathPlan({
      sourceId: 'scm_new',
      type: 'git',
      localPath: '/repos/one/vendor',
      workspacesPath: '/ws/brand-new',
      existingSources,
      isAdmin: true,
    })
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.status).toBe(409)
    expect(plan.error).toContain('one')
  })
})
