/**
 * Pre-execution staleness decision for git-trigger runs.
 *
 * The rule under test: a run fired for `opened`/`updated`/`commented` describes
 * an OPEN request, so if that request has left the open set by the time the run
 * actually starts, executing it spends tokens on work that is already moot —
 * and to the operator it looks like "a closed MR triggered my agent". A run
 * fired for `closed` is the opposite: its subject is SUPPOSED to be gone, so it
 * must never be skipped. Every ambiguous verdict fails open into "run it".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchRequestState = vi.fn()
vi.mock('../git-trigger-cli.js', () => ({
  fetchRequestState: (...args: unknown[]) => fetchRequestState(...args),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { gitTriggerRunSkipReason } from '../git-trigger-run-preflight.js'

const origin = {
  provider: 'glab' as const,
  event: 'opened' as const,
  project: 'group/repo',
  number: 42,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gitTriggerRunSkipReason', () => {
  it('skips an opened-run whose request was merged before execution', async () => {
    fetchRequestState.mockResolvedValue('merged')
    const reason = await gitTriggerRunSkipReason(origin)
    expect(reason).toMatch(/merged/)
    expect(reason).toContain('group/repo')
    expect(reason).toContain('42')
  })

  it('skips an updated-run whose request was closed unmerged', async () => {
    fetchRequestState.mockResolvedValue('closed')
    expect(await gitTriggerRunSkipReason({ ...origin, event: 'updated' })).toMatch(/closed/)
  })

  it('never probes for a closed-event run — its subject is supposed to be gone', async () => {
    expect(await gitTriggerRunSkipReason({ ...origin, event: 'closed' })).toBeNull()
    expect(fetchRequestState).not.toHaveBeenCalled()
  })

  it('runs when the request is still open', async () => {
    fetchRequestState.mockResolvedValue('open')
    expect(await gitTriggerRunSkipReason(origin)).toBeNull()
  })

  it('fails open on an unknown verdict', async () => {
    fetchRequestState.mockResolvedValue('unknown')
    expect(await gitTriggerRunSkipReason(origin)).toBeNull()
  })

  it('fails open when the probe rejects unexpectedly', async () => {
    fetchRequestState.mockRejectedValue(new Error('boom'))
    expect(await gitTriggerRunSkipReason(origin)).toBeNull()
  })

  it('forwards host and provider to the probe', async () => {
    fetchRequestState.mockResolvedValue('open')
    await gitTriggerRunSkipReason({ ...origin, provider: 'gh', host: 'ghe.example.com' })
    expect(fetchRequestState).toHaveBeenCalledWith('gh', 'group/repo', 42, 'ghe.example.com')
  })
})
