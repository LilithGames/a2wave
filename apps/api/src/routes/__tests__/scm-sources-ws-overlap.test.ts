import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Path planning is pure; the db import is transitive via scm-workspace-safety.
vi.mock('../../db/client.js', () => ({ db: {} }))

import { env } from '../../env.js'
import { defaultWorkspacesPath } from '../../lib/git-workspace.js'
import { pathsOverlap, resolveScmPathPlan } from '../../lib/scm-path-plan.js'

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
      localPath: join(env.SCM_STORAGE_ROOT, 'SOURCES'),
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
      localPath: join(env.SCM_STORAGE_ROOT, 'SOURCES'),
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
