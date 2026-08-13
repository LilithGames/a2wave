import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/streaming-safe-fetch.js', async () => {
  const core = await vi.importActual<typeof import('../../lib/url-safety-core.js')>(
    '../../lib/url-safety-core.js',
  )
  return {
    parseTrustedHostnames: (raw?: string) => new Set((raw ?? '').split(',').filter(Boolean)),
    createStreamingSafeFetch:
      ({ allowPrivateTargets }: { allowPrivateTargets?: boolean }) =>
      (url: string | URL, init?: RequestInit) =>
        core.safeFetch(url.toString(), {
          ...init,
          validateHop: (hop) => {
            core.assertSafeHttpUrl(hop, { allowPrivateAddresses: allowPrivateTargets })
          },
        }),
  }
})

import { UnsafeUrlError } from '../../lib/url-safety-core.js'
import { invokeAgentHandler } from '../a2wave-agent-router.js'
import type { RouteTarget } from '../a2wave-agent-router.js'

beforeEach(() => {
  vi.restoreAllMocks()
})

function standardAgentCard(interfaceUrl: string) {
  return {
    name: 'Standard Agent',
    description: 'External standards-compatible agent',
    supportedInterfaces: [
      {
        url: interfaceUrl,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
    version: '1.0.0',
    capabilities: { streaming: true, extensions: [] },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  }
}

describe('A2A router recovery result continuity', () => {
  it('logs deduplicated task state transitions from an uninterrupted stream', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'state-stream-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const encoder = new TextEncoder()
    const fetchSpy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const request = JSON.parse(init?.body as string)
      const event = (state: string) =>
        `data: ${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            statusUpdate: {
              taskId: 'task-state-stream',
              contextId: 'context-state-stream',
              status: {
                state,
                ...(state === 'TASK_STATE_COMPLETED' && {
                  message: {
                    messageId: 'task-state-stream-result',
                    role: 'ROLE_AGENT',
                    parts: [{ text: 'completed', mediaType: 'text/plain' }],
                  },
                }),
              },
            },
          },
        })}`
      return new Response(
        encoder.encode(
          `${[
            event('TASK_STATE_WORKING'),
            event('TASK_STATE_WORKING'),
            event('TASK_STATE_COMPLETED'),
          ].join('\n\n')}\n\n`,
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await invokeAgentHandler(
      { agentId: 'remote:state-stream-v1', message: 'track task states' },
      targets,
    )

    const states = consoleSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[agent-router] {'))
      .map((line) => JSON.parse(line.slice('[agent-router] '.length)))
      .filter((entry) => entry.event === 'a2a.task.state')
      .map((entry) => entry.state)
    expect(states).toEqual(['TASK_STATE_WORKING', 'TASK_STATE_COMPLETED'])
  })

  it('preserves artifact chunks received before reconnecting by Task ID', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'chunk-reconnect-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const methods: string[] = []
    const encoder = new TextEncoder()
    const spy = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      if (request.method === 'SendStreamingMessage') {
        let sentFirstChunk = false
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sentFirstChunk) {
                sentFirstChunk = true
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      jsonrpc: '2.0',
                      id: request.id,
                      result: {
                        artifactUpdate: {
                          taskId: 'task-chunk-reconnect',
                          contextId: 'context-chunk-reconnect',
                          artifact: {
                            artifactId: 'artifact-chunk-reconnect',
                            parts: [{ text: 'Hel', mediaType: 'text/plain' }],
                          },
                          append: false,
                          lastChunk: false,
                        },
                      },
                    })}\n\n`,
                  ),
                )
                return
              }
              controller.error(new Error('connection reset between artifact chunks'))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(
        `${[
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              artifactUpdate: {
                taskId: 'task-chunk-reconnect',
                contextId: 'context-chunk-reconnect',
                artifact: {
                  artifactId: 'artifact-chunk-reconnect',
                  parts: [{ text: 'lo', mediaType: 'text/plain' }],
                },
                append: true,
                lastChunk: true,
              },
            },
          })}`,
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              statusUpdate: {
                taskId: 'task-chunk-reconnect',
                contextId: 'context-chunk-reconnect',
                status: { state: 'TASK_STATE_COMPLETED' },
              },
            },
          })}`,
        ].join('\n\n')}\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    })
    globalThis.fetch = spy as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:chunk-reconnect-v1', message: 'preserve every chunk' },
      targets,
    )

    expect(result.content[0].text).toBe('Hello')
    expect(methods).toEqual(['SendStreamingMessage', 'SubscribeToTask'])
  })

  it.each([
    ['Task ID', 'task-identity-b', 'context-identity-a'],
    ['context ID', 'task-identity-a', 'context-identity-b'],
  ])(
    'rejects a changed %s and cancels the first observed Task',
    async (_label, taskId, contextId) => {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'identity-change-v1',
          url: 'https://v1.example.com/cards/agent.json',
          connectionMode: 'agent_card',
        },
      ]
      const methods: string[] = []
      const encoder = new TextEncoder()
      const streamCancel = vi.fn()
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/cards/agent.json')) {
          return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        if (request.method === 'CancelTask') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                id: 'task-identity-a',
                contextId: 'context-identity-a',
                status: { state: 'TASK_STATE_CANCELED' },
                artifacts: [],
                history: [],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        const event = (nextTaskId: string, nextContextId: string) =>
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              statusUpdate: {
                taskId: nextTaskId,
                contextId: nextContextId,
                status: { state: 'TASK_STATE_WORKING' },
              },
            },
          })}`
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `${[
                    event('task-identity-a', 'context-identity-a'),
                    event(taskId, contextId),
                  ].join('\n\n')}\n\n`,
                ),
              )
            },
            cancel: streamCancel,
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }) as unknown as typeof fetch

      const result = await invokeAgentHandler(
        { agentId: 'remote:identity-change-v1', message: 'keep one Task identity' },
        targets,
      )

      expect((result as { isError?: boolean }).isError).toBe(true)
      expect(result.content[0].text).toContain('changed identity')
      expect(result.content[0].text).toContain('task-identity-a')
      expect(methods).toEqual(['SendStreamingMessage', 'CancelTask'])
      expect(streamCancel).toHaveBeenCalledOnce()
    },
  )

  it('does not charge unchanged Task history on every polling snapshot', async () => {
    vi.useFakeTimers()
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'stable-history-v1',
          url: 'https://v1.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      const methods: string[] = []
      const historyLengths: Array<number | undefined> = []
      const repeatedHistoryText = 'x'.repeat(6 * 1024 * 1024)
      let getTaskCalls = 0
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        historyLengths.push(
          request.method === 'SendMessage'
            ? request.params.configuration?.historyLength
            : request.params.historyLength,
        )
        if (request.method === 'CancelTask') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                id: 'task-stable-history',
                contextId: 'context-stable-history',
                status: { state: 'TASK_STATE_CANCELED' },
                artifacts: [],
                history: [],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }

        const completed = request.method === 'GetTask' && ++getTaskCalls === 2
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              ...(request.method === 'SendMessage'
                ? {
                    task: {
                      id: 'task-stable-history',
                      contextId: 'context-stable-history',
                      status: { state: 'TASK_STATE_WORKING' },
                      artifacts: [],
                      history:
                        request.params.configuration?.historyLength === 0
                          ? []
                          : [
                              {
                                messageId: 'large-original-request',
                                role: 'ROLE_USER',
                                parts: [{ text: repeatedHistoryText, mediaType: 'text/plain' }],
                              },
                            ],
                    },
                  }
                : {
                    id: 'task-stable-history',
                    contextId: 'context-stable-history',
                    status: { state: completed ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_WORKING' },
                    artifacts: completed
                      ? [
                          {
                            artifactId: 'artifact-stable-history',
                            parts: [
                              { text: 'completed after stable polling', mediaType: 'text/plain' },
                            ],
                          },
                        ]
                      : [],
                    history:
                      request.params.historyLength === 0
                        ? []
                        : [
                            {
                              messageId: 'large-original-request',
                              role: 'ROLE_USER',
                              parts: [{ text: repeatedHistoryText, mediaType: 'text/plain' }],
                            },
                          ],
                  }),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:stable-history-v1', message: 'wait without rebudgeting history' },
        targets,
      )
      await vi.advanceTimersByTimeAsync(1_001)
      const result = await invocation

      expect(result.content[0].text).toBe('completed after stable polling')
      expect(methods).toEqual(['SendMessage', 'GetTask', 'GetTask'])
      expect(historyLengths).toEqual([0, 0, 0])
    } finally {
      vi.useRealTimers()
    }
  })

  it('hydrates bounded terminal history only when polling produced no displayable response', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'terminal-history-v1',
        url: 'https://v1.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    const methods: string[] = []
    const historyLengths: Array<number | undefined> = []
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      const historyLength =
        request.method === 'SendMessage'
          ? request.params.configuration?.historyLength
          : request.params.historyLength
      historyLengths.push(historyLength)
      const task = {
        id: 'task-terminal-history',
        contextId: 'context-terminal-history',
        status: {
          state: request.method === 'SendMessage' ? 'TASK_STATE_WORKING' : 'TASK_STATE_COMPLETED',
        },
        artifacts: [],
        history:
          historyLength === 20
            ? [
                {
                  messageId: 'terminal-agent-message',
                  role: 'ROLE_AGENT',
                  parts: [
                    { text: 'answer restored from terminal history', mediaType: 'text/plain' },
                  ],
                },
              ]
            : [],
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'SendMessage' ? { task } : task,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const result = await invokeAgentHandler(
      { agentId: 'remote:terminal-history-v1', message: 'return an answer from Task history' },
      targets,
    )

    expect(result.content[0].text).toBe('answer restored from terminal history')
    expect(methods).toEqual(['SendMessage', 'GetTask', 'GetTask'])
    expect(historyLengths).toEqual([0, 0, 20])
  })

  it('hydrates bounded terminal history when SendMessage completes immediately', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'immediate-terminal-history-v1',
        url: 'https://v1.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ]
    const methods: string[] = []
    const historyLengths: Array<number | undefined> = []
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      const historyLength =
        request.method === 'SendMessage'
          ? request.params.configuration?.historyLength
          : request.params.historyLength
      historyLengths.push(historyLength)
      const task = {
        id: 'task-immediate-terminal-history',
        contextId: 'context-immediate-terminal-history',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [],
        history:
          historyLength === 20
            ? [
                {
                  messageId: 'immediate-terminal-agent-message',
                  role: 'ROLE_AGENT',
                  parts: [
                    { text: 'answer restored after immediate completion', mediaType: 'text/plain' },
                  ],
                },
              ]
            : [],
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: request.method === 'SendMessage' ? { task } : task,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const result = await invokeAgentHandler(
      {
        agentId: 'remote:immediate-terminal-history-v1',
        message: 'complete immediately with an answer in Task history',
      },
      targets,
    )

    expect(result.content[0].text).toBe('answer restored after immediate completion')
    expect(methods).toEqual(['SendMessage', 'GetTask'])
    expect(historyLengths).toEqual([0, 20])
  })

  it('hydrates bounded terminal history after resubscription completes', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'resubscribed-terminal-history-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const methods: string[] = []
    const historyLengths: Array<number | undefined> = []
    const encoder = new TextEncoder()
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      if (request.method === 'SendStreamingMessage') {
        let sentWorkingState = false
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sentWorkingState) {
                sentWorkingState = true
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      jsonrpc: '2.0',
                      id: request.id,
                      result: {
                        statusUpdate: {
                          taskId: 'task-resubscribed-terminal-history',
                          contextId: 'context-resubscribed-terminal-history',
                          status: { state: 'TASK_STATE_WORKING' },
                        },
                      },
                    })}\n\n`,
                  ),
                )
                return
              }
              controller.error(new Error('stream disconnected after Task observation'))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }

      if (request.method === 'SubscribeToTask') {
        return new Response(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              statusUpdate: {
                taskId: 'task-resubscribed-terminal-history',
                contextId: 'context-resubscribed-terminal-history',
                status: { state: 'TASK_STATE_COMPLETED' },
              },
            },
          })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }

      const historyLength = request.params.historyLength
      historyLengths.push(historyLength)
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            id: 'task-resubscribed-terminal-history',
            contextId: 'context-resubscribed-terminal-history',
            status: { state: 'TASK_STATE_COMPLETED' },
            artifacts: [],
            history:
              historyLength === 20
                ? [
                    {
                      messageId: 'resubscribed-terminal-agent-message',
                      role: 'ROLE_AGENT',
                      parts: [
                        {
                          text: 'answer restored after resubscription',
                          mediaType: 'text/plain',
                        },
                      ],
                    },
                  ]
                : [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const result = await invokeAgentHandler(
      {
        agentId: 'remote:resubscribed-terminal-history-v1',
        message: 'recover a history-only answer after resubscription',
      },
      targets,
    )

    expect(result.content[0].text).toBe('answer restored after resubscription')
    expect(methods).toEqual(['SendStreamingMessage', 'SubscribeToTask', 'GetTask'])
    expect(historyLengths).toEqual([20])
  })

  it('does not retry or mislabel polling that fails after a successful resubscription', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'post-resubscribe-poll-failure-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const methods: string[] = []
    const encoder = new TextEncoder()
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      if (request.method === 'SendStreamingMessage') {
        let sentWorkingState = false
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sentWorkingState) {
                sentWorkingState = true
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      jsonrpc: '2.0',
                      id: request.id,
                      result: {
                        statusUpdate: {
                          taskId: 'task-post-resubscribe-poll-failure',
                          contextId: 'context-post-resubscribe-poll-failure',
                          status: { state: 'TASK_STATE_WORKING' },
                        },
                      },
                    })}\n\n`,
                  ),
                )
                return
              }
              controller.error(new Error('initial stream disconnected'))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (request.method === 'SubscribeToTask') {
        return new Response(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              statusUpdate: {
                taskId: 'task-post-resubscribe-poll-failure',
                contextId: 'context-post-resubscribe-poll-failure',
                status: { state: 'TASK_STATE_WORKING' },
              },
            },
          })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32601,
            message:
              request.method === 'CancelTask'
                ? 'cleanup cancellation failed'
                : 'polling failed after successful resubscription',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const lifecycleLogs = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await invokeAgentHandler(
      {
        agentId: 'remote:post-resubscribe-poll-failure-v1',
        message: 'do not retry a post-resubscription protocol failure',
      },
      targets,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('polling failed after successful resubscription')
    expect(result.content[0].text).not.toContain('cleanup cancellation failed')
    expect(methods).toEqual(['SendStreamingMessage', 'SubscribeToTask', 'GetTask', 'CancelTask'])
    const lifecycleEvents = lifecycleLogs.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[agent-router] {'))
      .map((line) => JSON.parse(line.slice('[agent-router] '.length)).event)
    expect(lifecycleEvents).not.toContain('a2a.task.resubscribe_failed')
  })

  it('does not poll or cancel after terminal history hydration fails following resubscription', async () => {
    const targets: RouteTarget[] = [
      {
        type: 'remote',
        name: 'terminal-history-failure-v1',
        url: 'https://v1.example.com/cards/agent.json',
        connectionMode: 'agent_card',
      },
    ]
    const methods: string[] = []
    const encoder = new TextEncoder()
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/cards/agent.json')) {
        return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      const request = JSON.parse(init?.body as string)
      methods.push(request.method)
      if (request.method === 'SendStreamingMessage') {
        let sentWorkingState = false
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!sentWorkingState) {
                sentWorkingState = true
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({
                      jsonrpc: '2.0',
                      id: request.id,
                      result: {
                        statusUpdate: {
                          taskId: 'task-terminal-history-failure',
                          contextId: 'context-terminal-history-failure',
                          status: { state: 'TASK_STATE_WORKING' },
                        },
                      },
                    })}\n\n`,
                  ),
                )
                return
              }
              controller.error(new Error('initial stream disconnected'))
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (request.method === 'SubscribeToTask') {
        return new Response(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              statusUpdate: {
                taskId: 'task-terminal-history-failure',
                contextId: 'context-terminal-history-failure',
                status: { state: 'TASK_STATE_COMPLETED' },
              },
            },
          })}\n\n`,
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        )
      }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'terminal history permanently unavailable' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch
    const lifecycleLogs = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const result = await invokeAgentHandler(
      {
        agentId: 'remote:terminal-history-failure-v1',
        message: 'do not cancel a terminal Task when history hydration fails',
      },
      targets,
    )

    expect((result as { isError?: boolean }).isError).toBe(true)
    expect(result.content[0].text).toContain('terminal history permanently unavailable')
    expect(methods).toEqual(['SendStreamingMessage', 'SubscribeToTask', 'GetTask'])
    const lifecycleEvents = lifecycleLogs.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('[agent-router] {'))
      .map((line) => JSON.parse(line.slice('[agent-router] '.length)).event)
    expect(lifecycleEvents).not.toContain('a2a.task.resubscribe_failed')
    expect(lifecycleEvents).not.toContain('a2a.task.cancel_requested')
  })

  it('retries transient terminal history hydration failures after resubscription', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'terminal-history-retry-v1',
          url: 'https://v1.example.com/cards/agent.json',
          connectionMode: 'agent_card',
        },
      ]
      const methods: string[] = []
      const historyLengths: number[] = []
      const encoder = new TextEncoder()
      let terminalHistoryCalls = 0
      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/cards/agent.json')) {
          return new Response(JSON.stringify(standardAgentCard('https://v1.example.com/a2a')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        if (request.method === 'SendStreamingMessage') {
          let sentWorkingState = false
          return new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (!sentWorkingState) {
                  sentWorkingState = true
                  controller.enqueue(
                    encoder.encode(
                      `data: ${JSON.stringify({
                        jsonrpc: '2.0',
                        id: request.id,
                        result: {
                          statusUpdate: {
                            taskId: 'task-terminal-history-retry',
                            contextId: 'context-terminal-history-retry',
                            status: { state: 'TASK_STATE_WORKING' },
                          },
                        },
                      })}\n\n`,
                    ),
                  )
                  return
                }
                controller.error(new Error('initial stream disconnected'))
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }
        if (request.method === 'SubscribeToTask') {
          return new Response(
            `data: ${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                statusUpdate: {
                  taskId: 'task-terminal-history-retry',
                  contextId: 'context-terminal-history-retry',
                  status: { state: 'TASK_STATE_COMPLETED' },
                },
              },
            })}\n\n`,
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )
        }

        const historyLength = request.params.historyLength as number
        historyLengths.push(historyLength)
        if (historyLength === 20 && ++terminalHistoryCalls === 1) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32603, message: 'terminal history temporarily unavailable' },
            }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              id: 'task-terminal-history-retry',
              contextId: 'context-terminal-history-retry',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [],
              history:
                historyLength === 20
                  ? [
                      {
                        messageId: 'terminal-history-retry-message',
                        role: 'ROLE_AGENT',
                        parts: [
                          { text: 'completed after resubscribe retry', mediaType: 'text/plain' },
                        ],
                      },
                    ]
                  : [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch
      const lifecycleLogs = vi.spyOn(console, 'error').mockImplementation(() => undefined)

      const invocation = invokeAgentHandler(
        {
          agentId: 'remote:terminal-history-retry-v1',
          message: 'retry terminal history after resubscription',
        },
        targets,
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(terminalHistoryCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)

      const result = await invocation
      expect(result.content[0].text).toBe('completed after resubscribe retry')
      expect(methods).toEqual([
        'SendStreamingMessage',
        'SubscribeToTask',
        'GetTask',
        'GetTask',
        'GetTask',
      ])
      expect(historyLengths).toEqual([20, 0, 20])
      const lifecycleEvents = lifecycleLogs.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith('[agent-router] {'))
        .map((line) => JSON.parse(line.slice('[agent-router] '.length)).event)
      expect(lifecycleEvents).toContain('a2a.task.poll_retry')
      expect(lifecycleEvents).not.toContain('a2a.task.resubscribe_failed')
      expect(lifecycleEvents).not.toContain('a2a.task.cancel_requested')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat a working status message as the final Task response', async () => {
    vi.useFakeTimers()
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'progress-terminal-history-v1',
          url: 'https://v1.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      const methods: string[] = []
      const historyLengths: Array<number | undefined> = []
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        const historyLength =
          request.method === 'SendMessage'
            ? request.params.configuration?.historyLength
            : request.params.historyLength
        historyLengths.push(historyLength)
        const task = {
          id: 'task-progress-terminal-history',
          contextId: 'context-progress-terminal-history',
          status:
            request.method === 'SendMessage'
              ? {
                  state: 'TASK_STATE_WORKING',
                  message: {
                    messageId: 'working-progress-message',
                    role: 'ROLE_AGENT',
                    parts: [{ text: 'Still working', mediaType: 'text/plain' }],
                  },
                }
              : { state: 'TASK_STATE_COMPLETED' },
          artifacts: [],
          history:
            historyLength === 20
              ? [
                  {
                    messageId: 'completed-agent-message',
                    role: 'ROLE_AGENT',
                    parts: [{ text: 'finished after progress', mediaType: 'text/plain' }],
                  },
                ]
              : [],
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: request.method === 'SendMessage' ? { task } : task,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        {
          agentId: 'remote:progress-terminal-history-v1',
          message: 'return the final answer after progress',
        },
        targets,
      )
      await vi.advanceTimersByTimeAsync(1_001)
      const result = await invocation

      expect(result.content[0].text).toBe('finished after progress')
      expect(methods).toEqual(['SendMessage', 'GetTask', 'GetTask'])
      expect(historyLengths).toEqual([0, 0, 20])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not promote a working status message replayed in terminal history', async () => {
    vi.useFakeTimers()
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'progress-empty-terminal-v1',
          url: 'https://v1.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      const methods: string[] = []
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        const historyLength =
          request.method === 'SendMessage'
            ? request.params.configuration?.historyLength
            : request.params.historyLength
        const task = {
          id: 'task-progress-empty-terminal',
          contextId: 'context-progress-empty-terminal',
          status:
            request.method === 'SendMessage'
              ? {
                  state: 'TASK_STATE_WORKING',
                  message: {
                    messageId: 'working-progress-message',
                    role: 'ROLE_AGENT',
                    parts: [{ text: 'Still working', mediaType: 'text/plain' }],
                  },
                }
              : { state: 'TASK_STATE_COMPLETED' },
          artifacts: [],
          history:
            historyLength === 20
              ? [
                  {
                    messageId: 'working-progress-message',
                    role: 'ROLE_AGENT',
                    parts: [{ text: 'Still working', mediaType: 'text/plain' }],
                  },
                ]
              : [],
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: request.method === 'SendMessage' ? { task } : task,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        {
          agentId: 'remote:progress-empty-terminal-v1',
          message: 'do not return progress as the final answer',
        },
        targets,
      )
      await vi.advanceTimersByTimeAsync(1_001)
      const result = await invocation

      expect(result.content[0].text).not.toBe('Still working')
      expect(result.content[0].text).toContain('task-progress-empty-terminal')
      expect(methods).toEqual(['SendMessage', 'GetTask', 'GetTask'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses capped exponential backoff for consecutive retryable polling failures', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'poll-backoff-v1',
          url: 'https://v1.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      let getTaskCalls = 0
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        const task = {
          id: 'task-poll-backoff',
          contextId: 'context-poll-backoff',
          status: {
            state: request.method === 'SendMessage' ? 'TASK_STATE_WORKING' : 'TASK_STATE_COMPLETED',
          },
          artifacts:
            request.method === 'GetTask'
              ? [
                  {
                    artifactId: 'artifact-poll-backoff',
                    parts: [{ text: 'completed after backoff', mediaType: 'text/plain' }],
                  },
                ]
              : [],
          history: [],
        }
        if (request.method === 'GetTask') {
          getTaskCalls += 1
          if (getTaskCalls <= 2) {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32603, message: 'temporarily unavailable' },
              }),
              { status: 503, headers: { 'content-type': 'application/json' } },
            )
          }
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: request.method === 'SendMessage' ? { task } : task,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:poll-backoff-v1', message: 'retry with backoff' },
        targets,
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(getTaskCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(getTaskCalls).toBe(2)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(getTaskCalls).toBe(2)
      await vi.advanceTimersByTimeAsync(1)

      const result = await invocation
      expect(getTaskCalls).toBe(3)
      expect(result.content[0].text).toBe('completed after backoff')
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps exponential backoff across repeated terminal-history read failures', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const lifecycleLogs = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'terminal-history-backoff-v1',
          url: 'https://v1.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      const historyLengths: number[] = []
      let terminalHistoryCalls = 0
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        const historyLength = request.params.historyLength
        if (request.method === 'GetTask') {
          historyLengths.push(historyLength)
          if (historyLength === 20 && ++terminalHistoryCalls <= 2) {
            return new Response(
              JSON.stringify({
                jsonrpc: '2.0',
                id: request.id,
                error: { code: -32603, message: 'terminal history temporarily unavailable' },
              }),
              { status: 503, headers: { 'content-type': 'application/json' } },
            )
          }
        }

        const task = {
          id: 'task-terminal-history-backoff',
          contextId: 'context-terminal-history-backoff',
          status: {
            state: request.method === 'SendMessage' ? 'TASK_STATE_WORKING' : 'TASK_STATE_COMPLETED',
          },
          artifacts: [],
          history:
            historyLength === 20
              ? [
                  {
                    messageId: 'terminal-history-backoff-message',
                    role: 'ROLE_AGENT',
                    parts: [{ text: 'completed after history backoff', mediaType: 'text/plain' }],
                  },
                ]
              : [],
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: request.method === 'SendMessage' ? { task } : task,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        {
          agentId: 'remote:terminal-history-backoff-v1',
          message: 'retry terminal history with backoff',
        },
        targets,
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(terminalHistoryCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(terminalHistoryCalls).toBe(2)
      await vi.advanceTimersByTimeAsync(1_999)
      expect(terminalHistoryCalls).toBe(2)
      await vi.advanceTimersByTimeAsync(1)

      const result = await invocation
      expect(result.content[0].text).toBe('completed after history backoff')
      expect(historyLengths).toEqual([0, 20, 0, 20, 0, 20])
      const retryAttempts = lifecycleLogs.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith('[agent-router] {'))
        .map((line) => JSON.parse(line.slice('[agent-router] '.length)))
        .filter((entry) => entry.event === 'a2a.task.poll_retry')
        .map((entry) => entry.attempt)
      expect(retryAttempts).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  it('honors Retry-After beyond the local exponential-backoff cap', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'poll-retry-after-v1',
          url: 'https://v1.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      let getTaskCalls = 0
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        const task = {
          id: 'task-retry-after',
          contextId: 'context-retry-after',
          status: {
            state: request.method === 'SendMessage' ? 'TASK_STATE_WORKING' : 'TASK_STATE_COMPLETED',
          },
          artifacts:
            request.method === 'GetTask'
              ? [
                  {
                    artifactId: 'artifact-retry-after',
                    parts: [{ text: 'completed after rate limit', mediaType: 'text/plain' }],
                  },
                ]
              : [],
          history: [],
        }
        if (request.method === 'GetTask' && ++getTaskCalls === 1) {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32603, message: 'rate limited' },
            }),
            {
              status: 429,
              headers: { 'content-type': 'application/json', 'retry-after': '120' },
            },
          )
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: request.method === 'SendMessage' ? { task } : task,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:poll-retry-after-v1', message: 'respect server pacing' },
        targets,
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(getTaskCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(119_999)
      expect(getTaskCalls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)

      const result = await invocation
      expect(getTaskCalls).toBe(2)
      expect(result.content[0].text).toBe('completed after rate limit')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a transient DNS resolution failure while polling a known Task', async () => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    try {
      const targets: RouteTarget[] = [
        {
          type: 'remote',
          name: 'dns-retry-v1',
          url: 'https://v1.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
        },
      ]
      const methods: string[] = []
      let getTaskCalls = 0
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        const request = JSON.parse(init?.body as string)
        methods.push(request.method)
        if (request.method === 'SendMessage') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              result: {
                task: {
                  id: 'task-dns-retry',
                  contextId: 'context-dns-retry',
                  status: { state: 'TASK_STATE_WORKING' },
                  artifacts: [],
                  history: [],
                },
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        getTaskCalls += 1
        if (getTaskCalls === 1) {
          throw new UnsafeUrlError(
            'blocked',
            'URL hostname could not be resolved safely',
            'dns_resolution_failed',
          )
        }
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              id: 'task-dns-retry',
              contextId: 'context-dns-retry',
              status: { state: 'TASK_STATE_COMPLETED' },
              artifacts: [
                {
                  artifactId: 'artifact-dns-retry',
                  parts: [{ text: 'recovered after DNS retry', mediaType: 'text/plain' }],
                },
              ],
              history: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }) as unknown as typeof fetch

      const invocation = invokeAgentHandler(
        { agentId: 'remote:dns-retry-v1', message: 'wait through DNS recovery' },
        targets,
      )
      await vi.advanceTimersByTimeAsync(1_001)
      const result = await invocation

      expect(result.content[0].text).toBe('recovered after DNS retry')
      expect(methods).toEqual(['SendMessage', 'GetTask', 'GetTask'])
    } finally {
      vi.useRealTimers()
    }
  })
})
