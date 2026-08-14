import { runCommand } from 'citty'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('citty', () => ({
  defineCommand: vi.fn(() => ({})),
  runCommand: vi.fn(() => Promise.resolve({ result: undefined })),
  showUsage: vi.fn(() => Promise.resolve()),
  resolveSubCommand: vi.fn(() => Promise.resolve([{}, undefined])),
}))

vi.mock('../commands/login.js', () => ({
  loginCommand: {},
  logoutCommand: {},
}))
vi.mock('../commands/skills.js', () => ({ skillsCommand: {} }))
vi.mock('../commands/agents.js', () => ({ agentsCommand: {} }))
vi.mock('../commands/runs.js', () => ({ runsCommand: {} }))

const { handleError, runCli } = await import('../index.js')
const { CliError } = await import('../errors.js')
const { ApiError } = await import('../client.js')

describe('handleError', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prints message and exits with 1 for CliError', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    expect(() => handleError(new CliError('something went wrong'))).toThrow('process.exit')
    expect(errorSpy).toHaveBeenCalledWith('something went wrong')
    expect(exitSpy).toHaveBeenCalledWith(1)

    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('prints formatted message for ApiError', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    expect(() => handleError(new ApiError(404, 'not found'))).toThrow('process.exit')
    expect(errorSpy).toHaveBeenCalledWith('API Error (404): not found')
    expect(exitSpy).toHaveBeenCalledWith(1)

    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('appends a hint on its own line when the error carries one', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    expect(() =>
      handleError(new CliError('Session expired', { type: 'auth', hint: 'a2wave login' })),
    ).toThrow('process.exit')
    const printed = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).toContain('Session expired')
    expect(printed).toContain('a2wave login')

    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('does not leak a raw stack trace for an unexpected error', () => {
    // Previously this re-threw, so a TypeError surfaced as a full Node stack
    // dump — unparseable for an agent and alarming for a human. It is a bug in
    // this CLI, so it gets a stable `internal` shape and still exits 1.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)

    expect(() => handleError(new TypeError('x.y is not a function'))).toThrow('process.exit')
    const printed = errorSpy.mock.calls.map((c) => String(c[0])).join('\n')
    expect(printed).toContain('x.y is not a function')
    expect(printed).not.toContain('at Object.')
    expect(exitSpy).toHaveBeenCalledWith(1)

    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('shows the stack behind A2WAVE_DEBUG for actually debugging one', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit')
    }) as never)
    vi.stubEnv('A2WAVE_DEBUG', '1')

    expect(() => handleError(new TypeError('boom'))).toThrow('process.exit')
    expect(errorSpy.mock.calls.flat().some((c) => String(c).includes('TypeError'))).toBe(true)

    vi.unstubAllEnvs()
    errorSpy.mockRestore()
    exitSpy.mockRestore()
  })

  describe('--json envelope', () => {
    // handleError receives only the error — citty has already unwound — so the
    // only honest way to know the caller asked for JSON is the raw argv.
    function withArgv(argv: string[], fn: () => void) {
      const original = process.argv
      process.argv = ['node', 'a2wave', ...argv]
      try {
        fn()
      } finally {
        process.argv = original
      }
    }

    it('emits {ok:false,error:{...}} on stderr when --json was passed', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)

      withArgv(['agents', 'list', '--json'], () => {
        expect(() =>
          handleError(new CliError('Session expired', { type: 'auth', hint: 'a2wave login' })),
        ).toThrow('process.exit')
      })

      const parsed = JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0]))
      expect(parsed).toEqual({
        ok: false,
        error: { type: 'auth', message: 'Session expired', hint: 'a2wave login' },
      })
      expect(exitSpy).toHaveBeenCalledWith(1)

      errorSpy.mockRestore()
      exitSpy.mockRestore()
    })

    it('recognises --fields and --json-pretty as JSON modes too', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)

      withArgv(['agents', 'list', '--fields', 'data[].id'], () => {
        expect(() => handleError(new CliError('boom'))).toThrow('process.exit')
      })

      expect(() => JSON.parse(String(errorSpy.mock.calls.at(-1)?.[0]))).not.toThrow()

      errorSpy.mockRestore()
      exitSpy.mockRestore()
    })

    it('stays plain text without a JSON flag', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)

      withArgv(['agents', 'list'], () => {
        expect(() => handleError(new CliError('boom'))).toThrow('process.exit')
      })

      expect(errorSpy).toHaveBeenCalledWith('boom')

      errorSpy.mockRestore()
      exitSpy.mockRestore()
    })

    it('does not mistake a flag VALUE of --json for the flag', () => {
      // `chat send bot -m "--json"` must not turn errors into JSON.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit')
      }) as never)

      withArgv(['chat', 'send', 'bot', '-m', '--json'], () => {
        expect(() => handleError(new CliError('boom'))).toThrow('process.exit')
      })

      expect(errorSpy).toHaveBeenCalledWith('boom')

      errorSpy.mockRestore()
      exitSpy.mockRestore()
    })
  })
})

describe('runCli', () => {
  it('prints the global version without running a nested command', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(runCommand).mockClear()

    runCli(['setup', '--version'])

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/))
    expect(runCommand).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('prints the version for a bare --version', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.mocked(runCommand).mockClear()

    runCli(['--version'])

    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/))
    expect(runCommand).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('does not treat a free-text --version value as the global version flag', () => {
    vi.mocked(runCommand).mockClear()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    runCli(['chat', 'send', 'my-agent', '-m', '--version'])

    expect(runCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rawArgs: ['chat', 'send', 'my-agent', '-m', '--version'] }),
    )
    expect(log).not.toHaveBeenCalled()
  })

  // The legacy alias used to be applied by mutating `process.argv`, so it was
  // invisible to a caller passing rawArgs in. It now travels with the argument
  // list, which is the only way `runCli(['upgrade'])` can honour it.
  it('rewrites the legacy `upgrade` alias to `update` on the passed args', () => {
    vi.mocked(runCommand).mockClear()

    runCli(['upgrade', '--check'])

    expect(runCommand).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rawArgs: ['update', '--check'] }),
    )
  })
})
