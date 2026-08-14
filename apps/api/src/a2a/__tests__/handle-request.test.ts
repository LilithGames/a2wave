import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockGetStreamingCard = vi.hoisted(() => vi.fn())
const mockShouldShowLocalChildOutput = vi.hoisted(() => vi.fn().mockReturnValue(true))
const mockTouchStreamingCard = vi.hoisted(() => vi.fn())
const mockBuildAgentConfig = vi.hoisted(() => vi.fn().mockReturnValue({ model: 'test-model' }))
const mockResolveWorkDir = vi.hoisted(() => vi.fn().mockResolvedValue('/tmp/test'))
const mockV1Handle = vi.hoisted(() => vi.fn().mockResolvedValue({ jsonrpc: '2.0', result: {} }))
const mockLegacyHandle = vi.hoisted(() => vi.fn().mockResolvedValue({ jsonrpc: '2.0', result: {} }))
const mockValidateVersion = vi.hoisted(() => vi.fn())
const mockStreamSSE = vi.hoisted(() => vi.fn())

vi.mock('../../lib/streaming-card-registry.js', () => ({
  getStreamingCard: mockGetStreamingCard,
  shouldShowLocalChildOutput: mockShouldShowLocalChildOutput,
  touchStreamingCard: mockTouchStreamingCard,
}))

vi.mock('../../lib/agent-helpers.js', () => ({
  buildAgentConfig: mockBuildAgentConfig,
  resolveWorkDir: mockResolveWorkDir,
}))

type CapturedExecuteFn = ((...args: unknown[]) => unknown) | null
// Mock the executor to capture the executeFn it receives
let capturedExecuteFn: CapturedExecuteFn = null
vi.mock('../executor.js', () => ({
  A2waveAgentExecutor: class {
    constructor(_config: unknown, executeFn: (...args: unknown[]) => unknown) {
      capturedExecuteFn = executeFn
    }
  },
}))

vi.mock('../agent-card.js', () => ({
  buildAgentCard: vi.fn().mockReturnValue({ name: 'test', supportedInterfaces: [] }),
}))

vi.mock('@a2a-js/sdk/server', () => ({
  DefaultExecutionEventBusManager: class {},
  DefaultRequestHandler: class {},
  JsonRpcTransportHandler: class {
    handle(...args: unknown[]) {
      return mockV1Handle(...args)
    }
    static mapToJSONRPCError(error: unknown) {
      return { code: -32009, message: String(error) }
    }
  },
  ServerCallContext: class {
    requestedVersion: string | undefined
    requestedExtensions?: string[]
    tenant?: string
    user?: unknown
    state: Map<string, unknown>
    constructor(options: Record<string, unknown> = {}) {
      this.requestedVersion = options.requestedVersion as string | undefined
      this.requestedExtensions = options.requestedExtensions as string[] | undefined
      this.tenant = options.tenant as string | undefined
      this.user = options.user
      this.state = (options.state as Map<string, unknown>) ?? new Map()
    }
  },
  validateVersion: mockValidateVersion,
}))

vi.mock('@a2a-js/sdk/compat/v0_3', () => ({
  isLegacyJsonRpcMethod: (method: unknown) => typeof method === 'string' && method.includes('/'),
  isV1JsonRpcMethod: (method: unknown) => typeof method === 'string' && /^[A-Z]/.test(method),
}))

vi.mock('@a2a-js/sdk/compat/v0_3/server', () => ({
  LegacyJsonRpcTransportHandler: class {
    handle(...args: unknown[]) {
      return mockLegacyHandle(...args)
    }
    static mapToLegacyJSONRPCError(error: unknown) {
      return { code: -32009, message: String(error) }
    }
  },
}))

vi.mock('hono/streaming', () => ({
  streamSSE: mockStreamSSE,
}))

import { UnusableProviderChainError } from '../../lib/errors.js'
import { handleA2ARequest } from '../handle-request.js'
import { A2WAVE_CALLER_PROVENANCE_EXTENSION_URI } from '../provenance.js'

function createMockContext(
  headers: Record<string, string> = {},
  body: Record<string, unknown> = {
    jsonrpc: '2.0',
    method: 'message/send',
    params: {},
  },
  rawBody?: string,
) {
  const rawHeaders = new Headers(headers)
  return {
    req: {
      url: 'http://localhost:3502/api/internal/a2a/agt_1',
      path: '/api/internal/a2a/agt_1',
      header: (name: string) => headers[name],
      text: () => Promise.resolve(rawBody ?? JSON.stringify(body)),
      raw: { headers: rawHeaders },
    },
    get: () => undefined,
    json: <T>(data: T) => data,
  } as unknown as Parameters<typeof handleA2ARequest>[0]
}

type HandleA2AArgs = Parameters<typeof handleA2ARequest>
const fakeAgent = {
  id: 'agt_1',
  name: 'Test Agent',
} as unknown as HandleA2AArgs[1]

const fakeTaskStore = {} as unknown as HandleA2AArgs[2]

describe('handleA2ARequest', () => {
  const baseFn = vi.fn().mockResolvedValue({
    success: true,
    output: 'hello',
    durationMs: 100,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockBuildAgentConfig.mockReset().mockReturnValue({ model: 'test-model' })
    mockResolveWorkDir.mockReset().mockResolvedValue('/tmp/test')
    mockValidateVersion.mockReset()
    mockV1Handle.mockResolvedValue({ jsonrpc: '2.0', result: {} })
    mockLegacyHandle.mockResolvedValue({ jsonrpc: '2.0', result: {} })
    capturedExecuteFn = null
    mockGetStreamingCard.mockReturnValue(undefined)
    mockShouldShowLocalChildOutput.mockReturnValue(true)
    mockStreamSSE.mockReset()
  })

  // An A2A client parses JSON-RPC, not HTTP errors. Letting the exception escape
  // surfaces a configuration fault as a transport failure the caller can't act on.
  it('returns a JSON-RPC error when the provider chain is unusable', async () => {
    mockBuildAgentConfig.mockImplementationOnce(() => {
      throw new UnusableProviderChainError('agt_1')
    })
    const c = createMockContext(
      {},
      { jsonrpc: '2.0', method: 'message/send', params: {}, id: 'provider-error' },
    )

    const res = (await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)) as unknown as {
      jsonrpc: string
      id: string
      error: { code: number; message: string; data: { code: string } }
    }

    expect(res.jsonrpc).toBe('2.0')
    expect(res.id).toBe('provider-error')
    expect(res.error.code).toBe(-32603)
    expect(res.error.data.code).toBe('UNUSABLE_PROVIDER_CHAIN')
    // Never reaches execution setup.
    expect(capturedExecuteFn).toBeNull()
  })

  it('does not resolve the workspace before the transport admits execution', async () => {
    const c = createMockContext(
      { 'A2A-Version': '1.0' },
      { jsonrpc: '2.0', method: 'SendMessage', params: {}, id: 'deferred-workspace' },
    )

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(mockV1Handle).toHaveBeenCalledTimes(2)
    expect(mockResolveWorkDir).not.toHaveBeenCalled()
  })

  it('validates the protocol version before resolving execution configuration', async () => {
    mockValidateVersion.mockImplementationOnce(() => {
      throw new Error('unsupported protocol version')
    })
    const c = createMockContext(
      { 'A2A-Version': '2.0' },
      { jsonrpc: '2.0', method: 'SendMessage', params: {}, id: 'bad-version' },
    )

    const result = (await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)) as unknown as {
      id: string
      error: { code: number; message: string }
    }

    expect(result.id).toBe('bad-version')
    expect(result.error).toMatchObject({ code: -32009 })
    expect(mockBuildAgentConfig).not.toHaveBeenCalled()
    expect(mockResolveWorkDir).not.toHaveBeenCalled()
    expect(capturedExecuteFn).toBeNull()
  })

  it('serves task operations without provider or workspace setup', async () => {
    mockBuildAgentConfig.mockImplementationOnce(() => {
      throw new UnusableProviderChainError('agt_1')
    })
    const c = createMockContext(
      { 'A2A-Version': '1.0' },
      { jsonrpc: '2.0', method: 'GetTask', params: { id: 'task-1' }, id: 'get-task' },
    )

    const result = await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(result).toEqual({ jsonrpc: '2.0', result: {} })
    expect(mockV1Handle).toHaveBeenCalledOnce()
    expect(mockBuildAgentConfig).not.toHaveBeenCalled()
    expect(mockResolveWorkDir).not.toHaveBeenCalled()
  })

  it('uses original executeFn when no X-Streaming-Card-Id header', async () => {
    const c = createMockContext()

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(capturedExecuteFn).toBe(baseFn)
    expect(mockGetStreamingCard).not.toHaveBeenCalled()
  })

  it('dispatches v1 PascalCase methods to the v1 transport with scoped context', async () => {
    const c = createMockContext(
      { 'A2A-Version': '1.0' },
      { jsonrpc: '2.0', method: 'SendMessage', params: {}, id: 'v1' },
    )

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(mockV1Handle).toHaveBeenCalledTimes(2)
    expect(mockLegacyHandle).not.toHaveBeenCalled()
    expect(mockV1Handle.mock.calls[1][1]).toMatchObject({
      requestedVersion: '1.0',
      tenant: 'agt_1',
      user: { userName: 'internal:platform' },
    })
  })

  it('parses the standard v1 extension activation header into the call context', async () => {
    const extensionUri = A2WAVE_CALLER_PROVENANCE_EXTENSION_URI
    const c = createMockContext(
      { 'A2A-Version': '1.0', 'A2A-Extensions': extensionUri },
      { jsonrpc: '2.0', method: 'SendMessage', params: {}, id: 'v1-extension' },
    )

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(mockV1Handle.mock.calls[1][1]).toMatchObject({
      requestedVersion: '1.0',
      requestedExtensions: [extensionUri],
    })
  })

  it('dispatches v0.3 methods through the SDK compatibility transport', async () => {
    const c = createMockContext(
      {},
      { jsonrpc: '2.0', method: 'message/stream', params: {}, id: 'legacy' },
    )

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(mockLegacyHandle).toHaveBeenCalledTimes(2)
    expect(mockV1Handle).not.toHaveBeenCalled()
    expect(mockValidateVersion).toHaveBeenCalledWith('0.3', expect.anything(), 'JSONRPC')
    expect(mockLegacyHandle.mock.calls[0][1]).toMatchObject({ requestedVersion: '0.3' })
  })

  it('defaults headerless v1 methods to protocol version 1.0', async () => {
    const c = createMockContext(
      {},
      { jsonrpc: '2.0', method: 'SendMessage', params: {}, id: 'v1-headerless' },
    )

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(mockV1Handle).toHaveBeenCalledTimes(2)
    expect(mockLegacyHandle).not.toHaveBeenCalled()
    expect(mockValidateVersion).toHaveBeenCalledWith('1.0', expect.anything(), 'JSONRPC')
    expect(mockV1Handle.mock.calls[0][1]).toMatchObject({ requestedVersion: '1.0' })
  })

  it('returns the standard parse error for malformed JSON', async () => {
    const c = createMockContext({}, {}, '{not-json')

    const result = (await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)) as unknown as {
      error: { code: number }
    }

    expect(result.error.code).toBe(-32700)
    expect(mockLegacyHandle).not.toHaveBeenCalled()
    expect(mockV1Handle).not.toHaveBeenCalled()
  })

  it('returns an SDK protocol error before resolving execution configuration', async () => {
    mockV1Handle.mockResolvedValueOnce({
      jsonrpc: '2.0',
      id: 'malformed-send',
      error: { code: -32602, message: 'Invalid JSON-RPC Request.' },
    })
    mockBuildAgentConfig.mockImplementationOnce(() => {
      throw new UnusableProviderChainError('agt_1')
    })
    const c = createMockContext(
      { 'A2A-Version': '1.0' },
      { jsonrpc: '1.0', method: 'SendMessage', params: null, id: 'malformed-send' },
    )

    const result = (await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)) as unknown as {
      error: { code: number; message: string }
    }

    expect(result.error).toEqual({ code: -32602, message: 'Invalid JSON-RPC Request.' })
    expect(mockBuildAgentConfig).not.toHaveBeenCalled()
    expect(mockResolveWorkDir).not.toHaveBeenCalled()
    expect(mockV1Handle).toHaveBeenCalledOnce()
  })

  it('maps an error raised before the first streaming event to a JSON-RPC response', async () => {
    async function* failedStream() {
      await Promise.reject(new Error('missing task'))
      yield { unreachable: true }
    }
    mockV1Handle.mockResolvedValue(failedStream())
    const c = createMockContext(
      { 'A2A-Version': '1.0' },
      { jsonrpc: '2.0', method: 'SubscribeToTask', params: { id: 'missing' }, id: 'sub-1' },
    )

    const result = (await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)) as unknown as {
      id: string
      error: { code: number; message: string }
    }

    expect(result.id).toBe('sub-1')
    expect(result.error).toMatchObject({ code: -32009 })
    expect(mockStreamSSE).not.toHaveBeenCalled()
  })

  it('emits a JSON-RPC error event when a stream fails after its first event', async () => {
    async function* failedStream() {
      yield { jsonrpc: '2.0', id: 'stream-1', result: { state: 'working' } }
      throw new Error('late stream failure')
    }
    mockV1Handle.mockResolvedValue(failedStream())
    const writes: Array<{ data: string }> = []
    mockStreamSSE.mockImplementation(async (_c, callback) => {
      await callback({ writeSSE: async (event: { data: string }) => writes.push(event) })
      return { streamed: true }
    })
    const c = createMockContext(
      { 'A2A-Version': '1.0' },
      { jsonrpc: '2.0', method: 'SendStreamingMessage', params: {}, id: 'stream-1' },
    )

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(writes.map((entry) => JSON.parse(entry.data))).toEqual([
      { jsonrpc: '2.0', id: 'stream-1', result: { state: 'working' } },
      expect.objectContaining({
        jsonrpc: '2.0',
        id: 'stream-1',
        error: expect.objectContaining({ code: -32009 }),
      }),
    ])
  })

  it('uses original executeFn when header present but card not in registry', async () => {
    const c = createMockContext({ 'X-Streaming-Card-Id': 'card_123' })
    mockGetStreamingCard.mockReturnValue(undefined)

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(mockGetStreamingCard).toHaveBeenCalledWith('card_123')
    expect(capturedExecuteFn).toBe(baseFn)
  })

  it('wraps executeFn to create child section and forward updates when card found', async () => {
    const mockAddChildSection = vi.fn().mockResolvedValue(undefined)
    const mockUpdateChildContent = vi.fn()
    const parentCard = {
      addChildSection: mockAddChildSection,
      updateChildContent: mockUpdateChildContent,
    }
    mockGetStreamingCard.mockReturnValue(parentCard)

    const c = createMockContext({ 'X-Streaming-Card-Id': 'card_456' })

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    expect(mockGetStreamingCard).toHaveBeenCalledWith('card_456')
    expect(capturedExecuteFn).not.toBe(baseFn)

    const originalOnUpdate = vi.fn()
    await capturedExecuteFn?.(
      'task1',
      { taskId: 'task1', prompt: 'hi', workDir: '/tmp', agentConfig: {} },
      { onUpdate: originalOnUpdate },
    )

    // addChildSection should be called with taskId and agent name
    expect(mockAddChildSection).toHaveBeenCalledWith('task1', 'Test Agent')
    expect(mockTouchStreamingCard).toHaveBeenCalledWith('card_456')

    const callOptions = baseFn.mock.calls[0][2]
    mockTouchStreamingCard.mockClear()
    callOptions.onUpdate('streaming content')

    expect(originalOnUpdate).toHaveBeenCalledWith('streaming content')
    expect(mockTouchStreamingCard).toHaveBeenCalledWith('card_456')
    expect(mockUpdateChildContent).toHaveBeenCalledWith('task1', 'streaming content')
  })

  it('wrapped executeFn handles missing original onUpdate gracefully', async () => {
    const mockAddChildSection = vi.fn().mockResolvedValue(undefined)
    const mockUpdateChildContent = vi.fn()
    const parentCard = {
      addChildSection: mockAddChildSection,
      updateChildContent: mockUpdateChildContent,
    }
    mockGetStreamingCard.mockReturnValue(parentCard)

    const c = createMockContext({ 'X-Streaming-Card-Id': 'card_789' })

    await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

    await capturedExecuteFn?.(
      'task1',
      { taskId: 'task1', prompt: 'hi', workDir: '/tmp', agentConfig: {} },
      {},
    )

    const callOptions = baseFn.mock.calls[0][2]
    callOptions.onUpdate('content')

    expect(mockUpdateChildContent).toHaveBeenCalledWith('task1', 'content')
  })

  describe('showChildOutput=false (skip child output)', () => {
    it('uses original executeFn when showChildOutput is false', async () => {
      const parentCard = { addChildSection: vi.fn(), updateChildContent: vi.fn() }
      mockGetStreamingCard.mockReturnValue(parentCard)
      mockShouldShowLocalChildOutput.mockReturnValue(false)

      const c = createMockContext({ 'X-Streaming-Card-Id': 'card_hidden' })

      await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)

      // Should NOT wrap — uses original executeFn
      expect(capturedExecuteFn).toBe(baseFn)
    })

    it('does not create child section when showChildOutput is false', async () => {
      const mockAddChildSection = vi.fn()
      const parentCard = { addChildSection: mockAddChildSection, updateChildContent: vi.fn() }
      mockGetStreamingCard.mockReturnValue(parentCard)
      mockShouldShowLocalChildOutput.mockReturnValue(false)

      const c = createMockContext({ 'X-Streaming-Card-Id': 'card_hidden2' })

      await handleA2ARequest(c, fakeAgent, fakeTaskStore, baseFn)
      await capturedExecuteFn?.(
        'task1',
        { taskId: 'task1', prompt: 'hi', workDir: '/tmp', agentConfig: {} },
        {},
      )

      expect(mockAddChildSection).not.toHaveBeenCalled()
    })
  })
})
