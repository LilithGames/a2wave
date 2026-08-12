import { describe, expect, it, vi } from 'vitest'

// Path planning is pure; the db import is transitive via scm-workspace-safety.
vi.mock('../../db/client.js', () => ({ db: {} }))

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
