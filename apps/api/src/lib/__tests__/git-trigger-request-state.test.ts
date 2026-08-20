/**
 * `fetchRequestState` — the pre-execution staleness probe for git-trigger runs.
 *
 * A trigger legitimately fires while a request is open, but the Run may only
 * leave the queue minutes later — by which time the request can already be
 * merged. This probe is what lets execution skip such a run before any tokens
 * are spent, so its contract matters in one specific way: it must NEVER throw
 * and must return 'unknown' (fail open) on every CLI failure shape, because a
 * transient forge error must not cancel a legitimate run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runStatusProbe = vi.fn()
vi.mock('../../engine/login-status-helper.js', () => ({
  runStatusProbe: (...args: unknown[]) => runStatusProbe(...args),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { fetchRequestState } from '../git-trigger-cli.js'

function probeResult(overrides: Record<string, unknown> = {}) {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, notFound: false, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fetchRequestState — glab', () => {
  it('maps GitLab states to the live-state verdict', async () => {
    for (const [state, expected] of [
      ['opened', 'open'],
      ['merged', 'merged'],
      ['closed', 'closed'],
      // 'locked' is a transient mid-merge state; treated as unknown so the
      // caller fails open rather than cancelling on a state that can revert.
      ['locked', 'unknown'],
    ] as const) {
      runStatusProbe.mockResolvedValue(probeResult({ stdout: JSON.stringify({ state }) }))
      expect(await fetchRequestState('glab', 'group/sub/repo', 42)).toBe(expected)
    }
  })

  it('queries the single-MR endpoint with the project path URL-encoded', async () => {
    runStatusProbe.mockResolvedValue(probeResult({ stdout: '{"state":"opened"}' }))
    await fetchRequestState('glab', 'group/sub/repo', 42)
    expect(runStatusProbe).toHaveBeenCalledWith(
      'glab',
      ['api', 'projects/group%2Fsub%2Frepo/merge_requests/42'],
      expect.anything(),
    )
  })

  it('forwards the host through GITLAB_HOST', async () => {
    runStatusProbe.mockResolvedValue(probeResult({ stdout: '{"state":"opened"}' }))
    await fetchRequestState('glab', 'group/repo', 7, 'gitlab.example.com')
    const opts = runStatusProbe.mock.calls[0][2] as { env: Record<string, string> }
    expect(opts.env.GITLAB_HOST).toBe('gitlab.example.com')
  })

  it('tolerates a banner before the JSON body', async () => {
    runStatusProbe.mockResolvedValue(
      probeResult({
        stdout:
          'Warning: Multiple config files found. Only the first one will be used.\n{"state":"merged"}',
      }),
    )
    expect(await fetchRequestState('glab', 'group/repo', 1)).toBe('merged')
  })
})

describe('fetchRequestState — gh', () => {
  it('distinguishes merged from closed-unmerged', async () => {
    runStatusProbe.mockResolvedValue(
      probeResult({ stdout: JSON.stringify({ state: 'closed', merged: true }) }),
    )
    expect(await fetchRequestState('gh', 'octo/repo', 5)).toBe('merged')

    runStatusProbe.mockResolvedValue(
      probeResult({ stdout: JSON.stringify({ state: 'closed', merged: false }) }),
    )
    expect(await fetchRequestState('gh', 'octo/repo', 5)).toBe('closed')

    runStatusProbe.mockResolvedValue(
      probeResult({ stdout: JSON.stringify({ state: 'open', merged: false }) }),
    )
    expect(await fetchRequestState('gh', 'octo/repo', 5)).toBe('open')
  })

  it('queries the REST pulls endpoint', async () => {
    runStatusProbe.mockResolvedValue(probeResult({ stdout: '{"state":"open"}' }))
    await fetchRequestState('gh', 'octo/repo', 5)
    expect(runStatusProbe).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/octo/repo/pulls/5'],
      expect.anything(),
    )
  })
})

describe('fetchRequestState — fail-open contract', () => {
  it.each([
    ['CLI not installed', { notFound: true }],
    ['timeout', { timedOut: true }],
    ['non-zero exit (404 body)', { exitCode: 1, stdout: '{"message":"404 Not Found"}' }],
    ['unparsable stdout', { stdout: 'A new version of glab is available' }],
    ['missing state field', { stdout: '{"iid":42}' }],
  ])('returns unknown on %s', async (_label, overrides) => {
    runStatusProbe.mockResolvedValue(probeResult(overrides))
    expect(await fetchRequestState('glab', 'group/repo', 42)).toBe('unknown')
  })

  it('returns unknown when the probe itself rejects', async () => {
    runStatusProbe.mockRejectedValue(new Error('spawn failed'))
    expect(await fetchRequestState('glab', 'group/repo', 42)).toBe('unknown')
  })
})
