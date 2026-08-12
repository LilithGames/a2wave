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

import { resolveScmPathPlan } from '../scm-path-plan.js'

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
