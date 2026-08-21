import { beforeEach, describe, expect, it, vi } from 'vitest'
import { withA2ACommandResponder } from '../command-execute.js'

const mockIntercept = vi.hoisted(() => vi.fn())
vi.mock('../../lib/native-chat-command.js', () => ({
  interceptNativeChatCommand: (input: unknown) => mockIntercept(input),
}))

const AGENT = { id: 'agt_1', name: 'Reviewer' } as never

const PAYLOAD = {
  taskId: 'tsk_1',
  prompt: '/status',
  workDir: '/tmp/x',
  agentConfig: {},
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIntercept.mockResolvedValue({ handled: false })
})

describe('withA2ACommandResponder', () => {
  it('answers a responder command as a successful task without executing', async () => {
    mockIntercept.mockResolvedValue({ handled: true, reply: 'Reviewer — idle' })
    const inner = vi.fn()

    const result = await withA2ACommandResponder(AGENT, inner)('tsk_1', PAYLOAD)

    expect(inner).not.toHaveBeenCalled()
    expect(result).toMatchObject({ success: true, output: 'Reviewer — idle' })
  })

  it('reports a duration so the task record is well formed', async () => {
    mockIntercept.mockResolvedValue({ handled: true, reply: 'ok' })

    const result = await withA2ACommandResponder(AGENT, vi.fn())('tsk_1', PAYLOAD)

    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('delegates ordinary prompts to the wrapped executor untouched', async () => {
    const inner = vi.fn().mockResolvedValue({ success: true, output: 'done', durationMs: 5 })
    const payload = { ...PAYLOAD, prompt: 'review MR 42' }
    const options = { provenance: undefined }

    const result = await withA2ACommandResponder(AGENT, inner)('tsk_1', payload, options)

    expect(inner).toHaveBeenCalledWith('tsk_1', payload, options)
    expect(result).toMatchObject({ output: 'done' })
  })

  it('treats an agent-to-agent call as a direct conversation', async () => {
    await withA2ACommandResponder(AGENT, vi.fn())('tsk_1', PAYLOAD)

    expect(mockIntercept).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agt_1', text: '/status', chatType: 'p2p' }),
    )
  })
})
