import { type Message, type Part, Role, type Task, TaskState } from '@a2a-js/sdk'
import { RequestContext, ServerCallContext } from '@a2a-js/sdk/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { A2waveAgentExecutor, type ExecuteFn } from '../executor.js'
import { A2WAVE_CALLER_PROVENANCE_EXTENSION_URI } from '../provenance.js'

function createMockEventBus() {
  return {
    publish: vi.fn(),
    finished: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn(),
  }
}

function textPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    mediaType: 'text/plain',
    filename: '',
    metadata: undefined,
  }
}

let messageCounter = 0
function createMessage(texts: string[]): Message {
  messageCounter++
  return {
    messageId: `test-msg-${messageCounter}`,
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: texts.map(textPart),
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}

function createRequestContext(
  message: Message,
  taskId: string,
  contextId: string,
  task?: Task,
  serverContext = new ServerCallContext({ requestedVersion: '1.0' }),
): RequestContext {
  return new RequestContext(
    { tenant: '', message, configuration: undefined, metadata: undefined },
    taskId,
    contextId,
    serverContext,
    task,
  )
}

type PublishedEvent = { kind: string; data: Record<string, unknown> }

function publishedEvents(eventBus: ReturnType<typeof createMockEventBus>): PublishedEvent[] {
  return eventBus.publish.mock.calls.map((call) => call[0] as PublishedEvent)
}

const defaultConfig = {
  agentConfig: { provider: 'openai' },
  workDir: '/tmp/test',
  model: 'gpt-4o',
}

describe('A2waveAgentExecutor', () => {
  let eventBus: ReturnType<typeof createMockEventBus>
  let executeFn: ReturnType<typeof vi.fn<ExecuteFn>>
  let executor: A2waveAgentExecutor

  beforeEach(() => {
    eventBus = createMockEventBus()
    executeFn = vi.fn<ExecuteFn>().mockResolvedValue({
      success: true,
      output: 'Hello from agent',
      durationMs: 100,
    })
    executor = new A2waveAgentExecutor(defaultConfig, executeFn)
  })

  it('extracts v1 text parts and passes the prompt to the recorded execution', async () => {
    const ctx = createRequestContext(createMessage(['Hello', 'World']), 'task_1', 'ctx_1')

    await executor.execute(ctx, eventBus)

    expect(executeFn).toHaveBeenCalledOnce()
    expect(executeFn.mock.calls[0][1]).toMatchObject({
      prompt: 'Hello\nWorld',
      taskId: 'task_1',
      model: 'gpt-4o',
      workDir: '/tmp/test',
      agentConfig: { provider: 'openai' },
    })
  })

  it('passes validated caller provenance from an activated v1 message to recording', async () => {
    const extensionUri = A2WAVE_CALLER_PROVENANCE_EXTENSION_URI
    const message = createMessage(['Trace this call'])
    message.extensions = [extensionUri]
    message.metadata = {
      [extensionUri]: {
        userName: '张鑫',
        callerAgent: { id: 'agt_remote_router', name: 'SDK Manager大神' },
      },
    }
    const serverContext = new ServerCallContext({
      requestedVersion: '1.0',
      requestedExtensions: [extensionUri],
    })

    await executor.execute(
      createRequestContext(message, 'task_provenance', 'ctx_provenance', undefined, serverContext),
      eventBus,
    )

    expect(executeFn.mock.calls[0][2]).toMatchObject({
      provenance: {
        userName: '张鑫',
        callerAgent: { id: 'agt_remote_router', name: 'SDK Manager大神' },
      },
    })
    expect(serverContext.activatedExtensions).toEqual([extensionUri])
  })

  it('accepts caller Agent provenance when the original user is unavailable', async () => {
    const extensionUri = A2WAVE_CALLER_PROVENANCE_EXTENSION_URI
    const message = createMessage(['System initiated call'])
    message.extensions = [extensionUri]
    message.metadata = {
      [extensionUri]: {
        callerAgent: { id: 'agt_remote_router', name: 'Remote Router' },
      },
    }

    await executor.execute(
      createRequestContext(
        message,
        'task_agent_only',
        'ctx_agent_only',
        undefined,
        new ServerCallContext({
          requestedVersion: '1.0',
          requestedExtensions: [extensionUri],
        }),
      ),
      eventBus,
    )

    expect(executeFn.mock.calls[0][2]).toMatchObject({
      provenance: { callerAgent: { id: 'agt_remote_router', name: 'Remote Router' } },
    })
  })

  it('ignores provenance metadata when the extension was not activated', async () => {
    const extensionUri = A2WAVE_CALLER_PROVENANCE_EXTENSION_URI
    const message = createMessage(['Do not trust metadata alone'])
    message.extensions = [extensionUri]
    message.metadata = {
      [extensionUri]: {
        userName: 'Unactivated User',
        callerAgent: { id: 'agt_unactivated', name: 'Unactivated Agent' },
      },
    }

    await executor.execute(
      createRequestContext(message, 'task_unactivated', 'ctx_unactivated'),
      eventBus,
    )

    expect(executeFn.mock.calls[0][2]).not.toHaveProperty('provenance')
  })

  it('preserves v1 raw and URL attachments for materialization', async () => {
    const message = createMessage(['Inspect files'])
    message.parts.push(
      {
        content: { $case: 'raw', value: Buffer.from('hello') },
        filename: 'hello.txt',
        mediaType: 'text/plain',
        metadata: undefined,
      },
      {
        content: { $case: 'url', value: 'https://example.com/report.pdf' },
        filename: 'report.pdf',
        mediaType: 'application/pdf',
        metadata: undefined,
      },
    )

    await executor.execute(createRequestContext(message, 'task_files', 'ctx_files'), eventBus)

    expect(executeFn.mock.calls[0][1].attachments).toEqual([
      { kind: 'bytes', bytes: 'aGVsbG8=', name: 'hello.txt', mimeType: 'text/plain' },
      {
        kind: 'uri',
        uri: 'https://example.com/report.pdf',
        name: 'report.pdf',
        mimeType: 'application/pdf',
      },
    ])
  })

  it('publishes a valid v1 task lifecycle on success', async () => {
    await executor.execute(
      createRequestContext(createMessage(['Do something']), 'task_2', 'ctx_2'),
      eventBus,
    )

    const events = publishedEvents(eventBus)
    expect(events.map((event) => event.kind)).toEqual([
      'task',
      'statusUpdate',
      'artifactUpdate',
      'statusUpdate',
    ])
    expect(events[0].data).toMatchObject({
      id: 'task_2',
      status: { state: TaskState.TASK_STATE_SUBMITTED },
    })
    expect(events[1].data).toMatchObject({
      taskId: 'task_2',
      contextId: 'ctx_2',
      status: { state: TaskState.TASK_STATE_WORKING },
    })
    expect(events[2].data).toMatchObject({
      artifact: {
        parts: [{ content: { $case: 'text', value: 'Hello from agent' } }],
      },
      lastChunk: true,
      append: false,
    })
    expect(events[3].data).toMatchObject({
      status: { state: TaskState.TASK_STATE_COMPLETED },
    })
  })

  it('preserves existing task history, artifacts, and metadata on a follow-up turn', async () => {
    const previousMessage = createMessage(['First turn'])
    const followUpMessage = createMessage(['Second turn'])
    const existingTask: Task = {
      id: 'task_follow_up',
      contextId: 'ctx_follow_up',
      status: {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        message: undefined,
        timestamp: '2026-08-06T01:00:00.000Z',
      },
      artifacts: [
        {
          artifactId: 'artifact_existing',
          name: 'existing.txt',
          description: '',
          parts: [textPart('Existing output')],
          metadata: undefined,
          extensions: [],
        },
      ],
      history: [previousMessage, followUpMessage],
      metadata: { source: 'follow-up-test' },
    }

    await executor.execute(
      createRequestContext(followUpMessage, existingTask.id, existingTask.contextId, existingTask),
      eventBus,
    )

    expect(publishedEvents(eventBus)[0]).toMatchObject({
      kind: 'task',
      data: {
        id: existingTask.id,
        history: [
          { messageId: previousMessage.messageId },
          { messageId: followUpMessage.messageId },
        ],
        artifacts: [{ artifactId: 'artifact_existing' }],
        metadata: { source: 'follow-up-test' },
      },
    })
  })

  it('publishes terminal failure state and message when execution fails', async () => {
    executeFn.mockResolvedValue({
      success: false,
      output: '',
      error: 'boom',
      durationMs: 50,
    })

    await executor.execute(
      createRequestContext(createMessage(['fail please']), 'task_3', 'ctx_3'),
      eventBus,
    )

    const failed = publishedEvents(eventBus)[2]
    expect(failed.kind).toBe('statusUpdate')
    expect(failed.data).toMatchObject({
      status: {
        state: TaskState.TASK_STATE_FAILED,
        message: { parts: [{ content: { $case: 'text', value: 'boom' } }] },
      },
    })
  })

  it('keeps an idempotent in-progress retry non-terminal', async () => {
    executeFn.mockResolvedValue({
      success: false,
      inProgress: true,
      output: '',
      error: 'Task already in progress for this taskId',
      durationMs: 0,
    })

    await executor.execute(
      createRequestContext(createMessage(['retry']), 'task_inflight', 'ctx_inflight'),
      eventBus,
    )

    const states = publishedEvents(eventBus)
      .filter((event) => event.kind === 'statusUpdate')
      .map((event) => (event.data.status as { state: TaskState }).state)
    expect(states).toEqual([TaskState.TASK_STATE_WORKING, TaskState.TASK_STATE_WORKING])
  })

  it('publishes failure and finishes the bus when executeFn throws', async () => {
    executeFn.mockRejectedValue(new Error('unexpected crash'))

    await executor.execute(
      createRequestContext(createMessage(['crash']), 'task_4', 'ctx_4'),
      eventBus,
    )

    expect(publishedEvents(eventBus)[2].data).toMatchObject({
      status: {
        state: TaskState.TASK_STATE_FAILED,
        message: { parts: [{ content: { value: 'unexpected crash' } }] },
      },
    })
    expect(eventBus.finished).toHaveBeenCalledOnce()
  })

  it('handles an empty prompt and always finishes the bus', async () => {
    await executor.execute(
      createRequestContext(createMessage([]), 'task_empty', 'ctx_empty'),
      eventBus,
    )

    expect(executeFn.mock.calls[0][1].prompt).toBe('')
    expect(eventBus.finished).toHaveBeenCalledOnce()
  })

  it('publishes the v1 canceled terminal state', async () => {
    const cancelFn = vi.fn().mockResolvedValue('cancelled' as const)
    executor = new A2waveAgentExecutor(defaultConfig, executeFn, cancelFn)

    await executor.cancelTask('task_cancel', eventBus)

    expect(cancelFn).toHaveBeenCalledWith('task_cancel')
    expect(publishedEvents(eventBus)).toEqual([
      expect.objectContaining({
        kind: 'statusUpdate',
        data: expect.objectContaining({
          taskId: 'task_cancel',
          status: expect.objectContaining({ state: TaskState.TASK_STATE_CANCELED }),
        }),
      }),
    ])
    expect(eventBus.finished).toHaveBeenCalledOnce()
  })

  it('does not publish canceled when the recorded run can no longer be canceled', async () => {
    executor = new A2waveAgentExecutor(
      defaultConfig,
      executeFn,
      vi.fn().mockResolvedValue('not_cancellable'),
    )

    await expect(executor.cancelTask('task_done', eventBus)).rejects.toThrow(
      'Task cannot be canceled',
    )
    expect(eventBus.publish).not.toHaveBeenCalled()
  })
})
