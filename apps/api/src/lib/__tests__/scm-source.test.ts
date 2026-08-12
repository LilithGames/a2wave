import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCreateGitWorkspace = vi.fn()
const mockRemoveGitWorkspace = vi.fn()
const mockListGitWorkspaces = vi.fn()
const mockDefaultWorkspacesPath = vi.fn((name: string) => `/home/user/.a2wave/${name}`)

vi.mock('../git-workspace.js', () => ({
  createGitWorkspace: (...args: unknown[]) => mockCreateGitWorkspace(...args),
  removeGitWorkspace: (...args: unknown[]) => mockRemoveGitWorkspace(...args),
  listGitWorkspaces: (...args: unknown[]) => mockListGitWorkspaces(...args),
  defaultWorkspacesPath: (name: string) => mockDefaultWorkspacesPath(name),
}))

const mockAssertStoredScmWorkspacesRoot = vi.fn<(source: unknown) => Promise<void>>()

vi.mock('../scm-workspace-safety.js', () => ({
  assertStoredScmWorkspacesRoot: (source: unknown) => mockAssertStoredScmWorkspacesRoot(source),
}))

import { type ScmSourceRow, createScmSource } from '../scm-source.js'

function makeGitSourceRow(overrides?: Partial<ScmSourceRow>): ScmSourceRow {
  return {
    id: 'my-repo',
    type: 'git',
    localPath: '/data/repos/my-repo',
    name: 'my-repo',
    config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', branch: 'main' },
    ...overrides,
  }
}

describe('createScmSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAssertStoredScmWorkspacesRoot.mockResolvedValue(undefined)
  })

  describe('unsafe workspaces-root backstop', () => {
    /**
     * Regression: the assertion is async (it resolves the owner's live role from
     * the DB). When the factory did not await it, the returned Promise was
     * merely truthy, the source was handed back anyway, and the rejection
     * escaped as an unhandled one — the backstop never blocked anything.
     */
    it('rejects instead of returning a source when the stored root is unsafe', async () => {
      const failure = new Error('Unsafe saved workspacesPath')
      mockAssertStoredScmWorkspacesRoot.mockRejectedValue(failure)

      await expect(createScmSource(makeGitSourceRow({ workspacesPath: '/etc' }))).rejects.toThrow(
        failure,
      )
    })

    it('awaits the assertion before constructing the source', async () => {
      let assertionSettled = false
      mockAssertStoredScmWorkspacesRoot.mockImplementation(async () => {
        await Promise.resolve()
        assertionSettled = true
      })

      const source = await createScmSource(makeGitSourceRow())

      expect(assertionSettled).toBe(true)
      expect(source).not.toBeNull()
    })

    it('does not validate a type that has no workspace support', async () => {
      expect(await createScmSource(makeGitSourceRow({ type: 'p4' }))).toBeNull()
      expect(mockAssertStoredScmWorkspacesRoot).not.toHaveBeenCalled()
    })
  })

  it('returns GitScmSource for git type', async () => {
    const source = await createScmSource(makeGitSourceRow())
    expect(source).not.toBeNull()
    expect(source!.type).toBe('git')
    expect(source!.localPath).toBe('/data/repos/my-repo')
  })

  it('returns null for unsupported types', async () => {
    expect(await createScmSource(makeGitSourceRow({ type: 'p4' }))).toBeNull()
    expect(await createScmSource(makeGitSourceRow({ type: 'svn' }))).toBeNull()
  })

  describe('GitScmSource wsRoot resolution', () => {
    it('uses source.workspacesPath when set', async () => {
      const source = await createScmSource(makeGitSourceRow({ workspacesPath: '/custom/ws' }))
      expect(source!.wsRoot).toBe('/custom/ws')
      expect(mockDefaultWorkspacesPath).not.toHaveBeenCalled()
    })

    it('falls back to defaultWorkspacesPath when no explicit path', async () => {
      const source = await createScmSource(makeGitSourceRow({ workspacesPath: null }))
      expect(source!.wsRoot).toBe('/home/user/.a2wave/my-repo')
      expect(mockDefaultWorkspacesPath).toHaveBeenCalledWith('my-repo')
    })
  })

  describe('GitScmSource workspace methods', () => {
    it('delegates createWorkspace to createGitWorkspace', async () => {
      mockCreateGitWorkspace.mockResolvedValue({ path: '/ws/path/ws-abc', created: true })
      const source = await createScmSource(makeGitSourceRow({ workspacesPath: '/ws/path' }))

      const result = await source!.createWorkspace('ws-abc')

      expect(result).toEqual({ path: '/ws/path/ws-abc', created: true })
      expect(mockCreateGitWorkspace).toHaveBeenCalledWith(
        '/data/repos/my-repo',
        '/ws/path',
        'ws-abc',
        expect.objectContaining({ type: 'git' }),
        undefined,
      )
    })

    it('delegates removeWorkspace to removeGitWorkspace', async () => {
      mockRemoveGitWorkspace.mockResolvedValue(undefined)
      const source = await createScmSource(makeGitSourceRow({ workspacesPath: '/ws/path' }))

      await source!.removeWorkspace('ws-abc', { keepBranches: true })

      expect(mockRemoveGitWorkspace).toHaveBeenCalledWith(
        '/data/repos/my-repo',
        '/ws/path',
        'ws-abc',
        expect.objectContaining({ type: 'git' }),
        { keepBranches: true },
      )
    })

    it('delegates listWorkspaces to listGitWorkspaces', async () => {
      const workspaces = [{ name: 'ws-a', path: '/ws/ws-a', branch: null, commit: 'abc1234' }]
      mockListGitWorkspaces.mockResolvedValue(workspaces)
      const source = await createScmSource(makeGitSourceRow({ workspacesPath: '/ws' }))

      const result = await source!.listWorkspaces()

      expect(result).toEqual(workspaces)
      expect(mockListGitWorkspaces).toHaveBeenCalledWith(
        '/data/repos/my-repo',
        '/ws',
        expect.objectContaining({ type: 'git' }),
      )
    })
  })
})
