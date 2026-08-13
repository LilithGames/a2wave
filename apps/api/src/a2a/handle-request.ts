import { A2A_VERSION_HEADER, Extensions, HTTP_EXTENSION_HEADER } from '@a2a-js/sdk'
import { isLegacyJsonRpcMethod, isV1JsonRpcMethod } from '@a2a-js/sdk/compat/v0_3'
import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server'
import { RequestMalformedError } from '@a2a-js/sdk/errors'
import {
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  validateVersion,
} from '@a2a-js/sdk/server'
import type { TaskStore, User } from '@a2a-js/sdk/server'
import type { Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { agents } from '../db/schema.js'
import { buildAgentConfig } from '../lib/agent-helpers.js'
import { ProviderConfigurationError } from '../lib/errors.js'
import {
  getStreamingCard,
  shouldShowLocalChildOutput,
  touchStreamingCard,
} from '../lib/streaming-card-registry.js'
import {
  type GatewayCaller,
  normalizeAuthType,
  oauthUploaderId,
} from '../middleware/gateway-auth.js'
import { buildAgentCard } from './agent-card.js'
import { createScopedEventBusManager } from './event-bus-manager.js'
import { A2waveAgentExecutor } from './executor.js'
import type { A2waveExecutorConfig, CancelFn, ExecuteFn } from './executor.js'

type AgentRow = typeof agents.$inferSelect

function readRequestMethod(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
  return (body as Record<string, unknown>).method
}

function shouldUseLegacyHandler(body: unknown): boolean {
  const method = readRequestMethod(body)
  return isLegacyJsonRpcMethod(method) || !isV1JsonRpcMethod(method)
}

function readRequestId(body: unknown): string | number | null {
  return body && typeof body === 'object' && 'id' in body
    ? ((body as { id?: string | number | null }).id ?? null)
    : null
}

function isExecutionMethod(body: unknown): boolean {
  const method = readRequestMethod(body)
  return (
    method === 'SendMessage' ||
    method === 'SendStreamingMessage' ||
    method === 'message/send' ||
    method === 'message/stream'
  )
}

function mapJsonRpcError(error: unknown, useLegacy: boolean) {
  return useLegacy
    ? LegacyJsonRpcTransportHandler.mapToLegacyJSONRPCError(error)
    : JsonRpcTransportHandler.mapToJSONRPCError(error)
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return Symbol.asyncIterator in Object(value)
}

/**
 * Run the SDK transport's request parsing and compatibility translation before
 * resolving any execution resources. The validation handler has no task store
 * or executor, so a valid request stops after conversion while malformed input
 * returns the exact protocol-shaped error produced by the selected transport.
 */
async function preflightExecutionRequest(
  requestBody: unknown,
  useLegacy: boolean,
  agentCard: ReturnType<typeof buildAgentCard>,
  callContext: ServerCallContext,
): Promise<unknown | null> {
  const validateMessage = (params: unknown) => {
    const message = (params as { message?: { messageId?: string } } | null)?.message
    // DefaultRequestHandler performs this check before touching its task store
    // or executor. Keep it in the side-effect-free preflight as well.
    if (!message?.messageId) throw new RequestMalformedError('message.messageId is required.')
    return message
  }
  const validationHandler = {
    getAgentCard: async () => agentCard,
    sendMessage: async (params: unknown) => validateMessage(params),
    sendMessageStream: (params: unknown) => {
      validateMessage(params)
      return (async function* emptyValidationStream() {})()
    },
  }
  const body: string | Record<string, unknown> =
    typeof requestBody === 'object' && requestBody !== null && !Array.isArray(requestBody)
      ? (requestBody as Record<string, unknown>)
      : (JSON.stringify(requestBody) ?? '')
  const result = useLegacy
    ? await new LegacyJsonRpcTransportHandler(
        validationHandler as unknown as ConstructorParameters<
          typeof LegacyJsonRpcTransportHandler
        >[0],
      ).handle(body, callContext)
    : await new JsonRpcTransportHandler(
        validationHandler as unknown as ConstructorParameters<typeof JsonRpcTransportHandler>[0],
      ).handle(body, callContext)

  if (isAsyncIterable(result)) return null
  return result && typeof result === 'object' && 'error' in result ? result : null
}

function buildServerCallContext(
  c: Context,
  agent: AgentRow,
  requestedVersion: string,
): ServerCallContext {
  const oauthCaller = (c.get as (key: string) => unknown)('oauthCaller') as
    | GatewayCaller
    | undefined
  const isInternalRoute = c.req.path.includes('/internal/a2a/')
  const internalCallerId = isInternalRoute ? c.req.header('X-A2WAVE-Caller-Agent-Id') : undefined
  const authType = normalizeAuthType(agent.a2aAuthType)
  const ownerScope = oauthCaller
    ? oauthUploaderId(oauthCaller)
    : isInternalRoute
      ? `internal:${internalCallerId || 'platform'}`
      : `a2a:${agent.id}:${authType}`
  const user: User = {
    isAuthenticated: authType !== 'none' || isInternalRoute,
    userName: ownerScope,
  }
  const headers: Record<string, string> = {}
  c.req.raw.headers.forEach((value, key) => {
    headers[key] = value
  })

  return new ServerCallContext({
    requestedExtensions: Extensions.parseServiceParameter(c.req.header(HTTP_EXTENSION_HEADER)),
    requestedVersion,
    tenant: agent.id,
    user,
    state: new Map([['headers', headers]]),
  })
}

function exposeActivatedExtensions(c: Context, callContext: ServerCallContext): void {
  const activated = callContext.activatedExtensions
  if (activated?.length) {
    c.header(HTTP_EXTENSION_HEADER, Extensions.toServiceParameter(activated))
  }
}

export async function handleA2ARequest(
  c: Context,
  agent: AgentRow,
  taskStore: TaskStore,
  executeFn: ExecuteFn,
  cancelFn?: CancelFn,
) {
  const rawRequestBody = await c.req.text()
  let requestBody: unknown
  try {
    requestBody = JSON.parse(rawRequestBody) as unknown
  } catch {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON payload.' },
      },
      400,
    )
  }
  const useLegacy = shouldUseLegacyHandler(requestBody)
  const requestId = readRequestId(requestBody)

  const baseUrl = new URL(c.req.url).origin
  const agentCard = buildAgentCard(agent, baseUrl)
  const requestedVersion = c.req.header(A2A_VERSION_HEADER) ?? (useLegacy ? '0.3' : '1.0')
  const callContext = buildServerCallContext(c, agent, requestedVersion)
  try {
    validateVersion(callContext.requestedVersion, agentCard, 'JSONRPC')
  } catch (error) {
    return c.json({ jsonrpc: '2.0', id: requestId, error: mapJsonRpcError(error, useLegacy) })
  }

  let executorConfig: A2waveExecutorConfig = { agentConfig: {} }
  let wrappedExecuteFn = executeFn
  if (isExecutionMethod(requestBody)) {
    // Only validated methods that start execution need Provider and workspace
    // setup. Task operations and malformed/unknown requests must retain their
    // protocol errors even when the Agent cannot execute.
    const preflightError = await preflightExecutionRequest(
      requestBody,
      useLegacy,
      agentCard,
      callContext,
    )
    if (preflightError) return c.json(preflightError)

    let agentConfig: Awaited<ReturnType<typeof buildAgentConfig>>
    try {
      agentConfig = await buildAgentConfig(agent)
    } catch (err) {
      if (err instanceof ProviderConfigurationError) {
        return c.json({
          jsonrpc: '2.0',
          id: requestId,
          error: { code: -32603, message: err.message, data: { code: err.code } },
        })
      }
      return c.json({
        jsonrpc: '2.0',
        id: requestId,
        error: mapJsonRpcError(err, useLegacy),
      })
    }
    executorConfig = {
      agentConfig,
      model: agentConfig.model || undefined,
    }

    // If the parent Agent has a streaming card, create an independent child section.
    const streamingCardId = c.req.header('X-Streaming-Card-Id')
    const parentCard = streamingCardId ? getStreamingCard(streamingCardId) : undefined
    const showChild =
      parentCard && streamingCardId ? shouldShowLocalChildOutput(streamingCardId) : false
    if (parentCard && showChild && streamingCardId) {
      wrappedExecuteFn = async (taskId, payload, options) => {
        const childId = taskId
        touchStreamingCard(streamingCardId)
        await parentCard.addChildSection(childId, agent.name)
        const originalOnUpdate = options?.onUpdate
        return await executeFn(taskId, payload, {
          ...options,
          onUpdate: (content: string) => {
            originalOnUpdate?.(content)
            touchStreamingCard(streamingCardId)
            parentCard.updateChildContent(childId, content)
          },
        })
      }
    }
  }

  const eventBusManager = createScopedEventBusManager(callContext)
  const executor = new A2waveAgentExecutor(executorConfig, wrappedExecuteFn, cancelFn, (taskId) =>
    eventBusManager.wasReused(taskId),
  )
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor, eventBusManager)
  const transportHandler = new JsonRpcTransportHandler(requestHandler)
  const legacyTransportHandler = new LegacyJsonRpcTransportHandler(requestHandler)

  const rpcResult = useLegacy
    ? await legacyTransportHandler.handle(
        typeof requestBody === 'object' && requestBody !== null
          ? (requestBody as Record<string, unknown>)
          : rawRequestBody,
        callContext,
      )
    : await transportHandler.handle(
        typeof requestBody === 'object' && requestBody !== null
          ? (requestBody as Record<string, unknown>)
          : rawRequestBody,
        callContext,
      )

  if (Symbol.asyncIterator in Object(rpcResult)) {
    const iterator = (rpcResult as AsyncGenerator)[Symbol.asyncIterator]()
    let first: IteratorResult<unknown>
    try {
      // Advance once before committing the SSE response. SDK streaming methods
      // validate task visibility and state inside the generator, so errors such
      // as TaskNotFound must still be returned as ordinary JSON-RPC errors.
      first = await iterator.next()
      exposeActivatedExtensions(c, callContext)
    } catch (error) {
      return c.json({ jsonrpc: '2.0', id: requestId, error: mapJsonRpcError(error, useLegacy) })
    }

    return streamSSE(c, async (stream) => {
      try {
        if (!first.done) {
          await stream.writeSSE({ data: JSON.stringify(first.value) })
        }
        while (true) {
          const next = await iterator.next()
          if (next.done) break
          await stream.writeSSE({ data: JSON.stringify(next.value) })
        }
      } catch (error) {
        await stream.writeSSE({
          data: JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: mapJsonRpcError(error, useLegacy),
          }),
        })
      } finally {
        await iterator.return?.(undefined)
      }
    })
  }

  exposeActivatedExtensions(c, callContext)
  return c.json(rpcResult)
}
