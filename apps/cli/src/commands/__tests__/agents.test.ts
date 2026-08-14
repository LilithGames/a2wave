import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockGetRaw = vi.fn()
const mockPatch = vi.fn()
const mockPost = vi.fn()
const mockDel = vi.fn()
const mockResolveAgentId = vi.fn()
const mockResolveSkillId = vi.fn()
const mockResolveMcpServerId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    getRaw: mockGetRaw,
    patch: mockPatch,
    post: mockPost,
    del: mockDel,
    resolveAgentId: mockResolveAgentId,
    resolveSkillId: mockResolveSkillId,
    resolveMcpServerId: mockResolveMcpServerId,
  }),
}))

const mockWriteFileSync = vi.fn()
const mockExistsSync = vi.fn().mockReturnValue(false)
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
    existsSync: (...a: unknown[]) => mockExistsSync(...a),
  }
})

// Must import after mocks
const { agentsCommand } = await import('../agents.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
interface TestGroupCommand {
  subCommands: Record<string, TestSubCommand>
}

function getSubCommand(name: string) {
  const subCommands = agentsCommand.subCommands as Record<string, TestSubCommand>
  return subCommands[name]
}

function getGroupSub(group: string, name: string) {
  const groups = agentsCommand.subCommands as Record<string, TestGroupCommand>
  return groups[group].subCommands[name]
}

describe('agentsCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    process.exitCode = 0
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  describe('diagnose', () => {
    const sampleResult = {
      ok: true,
      meta: { scope: 'current_api_process', checkedAt: '2026-05-15T07:00:00.000Z' },
      checks: [
        { id: 'execution.provider', severity: 'info', message: 'provider OK' },
        { id: 'provider.cli', severity: 'warn', message: 'provider CLI not installed' },
      ],
    }

    it('GETs /diagnose and prints each check', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({ data: sampleResult })

      await getSubCommand('diagnose').run({ args: { id: 'agt_1' } })

      expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/diagnose')
      const out = consoleSpy.mock.calls.flat().join('\n')
      expect(out).toContain('✓ ok')
      expect(out).toContain('[info] execution.provider')
      expect(out).toContain('[warn] provider.cli')
    })

    it('sets process.exitCode=1 when ok=false', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_2')
      mockGet.mockResolvedValueOnce({
        data: {
          ...sampleResult,
          ok: false,
          checks: [{ id: 'feishu.ws', severity: 'error', message: 'socket closed' }],
        },
      })

      await getSubCommand('diagnose').run({ args: { id: 'agt_2' } })

      expect(process.exitCode).toBe(1)
    })

    it('emits the raw payload with --json', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({ data: sampleResult })

      await getSubCommand('diagnose').run({ args: { id: 'agt_1', json: true } })

      expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual({ data: sampleResult })
    })

    it('still sets process.exitCode=1 under --json', async () => {
      // diagnose doubles as a CI gate. The exit code has to be set BEFORE the
      // early --json return, or piping to jq silently turns a red check green —
      // the same trap `runs rerun --wait` and `eval run --wait` document.
      mockResolveAgentId.mockResolvedValueOnce('agt_2')
      mockGet.mockResolvedValueOnce({ data: { ...sampleResult, ok: false } })

      await getSubCommand('diagnose').run({ args: { id: 'agt_2', json: true } })

      expect(process.exitCode).toBe(1)
    })
  })

  describe('list', () => {
    it('defaults to the historical 100-row window', async () => {
      // The default deliberately stays 100 rather than dropping to the
      // 20 that `runs list` uses: lowering it would silently truncate output
      // for anyone already relying on `agents list` showing everything.
      // `--limit` adds control without changing what a bare call returns.
      mockGet.mockResolvedValueOnce({ data: [] })
      await getSubCommand('list').run({ args: {} })
      expect(mockGet).toHaveBeenCalledWith('/api/agents?page=1&pageSize=100')
    })

    it('honours --limit and --page', async () => {
      mockGet.mockResolvedValueOnce({ data: [] })
      await getSubCommand('list').run({ args: { limit: '5', page: '2' } })
      expect(mockGet).toHaveBeenCalledWith('/api/agents?page=2&pageSize=5')
    })

    it('prints agents with id, status, name, and description', async () => {
      mockGet.mockResolvedValueOnce({
        data: [
          { id: 'agt_1', name: 'Bot A', publishStatus: 'published', description: 'A bot' },
          { id: 'agt_2', name: 'Bot B', publishStatus: 'draft', description: null },
        ],
      })

      await getSubCommand('list').run({ args: {} })

      expect(mockGet).toHaveBeenCalledWith('/api/agents?page=1&pageSize=100')
      expect(consoleSpy).toHaveBeenCalledWith('agt_1  [published]  Bot A  A bot')
      expect(consoleSpy).toHaveBeenCalledWith('agt_2  [draft]  Bot B')
    })

    it('prints message when no agents exist', async () => {
      mockGet.mockResolvedValueOnce({ data: [] })

      await getSubCommand('list').run({ args: {} })

      expect(consoleSpy).toHaveBeenCalledWith('No Agents yet')
    })
  })

  describe('get', () => {
    it('prints agent details', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'agt_1',
          name: 'Bot A',
          type: 'claude',
          status: 'active',
          publishStatus: 'published',
          description: 'A bot',
          skills: ['skl_1', 'skl_2'],
        },
      })

      await getSubCommand('get').run({ args: { id: 'agt_1' } })

      expect(mockResolveAgentId).toHaveBeenCalledWith('agt_1')
      expect(consoleSpy).toHaveBeenCalledWith('ID:            agt_1')
      expect(consoleSpy).toHaveBeenCalledWith('Name:          Bot A')
      expect(consoleSpy).toHaveBeenCalledWith('Skills:        skl_1, skl_2')
    })

    it('resolves agent by name', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'agt_1',
          name: 'Bot A',
          type: 'claude',
          status: 'active',
          publishStatus: 'published',
          description: null,
          skills: [],
        },
      })

      await getSubCommand('get').run({ args: { id: 'Bot A' } })

      expect(mockResolveAgentId).toHaveBeenCalledWith('Bot A')
    })

    it('prints expanded run config (provider/workspace/env/gateway)', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'agt_1',
          name: 'Bot A',
          type: 'cursor',
          status: 'active',
          publishStatus: 'published',
          description: null,
          skills: [],
          providerId: 'prv_x',
          authMode: 'apiKey',
          workspaceType: 'scm',
          scmSourceId: 'scm_1',
          maxConcurrency: 3,
          env: {
            LARK_APP_ID: { value: 'cli_public', sensitive: false },
            SECRET: { value: 'super-secret', sensitive: true },
          },
          a2aSkills: [{ id: 's1', name: 'Summarize' }],
        },
      })

      await getSubCommand('get').run({ args: { id: 'agt_1' } })

      const out = consoleSpy.mock.calls.flat().join('\n')
      expect(out).toContain('Provider:      prv_x')
      expect(out).toContain('Workspace:     scm (scm_1)')
      expect(out).toContain('Max Concurr.:  3')
      // Sensitive variables are masked; non-sensitive shown in plaintext
      expect(out).toContain('LARK_APP_ID = cli_public')
      expect(out).toContain('SECRET = ********')
      expect(out).not.toContain('super-secret')
      expect(out).toContain('A2A outbound skills: Summarize')
    })

    it('counts a single-object scheduleConfig as one schedule', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'agt_1',
          name: 'Bot A',
          type: 'cursor',
          status: 'active',
          publishStatus: 'published',
          description: null,
          skills: [],
          // scheduleConfig is a union(single, array) — a bare object for a single entry
          scheduleConfig: { cron: '0 9 * * 1-5', intent: 'Daily report reminder' },
        },
      })

      await getSubCommand('get').run({ args: { id: 'agt_1' } })

      const out = consoleSpy.mock.calls.flat().join('\n')
      expect(out).toContain('Schedules:     1 entries')
    })

    it('lists config keys only (no value dump) to avoid leaking secrets', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'agt_1',
          name: 'Bot A',
          type: 'cursor',
          status: 'active',
          publishStatus: 'published',
          description: null,
          skills: [],
          config: { model: 'claude-opus-4-8', apiKey: 'sk-super-secret' },
        },
      })

      await getSubCommand('get').run({ args: { id: 'agt_1' } })

      const out = consoleSpy.mock.calls.flat().join('\n')
      expect(out).toContain('config:        configured (keys: model, apiKey)')
      expect(out).not.toContain('sk-super-secret')
    })

    it('prints artifact policy (defaults when absent)', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'agt_1',
          name: 'Bot A',
          type: 'claude',
          status: 'active',
          publishStatus: 'published',
          description: null,
          skills: [],
        },
      })

      await getSubCommand('get').run({ args: { id: 'agt_1' } })

      const out = consoleSpy.mock.calls.flat().join('\n')
      expect(out).toContain('--- Artifact Policy ---')
      expect(out).toContain('Auto share:    disabled')
      expect(out).toContain('Access level:  login required')
      expect(out).toContain('Share expiry:  7 days')
    })

    it('prints artifact policy values when present', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'agt_1',
          name: 'Bot A',
          type: 'claude',
          status: 'active',
          publishStatus: 'published',
          description: null,
          skills: [],
          artifactPolicy: {
            autoShare: 'on',
            shareAccessLevel: 'public',
            shareExpiryDays: 30,
          },
        },
      })

      await getSubCommand('get').run({ args: { id: 'agt_1' } })

      const out = consoleSpy.mock.calls.flat().join('\n')
      expect(out).toContain('Auto share:    enabled')
      expect(out).toContain('Access level:  public')
      expect(out).toContain('Share expiry:  30 days')
    })

    it('prints system prompt when present', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: {
          id: 'agt_1',
          name: 'Bot A',
          type: 'claude',
          status: 'active',
          publishStatus: 'published',
          description: null,
          skills: [],
          systemPrompt: 'You are a helpful bot.',
        },
      })

      await getSubCommand('get').run({ args: { id: 'agt_1' } })

      expect(consoleSpy).toHaveBeenCalledWith('\n--- System Prompt ---')
      expect(consoleSpy).toHaveBeenCalledWith('You are a helpful bot.')
    })
  })

  describe('update', () => {
    it('updates name and description', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', name: 'New Name', description: 'New Desc' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        name: 'New Name',
        description: 'New Desc',
      })
      expect(consoleSpy).toHaveBeenCalledWith('Agent updated ✓')
    })

    it('updates system prompt', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'system-prompt': 'You are helpful.' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        systemPrompt: 'You are helpful.',
      })
    })

    it('adds a skill to existing list', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: { skills: ['skl_1'], mcpServerIds: [] },
      })
      mockResolveSkillId.mockResolvedValueOnce('skl_2')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'add-skill': 'My Skill' },
      })

      expect(mockResolveSkillId).toHaveBeenCalledWith('My Skill')
      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        skills: ['skl_1', 'skl_2'],
      })
    })

    it('does not duplicate when adding existing skill', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: { skills: ['skl_1'], mcpServerIds: [] },
      })
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'add-skill': 'skl_1' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        skills: ['skl_1'],
      })
    })

    it('removes a skill from existing list', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: { skills: ['skl_1', 'skl_2'], mcpServerIds: [] },
      })
      mockResolveSkillId.mockResolvedValueOnce('skl_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'remove-skill': 'skl_1' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        skills: ['skl_2'],
      })
    })

    it('adds an MCP server', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: { skills: [], mcpServerIds: ['mcp_1'] },
      })
      mockResolveMcpServerId.mockResolvedValueOnce('mcp_2')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'add-mcp': 'My MCP' },
      })

      expect(mockResolveMcpServerId).toHaveBeenCalledWith('My MCP')
      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        mcpServerIds: ['mcp_1', 'mcp_2'],
      })
    })

    it('removes an MCP server', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: { skills: [], mcpServerIds: ['mcp_1', 'mcp_2'] },
      })
      mockResolveMcpServerId.mockResolvedValueOnce('mcp_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'remove-mcp': 'mcp_1' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        mcpServerIds: ['mcp_2'],
      })
    })

    it('does not duplicate when adding existing MCP server', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: { skills: [], mcpServerIds: ['mcp_1'] },
      })
      mockResolveMcpServerId.mockResolvedValueOnce('mcp_1')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'add-mcp': 'mcp_1' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        mcpServerIds: ['mcp_1'],
      })
    })

    it('updates skills and MCP servers in a single call', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: { skills: ['skl_1'], mcpServerIds: ['mcp_1'] },
      })
      mockResolveSkillId.mockResolvedValueOnce('skl_2')
      mockResolveMcpServerId.mockResolvedValueOnce('mcp_2')
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'add-skill': 'New Skill', 'add-mcp': 'New MCP' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        skills: ['skl_1', 'skl_2'],
        mcpServerIds: ['mcp_1', 'mcp_2'],
      })
    })

    it('throws when no fields specified', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')

      await expect(getSubCommand('update').run({ args: { id: 'agt_1' } })).rejects.toThrow(
        'Specify at least one field to update',
      )
    })

    it('merges artifact policy when setting a single field', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: {
          skills: [],
          mcpServerIds: [],
          artifactPolicy: {
            autoShare: 'on',
            shareAccessLevel: 'public',
            shareExpiryDays: 30,
          },
        },
      })
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'share-expiry-days': '14' },
      })

      // Only expiry changes; autoShare / accessLevel keep their current values
      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        artifactPolicy: {
          autoShare: 'on',
          shareAccessLevel: 'public',
          shareExpiryDays: 14,
        },
      })
    })

    it('applies schema defaults when agent has no existing policy', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: { skills: [], mcpServerIds: [], artifactPolicy: null },
      })
      mockPatch.mockResolvedValueOnce({})

      await getSubCommand('update').run({
        args: { id: 'agt_1', 'auto-share': 'on', 'share-access-level': 'public' },
      })

      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_1', {
        artifactPolicy: {
          autoShare: 'on',
          shareAccessLevel: 'public',
          shareExpiryDays: 7,
        },
      })
    })

    it('rejects invalid --auto-share', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({ data: { skills: [], mcpServerIds: [] } })

      await expect(
        getSubCommand('update').run({ args: { id: 'agt_1', 'auto-share': 'yes' } }),
      ).rejects.toThrow('Invalid --auto-share')
      expect(mockPatch).not.toHaveBeenCalled()
    })

    it('rejects out-of-range --share-expiry-days', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({ data: { skills: [], mcpServerIds: [] } })

      await expect(
        getSubCommand('update').run({ args: { id: 'agt_1', 'share-expiry-days': '400' } }),
      ).rejects.toThrow('Invalid --share-expiry-days')
      expect(mockPatch).not.toHaveBeenCalled()
    })
  })

  describe('delete', () => {
    it('deletes resolved agent with --force', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockDel.mockResolvedValueOnce({})
      await getSubCommand('delete').run({ args: { id: 'My Agent', force: true } })
      expect(mockResolveAgentId).toHaveBeenCalledWith('My Agent')
      expect(mockDel).toHaveBeenCalledWith('/api/agents/agt_1')
      expect(consoleSpy).toHaveBeenCalledWith('Agent deleted ✓')
    })

    it('refuses to delete without --force in a non-interactive shell', async () => {
      // vitest runs with no TTY on stdin → confirmDestructive requires --force.
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      await expect(getSubCommand('delete').run({ args: { id: 'My Agent' } })).rejects.toThrow(
        /--force/,
      )
      expect(mockDel).not.toHaveBeenCalled()
    })
  })

  describe('stats', () => {
    it('prints stats returned bare (not wrapped in data)', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        total: 10,
        successRate: '90%',
        avgDuration: '2s',
        todayRuns: 3,
        askerCount: 5,
        // Backend contract: byStatus is an object (not an array); only channelBreakdown is an array.
        byStatus: { completed: 9, failed: 1, running: 0, pending: 0, queued: 0, cancelled: 0 },
        channelBreakdown: [{ source: 'feishu', count: 7 }],
      })
      await getSubCommand('stats').run({ args: { id: 'agt_1' } })
      expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/stats')
      expect(consoleSpy).toHaveBeenCalledWith('Total runs:    10')
      expect(consoleSpy).toHaveBeenCalledWith('By status:')
      expect(consoleSpy).toHaveBeenCalledWith('  completed: 9')
      expect(consoleSpy).toHaveBeenCalledWith('  failed: 1')
      expect(consoleSpy).toHaveBeenCalledWith('  feishu: 7')
    })

    it('emits the raw payload with --json', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      const payload = { total: 10, byStatus: { completed: 9 }, channelBreakdown: [] }
      mockGet.mockResolvedValueOnce(payload)

      await getSubCommand('stats').run({ args: { id: 'agt_1', json: true } })

      expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual(payload)
    })
  })

  describe('artifacts', () => {
    it('lists artifacts by agentId', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: [
          { id: 'art_1', filename: 'chart.svg', kind: 'file', size: 100, createdAt: '2026-01-01' },
        ],
      })
      await getGroupSub('artifacts', 'list').run({ args: { agent: 'agt_1' } })
      expect(mockGet).toHaveBeenCalledWith('/api/artifacts?agentId=agt_1')
      expect(consoleSpy).toHaveBeenCalledWith('art_1  [file]  chart.svg  100B  2026-01-01')
    })

    it('downloads artifact using content-disposition filename', async () => {
      mockGetRaw.mockResolvedValueOnce({
        headers: {
          get: (k: string) =>
            k === 'content-disposition' ? "attachment; filename*=UTF-8''report.zip" : null,
        },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      })
      await getGroupSub('artifacts', 'download').run({ args: { id: 'art_1' } })
      expect(mockGetRaw).toHaveBeenCalledWith('/api/artifacts/art_1/download')
      expect(mockWriteFileSync).toHaveBeenCalledWith('report.zip', expect.any(Buffer))
    })

    it('strips path components from a malicious content-disposition filename', async () => {
      mockGetRaw.mockResolvedValueOnce({
        headers: {
          get: (k: string) =>
            k === 'content-disposition'
              ? "attachment; filename*=UTF-8''%2E%2E%2F%2E%2E%2F.bashrc"
              : null,
        },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      })
      await getGroupSub('artifacts', 'download').run({ args: { id: 'art_1' } })
      // basename('../../.bashrc') === '.bashrc' → stays in the current directory, no traversal
      expect(mockWriteFileSync).toHaveBeenCalledWith('.bashrc', expect.any(Buffer))
    })

    it('falls back to artifactId when there is no content-disposition', async () => {
      mockGetRaw.mockResolvedValueOnce({
        headers: { get: () => null },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      })
      await getGroupSub('artifacts', 'download').run({ args: { id: 'art_1' } })
      expect(mockWriteFileSync).toHaveBeenCalledWith('art_1', expect.any(Buffer))
    })

    it('refuses to overwrite an existing target without --force', async () => {
      mockExistsSync.mockReturnValue(true)
      mockGetRaw.mockResolvedValueOnce({
        headers: {
          get: (k: string) =>
            k === 'content-disposition' ? "attachment; filename*=UTF-8''report.zip" : null,
        },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      })
      await expect(
        getGroupSub('artifacts', 'download').run({ args: { id: 'art_1' } }),
      ).rejects.toThrow(/already exists/)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
    })

    it('overwrites an existing target with --force', async () => {
      mockExistsSync.mockReturnValue(true)
      mockGetRaw.mockResolvedValueOnce({
        headers: {
          get: (k: string) =>
            k === 'content-disposition' ? "attachment; filename*=UTF-8''report.zip" : null,
        },
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      })
      await getGroupSub('artifacts', 'download').run({ args: { id: 'art_1', force: true } })
      expect(mockWriteFileSync).toHaveBeenCalledWith('report.zip', expect.any(Buffer))
    })

    it('deletes an artifact', async () => {
      mockDel.mockResolvedValueOnce({})
      // `--force` is now required: artifact delete is high-risk-write, and
      // this suite runs without a TTY exactly as an agent does.
      await getGroupSub('artifacts', 'delete').run({ args: { id: 'art_1', force: true } })
      expect(mockDel).toHaveBeenCalledWith('/api/artifacts/art_1')
    })
  })

  describe('memory', () => {
    it('stats unwraps { data } and prints it', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({ data: { total: 42, byKind: { fact: 40 } } })
      await getGroupSub('memory', 'stats').run({ args: { agent: 'agt_1' } })
      expect(mockGet).toHaveBeenCalledWith('/api/memories/agt_1/stats')
      // Asserted on the parsed value, not the exact string: the JSON layout is
      // emit()'s concern (compact by default, indented under --json-pretty),
      // and pinning it here would fail the whole suite on a formatting change
      // that is not this command's behaviour.
      const printed = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))
      expect(printed).toEqual({ total: 42, byKind: { fact: 40 } })
    })

    it('search uses q query param', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({ data: { results: [{ text: 'x' }] } })
      await getGroupSub('memory', 'search').run({ args: { agent: 'agt_1', query: 'hello world' } })
      expect(mockGet).toHaveBeenCalledWith('/api/memories/agt_1/search?q=hello%20world')
    })

    // Memory content is free-form text an Agent wrote about its own work, so
    // unlike the scm probes there is no server-side allowlist bounding it — a
    // recalled note can contain anything the Agent once saw, credentials
    // included. This printed raw, outside emit(), with no redaction and no way
    // to opt into machine-readable output.
    it('search redacts credential-bearing fields', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({
        data: { results: [{ text: 'deploy note', apiKey: 'sk-live-secret' }] },
      })

      await getGroupSub('memory', 'search').run({
        args: { agent: 'agt_1', query: 'deploy', json: true },
      })

      const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(out).not.toContain('sk-live-secret')
      expect(out).toContain('********')
      expect(out).toContain('deploy note')
    })

    it('stats redacts credential-bearing fields', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockGet.mockResolvedValueOnce({ data: { total: 1, providerApiKey: 'sk-live-secret' } })

      await getGroupSub('memory', 'stats').run({ args: { agent: 'agt_1', json: true } })

      const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
      expect(out).not.toContain('sk-live-secret')
      expect(out).toContain('********')
    })

    it('reindex posts', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockPost.mockResolvedValueOnce({})
      await getGroupSub('memory', 'reindex').run({ args: { agent: 'agt_1' } })
      expect(mockPost).toHaveBeenCalledWith('/api/memories/agt_1/reindex', {})
    })

    it('consolidate posts to the consolidate route', async () => {
      mockResolveAgentId.mockResolvedValueOnce('agt_1')
      mockPost.mockResolvedValueOnce({})
      await getGroupSub('memory', 'consolidate').run({ args: { agent: 'agt_1' } })
      expect(mockPost).toHaveBeenCalledWith('/api/memories/agt_1/consolidate', {})
      expect(consoleSpy).toHaveBeenCalledWith('Memory consolidation triggered ✓')
    })
  })
})
