import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const apiRoot = resolve(import.meta.dirname, '../..')

/**
 * The fail-stop promise is a *floor*, not a door check.
 *
 * `instance-heartbeat.ts` states that an expired owner has stopped touching the
 * workspace before any peer may reclaim it. Admission alone cannot deliver that:
 * sync and CodeGraph indexing spawn their own child processes (invisible to the
 * engine registry's reaper) and run for minutes, an evaluation replays case
 * after case long past its one admission check, and workspace removal would
 * `--force` delete a worktree a peer may already have taken over.
 *
 * Each of those entry points therefore consults the fence itself. A structural
 * test rather than a behavioural one: these live in four modules with heavy
 * external dependencies, and what actually needs guarding is that the check is
 * not quietly dropped — which is exactly what a grep can pin.
 */
describe('fail-stop fence coverage', () => {
  const guarded = [
    ['lib/p4-sync.ts', 'SCM sync writes the shared checkout for as long as a clone takes'],
    ['lib/codegraph-index.ts', 'indexing reads the checkout for up to its full timeout'],
    ['routes/evaluation.ts', 'an evaluation replays many cases across many minutes'],
    ['lib/scm-workspace-removal.ts', 'removal force-deletes a worktree a peer may now own'],
    ['lib/scm-workload-lifecycle.ts', 'admission is the entry gate for new SCM work'],
  ] as const

  it.each(guarded)('%s consults the liveness fence (%s)', (relativePath) => {
    const source = readFileSync(resolve(apiRoot, relativePath), 'utf8')
    expect(source).toContain('hasLostHeartbeatOwnership')
  })

  it('starts the heartbeat before anything can consult ownership', () => {
    // hasLostHeartbeatOwnership answers "not fenced" before the loop starts —
    // the fail-open side. That is safe only because the beat is started before
    // the port opens and before any sweeper or recovery runs. Nothing in the
    // type system holds that ordering, so pin it here: a future reordering
    // would otherwise silently get "healthy" from a process with no lease.
    const index = readFileSync(resolve(apiRoot, 'index.ts'), 'utf8')
    // The assignment, not the import line, is the call site.
    const heartbeatStart = index.indexOf('stopInstanceHeartbeat = startInstanceHeartbeat(')
    expect(heartbeatStart).toBeGreaterThan(-1)
    // Invocations, not declarations: `function startListening()` is defined
    // far above the boot sequence that calls it.
    for (const laterCall of [
      'server = startListening()',
      'startStaleLeaseSweeper()',
      'recoverOnStartup(',
    ]) {
      expect(index.indexOf(laterCall)).toBeGreaterThan(heartbeatStart)
    }
  })

  it('awaits the first beat, so liveness is visible before any lease is taken', () => {
    // Fire-and-forget would let this process admit a Run and activate a lease
    // while peers cannot see it is alive; one past its grace window would then
    // reap that live workload.
    const index = readFileSync(resolve(apiRoot, 'index.ts'), 'utf8')
    expect(index).toMatch(/await beatInstanceHeartbeat\(\)/)
  })

  it('stops the auto-sync timers during shutdown', () => {
    // stopAllAutoSync aborts in-flight sync/index children. It existed but was
    // never called — the one thing that could reap the child processes the
    // engine registry cannot see.
    const index = readFileSync(resolve(apiRoot, 'index.ts'), 'utf8')
    expect(index).toContain('stopAllAutoSync()')
  })
})
