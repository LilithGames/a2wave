/**
 * `requireConfirmation` is the machine-enforced half of the risk vocabulary:
 * a command labelled `high-risk-write` cannot run unattended without `--yes`.
 *
 * It generalizes `confirmDestructive` rather than replacing it, so the semantics
 * an agent already depends on are the ones being tested here: `--force`/`--yes`
 * proceeds, no TTY THROWS instead of running silently, and the error carries the
 * `confirmation` type and a runnable hint.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../../errors.js'
import { requireConfirmation, resolveForceFlag } from '../args.js'

const originalIsTTY = process.stdin.isTTY

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
  vi.restoreAllMocks()
})

function setTTY(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
}

describe('requireConfirmation', () => {
  it('is a no-op for a read command', async () => {
    setTTY(false)
    await expect(requireConfirmation('read', 'Delete everything?', false)).resolves.toBeUndefined()
  })

  it('is a no-op for a plain write command', async () => {
    // `write` is the ordinary case and must stay behaviorally unchanged — a
    // confirmation on every update would train callers to pass --yes always,
    // which is how the flag stops meaning anything.
    setTTY(false)
    await expect(requireConfirmation('write', 'Rename the agent?', false)).resolves.toBeUndefined()
  })

  it('throws a confirmation error for high-risk-write without a TTY', async () => {
    setTTY(false)
    const err = await requireConfirmation('high-risk-write', 'Delete Agent X?', false).catch(
      (e) => e,
    )
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).type).toBe('confirmation')
    expect((err as CliError).subtype).toBe('confirmation_required')
    expect((err as CliError).hint).toBe('--force')
    expect((err as CliError).message).toContain('Delete Agent X?')
  })

  it('proceeds for high-risk-write when force is set', async () => {
    setTTY(false)
    await expect(
      requireConfirmation('high-risk-write', 'Delete Agent X?', true),
    ).resolves.toBeUndefined()
  })
})

describe('resolveForceFlag', () => {
  it('treats --yes as an alias of --force', () => {
    expect(resolveForceFlag({ force: true })).toBe(true)
    expect(resolveForceFlag({ yes: true })).toBe(true)
    expect(resolveForceFlag({ force: false, yes: true })).toBe(true)
    expect(resolveForceFlag({})).toBe(false)
  })
})
