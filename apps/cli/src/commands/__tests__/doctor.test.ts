import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CheckReport } from '../../lib/checks.js'

const mockRunChecks = vi.fn<() => Promise<CheckReport>>()
vi.mock('../../lib/checks.js', () => ({
  runChecks: (...a: unknown[]) => mockRunChecks(...(a as [])),
}))

const { doctorCommand } = await import('../doctor.js')

type TestCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
const doctor = doctorCommand as unknown as TestCommand

function report(checks: CheckReport['checks']): CheckReport {
  return { ok: !checks.some((c) => c.status === 'fail'), checks }
}

describe('doctorCommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    process.exitCode = 0
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('emits the whole report under --json', async () => {
    const r = report([{ name: 'instance.url', status: 'pass', message: 'https://a.example' }])
    mockRunChecks.mockResolvedValueOnce(r)

    await doctor.run({ args: { json: true } })

    expect(JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))).toEqual(r)
  })

  it('prints every check with its name, so one can be grepped for', async () => {
    mockRunChecks.mockResolvedValueOnce(
      report([
        { name: 'instance.url', status: 'pass', message: 'https://a.example' },
        { name: 'instance.health', status: 'fail', message: 'unreachable', hint: 'a2wave status' },
      ]),
    )

    await doctor.run({ args: {} })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('instance.url')
    expect(out).toContain('instance.health')
    expect(out).toContain('unreachable')
  })

  it('prints the hint of every non-pass check', async () => {
    // A warn that does not say how to clear it is just noise.
    mockRunChecks.mockResolvedValueOnce(
      report([
        {
          name: 'credentials.token',
          status: 'warn',
          message: 'not logged in',
          hint: 'a2wave login',
        },
      ]),
    )

    await doctor.run({ args: {} })

    expect(consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toContain(
      'a2wave login',
    )
  })

  it('exits non-zero when any check failed', async () => {
    mockRunChecks.mockResolvedValueOnce(
      report([{ name: 'instance.health', status: 'fail', message: 'unreachable' }]),
    )

    await doctor.run({ args: {} })

    expect(process.exitCode).toBe(1)
  })

  it('does NOT fail the run for a warn', async () => {
    // The three-state model exists precisely so an optional or cosmetic issue
    // does not read as a broken install. A `doctor` that exits 1 on every warn
    // teaches callers to ignore its exit code.
    mockRunChecks.mockResolvedValueOnce(
      report([{ name: 'sso.cache', status: 'warn', message: 'not found', hint: 'a2wave login' }]),
    )

    await doctor.run({ args: {} })

    expect(process.exitCode).toBe(0)
  })

  it('sets the exit code before the --json early return', async () => {
    // emit() returns immediately after printing, so deciding the exit code
    // afterwards would make `doctor --json | jq` exit 0 on a red report — the
    // same trap `agents diagnose` and `eval run --wait` already guard against.
    mockRunChecks.mockResolvedValueOnce(
      report([{ name: 'instance.health', status: 'fail', message: 'unreachable' }]),
    )

    await doctor.run({ args: { json: true } })

    expect(process.exitCode).toBe(1)
  })

  it('prints a rollup line so a human sees the verdict without reading every row', async () => {
    mockRunChecks.mockResolvedValueOnce(
      report([{ name: 'instance.url', status: 'pass', message: 'ok' }]),
    )

    await doctor.run({ args: {} })

    expect(consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')).toMatch(/1 passed/)
  })
})
