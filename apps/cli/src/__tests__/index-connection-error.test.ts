/**
 * An unreachable instance used to reach `handleError` as a bare
 * `TypeError: fetch failed`, which is the "internal" branch — the user was
 * told to file a bug against the CLI for a wrong URL. The client now converts
 * it to a CliError; this pins that the entry point renders it as an ordinary
 * error (message + hint, no "This is a bug" footer, exit 1).
 */
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

vi.mock('citty', () => ({
  defineCommand: vi.fn(() => ({})),
  runCommand: vi.fn(() => Promise.resolve({ result: undefined })),
  showUsage: vi.fn(() => Promise.resolve()),
}))
vi.mock('../commands/login.js', () => ({ loginCommand: {}, logoutCommand: {} }))
vi.mock('../commands/skills.js', () => ({ skillsCommand: {} }))
vi.mock('../commands/agents.js', () => ({ agentsCommand: {} }))
vi.mock('../commands/runs.js', () => ({ runsCommand: {} }))

const { handleError } = await import('../index.js')
const { toConnectionError } = await import('../client.js')

function connectionRefused(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED 10.3.113.32:3512'), {
    code: 'ECONNREFUSED',
  })
  return new TypeError('fetch failed', { cause })
}

describe('handleError — connection failure', () => {
  let errorSpy: MockInstance<typeof console.error>
  let exitSpy: MockInstance<typeof process.exit>

  beforeEach(() => {
    vi.clearAllMocks()
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    return () => {
      errorSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })

  it('reports it as a normal error, not as a CLI bug', () => {
    const err = toConnectionError(connectionRefused(), 'http://10.3.113.32:3512')
    expect(err).not.toBeNull()

    expect(() => handleError(err)).toThrow('process.exit')

    const printed = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).toContain('Cannot reach a2wave at http://10.3.113.32:3512 (ECONNREFUSED).')
    expect(printed).toContain('a2wave config set-url <url>')
    expect(printed).not.toContain('Internal error')
    expect(printed).not.toContain('This is a bug')
    expect(printed).not.toContain('A2WAVE_DEBUG')
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('emits a network envelope under --json', () => {
    const argvSpy = vi
      .spyOn(process, 'argv', 'get')
      .mockReturnValue(['node', 'a2wave', 'agents', 'list', '--json'])
    try {
      const err = toConnectionError(connectionRefused(), 'http://10.3.113.32:3512')
      expect(() => handleError(err)).toThrow('process.exit')
      const envelope = JSON.parse(String(errorSpy.mock.calls[0][0]))
      expect(envelope.ok).toBe(false)
      expect(envelope.error.type).toBe('network')
      expect(envelope.error.subtype).toBe('ECONNREFUSED')
      expect(envelope.error.message).toContain('Cannot reach a2wave')
    } finally {
      argvSpy.mockRestore()
    }
  })
})
