/**
 * `a2wave providers cli …` — runtime install / status / uninstall of the
 * Provider CLIs (Claude Code, Codex, …) through the admin-only
 * `/api/provider-clis` endpoints.
 *
 * Before this group existed the only path was the raw `a2wave api` escape
 * hatch plus hand-polling `GET /api/provider-clis`, so these tests pin the
 * ergonomics that replace it: one command to install, `--wait` to block on the
 * background job, a non-zero exit when the job ends in `error`, and a
 * confirmation gate on uninstall.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../../errors.js'

const mockGet = vi.fn()
const mockPost = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({ get: mockGet, post: mockPost }),
}))

const { providersCommand, waitForCliInstall } = await import('../providers.js')

type TestSubCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
type Node = { subCommands?: Record<string, Node> }

function cliSub(name: string): TestSubCommand {
  const cli = (providersCommand.subCommands as Record<string, Node>).cli
  return (cli.subCommands as Record<string, unknown>)[name] as TestSubCommand
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'claude-code',
    binary: 'claude',
    lockedVersion: '2.1.0',
    installType: 'npm',
    installed: true,
    installedVersion: '2.1.0',
    matchesLock: true,
    lockDrift: 'match',
    minVersion: '2.0.0',
    meetsMinimum: true,
    status: 'idle',
    lastError: null,
    lastOutput: null,
    ...overrides,
  }
}

const originalIsTTY = process.stdin.isTTY

describe('providers cli', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let prevExitCode: string | number | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    prevExitCode = process.exitCode ?? undefined
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  })

  afterEach(() => {
    process.exitCode = prevExitCode
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
  })

  /** Everything the command printed, joined so a regex can span the table. */
  const printed = () => consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')

  describe('status', () => {
    it('lists every managed CLI with version, lock drift and job state', async () => {
      mockGet.mockResolvedValueOnce({
        data: [
          state(),
          state({
            kind: 'codex',
            binary: 'codex',
            installed: false,
            installedVersion: null,
            matchesLock: null,
            lockDrift: null,
            meetsMinimum: null,
            status: 'error',
            lastError: 'npm exited with code 1',
          }),
        ],
      })

      await cliSub('status').run({ args: {} })

      expect(mockGet).toHaveBeenCalledWith('/api/provider-clis')
      const out = printed()
      expect(out).toMatch(/claude-code\s+2\.1\.0\s+2\.1\.0\s+match\s+yes\s+idle/)
      expect(out).toMatch(/codex\s+-\s+2\.1\.0\s+-\s+-\s+error\s+npm exited with code 1/)
    })

    it('truncates a long lastError so the table stays one line per CLI', async () => {
      mockGet.mockResolvedValueOnce({
        data: [state({ status: 'error', lastError: 'x'.repeat(200) })],
      })

      await cliSub('status').run({ args: {} })

      const out = printed()
      expect(out).not.toContain('x'.repeat(200))
      expect(out).toContain('…')
    })

    it('narrows to one kind when given', async () => {
      mockGet.mockResolvedValueOnce({ data: [state(), state({ kind: 'codex' })] })

      await cliSub('status').run({ args: { kind: 'codex' } })

      const out = printed()
      expect(out).toContain('codex')
      expect(out).not.toContain('claude-code')
    })

    it('rejects a kind the server does not manage, naming the real ones', async () => {
      mockGet.mockResolvedValueOnce({ data: [state(), state({ kind: 'codex' })] })

      await expect(cliSub('status').run({ args: { kind: 'bogus' } })).rejects.toThrow(
        /bogus.*claude-code.*codex/s,
      )
    })

    it('emits the raw payload under --json, filtered by kind', async () => {
      const rows = [state(), state({ kind: 'codex' })]
      mockGet.mockResolvedValueOnce({ data: rows })

      await cliSub('status').run({ args: { kind: 'codex', json: true } })

      expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual({ data: [rows[1]] })
    })
  })

  describe('install', () => {
    it('posts the install and prints how to follow it when not waiting', async () => {
      mockPost.mockResolvedValueOnce({ data: { kind: 'claude-code', status: 'installing' } })

      await cliSub('install').run({ args: { kind: 'claude-code' } })

      expect(mockPost).toHaveBeenCalledWith('/api/provider-clis/claude-code/install', {})
      expect(mockGet).not.toHaveBeenCalled()
      const out = printed()
      expect(out).toContain('claude-code')
      expect(out).toContain('a2wave providers cli status claude-code')
    })

    it('--wait polls until the job settles and prints the final version', async () => {
      mockPost.mockResolvedValueOnce({ data: { kind: 'claude-code', status: 'installing' } })
      mockGet.mockResolvedValueOnce({ data: [state({ installedVersion: '2.1.0' })] })

      await cliSub('install').run({ args: { kind: 'claude-code', wait: true } })

      expect(mockGet).toHaveBeenCalledWith('/api/provider-clis')
      const out = printed()
      expect(out).toContain('2.1.0')
      expect(out).toContain('match')
      expect(process.exitCode).not.toBe(1)
    })

    it('--wait exits non-zero and prints lastError when the job ends in error', async () => {
      mockPost.mockResolvedValueOnce({ data: { kind: 'claude-code', status: 'installing' } })
      mockGet.mockResolvedValueOnce({
        data: [
          state({
            installed: false,
            installedVersion: null,
            lockDrift: null,
            status: 'error',
            lastError: 'checksum mismatch',
          }),
        ],
      })

      await cliSub('install').run({ args: { kind: 'claude-code', wait: true } })

      expect(process.exitCode).toBe(1)
      const out = printed()
      expect(out).toContain('checksum mismatch')
    })

    it('--wait explains that `above` drift is a newer build the engine accepts', async () => {
      mockPost.mockResolvedValueOnce({ data: { kind: 'claude-code', status: 'installing' } })
      mockGet.mockResolvedValueOnce({
        data: [state({ installedVersion: '2.2.0', matchesLock: false, lockDrift: 'above' })],
      })

      await cliSub('install').run({ args: { kind: 'claude-code', wait: true } })

      expect(process.exitCode).not.toBe(1)
      const out = printed()
      expect(out).toMatch(/above/)
      expect(out).toMatch(/newer/i)
    })

    it('--wait --json emits the final state and still sets the exit code first', async () => {
      mockPost.mockResolvedValueOnce({ data: { kind: 'claude-code', status: 'installing' } })
      const final = state({ status: 'error', lastError: 'boom' })
      mockGet.mockResolvedValueOnce({ data: [final] })

      await cliSub('install').run({ args: { kind: 'claude-code', wait: true, json: true } })

      expect(process.exitCode).toBe(1)
      expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual({ data: final })
    })

    it('rejects a non-integer --timeout before posting anything', async () => {
      await expect(
        cliSub('install').run({ args: { kind: 'claude-code', wait: true, timeout: '1e3' } }),
      ).rejects.toThrow(/--timeout/)
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('--timeout implies --wait, so a value is never silently ignored', async () => {
      mockPost.mockResolvedValueOnce({ data: { kind: 'claude-code', status: 'installing' } })
      mockGet.mockResolvedValueOnce({ data: [state({ installedVersion: '2.1.0' })] })

      await cliSub('install').run({ args: { kind: 'claude-code', timeout: '30' } })

      expect(mockGet).toHaveBeenCalledWith('/api/provider-clis')
      const out = printed()
      expect(out).toContain('2.1.0')
      expect(out).not.toContain('Follow with:')
    })

    it('a bad --timeout without --wait still fails before any request', async () => {
      await expect(
        cliSub('install').run({ args: { kind: 'claude-code', timeout: 'soon' } }),
      ).rejects.toThrow(/--timeout/)
      expect(mockPost).not.toHaveBeenCalled()
      expect(mockGet).not.toHaveBeenCalled()
    })

    it('documents that --timeout implies --wait', () => {
      const install = cliSub('install') as unknown as {
        args: { timeout: { description: string } }
      }
      expect(install.args.timeout.description).toMatch(/implies --wait/)
    })
  })

  describe('waitForCliInstall', () => {
    it('keeps polling while the job is installing, without real delays', async () => {
      const get = vi
        .fn()
        .mockResolvedValueOnce({ data: [state({ status: 'installing' })] })
        .mockResolvedValueOnce({ data: [state({ status: 'installing' })] })
        .mockResolvedValueOnce({ data: [state({ status: 'idle' })] })
      const sleep = vi.fn().mockResolvedValue(undefined)

      const final = await waitForCliInstall({ get }, 'claude-code', { sleep })

      expect(final.status).toBe('idle')
      expect(get).toHaveBeenCalledTimes(3)
      // The 3 s cadence the spec asks for — a CLI install takes tens of seconds
      // to minutes, so a faster loop only adds load on the probe.
      expect(sleep).toHaveBeenCalledTimes(2)
      expect(sleep).toHaveBeenCalledWith(3000)
    })

    it('times out with the last status and the timeout it waited for', async () => {
      const get = vi.fn().mockResolvedValue({ data: [state({ status: 'installing' })] })

      await expect(
        waitForCliInstall({ get }, 'claude-code', { timeoutMs: 0, sleep: async () => {} }),
      ).rejects.toThrow(/Timed out after 0s.*claude-code.*installing/)
    })

    it('fails loudly when the kind disappears from the list', async () => {
      const get = vi.fn().mockResolvedValue({ data: [state({ kind: 'codex' })] })

      await expect(
        waitForCliInstall({ get }, 'claude-code', { sleep: async () => {} }),
      ).rejects.toThrow(/claude-code/)
    })

    it('--timeout is forwarded in seconds', async () => {
      mockPost.mockResolvedValueOnce({ data: { kind: 'claude-code', status: 'installing' } })
      mockGet.mockResolvedValue({ data: [state({ status: 'installing' })] })

      await expect(
        cliSub('install').run({ args: { kind: 'claude-code', wait: true, timeout: '0' } }),
      ).rejects.toThrow(/Timed out after 0s/)
    })
  })

  describe('uninstall', () => {
    it('refuses to run unattended without --yes', async () => {
      const err = await cliSub('uninstall')
        .run({ args: { kind: 'claude-code' } })
        .catch((e: unknown) => e)

      expect(err).toBeInstanceOf(CliError)
      expect((err as CliError).type).toBe('confirmation')
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('proceeds with --yes', async () => {
      mockPost.mockResolvedValueOnce({ data: { kind: 'claude-code', status: 'idle' } })

      await cliSub('uninstall').run({ args: { kind: 'claude-code', yes: true } })

      expect(mockPost).toHaveBeenCalledWith('/api/provider-clis/claude-code/uninstall', {})
      const out = printed()
      expect(out).toContain('claude-code')
    })

    it('accepts --force as the alias every other delete uses', async () => {
      mockPost.mockResolvedValueOnce({ data: { kind: 'claude-code', status: 'idle' } })

      await cliSub('uninstall').run({ args: { kind: 'claude-code', force: true } })

      expect(mockPost).toHaveBeenCalledTimes(1)
    })
  })

  describe('risk labels', () => {
    it.each([
      ['status', 'read'],
      ['install', 'write'],
      ['uninstall', 'high-risk-write'],
    ])('%s is labelled %s', (name, risk) => {
      const node = cliSub(name) as unknown as { meta: { agentMeta: { risk: string } } }
      expect(node.meta.agentMeta.risk).toBe(risk)
    })
  })
})
