import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * End-to-end dispatch tests, run against the real entry point via tsx.
 *
 * These exist because the unit tests could not have caught the bug they pin:
 * they call `handleError` directly, while the shipped binary never reached it.
 * citty's `runMain` catches every error itself, prints it through consola and
 * exits — so `runMain(main).catch(handleError)` was dead code, and a plain
 * CliError surfaced as a stack trace with the message printed twice.
 *
 * Anything asserting how the process actually behaves has to run the process.
 */
const ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts')

// citty colours its usage, so the rendered line is
// `USAGE\e[22m\e[24m \e[36ma2wave` — the escapes sit between the two words a
// caller wants to assert on, and `toContain('USAGE a2wave')` fails on a machine
// whose environment enables colour while passing on a bare CI runner. Strip the
// sequences so the assertions read the text, not the terminal styling.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires ESC.
const ANSI = /\[[0-9;]*m/g

function stripAnsi(value: string): string {
  return value.replace(ANSI, '')
}

function run(args: string[]): { stdout: string; stderr: string; code: number } {
  // consola — which citty's showUsage prints through — suppresses output when
  // it believes it is under test. It decides that from `TEST` and `NODE_ENV`
  // (std-env: `isTest = nodeENV === 'test' || !!env.TEST`), both of which vitest
  // sets and a child process inherits. Left in place, every help assertion here
  // would compare against an empty string and pass for the wrong reason.
  const { TEST, VITEST, VITEST_WORKER_ID, NODE_ENV, ...cleanEnv } = process.env
  try {
    const stdout = execFileSync('npx', ['tsx', ENTRY, ...args], {
      encoding: 'utf-8',
      // No instance is reachable, which is the point: every data command fails
      // fast on the missing credential and exercises the error path.
      env: { ...cleanEnv, A2WAVE_URL: 'http://127.0.0.1:59999', A2WAVE_DEBUG: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout: stripAnsi(stdout), stderr: '', code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return {
      stdout: stripAnsi(e.stdout ?? ''),
      stderr: stripAnsi(e.stderr ?? ''),
      code: e.status ?? -1,
    }
  }
}

// Each case spawns `npx tsx` on the real entry point, which is slow to cold
// start — well past vitest's 5s default once several run in one file. The cost
// is the point: nothing cheaper observes how the process actually behaves.
describe('dispatch', { timeout: 60_000 }, () => {
  it('reports a CliError as one clean line, with no stack trace', () => {
    const { stderr, code } = run(['agents', 'list'])

    expect(code).toBe(1)
    expect(stderr).toContain('Not logged in')
    // The regression: citty used to print the message twice, wrapped in an
    // ERROR banner, with six frames of its own internals between them.
    expect(stderr).not.toContain('    at ')
    expect(stderr.match(/Not logged in/g)).toHaveLength(1)
  })

  it('emits the JSON envelope on stderr under --json', () => {
    const { stderr, code } = run(['agents', 'list', '--json'])

    expect(code).toBe(1)
    const parsed = JSON.parse(stderr.trim())
    expect(parsed.ok).toBe(false)
    expect(parsed.error.message).toContain('Not logged in')
  })

  it('treats an unknown command as validation, not an internal bug', () => {
    const { stderr, code } = run(['bogus', '--json'])

    expect(code).toBe(1)
    const parsed = JSON.parse(stderr.trim().split('\n').at(-1) ?? '{}')
    expect(parsed.error.type).toBe('validation')
    expect(parsed.error.subtype).toBe('unknown_command')
  })

  it('still prints help and exits 0', () => {
    const { stdout, code } = run(['--help'])

    expect(code).toBe(0)
    expect(stdout).toContain('USAGE a2wave')
  })

  it('still prints nested help', () => {
    const { stdout, code } = run(['agents', 'members', '--help'])

    expect(code).toBe(0)
    expect(stdout).toContain('list|add|update|remove')
  })

  it('still prints the version and exits 0', () => {
    const { stdout, code } = run(['--version'])

    expect(code).toBe(0)
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
  })
})

describe('agent-facing help', { timeout: 60_000 }, () => {
  it('prints the risk label of a leaf command', () => {
    // A risk label an agent cannot see is a label it cannot act on, and --help
    // is the one surface every caller reads first.
    const { stdout } = run(['agents', 'delete', '--help'])
    expect(stdout).toContain('Risk: high-risk-write')
  })

  it('prints `read` for a read-only leaf', () => {
    const { stdout } = run(['agents', 'list', '--help'])
    expect(stdout).toContain('Risk: read')
  })

  it('omits the risk line on a group node, which does no work of its own', () => {
    const { stdout } = run(['agents', '--help'])
    expect(stdout).not.toContain('Risk:')
  })

  it('opens the root help with the agent quickstart', () => {
    // The loop and the tier order are what a first-time caller needs; human
    // setup is exiled to the last line so it does not lead.
    const { stdout } = run(['--help'])
    expect(stdout).toContain('AGENT QUICKSTART')
    expect(stdout).toContain('schema')
  })
})
