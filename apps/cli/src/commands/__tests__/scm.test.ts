import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockDel = vi.fn()
const mockResolveScmSourceId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    del: mockDel,
    resolveScmSourceId: mockResolveScmSourceId,
  }),
}))

const { scmCommand } = await import('../scm.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
function getSubCommand(name: string) {
  return (scmCommand.subCommands as Record<string, TestSubCommand>)[name]
}

describe('scmCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('list', () => {
    it('prints sources with type and enabled', async () => {
      mockGet.mockResolvedValueOnce({
        data: [{ id: 'scm_1', name: 'repo', type: 'git', isEnabled: true, syncStatus: 'synced' }],
      })
      await getSubCommand('list').run({ args: {} })
      expect(mockGet).toHaveBeenCalledWith('/api/scm-sources?page=1&pageSize=100')
      expect(consoleSpy).toHaveBeenCalledWith('scm_1  [git]  repo  enabled  sync=synced')
    })
  })

  describe('create', () => {
    it('creates a managed git source when --local-path is omitted', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'scm_9', name: 'managed-repo' } })
      await getSubCommand('create').run({
        args: {
          name: 'managed-repo',
          type: 'git',
          'repo-url': 'https://git.test/managed.git',
        },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/scm-sources', {
        name: 'managed-repo',
        type: 'git',
        config: { type: 'git', repoUrl: 'https://git.test/managed.git' },
      })
    })

    it('builds git config', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'scm_9', name: 'repo' } })
      await getSubCommand('create').run({
        args: {
          name: 'repo',
          type: 'git',
          'local-path': '/data/repo',
          'repo-url': 'https://git.test/x.git',
          branch: 'dev',
        },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/scm-sources', {
        name: 'repo',
        type: 'git',
        localPath: '/data/repo',
        config: { type: 'git', repoUrl: 'https://git.test/x.git', branch: 'dev' },
      })
    })

    it('builds p4 config', async () => {
      mockPost.mockResolvedValueOnce({ data: { id: 'scm_9', name: 'p4src' } })
      await getSubCommand('create').run({
        args: {
          name: 'p4src',
          type: 'p4',
          'local-path': '/data/p4',
          p4port: 'perforce:1666',
          p4user: 'bob',
          p4client: 'bob_ws',
        },
      })
      expect(mockPost).toHaveBeenCalledWith('/api/scm-sources', {
        name: 'p4src',
        type: 'p4',
        localPath: '/data/p4',
        config: { type: 'p4', p4port: 'perforce:1666', p4user: 'bob', p4client: 'bob_ws' },
      })
    })

    it('still requires --local-path for p4', async () => {
      await expect(
        getSubCommand('create').run({
          args: {
            name: 'p4src',
            type: 'p4',
            p4port: 'perforce:1666',
            p4user: 'bob',
            p4client: 'bob_ws',
          },
        }),
      ).rejects.toThrow('--local-path')
    })

    it('requires --type', async () => {
      await expect(
        getSubCommand('create').run({ args: { name: 'x', 'local-path': '/d' } }),
      ).rejects.toThrow('--type')
    })

    it('requires git repo-url', async () => {
      await expect(
        getSubCommand('create').run({ args: { name: 'x', type: 'git', 'local-path': '/d' } }),
      ).rejects.toThrow('--repo-url')
    })
  })

  describe('sync', () => {
    it('posts sync', async () => {
      mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
      mockPost.mockResolvedValueOnce({})
      await getSubCommand('sync').run({ args: { id: 'repo' } })
      expect(mockPost).toHaveBeenCalledWith('/api/scm-sources/scm_1/sync', {})
    })
  })

  describe('delete', () => {
    it('deletes resolved id', async () => {
      mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
      mockDel.mockResolvedValueOnce({})
      // `--force` is now required: delete is high-risk-write, and this suite
      // runs without a TTY exactly as an agent does.
      await getSubCommand('delete').run({ args: { id: 'repo', force: true } })
      expect(mockDel).toHaveBeenCalledWith('/api/scm-sources/scm_1')
    })
  })
})

describe('scm workspaces / codegraph', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  function nested(...path: string[]): TestSubCommand {
    let node: Record<string, unknown> = scmCommand as unknown as Record<string, unknown>
    for (const p of path) {
      node = (node.subCommands as Record<string, Record<string, unknown>>)[p]
    }
    return node as unknown as TestSubCommand
  }

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('lists worktrees with their occupied state', async () => {
    mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
    mockGet.mockResolvedValueOnce({
      data: [
        { name: 'eval-evt_1', path: '/ws/eval-evt_1', branch: 'main', occupied: true },
        { name: 'free-one', path: '/ws/free-one', occupied: false },
      ],
    })

    await nested('workspaces', 'list').run({ args: { id: 'repo' } })

    expect(mockGet).toHaveBeenCalledWith('/api/scm-sources/scm_1/workspaces')
    const printed = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(printed).toContain('occupied')
    expect(printed).toContain('free')
  })

  it('reports an empty worktree list', async () => {
    mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
    mockGet.mockResolvedValueOnce({ data: [] })

    await nested('workspaces', 'list').run({ args: { id: 'repo' } })

    expect(consoleSpy).toHaveBeenCalledWith('No worktrees')
  })

  it('url-encodes the worktree name on delete', async () => {
    mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
    mockDel.mockResolvedValueOnce({})

    await nested('workspaces', 'remove').run({
      args: { id: 'repo', name: 'feat/x', force: true },
    })

    expect(mockDel).toHaveBeenCalledWith('/api/scm-sources/scm_1/workspaces/feat%2Fx')
  })

  it('triggers a codegraph reindex', async () => {
    mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
    mockPost.mockResolvedValueOnce({ data: {} })

    await nested('codegraph', 'reindex').run({ args: { id: 'repo' } })

    expect(mockPost).toHaveBeenCalledWith('/api/scm-sources/scm_1/codegraph/reindex', {})
  })

  it('emits raw JSON for worktrees with --json', async () => {
    mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
    const payload = { data: [{ name: 'w', path: '/p', occupied: false }] }
    mockGet.mockResolvedValueOnce(payload)

    await nested('workspaces', 'list').run({ args: { id: 'repo', json: true } })

    // Parsed, not string-compared: the JSON layout belongs to emit().
    expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual(payload)
  })
})

describe('scm workspaces branch rendering', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  function nested2(...path: string[]): TestSubCommand {
    let node: Record<string, unknown> = scmCommand as unknown as Record<string, unknown>
    for (const p of path) {
      node = (node.subCommands as Record<string, Record<string, unknown>>)[p]
    }
    return node as unknown as TestSubCommand
  }

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('reads the branch from repos[], since WorkspaceInfo has no branch field', async () => {
    mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
    mockGet.mockResolvedValueOnce({
      data: [
        { name: 'w1', path: '/p1', occupied: false, repos: [{ directory: '', branch: 'main' }] },
      ],
    })

    await nested2('workspaces', 'list').run({ args: { id: 'repo' } })

    expect(consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain('main')
  })

  it('labels each sub-repo in multi-repo workspaces', async () => {
    mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
    mockGet.mockResolvedValueOnce({
      data: [
        {
          name: 'w1',
          path: '/p1',
          occupied: false,
          repos: [
            { directory: 'web', branch: 'main' },
            { directory: 'api', branch: null },
          ],
        },
      ],
    })

    await nested2('workspaces', 'list').run({ args: { id: 'repo' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('web=main')
    expect(out).toContain('api=detached')
  })

  // `check` and `status` printed `JSON.stringify(data, null, 2)` directly,
  // bypassing emit() and therefore redactSecrets(). The server sanitizes these
  // two payloads today, so this is defence in depth rather than a live leak —
  // but the CLI is the last hop before a terminal scrollback or a CI log, and
  // it must not depend on every upstream route staying careful. Both are also
  // the only scm commands with no `--json`, so a caller had no way to ask for
  // the machine-readable form these were already emitting.
  describe('check', () => {
    it('redacts credential-bearing fields instead of dumping raw', async () => {
      mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
      mockPost.mockResolvedValueOnce({
        data: { ok: false, message: 'failed', repoUrl: 'https://u:tok@git.example/o/r.git' },
      })

      await getSubCommand('check').run({ args: { id: 'repo', json: true } })

      const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(out).not.toContain('tok')
      expect(out).toContain('********')
      // The non-secret parts of the URL stay usable.
      expect(out).toContain('git.example')
    })

    it('still prints the payload when --json is absent', async () => {
      mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
      mockPost.mockResolvedValueOnce({ data: { ok: true, message: 'healthy' } })

      await getSubCommand('check').run({ args: { id: 'repo' } })

      const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(out).toContain('healthy')
    })
  })

  describe('status', () => {
    it('redacts credential-bearing fields instead of dumping raw', async () => {
      mockResolveScmSourceId.mockResolvedValueOnce('scm_1')
      mockGet.mockResolvedValueOnce({
        data: {
          syncStatus: 'error',
          lastSyncError: 'auth failed',
          repoUrl: 'https://u:tok@git.example/o/r.git',
        },
      })

      await getSubCommand('status').run({ args: { id: 'repo', json: true } })

      const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(out).not.toContain('tok')
      expect(out).toContain('********')
      expect(out).toContain('auth failed')
    })
  })
})
