/**
 * Startup ordering guard for the readiness contract.
 *
 * `GET /api/health/ready` must answer 503 `starting` until boot-time seeding has
 * finished, so a rolling update never routes into the window where the port is
 * bound but the seeded rows are not yet written (root CLAUDE.md).
 *
 * Regression: the PostgreSQL migration turned `recoverInterruptedInstalls`,
 * `seedBuiltinMcpServers` and `seedBuiltinSkills` async without updating their
 * call sites in `src/index.ts`. `markReady()` then ran while all three were
 * still in flight, so readiness flipped to 200 with the seeds half-written —
 * silently defeating the probe.
 *
 * `src/index.ts` cannot be imported in a unit test (it binds a port and kicks
 * off the whole boot pipeline as a side effect of import), so this asserts on
 * the source text — the same approach `dockerfile-mcp-build.test.ts` uses for
 * build wiring that is likewise unreachable at runtime.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Comments are stripped so the ordering assertions match real call sites only —
// the surrounding prose names these very functions when explaining the ordering.
const source = readFileSync(resolve(__dirname, '../index.ts'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

/** Index of a call in the boot source, asserting it appears exactly once. */
function callIndex(call: string): number {
  const first = source.indexOf(call)
  expect(first, `${call} not found in src/index.ts`).toBeGreaterThan(-1)
  expect(source.indexOf(call, first + 1), `${call} appears more than once`).toBe(-1)
  return first
}

describe('startup readiness ordering', () => {
  it.each([
    'recoverInterruptedInstalls()',
    'seedPresetProviders()',
    'seedBuiltinMcpServers()',
    'seedBuiltinSkills()',
  ])('awaits %s so its writes land before readiness flips', (call) => {
    expect(source).toContain(`await ${call}`)
  })

  it('marks ready only after every seed has been awaited', () => {
    const readyAt = callIndex('markReady()')
    for (const call of [
      'await seedPresetProviders()',
      'await seedBuiltinMcpServers()',
      'await seedBuiltinSkills()',
    ]) {
      expect(source.indexOf(call), `${call} must precede markReady()`).toBeLessThan(readyAt)
    }
  })

  it('settles interrupted CLI installs before the port opens', () => {
    // An admin reaching the port before recovery runs can have their freshly
    // claimed install row stomped to `error` by the recovery pass.
    expect(callIndex('await recoverInterruptedInstalls()')).toBeLessThan(
      callIndex('server = startListening()'),
    )
  })

  it('clears leaked SQLite workspace-removal reservations before the port opens', () => {
    // Once the port accepts mutations, a new removal may own a fresh row. A
    // later wholesale startup clear cannot distinguish that live attempt from
    // a row leaked by the previous process.
    expect(callIndex('await clearWorkspaceRemovalsOnStartup()')).toBeLessThan(
      callIndex('server = startListening()'),
    )
    expect(callIndex('await clearWorkspaceRemovalsOnStartup()')).toBeLessThan(
      callIndex('await bootstrapFromEnv()'),
    )
  })

  it('keeps auto-sync scheduler init off the readiness path but handles its rejection', () => {
    // Deliberately after markReady(): it only re-arms timers and settles rows
    // from a previous process, so it does not change how a fresh request is
    // answered. Being async, it still needs its rejection attached.
    expect(source.indexOf('initAutoSyncSchedulers()')).toBeGreaterThan(callIndex('markReady()'))
    expect(source).toMatch(/initAutoSyncSchedulers\(\)\s*\.catch\(/)
  })
})
