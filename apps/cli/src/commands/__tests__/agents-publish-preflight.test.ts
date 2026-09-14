import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../../errors.js'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockFindAgentByName = vi.fn()
const mockResolveAgentId = vi.fn(async (n: string) => (n.startsWith('agt_') ? n : `agt_${n}`))

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    findAgentByName: mockFindAgentByName,
    resolveAgentId: mockResolveAgentId,
    resolveProviderId: async (n: string) => `prv_${n}`,
    resolveSkillId: async (n: string) => `skl_${n}`,
    resolveSkillGroupId: async (n: string) => `skg_${n}`,
    resolveMcpServerId: async (n: string) => `mcp_${n}`,
    resolveKbDocumentId: async (n: string) => `kbd_${n}`,
    resolveScmSourceId: async (n: string) => `scm_${n}`,
  }),
}))

const { agentsCommand } = await import('../agents.js')

type SubCmd = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
const subs = agentsCommand.subCommands as Record<string, SubCmd>

const DIAGNOSE_URL = (id: string) => `/api/agents/${id}/diagnose`

function diagnose(
  checks: Array<{ id: string; severity: 'error' | 'warn' | 'info'; message: string }>,
) {
  return {
    data: {
      ok: !checks.some((c) => c.severity === 'error'),
      meta: { scope: 'agent', checkedAt: '2026-01-01T00:00:00Z' },
      checks,
    },
  }
}

const PROVIDER_ERRORS = [
  {
    id: 'provider_cli_not_installed',
    severity: 'error' as const,
    message: 'claude CLI is not installed',
  },
  {
    id: 'provider_chain_unusable',
    severity: 'error' as const,
    message: 'API key rejected (401)',
  },
  { id: 'feishu.config', severity: 'warn' as const, message: 'Feishu app secret not set' },
]

/**
 * Error-level items that describe the *runtime* state of an already-published
 * Agent (a Feishu socket not yet registered, a git-trigger poller that closed,
 * a CLI below its minimum version that the API itself says does not block
 * runs). Their remedy is publishing, so refusing to publish on them is a
 * deadlock.
 */
const RUNTIME_STATE_ERRORS = [
  { id: 'ws_not_registered', severity: 'error' as const, message: 'WS not registered' },
  { id: 'github_connection_closed', severity: 'error' as const, message: 'poller closed' },
  {
    id: 'provider_cli_version_below_minimum',
    severity: 'error' as const,
    message: 'installed 1.0.0, requires >= 2.0.0. This does not block runs.',
  },
]

/**
 * Publish preflight: an Agent whose Provider CLI is missing or whose
 * credential is wrong publishes fine and then cannot run a single turn. The
 * diagnose endpoint already knows; publish consults it before flipping the
 * switch, and `--skip-diagnose` is the explicit override.
 */
describe('publish preflight (GET /diagnose before POST /publish)', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    for (const m of [mockGet, mockPost, mockPatch, mockFindAgentByName]) m.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  const stderr = () => [...errorSpy.mock.calls, ...warnSpy.mock.calls].flat().join('\n')

  describe('agents publish', () => {
    it('aborts before POST /publish when diagnose reports an error, listing code + message', async () => {
      mockGet.mockResolvedValueOnce(diagnose(PROVIDER_ERRORS))

      const err = await subs.publish.run({ args: { id: 'agt_1' } }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).hint).toBe(
        'Fix the errors above, or pass --skip-diagnose to publish anyway.',
      )
      expect(mockGet).toHaveBeenCalledWith(DIAGNOSE_URL('agt_1'))
      expect(mockPost).not.toHaveBeenCalled()
      const out = stderr()
      expect(out).toContain('provider_cli_not_installed: claude CLI is not installed')
      expect(out).toContain('provider_chain_unusable: API key rejected (401)')
    })

    it('prints warn items as warnings and still publishes', async () => {
      mockGet.mockResolvedValueOnce(
        diagnose([{ id: 'feishu.config', severity: 'warn', message: 'Feishu app secret not set' }]),
      )
      mockPost.mockResolvedValueOnce({ data: {} })

      await subs.publish.run({ args: { id: 'agt_1' } })

      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/publish', {})
      expect(stderr()).toContain('feishu.config: Feishu app secret not set')
    })

    it('blocks only on "cannot run at all" ids; runtime-state errors are downgraded to warnings and publish proceeds', async () => {
      mockGet.mockResolvedValueOnce(diagnose(RUNTIME_STATE_ERRORS))
      mockPost.mockResolvedValueOnce({ data: {} })

      await subs.publish.run({ args: { id: 'agt_1' } })

      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/publish', {})
      const out = stderr()
      for (const c of RUNTIME_STATE_ERRORS) {
        expect(out).toContain(`${c.id}: ${c.message}`)
        expect(out).not.toContain(`[error] ${c.id}`)
      }
      expect(out).toMatch(/does not block publishing/i)
    })

    it('blocks when a blocking id is mixed with runtime-state errors, counting only the blocking one', async () => {
      mockGet.mockResolvedValueOnce(
        diagnose([
          ...RUNTIME_STATE_ERRORS,
          {
            id: 'provider_cli_not_installed',
            severity: 'error',
            message: 'claude CLI is not installed',
          },
        ]),
      )

      const err = await subs.publish.run({ args: { id: 'agt_1' } }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).message).toMatch(/found 1 error for agt_1/)
      expect(mockPost).not.toHaveBeenCalled()
      expect(stderr()).toContain('[error] provider_cli_not_installed: claude CLI is not installed')
    })

    it('publishes silently when diagnose is clean', async () => {
      mockGet.mockResolvedValueOnce(diagnose([{ id: 'engine', severity: 'info', message: 'ok' }]))
      mockPost.mockResolvedValueOnce({ data: {} })

      await subs.publish.run({ args: { id: 'agt_1' } })

      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/publish', {})
      expect(stderr()).toBe('')
    })

    it('--skip-diagnose skips the GET entirely and publishes', async () => {
      mockPost.mockResolvedValueOnce({ data: {} })

      await subs.publish.run({ args: { id: 'agt_1', 'skip-diagnose': true } })

      expect(mockGet).not.toHaveBeenCalled()
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/publish', {})
    })

    it('does not block when the diagnose endpoint itself fails; warns and continues', async () => {
      mockGet.mockRejectedValueOnce(new Error('fetch failed'))
      mockPost.mockResolvedValueOnce({ data: {} })

      await subs.publish.run({ args: { id: 'agt_1' } })

      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/publish', {})
      expect(stderr()).toMatch(/preflight could not run/i)
      expect(stderr()).toContain('fetch failed')
    })
  })

  describe('agents apply', () => {
    let dir: string
    let yamlPath: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'a2wave-preflight-'))
      yamlPath = join(dir, 'agent.yaml')
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    const YAML_WITH_PUBLISH = 'name: my-bot\npublish:\n  channels: [api]\n'

    it('CREATE path: creates the agent, then aborts before /publish on a diagnose error', async () => {
      writeFileSync(yamlPath, YAML_WITH_PUBLISH)
      mockFindAgentByName.mockResolvedValueOnce(null)
      mockPost.mockResolvedValueOnce({ data: { id: 'agt_new' } })
      mockGet.mockResolvedValueOnce(diagnose(PROVIDER_ERRORS))

      const err = await subs.apply.run({ args: { file: yamlPath } }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect(mockPost).toHaveBeenCalledTimes(1)
      expect(mockPost).toHaveBeenCalledWith(
        '/api/agents',
        expect.objectContaining({ name: 'my-bot' }),
      )
      expect(mockGet).toHaveBeenCalledWith(DIAGNOSE_URL('agt_new'))
      expect(logSpy).toHaveBeenCalledWith('Created agt_new (my-bot)')
      expect(stderr()).toContain('provider_cli_not_installed: claude CLI is not installed')
    })

    it('CREATE path: the error says the Agent now exists in draft and that re-applying updates it', async () => {
      writeFileSync(yamlPath, YAML_WITH_PUBLISH)
      mockFindAgentByName.mockResolvedValueOnce(null)
      mockPost.mockResolvedValueOnce({ data: { id: 'agt_new' } })
      mockGet.mockResolvedValueOnce(diagnose(PROVIDER_ERRORS))

      const err = await subs.apply.run({ args: { file: yamlPath } }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      const message = (err as CliError).message
      expect(message).toContain('agt_new')
      expect(message).toMatch(/draft/i)
      expect(message).toMatch(/agents apply/)
      expect(message).toMatch(/same YAML/i)
      expect(message).toMatch(/update/i)
      expect(message).toMatch(/rather than create a second one/i)
      expect((err as CliError).hint).toBe(
        'Fix the errors above, or pass --skip-diagnose to publish anyway.',
      )
    })

    it('UPDATE path: the error does not mention a draft being left behind', async () => {
      writeFileSync(yamlPath, `${YAML_WITH_PUBLISH}description: NEW\n`)
      mockFindAgentByName.mockResolvedValueOnce({ id: 'agt_x', name: 'my-bot' })
      mockGet.mockResolvedValueOnce({ data: { id: 'agt_x', name: 'my-bot', description: 'OLD' } })
      mockGet.mockResolvedValueOnce(diagnose(PROVIDER_ERRORS))

      const err = await subs.apply.run({ args: { file: yamlPath } }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).message).not.toMatch(/draft/i)
    })

    it('UPDATE path: patches, then aborts before /publish on a diagnose error', async () => {
      writeFileSync(yamlPath, `${YAML_WITH_PUBLISH}description: NEW\n`)
      mockFindAgentByName.mockResolvedValueOnce({ id: 'agt_x', name: 'my-bot' })
      mockGet.mockResolvedValueOnce({ data: { id: 'agt_x', name: 'my-bot', description: 'OLD' } })
      mockGet.mockResolvedValueOnce(diagnose(PROVIDER_ERRORS))

      const err = await subs.apply.run({ args: { file: yamlPath } }).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_x', { description: 'NEW' })
      expect(mockGet).toHaveBeenCalledWith(DIAGNOSE_URL('agt_x'))
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('UPDATE path: publishes when diagnose is clean', async () => {
      writeFileSync(yamlPath, YAML_WITH_PUBLISH)
      mockFindAgentByName.mockResolvedValueOnce({ id: 'agt_x', name: 'my-bot' })
      mockGet.mockResolvedValueOnce({ data: { id: 'agt_x', name: 'my-bot' } })
      mockGet.mockResolvedValueOnce(diagnose([]))
      mockPost.mockResolvedValueOnce({ data: {} })

      await subs.apply.run({ args: { file: yamlPath } })

      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_x/publish', { channels: ['api'] })
    })

    it('--skip-diagnose publishes without calling diagnose', async () => {
      writeFileSync(yamlPath, YAML_WITH_PUBLISH)
      mockFindAgentByName.mockResolvedValueOnce(null)
      mockPost.mockResolvedValueOnce({ data: { id: 'agt_new' } })
      mockPost.mockResolvedValueOnce({ data: {} })

      await subs.apply.run({ args: { file: yamlPath, 'skip-diagnose': true } })

      expect(mockGet).not.toHaveBeenCalled()
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_new/publish', { channels: ['api'] })
    })

    it('--dry-run never calls diagnose (the agent may not exist yet)', async () => {
      writeFileSync(yamlPath, YAML_WITH_PUBLISH)
      mockFindAgentByName.mockResolvedValueOnce(null)

      await subs.apply.run({ args: { file: yamlPath, 'dry-run': true } })

      expect(mockGet).not.toHaveBeenCalled()
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('does not call diagnose when the yaml has no publish block', async () => {
      writeFileSync(yamlPath, 'name: my-bot\n')
      mockFindAgentByName.mockResolvedValueOnce(null)
      mockPost.mockResolvedValueOnce({ data: { id: 'agt_new' } })

      await subs.apply.run({ args: { file: yamlPath } })

      expect(mockGet).not.toHaveBeenCalled()
    })

    it('warns and still publishes when the diagnose endpoint fails', async () => {
      writeFileSync(yamlPath, YAML_WITH_PUBLISH)
      mockFindAgentByName.mockResolvedValueOnce(null)
      mockPost.mockResolvedValueOnce({ data: { id: 'agt_new' } })
      mockGet.mockRejectedValueOnce(new Error('503 upstream'))
      mockPost.mockResolvedValueOnce({ data: {} })

      await subs.apply.run({ args: { file: yamlPath } })

      expect(stderr()).toMatch(/preflight could not run/i)
      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_new/publish', { channels: ['api'] })
    })
  })
})
