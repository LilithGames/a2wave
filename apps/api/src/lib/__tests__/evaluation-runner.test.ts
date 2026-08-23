/**
 * Unit tests for the evaluation runner's turn replay.
 *
 * The engine is mocked: these tests pin down the replay contract (session
 * threading, ordering, failure containment), not the CLI behaviour.
 */
import type { RunChannelContext } from '@a2wave/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeWithRetryMock = vi.fn()

vi.mock('../execute-with-retry.js', () => ({
  executeWithRetry: (...args: unknown[]) => executeWithRetryMock(...args),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const discardRunArtifactsDirMock = vi.fn()

vi.mock('../artifact-storage.js', () => ({
  discardRunArtifactsDir: (...args: unknown[]) => discardRunArtifactsDirMock(...args),
}))

const { replayCase } = await import('../evaluation-runner.js')

/** Engine reply helper: succeeds, echoing a chatId so resume can be asserted. */
function ok(output: string, chatId = 'chat_1') {
  return { result: { success: true, output, chatId }, retries: [], logs: [] }
}

function fail(error: string) {
  return { result: { success: false, output: '', error }, retries: [], logs: [] }
}

const AGENT_CONFIG = { engineType: 'claude-code', model: 'm' }

beforeEach(() => {
  executeWithRetryMock.mockReset()
  discardRunArtifactsDirMock.mockReset()
})

describe('replayCase', () => {
  it('replays a single turn and captures the actual response', async () => {
    executeWithRetryMock.mockResolvedValueOnce(ok('Hello there!'))

    const result = await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [{ request: 'hello', expectedResponse: 'a greeting' }],
      agentConfig: AGENT_CONFIG,
      workDir: '',
    })

    expect(result.status).toBe('completed')
    expect(result.actualTurns).toHaveLength(1)
    expect(result.actualTurns[0].actualResponse).toBe('Hello there!')
    expect(result.actualTurns[0].expectedResponse).toBe('a greeting')
  })

  it('threads the chatId so later turns resume the same session', async () => {
    executeWithRetryMock
      .mockResolvedValueOnce(ok('asking for the date', 'chat_abc'))
      .mockResolvedValueOnce(ok('declining politely', 'chat_abc'))

    await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [
        { request: 'refund please', expectedResponse: 'ask for date' },
        { request: '40 days ago', expectedResponse: 'decline' },
      ],
      agentConfig: AGENT_CONFIG,
      workDir: '',
    })

    // First turn starts a fresh session, second resumes the returned one.
    expect(executeWithRetryMock.mock.calls[0][1].chatId).toBeUndefined()
    expect(executeWithRetryMock.mock.calls[1][1].chatId).toBe('chat_abc')
  })

  it('sends each turn request as the prompt, in order', async () => {
    executeWithRetryMock.mockResolvedValueOnce(ok('a')).mockResolvedValueOnce(ok('b'))

    await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [
        { request: 'first', expectedResponse: '' },
        { request: 'second', expectedResponse: '' },
      ],
      agentConfig: AGENT_CONFIG,
      workDir: '',
    })

    expect(executeWithRetryMock.mock.calls.map((call) => call[1].prompt)).toEqual([
      'first',
      'second',
    ])
  })

  it('uses one consistent taskId per turn for the positional arg and the payload', async () => {
    executeWithRetryMock.mockResolvedValueOnce(ok('done'))

    await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [{ request: 'hi', expectedResponse: '' }],
      agentConfig: AGENT_CONFIG,
      workDir: '',
    })

    const [positionalTaskId, payload] = executeWithRetryMock.mock.calls[0]
    expect(payload.taskId).toBe(positionalTaskId)
  })

  it('stops at the first failing turn and marks the case failed', async () => {
    executeWithRetryMock
      .mockResolvedValueOnce(ok('fine'))
      .mockResolvedValueOnce(fail('engine exploded'))

    const result = await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [
        { request: 'one', expectedResponse: '' },
        { request: 'two', expectedResponse: '' },
        { request: 'three', expectedResponse: '' },
      ],
      agentConfig: AGENT_CONFIG,
      workDir: '',
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('engine exploded')
    // The third turn must not run once the second failed.
    expect(executeWithRetryMock).toHaveBeenCalledTimes(2)
    expect(result.actualTurns).toHaveLength(2)
    expect(result.actualTurns[1].error).toContain('engine exploded')
  })

  it('contains a thrown engine error rather than propagating it', async () => {
    executeWithRetryMock.mockRejectedValueOnce(new Error('spawn ENOENT'))

    const result = await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [{ request: 'hi', expectedResponse: '' }],
      agentConfig: AGENT_CONFIG,
      workDir: '',
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('spawn ENOENT')
  })

  it('records a duration for the case', async () => {
    executeWithRetryMock.mockResolvedValueOnce(ok('done'))

    const result = await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [{ request: 'hi', expectedResponse: '' }],
      agentConfig: AGENT_CONFIG,
      workDir: '',
    })

    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(typeof result.durationMs).toBe('number')
  })

  it('aborts before running when the signal is already cancelled', async () => {
    const result = await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [{ request: 'hi', expectedResponse: '' }],
      agentConfig: AGENT_CONFIG,
      workDir: '',
      isCancelled: () => true,
    })

    expect(executeWithRetryMock).not.toHaveBeenCalled()
    // Not `failed`: the user stopped this case, the Agent did not fail it.
    expect(result.status).toBe('cancelled')
  })

  it('finishes the case in flight rather than cancelling between turns', async () => {
    executeWithRetryMock.mockResolvedValueOnce(ok('reply 1')).mockResolvedValueOnce(ok('reply 2'))

    const result = await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [
        { request: 'turn 1', expectedResponse: '' },
        { request: 'turn 2', expectedResponse: '' },
      ],
      agentConfig: AGENT_CONFIG,
      workDir: '',
      // Not cancelled at case start, then cancelled while turn 1 is running.
      isCancelled: () => executeWithRetryMock.mock.calls.length > 0,
    })

    // The API and the user manual both promise cancellation takes effect
    // between cases; abandoning a multi-turn conversation halfway would leave a
    // transcript the reviewer cannot judge.
    expect(executeWithRetryMock).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('completed')
  })

  /**
   * Regression: the route supplies `() => shouldStopTask(taskId)`, which is
   * async. An unawaited Promise is always truthy, so every case aborted at turn
   * 0 with "Evaluation cancelled" — the whole feature replayed nothing.
   */
  it('replays the turns when an async predicate reports not cancelled', async () => {
    executeWithRetryMock.mockResolvedValueOnce(ok('reply 1')).mockResolvedValueOnce(ok('reply 2'))

    const result = await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [
        { request: 'turn 1', expectedResponse: 'a' },
        { request: 'turn 2', expectedResponse: 'b' },
      ],
      agentConfig: AGENT_CONFIG,
      workDir: '',
      isCancelled: async () => false,
    })

    expect(executeWithRetryMock).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('completed')
    expect(result.error).toBeNull()
    expect(result.actualTurns.map((turn) => turn.actualResponse)).toEqual(['reply 1', 'reply 2'])
  })

  it('aborts before running when an async predicate reports cancelled', async () => {
    const result = await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [{ request: 'hi', expectedResponse: '' }],
      agentConfig: AGENT_CONFIG,
      workDir: '',
      isCancelled: async () => true,
    })

    expect(executeWithRetryMock).not.toHaveBeenCalled()
    expect(result.status).toBe('cancelled')
    expect(result.error).toBe('Evaluation cancelled')
  })

  it('passes the caller channel through so gateway Agents can sign a token', async () => {
    executeWithRetryMock.mockResolvedValueOnce(ok('hi'))
    const channel = {
      channel_type: 'debug',
      channel_info: { triggered_by_user_id: 'usr_1' },
      user_info: null,
    } as RunChannelContext

    await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [{ request: 'hi', expectedResponse: '' }],
      agentConfig: AGENT_CONFIG,
      workDir: '',
      channel,
    })

    // Without this a gateway-enabled Agent fails every turn with
    // GATEWAY_NO_USER_IDENTITY before reaching the model.
    const payload = executeWithRetryMock.mock.calls[0]?.[1] as { context?: { channel?: unknown } }
    expect(payload.context?.channel).toEqual(channel)
  })
})

describe('summarizeResults', () => {
  it('excludes cancelled cases instead of stranding them as unreviewed', async () => {
    const { summarizeResults } = await import('../evaluation-runner.js')

    const summary = summarizeResults([
      { review: { verdict: 'pass' }, status: 'completed' },
      { review: null, status: 'cancelled' },
      { review: null, status: 'cancelled' },
    ])

    // A cancelled case produced no answer and can never be given a verdict, so
    // counting it would hold "reviewed 1 / 3" short of completion forever.
    expect(summary.total).toBe(1)
    expect(summary.unreviewed).toBe(0)
    expect(summary.passRate).toBe(1)
  })

  it('counts verdicts and computes a pass rate over reviewed cases only', async () => {
    const { summarizeResults } = await import('../evaluation-runner.js')

    const summary = summarizeResults([
      { review: { verdict: 'pass' } },
      { review: { verdict: 'pass' } },
      { review: { verdict: 'fail' } },
      { review: null },
    ] as never)

    expect(summary).toEqual({
      total: 4,
      passed: 2,
      failed: 1,
      unreviewed: 1,
      passRate: 2 / 3,
    })
  })

  it('reports a null pass rate when nothing has been reviewed', async () => {
    const { summarizeResults } = await import('../evaluation-runner.js')

    const summary = summarizeResults([{ review: null }, { review: null }] as never)

    expect(summary.passRate).toBeNull()
    expect(summary.unreviewed).toBe(2)
  })
})

describe('replayCase artifacts scratch', () => {
  it('discards every turn artifacts directory, including the turn that failed', async () => {
    // Each turn runs under its own taskId and therefore its own
    // $A2WAVE_ARTIFACTS_DIR. Evaluation never registers artifacts, so nothing
    // else would remove them — and on a shared checkout that outlives the task
    // they would accumulate one directory per turn, forever.
    executeWithRetryMock
      .mockResolvedValueOnce(ok('a'))
      .mockRejectedValueOnce(new Error('engine crashed'))

    await replayCase({
      taskId: 'evt_1',
      caseId: 'evc_1',
      turns: [
        { request: 'one', expectedResponse: 'a' },
        { request: 'two', expectedResponse: 'b' },
      ],
      agentConfig: AGENT_CONFIG,
      workDir: '/tmp/eval-workdir',
    })

    const turnTaskIds = executeWithRetryMock.mock.calls.map((call) => call[0] as string)
    expect(turnTaskIds).toHaveLength(2)
    expect(discardRunArtifactsDirMock.mock.calls.map((call) => call[1])).toEqual(turnTaskIds)
    for (const call of discardRunArtifactsDirMock.mock.calls) {
      expect(call[0]).toBe('/tmp/eval-workdir')
    }
  })
})
