import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests never touch a real database. The stored-root validator reads the
 * owner's live role and (for the cross-source overlap scan) every other source
 * row; both resolve to empty here, so each test states its own peers explicitly.
 */
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      // The peer scan awaits `.from(...)` directly; the owner lookup chains
      // `.where().limit()`. One thenable object satisfies both shapes.
      from: () =>
        Object.assign(Promise.resolve([]), {
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
    }),
  },
}))

import { env } from '../../env.js'
import {
  detectFilesystemCaseInsensitive,
  getDefaultScmWorkspacesAllowedRoot,
  validateScmWorkspacesRoot,
  validateStoredScmWorkspacesRoot,
} from '../scm-workspace-safety.js'

describe('detectFilesystemCaseInsensitive', () => {
  it('detects a case-insensitive bind mount even when the container platform is Linux', () => {
    const sameDirectory = { dev: 7, ino: 42 }
    const existing = new Set(['/data/workspace/sources', '/data/workspace/Sources'])

    expect(
      detectFilesystemCaseInsensitive('/data/workspace/sources/new-source', 'linux', {
        existsSync: (path) => existing.has(path),
        realpathSync: (path) => path,
        statSync: () => sameDirectory,
      }),
    ).toBe(true)
  })
})

describe('validateScmWorkspacesRoot', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('allows the platform default root without operator configuration', async () => {
    const defaultRoot = getDefaultScmWorkspacesAllowedRoot()

    expect(validateScmWorkspacesRoot(join(defaultRoot, 'scm-source'), '')).toBeNull()
  })

  it('keeps the pre-managed-storage default root allowed after an upgrade', async () => {
    const legacyRoot = join(homedir(), '.a2wave', 'workspaces')
    const originalStorageRoot = env.SCM_STORAGE_ROOT
    env.SCM_STORAGE_ROOT = '/data/workspace'
    try {
      expect(validateScmWorkspacesRoot(join(legacyRoot, 'legacy-source'), '')).toBeNull()
    } finally {
      env.SCM_STORAGE_ROOT = originalStorageRoot
    }
  })

  it('rejects an arbitrary absolute path outside approved roots', async () => {
    expect(validateScmWorkspacesRoot('/opt/unapproved/worktrees', '')).toMatch(
      /SCM_WORKSPACES_ALLOWED_ROOTS/,
    )
  })

  it('allows a path beneath an explicit operator-approved root', async () => {
    expect(
      validateScmWorkspacesRoot('/srv/a2wave-worktrees/source-a', '/srv/a2wave-worktrees'),
    ).toBeNull()
  })

  it('keeps path casing significant on macOS and Linux filesystems', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(
        validateScmWorkspacesRoot('/srv/Allowed/source-a', '/srv/allowed', {
          platform,
          protectedPaths: ['/unrelated'],
        }),
      ).toMatch(/SCM_WORKSPACES_ALLOWED_ROOTS/)
    }
  })

  it('retains Windows case-insensitive comparison semantics', async () => {
    expect(
      validateScmWorkspacesRoot('/srv/Allowed/source-a', '/srv/allowed', {
        platform: 'win32',
        protectedPaths: ['/unrelated'],
      }),
    ).toBeNull()
  })

  it('allows an admin-selected dedicated root while retaining protected-path checks', async () => {
    expect(
      validateScmWorkspacesRoot('/srv/admin-selected/source-a', '', {
        allowOutsideConfiguredRoots: true,
        protectedPaths: ['/app/data'],
      }),
    ).toBeNull()
  })

  it('rejects the private reclaim root even for an administrator and broad allowlist', () => {
    const originalStorageRoot = env.SCM_STORAGE_ROOT
    env.SCM_STORAGE_ROOT = '/data/workspace'
    try {
      expect(
        validateScmWorkspacesRoot(
          '/data/workspace/.a2wave-scm-reclaim-v1/operator-worktrees',
          '/data/workspace',
          { allowOutsideConfiguredRoots: true, protectedPaths: [] },
        ),
      ).toMatch(/reclaim root/)
    } finally {
      env.SCM_STORAGE_ROOT = originalStorageRoot
    }
  })

  it('rejects the legacy-volume reclaim root even for an administrator', async () => {
    const { legacyScmReclaimRoot } = await import('../scm-storage.js')
    expect(
      validateScmWorkspacesRoot(join(legacyScmReclaimRoot(), 'operator-worktrees'), '', {
        allowOutsideConfiguredRoots: true,
        protectedPaths: [],
      }),
    ).toMatch(/reclaim root/)
  })

  it('rejects platform storage even when an operator configures a broad allowed root', async () => {
    expect(
      validateScmWorkspacesRoot('/app/data/skills/worktrees', '/app/data', {
        protectedPaths: ['/app/data/skills'],
      }),
    ).toMatch(/protected platform storage/)
  })

  // The compose default narrowed from SCM_STORAGE_ROOT to
  // SCM_STORAGE_ROOT/workspaces. A custom root the OLD default approved must
  // keep working, or upgrading brick every non-admin source pointed at one:
  // the stored-root check runs on every use, so even renaming the source is
  // rejected and a non-admin cannot repair it through the UI.
  it('keeps a custom root approved by the pre-managed-storage default allowed', () => {
    const originalStorageRoot = env.SCM_STORAGE_ROOT
    env.SCM_STORAGE_ROOT = '/data/workspace'
    try {
      expect(
        validateScmWorkspacesRoot('/data/workspace/team-worktrees', '', { protectedPaths: [] }),
      ).toBeNull()
    } finally {
      env.SCM_STORAGE_ROOT = originalStorageRoot
    }
  })

  it('rejects workspaces beneath the managed checkout tree', () => {
    const originalStorageRoot = env.SCM_STORAGE_ROOT
    env.SCM_STORAGE_ROOT = '/data/workspace'
    try {
      expect(
        validateScmWorkspacesRoot('/data/workspace/sources/source-a', '/data/workspace', {
          protectedPaths: [],
        }),
      ).toMatch(/managed SCM checkout storage/)
    } finally {
      env.SCM_STORAGE_ROOT = originalStorageRoot
    }
  })

  it('rejects a filesystem root that would contain protected platform storage', async () => {
    expect(
      validateScmWorkspacesRoot('/', '', {
        allowOutsideConfiguredRoots: true,
        protectedPaths: ['/app/data'],
      }),
    ).toMatch(/protected platform storage/)
  })

  it('rejects a symlink that escapes an approved root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'scm-workspace-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'scm-workspace-outside-'))
    tempDirs.push(root, outside)
    await mkdir(join(root, 'approved'), { recursive: true })
    await symlink(outside, join(root, 'approved', 'linked'))

    expect(
      validateScmWorkspacesRoot(
        join(root, 'approved', 'linked', 'source-a'),
        join(root, 'approved'),
        { protectedPaths: [join(tmpdir(), 'unrelated-protected-path')] },
      ),
    ).toMatch(/SCM_WORKSPACES_ALLOWED_ROOTS/)
  })

  it('fails closed for a legacy non-admin source outside approved roots', async () => {
    expect(
      await validateStoredScmWorkspacesRoot(
        { id: 'scm_legacy', workspacesPath: '/legacy/custom/workspaces', userId: 'usr_user' },
        false,
      ),
    ).toMatch(/Unsafe saved workspacesPath.*approved dedicated root/)
  })

  it('keeps a non-admin source on the historical default root usable after an upgrade', async () => {
    const originalStorageRoot = env.SCM_STORAGE_ROOT
    env.SCM_STORAGE_ROOT = '/data/workspace'
    try {
      expect(
        await validateStoredScmWorkspacesRoot(
          {
            id: 'scm_legacy_default',
            workspacesPath: join(homedir(), '.a2wave', 'workspaces', 'legacy-source'),
            userId: 'usr_user',
          },
          false,
        ),
      ).toBeNull()
    } finally {
      env.SCM_STORAGE_ROOT = originalStorageRoot
    }
  })

  it('keeps an active admin-owned dedicated custom root compatible', async () => {
    expect(
      await validateStoredScmWorkspacesRoot(
        { id: 'scm_admin', workspacesPath: '/srv/admin-selected/source-a', userId: 'usr_admin' },
        true,
      ),
    ).toBeNull()
  })

  /**
   * The write-path planner rejects a worktree root that overlaps another
   * source's checkout, but the runtime backstop only ever compared against
   * allowed roots and platform storage — it had no notion of peers at all.
   *
   * That gap is reachable without any write: `SCM_STORAGE_ROOT` itself is a
   * legacy allowed root (kept so upgraded deployments keep working), and the
   * managed-checkout rule below it only excludes `SCM_STORAGE_ROOT/sources`. A
   * P4 source's `localPath` is operator-chosen and lives nowhere near that
   * subtree, so a row created before the planner existed can hold a worktree
   * root sitting directly on top of another source's checkout. Worktree cleanup
   * on the one then deletes the other's working tree.
   */
  it('rejects a stored root that overlaps another source checkout', async () => {
    expect(
      await validateStoredScmWorkspacesRoot(
        { id: 'scm_a', workspacesPath: '/srv/p4-checkout/worktrees', userId: 'usr_admin' },
        true,
        [{ id: 'scm_b', name: 'P4 main', localPath: '/srv/p4-checkout', workspacesPath: null }],
      ),
    ).toMatch(/overlaps/i)
  })

  it('ignores the source own row when scanning peers', async () => {
    expect(
      await validateStoredScmWorkspacesRoot(
        { id: 'scm_a', workspacesPath: '/srv/admin-selected/source-a', userId: 'usr_admin' },
        true,
        [
          {
            id: 'scm_a',
            name: 'self',
            localPath: '/srv/admin-selected/source-a/checkout',
            workspacesPath: '/srv/admin-selected/source-a',
          },
        ],
      ),
    ).toBeNull()
  })
})
