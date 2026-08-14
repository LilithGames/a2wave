import { describe, expect, it } from 'vitest'
import { FORCE_KILL_DELAY_MS } from '../../engine/cli-process-runner.js'
import { SHUTDOWN_HARD_TIMEOUT_MS } from '../graceful-shutdown.js'
import {
  INSTANCE_DEAD_AFTER_MS,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
  INSTANCE_SELF_FENCE_AFTER_MS,
} from '../instance-heartbeat.js'

/**
 * The fail-stop safety argument, expressed as an assertion.
 *
 * A fenced owner must be fully stopped — every agent CLI reaped — before any
 * peer is allowed to reclaim its checkout. That holds only while the owner's
 * worst-case exit fits inside the gap between its own fail-stop deadline and
 * the peer-death threshold. Every term is a tunable constant in a different
 * file, so without this test raising the shutdown timeout (a reasonable-looking
 * change) would silently let two processes write one worktree.
 */
describe('fail-stop timing budget', () => {
  /** Detection is on the beat interval, so an expiry can go unnoticed that long. */
  const worstCaseExitMs =
    INSTANCE_HEARTBEAT_INTERVAL_MS + SHUTDOWN_HARD_TIMEOUT_MS + FORCE_KILL_DELAY_MS
  const marginMs = INSTANCE_DEAD_AFTER_MS - INSTANCE_SELF_FENCE_AFTER_MS

  it('leaves the owner enough time to exit before peers may reclaim', () => {
    expect(worstCaseExitMs).toBeLessThan(marginMs)
  })

  it('fences before peers declare death, not after', () => {
    expect(INSTANCE_SELF_FENCE_AFTER_MS).toBeLessThan(INSTANCE_DEAD_AFTER_MS)
  })

  it('keeps detection latency a minority of the budget', () => {
    // Detection is already counted in worstCaseExitMs above; this pins the
    // shape of that budget — most of the margin must remain available for the
    // actual shutdown work, not be spent noticing that it is needed.
    expect(INSTANCE_HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(marginMs / 2)
  })
})
