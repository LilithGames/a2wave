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
import { createMockDrizzleDb, type MockDrizzleDb, makeSelectChain } from '../../test/index.js'

vi.mock('../../db/client.js', () => ({ db: createMockDrizzleDb() }))

const fetchRequestState = vi.fn()
vi.mock('../git-trigger-cli.js', () => ({
  fetchRequestState: (...args: unknown[]) => fetchRequestState(...args),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { db } from '../../db/client.js'
import { gitTriggerRunSkipReason } from '../git-trigger-run-preflight.js'

const mockDb = db as unknown as MockDrizzleDb

const origin = {
  provider: 'glab' as const,
  event: 'opened' as const,
  project: 'group/repo',
  number: 42,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDb.select.mockReturnValue(makeSelectChain([]))
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

/**
 * A busy request fires `opened` and then one `updated` per push, and with a
 * concurrency of 1 they all sit in the queue together. Each of them would
 * review the request's CURRENT head when it runs, so every run older than the
 * newest one for the same request is pure duplicate spend. The older run is
 * dropped when it reaches the front; the newest one does the review.
 */
describe('gitTriggerRunSkipReason — superseded by a newer run', () => {
  const self = { runId: 'run_old', agentId: 'agt_1', createdAt: new Date('2026-10-14T07:00:00Z') }
  const newerRun = (
    overrides: Record<string, unknown> = {},
    origin: Record<string, unknown> = {},
  ) => ({
    id: 'run_new',
    status: 'queued',
    executionMetadata: { gitTriggerOrigin: { ...originFields, event: 'updated', ...origin } },
    ...overrides,
  })
  const originFields = { provider: 'glab', project: 'group/repo', number: 42 }

  it('skips a queued opened-run once a newer run for the same request exists', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([newerRun()]))
    const reason = await gitTriggerRunSkipReason(origin, self)
    expect(reason).toContain('run_new')
    expect(reason).toContain('group/repo!42')
    // The DB answer is enough: no forge call is spent on a run we drop anyway.
    expect(fetchRequestState).not.toHaveBeenCalled()
  })

  it('skips an updated-run superseded by a later updated-run', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([newerRun()]))
    expect(await gitTriggerRunSkipReason({ ...origin, event: 'updated' }, self)).toContain(
      'run_new',
    )
  })

  it('counts a newer run that already completed — the request was reviewed at a later head', async () => {
    mockDb.select.mockReturnValue(makeSelectChain([newerRun({ status: 'completed' })]))
    expect(await gitTriggerRunSkipReason(origin, self)).toContain('run_new')
  })

  it('ignores a newer run that failed or was cancelled — it reviewed nothing', async () => {
    fetchRequestState.mockResolvedValue('open')
    mockDb.select.mockReturnValue(
      makeSelectChain([
        newerRun({ status: 'failed' }),
        newerRun({ id: 'run_x', status: 'cancelled' }),
      ]),
    )
    expect(await gitTriggerRunSkipReason(origin, self)).toBeNull()
  })

  it('ignores newer runs for another request number, project, provider or host', async () => {
    fetchRequestState.mockResolvedValue('open')
    mockDb.select.mockReturnValue(
      makeSelectChain([
        newerRun({}, { number: 43 }),
        newerRun({}, { project: 'group/other' }),
        newerRun({}, { provider: 'gh' }),
        newerRun({}, { host: 'gitlab.other.com' }),
      ]),
    )
    expect(await gitTriggerRunSkipReason(origin, self)).toBeNull()
  })

  it('ignores a newer commented-run — a comment does not re-review the code', async () => {
    fetchRequestState.mockResolvedValue('open')
    mockDb.select.mockReturnValue(makeSelectChain([newerRun({}, { event: 'commented' })]))
    expect(await gitTriggerRunSkipReason(origin, self)).toBeNull()
  })

  it('never supersedes a commented-run — each comment is its own question', async () => {
    fetchRequestState.mockResolvedValue('open')
    mockDb.select.mockReturnValue(makeSelectChain([newerRun()]))
    expect(await gitTriggerRunSkipReason({ ...origin, event: 'commented' }, self)).toBeNull()
  })

  it('ignores the run itself and rows without a git-trigger origin', async () => {
    fetchRequestState.mockResolvedValue('open')
    mockDb.select.mockReturnValue(
      makeSelectChain([
        newerRun({ id: 'run_old' }),
        { id: 'run_y', status: 'queued', executionMetadata: null },
      ]),
    )
    expect(await gitTriggerRunSkipReason(origin, self)).toBeNull()
  })

  it('fails open into the forge probe when the lookup throws', async () => {
    fetchRequestState.mockResolvedValue('open')
    mockDb.select.mockImplementation(() => {
      throw new Error('db down')
    })
    expect(await gitTriggerRunSkipReason(origin, self)).toBeNull()
    expect(fetchRequestState).toHaveBeenCalled()
  })

  it('does not look up newer runs without the run identity', async () => {
    fetchRequestState.mockResolvedValue('open')
    await gitTriggerRunSkipReason(origin)
    expect(mockDb.select).not.toHaveBeenCalled()
  })
})
