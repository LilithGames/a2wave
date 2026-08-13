import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentCard,
  type Artifact,
  CancelTaskRequest,
  GetTaskRequest,
  type Message,
  Role,
  SendMessageRequest,
  type SendMessageResult,
  type StreamResponse,
  SubscribeToTaskRequest,
  type Task,
  TaskState,
  taskStateToJSON,
} from '@a2a-js/sdk'
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  ServiceParameters,
  withA2AExtensions,
} from '@a2a-js/sdk/client'
import { A2A_ERROR_CODE, isJsonRpcError, isRestError } from '@a2a-js/sdk/errors'
import { z } from 'zod'
import {
  A2WAVE_CALLER_AGENT_ID_HEADER,
  A2WAVE_CALLER_AGENT_NAME_B64_HEADER,
  X_A2WAVE_CHANNEL_B64_HEADER,
  encodeCallerAgentNameHeader,
} from '../a2a/caller.js'
import {
  type A2ACallerProvenance,
  A2WAVE_CALLER_PROVENANCE_EXTENSION_URI,
  buildOutboundA2AProvenance,
} from '../a2a/provenance.js'
import { createStreamingSafeFetch, parseTrustedHostnames } from '../lib/streaming-safe-fetch.js'
import { UnsafeUrlError, assertSafeHttpUrl } from '../lib/url-safety-core.js'
import {
  type RouterInvocationRegistry,
  createRouterInvocationRegistry,
  installRouterShutdownHooks,
} from './agent-router-lifecycle.js'

// Internal enterprise networks are the primary deployment target, so ordinary
// private/CGNAT/ULA routes are enabled unless an operator explicitly selects
// public-only mode. Both modes retain per-hop validation and DNS pinning.
const privateRouteSetting = process.env.A2WAVE_ALLOW_PRIVATE_ROUTE_TARGETS
const ALLOW_PRIVATE_ROUTE_TARGETS =
  privateRouteSetting === undefined || privateRouteSetting === '1' || privateRouteSetting === 'true'
const safeRemoteRouteFetch = createStreamingSafeFetch({
  allowPrivateTargets: ALLOW_PRIVATE_ROUTE_TARGETS,
  trustedHosts: parseTrustedHostnames(process.env.A2WAVE_TRUSTED_A2A_ROUTE_HOSTS),
})

const AGENT_CARD_TIMEOUT_MS = 15 * 1000
const TASK_RPC_TIMEOUT_MS = 15 * 1000
// CLI process groups are force-killed five seconds after graceful termination
// starts. Keep the independent CancelTask control request inside that window.
const TASK_CANCEL_TIMEOUT_MS = 3 * 1000
const TASK_POLL_INTERVAL_MS = 1000
const MAX_TASK_POLL_RETRY_DELAY_MS = 30 * 1000
const MAX_TIMER_DELAY_MS = 2_147_483_647
const TERMINAL_TASK_HISTORY_LENGTH = 20
const TASK_STREAM_IDLE_TIMEOUT_MS = 30 * 1000
const MAX_AGENT_CARD_BYTES = 1024 * 1024
const MAX_REMOTE_RESULT_BYTES = 16 * 1024 * 1024
const MAX_REMOTE_RESULT_EVENTS = 10_000

class RemoteResultLimitError extends Error {}

class RemoteTaskIdentityError extends Error {}

class RemoteTaskReadHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly retryAfterMs?: number,
  ) {
    super(`Remote Task read returned HTTP ${statusCode}`)
    this.name = 'RemoteTaskReadHttpError'
  }
}

interface InvocationResultBudget {
  events: number
}

function createInvocationResultBudget(): InvocationResultBudget {
  return { events: 0 }
}

function composeTimeoutSignal(signal: AbortSignal | null | undefined, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

async function cancelBodyQuietly(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

function isRetryableHttpStatus(statusCode: number): boolean {
  return statusCode === 408 || statusCode === 429 || statusCode >= 500
}

function parseRetryAfterMs(value: string | undefined, nowMs = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return undefined
  return Math.max(0, dateMs - nowMs)
}

function requestMethodFromBody(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== 'string') return undefined
  try {
    const parsed = JSON.parse(body) as { method?: unknown }
    return typeof parsed.method === 'string' ? parsed.method : undefined
  } catch {
    return undefined
  }
}

function isTaskReadMethod(method: string | undefined): boolean {
  return method === 'GetTask' || method === 'tasks/get'
}

async function throwForRetryableTaskReadResponse(
  response: Response,
  body: BodyInit | null | undefined,
): Promise<void> {
  if (
    response.ok ||
    !isRetryableHttpStatus(response.status) ||
    !isTaskReadMethod(requestMethodFromBody(body))
  ) {
    return
  }
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after') ?? undefined)
  await cancelBodyQuietly(response)
  throw new RemoteTaskReadHttpError(response.status, retryAfterMs)
}

function withResponseByteLimit(response: Response, maxBytes: number, label: string): Response {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void cancelBodyQuietly(response)
    throw new RemoteResultLimitError(`${label} exceeds the ${maxBytes}-byte response limit`)
  }
  if (!response.body) return response

  const reader = response.body.getReader()
  let totalBytes = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          await reader.cancel()
          controller.error(
            new RemoteResultLimitError(`${label} exceeds the ${maxBytes}-byte response limit`),
          )
          return
        }
        controller.enqueue(value)
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  if (!response.body) return response.text()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > maxBytes) {
      await reader.cancel()
      throw new RemoteResultLimitError(`${label} exceeds the ${maxBytes}-byte response limit`)
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

async function readResponseJsonWithLimit(response: Response): Promise<unknown> {
  if (!response.body) return response.json()
  const text = await readResponseTextWithLimit(
    response,
    MAX_REMOTE_RESULT_BYTES,
    'Remote A2A result',
  )
  return JSON.parse(text)
}

/**
 * Validate the literal remote URL before any outbound work. DNS answers and
 * every redirect hop are validated and pinned by safeRemoteRouteFetch.
 */
function checkRemoteTargetUrl(rawUrl: string): string | null {
  try {
    assertSafeHttpUrl(rawUrl, { allowPrivateAddresses: ALLOW_PRIVATE_ROUTE_TARGETS })
    return null
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      const policy = ALLOW_PRIVATE_ROUTE_TARGETS
        ? 'only http/https targets outside forbidden loopback, link-local, metadata, or reserved ranges are allowed'
        : 'only public http/https targets are allowed unless the hostname is explicitly trusted'
      return `Remote agent URL rejected (${err.reason}): ${policy}`
    }
    throw err
  }
}

const apiUrl = process.env.A2WAVE_API_URL ?? 'http://127.0.0.1:3502'

export interface RouteTarget {
  type: 'local' | 'remote'
  agentId?: string
  name?: string
  url?: string
  description?: string
  apiKey?: string
  /** Existing rows omit this and retain direct v0.3 behavior. */
  connectionMode?: 'agent_card' | 'direct'
  /** Direct endpoints default to v0.3 for backward compatibility. */
  protocolVersion?: '1.0' | '0.3'
  /** Explicit direct-v1 opt-in for the display-only caller provenance extension. */
  callerProvenance?: boolean
}

export function parseRouteTargets(env?: string): RouteTarget[] | null {
  if (!env) return null
  try {
    return JSON.parse(env)
  } catch {
    console.error('[agent-router] Failed to parse A2WAVE_ROUTE_TARGETS, ignoring')
    return null
  }
}

const routeTargets = parseRouteTargets(process.env.A2WAVE_ROUTE_TARGETS)

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON responses
async function fetchJson(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${apiUrl}${path}`, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body}`)
  }
  return res.json()
}

type RemoteRouteTarget = RouteTarget & {
  type: 'remote'
  name: string
  url: string
}

interface RemoteClientContext {
  client: Awaited<ReturnType<ClientFactory['createFromAgentCard']>>
  card: AgentCard
}

interface CollectedClientResult {
  result: {
    artifacts: Artifact[]
    history: Message[]
    task?: {
      taskId: string
      contextId: string
      state: TaskState
    }
  }
  failure?: string
}

function isRemoteRouteTarget(target: RouteTarget | undefined): target is RemoteRouteTarget {
  return target?.type === 'remote' && Boolean(target.name) && Boolean(target.url)
}

function createRemoteTargetFetch(target: RemoteRouteTarget): typeof fetch {
  return async (input, init = {}) => {
    const headers = new Headers(init.headers)
    if (target.apiKey && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${target.apiKey}`)
    }
    const isAgentCardRequest = !init.method || init.method.toUpperCase() === 'GET'
    const response = await safeRemoteRouteFetch(input instanceof URL ? input : input.toString(), {
      ...init,
      headers,
      // Agent Card discovery has a short connection deadline. A2A execution
      // requests inherit the parent run signal and must not gain an unrelated
      // absolute deadline: a Task can legitimately run longer than one HTTP
      // connection, and is recovered by id below.
      signal: isAgentCardRequest
        ? composeTimeoutSignal(init.signal, AGENT_CARD_TIMEOUT_MS)
        : init.signal,
    })
    await throwForRetryableTaskReadResponse(response, init.body)
    return withResponseByteLimit(
      response,
      isAgentCardRequest ? MAX_AGENT_CARD_BYTES : MAX_REMOTE_RESULT_BYTES,
      isAgentCardRequest ? 'Remote Agent Card' : 'Remote A2A result',
    )
  }
}

function createRemoteClientFactory(target: RemoteRouteTarget) {
  const fetchImpl = createRemoteTargetFetch(target)
  const cardResolver = new DefaultAgentCardResolver({
    fetchImpl,
    legacyCompat: { enabled: true },
  })
  const factory = new ClientFactory({
    transports: [
      new JsonRpcTransportFactory({
        fetchImpl,
        legacyCompat: { enabled: true },
      }),
    ],
    preferredTransports: ['JSONRPC'],
    cardResolver,
    // Ask non-streaming peers to return the Task immediately. The router owns
    // the lifecycle loop so it can reconnect and cancel by Task id.
    clientConfig: { polling: true },
  })
  return { cardResolver, factory }
}

function buildDirectAgentCard(target: RemoteRouteTarget): AgentCard {
  return AgentCard.fromJSON({
    name: target.name,
    description: target.description ?? '',
    supportedInterfaces: [
      {
        url: target.url,
        protocolBinding: 'JSONRPC',
        protocolVersion: target.protocolVersion ?? '0.3',
      },
    ],
    version: 'unknown',
    // Direct configuration has no remote Agent Card from which to negotiate
    // optional capabilities. Protocol selection alone must not imply extension
    // support, so provenance requires its own explicit operator opt-in.
    capabilities: {
      streaming: false,
      extensions:
        target.protocolVersion === '1.0' && target.callerProvenance === true
          ? [
              {
                uri: A2WAVE_CALLER_PROVENANCE_EXTENSION_URI,
                description: 'Configured direct a2wave v1 provenance support.',
                required: false,
              },
            ]
          : [],
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  })
}

async function resolveRemoteAgentCard(target: RemoteRouteTarget): Promise<AgentCard> {
  const rejection = checkRemoteTargetUrl(target.url)
  if (rejection) throw new Error(rejection)

  if (target.connectionMode !== 'agent_card') {
    return buildDirectAgentCard(target)
  }

  const { cardResolver } = createRemoteClientFactory(target)
  // An empty path tells the SDK that target.url is the complete Agent Card URL.
  return cardResolver.resolve(target.url, '')
}

function selectJsonRpcInterface(card: AgentCard) {
  const candidates = card.supportedInterfaces.filter(
    (agentInterface) => agentInterface.protocolBinding.toUpperCase() === 'JSONRPC',
  )
  // Mirror ClientFactory exactly: keep the first compatible interface, but
  // replace it whenever a v1.0 interface is encountered (therefore the last
  // advertised v1.0 JSON-RPC interface wins).
  return candidates.reduce<(typeof candidates)[number] | undefined>(
    (selected, candidate) =>
      !selected || candidate.protocolVersion === '1.0' ? candidate : selected,
    undefined,
  )
}

function validateDiscoveredInterface(target: RemoteRouteTarget, card: AgentCard): void {
  const agentInterface = selectJsonRpcInterface(card)
  if (!agentInterface) {
    throw new Error('Agent Card does not advertise a JSON-RPC interface')
  }

  const rejection = checkRemoteTargetUrl(agentInterface.url)
  if (rejection) throw new Error(rejection)

  if (target.apiKey && new URL(agentInterface.url).origin !== new URL(target.url).origin) {
    throw new Error(
      'Agent Card JSON-RPC interface has a different origin; refusing to forward configured credentials',
    )
  }
}

async function createRemoteClient(target: RemoteRouteTarget): Promise<RemoteClientContext> {
  const rejection = checkRemoteTargetUrl(target.url)
  if (rejection) throw new Error(rejection)

  const { factory } = createRemoteClientFactory(target)
  if (target.connectionMode === 'agent_card') {
    const card = await resolveRemoteAgentCard(target)
    validateDiscoveredInterface(target, card)
    return { client: await factory.createFromAgentCard(card), card }
  }

  const card = buildDirectAgentCard(target)
  validateDiscoveredInterface(target, card)
  return { client: await factory.createFromAgentCard(card), card }
}

function buildStandardSendRequest(
  message: string,
  provenance?: A2ACallerProvenance,
  historyLength?: number,
) {
  return SendMessageRequest.fromJSON({
    ...(historyLength !== undefined && {
      configuration: { historyLength, returnImmediately: true },
    }),
    message: {
      messageId: randomUUID(),
      role: 'ROLE_USER',
      parts: [{ text: message, mediaType: 'text/plain' }],
      ...(provenance
        ? {
            extensions: [A2WAVE_CALLER_PROVENANCE_EXTENSION_URI],
            metadata: { [A2WAVE_CALLER_PROVENANCE_EXTENSION_URI]: provenance },
          }
        : {}),
    },
  })
}

function textFromPart(part: unknown): string | null {
  if (!part || typeof part !== 'object') return null
  const candidate = part as {
    kind?: string
    type?: string
    text?: string
    content?: { $case?: string; value?: unknown }
  }
  if ((candidate.kind === 'text' || candidate.type === 'text') && candidate.text) {
    return candidate.text
  }
  if (candidate.content?.$case === 'text' && typeof candidate.content.value === 'string') {
    return candidate.content.value
  }
  return null
}

function isAgentMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false
  const role = (message as { role?: unknown }).role
  return role === 'agent' || role === 'ROLE_AGENT' || role === Role.ROLE_AGENT
}

function taskFailure(state: TaskState | undefined): string | undefined {
  switch (state) {
    case TaskState.TASK_STATE_FAILED:
      return 'Remote task failed'
    case TaskState.TASK_STATE_CANCELED:
      return 'Remote task was canceled'
    case TaskState.TASK_STATE_REJECTED:
      return 'Remote task was rejected'
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return 'Remote task requires authentication'
    case TaskState.TASK_STATE_INPUT_REQUIRED:
      return 'Remote task requires additional input'
    default:
      return undefined
  }
}

function endsCurrentInvocation(state: TaskState | undefined): boolean {
  return (
    state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED ||
    state === TaskState.TASK_STATE_REJECTED ||
    state === TaskState.TASK_STATE_INPUT_REQUIRED ||
    state === TaskState.TASK_STATE_AUTH_REQUIRED
  )
}

interface ArtifactAccumulator {
  artifacts: Artifact[]
  positions: Map<string, number>
  finalized: Set<string>
  byteSizes: Map<string, number>
  partsByteSizes: Map<string, number>
  totalBytes: number
}

interface CollectedResultAccumulator {
  artifactAccumulator: ArtifactAccumulator
  history: Message[]
  finalResponseMessageIds: Set<string>
  nonTerminalStatusMessageIds: Set<string>
  messagePositions: Map<string, number>
  messageByteSizes: Map<string, number>
  messageBytes: number
  failure?: string
  task?: CollectedClientResult['result']['task']
}

function createArtifactAccumulator(): ArtifactAccumulator {
  return {
    artifacts: [],
    positions: new Map(),
    finalized: new Set(),
    byteSizes: new Map(),
    partsByteSizes: new Map(),
    totalBytes: 0,
  }
}

function createCollectedResultAccumulator(): CollectedResultAccumulator {
  return {
    artifactAccumulator: createArtifactAccumulator(),
    history: [],
    finalResponseMessageIds: new Set(),
    nonTerminalStatusMessageIds: new Set(),
    messagePositions: new Map(),
    messageByteSizes: new Map(),
    messageBytes: 0,
  }
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function replaceCollectedArtifacts(
  accumulator: CollectedResultAccumulator,
  artifacts: Artifact[],
): void {
  accumulator.artifactAccumulator = createArtifactAccumulator()
  for (const artifact of artifacts) mergeArtifact(accumulator.artifactAccumulator, artifact)
}

function mergeCollectedMessage(
  accumulator: CollectedResultAccumulator,
  message: Message | undefined,
  onUpdate?: (content: string) => void,
): void {
  if (!message) return
  const position = accumulator.messagePositions.get(message.messageId)
  const previousBytes = accumulator.messageByteSizes.get(message.messageId) ?? 0
  const nextBytes = jsonByteLength(message)
  if (position === undefined) {
    accumulator.messagePositions.set(message.messageId, accumulator.history.length)
    accumulator.history.push(message)
  } else {
    accumulator.history[position] = message
  }
  accumulator.messageByteSizes.set(message.messageId, nextBytes)
  accumulator.messageBytes += nextBytes - previousBytes
  const text = message.parts
    .map(textFromPart)
    .filter((part): part is string => Boolean(part))
    .join('')
  if (text) onUpdate?.(text)
}

function markFinalResponseMessage(
  accumulator: CollectedResultAccumulator,
  message: Message | undefined,
): void {
  if (!message) return
  accumulator.nonTerminalStatusMessageIds.delete(message.messageId)
  accumulator.finalResponseMessageIds.add(message.messageId)
}

function markNonTerminalStatusMessage(
  accumulator: CollectedResultAccumulator,
  message: Message | undefined,
): void {
  if (message && !accumulator.finalResponseMessageIds.has(message.messageId)) {
    accumulator.nonTerminalStatusMessageIds.add(message.messageId)
  }
}

function markTerminalHistoryMessage(
  accumulator: CollectedResultAccumulator,
  message: Message,
): void {
  if (!accumulator.nonTerminalStatusMessageIds.has(message.messageId)) {
    accumulator.finalResponseMessageIds.add(message.messageId)
  }
}

function collectedResultFromAccumulator(
  accumulator: CollectedResultAccumulator,
): CollectedClientResult | null {
  const { artifactAccumulator, failure, finalResponseMessageIds, history, task } = accumulator
  const finalHistory = history.filter((message) => finalResponseMessageIds.has(message.messageId))
  if (
    artifactAccumulator.artifacts.length === 0 &&
    finalHistory.length === 0 &&
    !failure &&
    !task
  ) {
    return null
  }
  return {
    result: {
      artifacts: artifactAccumulator.artifacts,
      history: finalHistory,
      ...(task && { task }),
    },
    ...(failure && { failure }),
  }
}

function partsJsonByteLength(parts: Artifact['parts']): number {
  return parts.reduce((total, part) => total + jsonByteLength(part), 0)
}

function artifactJsonByteLengthFromParts(artifact: Artifact, serializedPartsBytes: number): number {
  const shellBytes = jsonByteLength({ ...artifact, parts: [] })
  const separatorBytes = Math.max(0, artifact.parts.length - 1)
  return shellBytes - 2 + serializedPartsBytes + separatorBytes
}

function mergeArtifact(
  accumulator: ArtifactAccumulator,
  artifact: Artifact,
  options: { append?: boolean; lastChunk?: boolean } = {},
): void {
  const artifactId = artifact.artifactId || `unkeyed-${accumulator.artifacts.length}`
  const position = accumulator.positions.get(artifactId)

  if (options.append && accumulator.finalized.has(artifactId)) {
    throw new Error(`Remote A2A result appended artifact "${artifactId}" after its final chunk`)
  }

  if (options.append && position !== undefined) {
    const previous = accumulator.artifacts[position]
    const appendedParts = artifact.parts
    const { parts: _parts, ...artifactFields } = artifact
    Object.assign(previous, artifactFields, { artifactId })
    for (const part of appendedParts) previous.parts.push(part)

    const previousBytes = accumulator.byteSizes.get(artifactId) ?? 0
    const nextPartsBytes =
      (accumulator.partsByteSizes.get(artifactId) ?? 0) + partsJsonByteLength(appendedParts)
    const nextBytes = artifactJsonByteLengthFromParts(previous, nextPartsBytes)
    accumulator.partsByteSizes.set(artifactId, nextPartsBytes)
    accumulator.byteSizes.set(artifactId, nextBytes)
    accumulator.totalBytes += nextBytes - previousBytes
  } else if (position !== undefined) {
    const storedArtifact = { ...artifact, artifactId, parts: [...artifact.parts] }
    accumulator.artifacts[position] = storedArtifact
    const previousBytes = accumulator.byteSizes.get(artifactId) ?? 0
    const nextBytes = jsonByteLength(storedArtifact)
    accumulator.partsByteSizes.set(artifactId, partsJsonByteLength(storedArtifact.parts))
    accumulator.byteSizes.set(artifactId, nextBytes)
    accumulator.totalBytes += nextBytes - previousBytes
  } else {
    accumulator.positions.set(artifactId, accumulator.artifacts.length)
    const storedArtifact = { ...artifact, artifactId, parts: [...artifact.parts] }
    accumulator.artifacts.push(storedArtifact)
    const nextBytes = jsonByteLength(storedArtifact)
    accumulator.partsByteSizes.set(artifactId, partsJsonByteLength(storedArtifact.parts))
    accumulator.byteSizes.set(artifactId, nextBytes)
    accumulator.totalBytes += nextBytes
  }

  if (options.lastChunk) accumulator.finalized.add(artifactId)
  else accumulator.finalized.delete(artifactId)
}

function enforceResultEventBudget(state: InvocationResultBudget): void {
  state.events += 1
  if (state.events > MAX_REMOTE_RESULT_EVENTS) {
    throw new RemoteResultLimitError(
      `Remote A2A result exceeds the ${MAX_REMOTE_RESULT_EVENTS}-event limit`,
    )
  }
}

function enforceAccumulatedResultBudget(accumulator: CollectedResultAccumulator): void {
  const structuralBytes = jsonByteLength({
    result: {
      artifacts: [],
      history: [],
      ...(accumulator.task && { task: accumulator.task }),
    },
    ...(accumulator.failure && { failure: accumulator.failure }),
  })
  const accumulatedBytes =
    structuralBytes +
    accumulator.artifactAccumulator.totalBytes +
    accumulator.artifactAccumulator.artifacts.length +
    accumulator.messageBytes +
    accumulator.history.length
  if (accumulatedBytes > MAX_REMOTE_RESULT_BYTES) {
    throw new RemoteResultLimitError(
      `Remote A2A result exceeds the ${MAX_REMOTE_RESULT_BYTES}-byte limit`,
    )
  }
}

async function collectClientResult(
  stream: AsyncGenerator<StreamResponse, void, undefined>,
  budget: InvocationResultBudget,
  onUpdate?: (content: string) => void,
  onTask?: (task: NonNullable<CollectedClientResult['result']['task']>) => void,
  onIdle?: () => void,
  taskAlreadyKnown = false,
  accumulator: CollectedResultAccumulator = createCollectedResultAccumulator(),
): Promise<CollectedClientResult | null> {
  let taskObserved = taskAlreadyKnown

  const iterator = stream[Symbol.asyncIterator]()
  let reachedEof = false
  let hasIterationError = false
  let iterationError: unknown
  try {
    while (true) {
      const next = taskObserved
        ? await new Promise<IteratorResult<StreamResponse, void>>((resolve, reject) => {
            const timer = setTimeout(() => {
              onIdle?.()
              reject(new Error(`A2A task stream was idle for ${TASK_STREAM_IDLE_TIMEOUT_MS}ms`))
            }, TASK_STREAM_IDLE_TIMEOUT_MS)
            iterator.next().then(
              (value) => {
                clearTimeout(timer)
                resolve(value)
              },
              (error) => {
                clearTimeout(timer)
                reject(error)
              },
            )
          })
        : await iterator.next()
      if (next.done) {
        reachedEof = true
        break
      }
      const response = next.value
      const payload = response.payload
      if (!payload) continue
      enforceResultEventBudget(budget)
      let shouldStop = false
      switch (payload.$case) {
        case 'artifactUpdate':
          taskObserved = true
          accumulator.task = {
            taskId: payload.value.taskId,
            contextId: payload.value.contextId,
            state: TaskState.TASK_STATE_UNSPECIFIED,
          }
          onTask?.(accumulator.task)
          if (payload.value.artifact) {
            mergeArtifact(accumulator.artifactAccumulator, payload.value.artifact, {
              append: payload.value.append,
              lastChunk: payload.value.lastChunk,
            })
          }
          break
        case 'statusUpdate':
          taskObserved = true
          mergeCollectedMessage(accumulator, payload.value.status?.message, onUpdate)
          if (endsCurrentInvocation(payload.value.status?.state)) {
            markFinalResponseMessage(accumulator, payload.value.status?.message)
          } else {
            markNonTerminalStatusMessage(accumulator, payload.value.status?.message)
          }
          accumulator.failure = taskFailure(payload.value.status?.state) ?? accumulator.failure
          accumulator.task = {
            taskId: payload.value.taskId,
            contextId: payload.value.contextId,
            state: payload.value.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
          }
          onTask?.(accumulator.task)
          shouldStop = endsCurrentInvocation(payload.value.status?.state)
          break
        case 'task':
          taskObserved = true
          replaceCollectedArtifacts(accumulator, payload.value.artifacts)
          for (const message of payload.value.history) {
            mergeCollectedMessage(accumulator, message)
            if (endsCurrentInvocation(payload.value.status?.state)) {
              markTerminalHistoryMessage(accumulator, message)
            }
          }
          mergeCollectedMessage(accumulator, payload.value.status?.message, onUpdate)
          if (endsCurrentInvocation(payload.value.status?.state)) {
            markFinalResponseMessage(accumulator, payload.value.status?.message)
          } else {
            markNonTerminalStatusMessage(accumulator, payload.value.status?.message)
          }
          accumulator.failure = taskFailure(payload.value.status?.state) ?? accumulator.failure
          accumulator.task = {
            taskId: payload.value.id,
            contextId: payload.value.contextId,
            state: payload.value.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
          }
          onTask?.(accumulator.task)
          shouldStop = endsCurrentInvocation(payload.value.status?.state)
          break
        case 'message':
          mergeCollectedMessage(accumulator, payload.value, onUpdate)
          markFinalResponseMessage(accumulator, payload.value)
          shouldStop = true
          break
      }
      enforceAccumulatedResultBudget(accumulator)
      // Interrupted states and message-only responses are final for this
      // stateless router invocation. The reference SDK may intentionally keep
      // an interrupted stream open for out-of-band continuation.
      if (shouldStop) break
    }
  } catch (error) {
    hasIterationError = true
    iterationError = error
  }

  if (!reachedEof) {
    try {
      await iterator.return?.()
    } catch (error) {
      if (!hasIterationError) {
        hasIterationError = true
        iterationError = error
      }
    }
  }
  if (hasIterationError) throw iterationError

  return collectedResultFromAccumulator(accumulator)
}

function collectSendMessageResult(
  response: SendMessageResult,
  onUpdate?: (content: string) => void,
  accumulator: CollectedResultAccumulator = createCollectedResultAccumulator(),
): CollectedClientResult {
  if ('messageId' in response) {
    mergeCollectedMessage(accumulator, response, onUpdate)
    markFinalResponseMessage(accumulator, response)
    return collectedResultFromAccumulator(accumulator) as CollectedClientResult
  }

  replaceCollectedArtifacts(accumulator, response.artifacts)
  for (const message of response.history) {
    mergeCollectedMessage(accumulator, message)
    if (endsCurrentInvocation(response.status?.state)) {
      markTerminalHistoryMessage(accumulator, message)
    }
  }
  mergeCollectedMessage(accumulator, response.status?.message, onUpdate)
  if (endsCurrentInvocation(response.status?.state)) {
    markFinalResponseMessage(accumulator, response.status?.message)
  } else {
    markNonTerminalStatusMessage(accumulator, response.status?.message)
  }
  accumulator.failure = taskFailure(response.status?.state) ?? accumulator.failure
  accumulator.task = {
    taskId: response.id,
    contextId: response.contextId,
    state: response.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
  }
  return collectedResultFromAccumulator(accumulator) as CollectedClientResult
}

type StandardA2AClient = RemoteClientContext['client']

interface StandardInvocationOptions {
  signal?: AbortSignal
  serviceParameters?: ReturnType<typeof ServiceParameters.create>
  onUpdate?: (content: string) => void
  targetLabel: string
}

interface TaskLifecycleDetails {
  contextId?: string
  state?: string
  attempt?: number
}

function logTaskLifecycle(
  event: string,
  targetLabel: string,
  taskId?: string,
  details: TaskLifecycleDetails = {},
): void {
  const safeDetails = {
    ...(details.contextId && { contextId: details.contextId.slice(0, 128) }),
    ...(details.state && { state: details.state.slice(0, 64) }),
    ...(Number.isSafeInteger(details.attempt) && { attempt: details.attempt }),
  }
  console.error(
    `[agent-router] ${JSON.stringify({
      event,
      target: targetLabel.slice(0, 256),
      ...(taskId && { taskId: taskId.slice(0, 128) }),
      ...safeDetails,
    })}`,
  )
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Parent invocation was canceled')
}

async function waitForPollInterval(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal ? abortError(signal) : new Error('Parent invocation was canceled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function taskToCollectedResult(
  task: Task,
  accumulator: CollectedResultAccumulator,
  onUpdate?: (content: string) => void,
) {
  return collectSendMessageResult(task, onUpdate, accumulator)
}

function hasDisplayableCollectedResponse(accumulator: CollectedResultAccumulator): boolean {
  const hasArtifactText = accumulator.artifactAccumulator.artifacts.some((artifact) =>
    artifact.parts.some((part) => Boolean(textFromPart(part))),
  )
  if (hasArtifactText) return true
  return accumulator.history.some(
    (message) =>
      accumulator.finalResponseMessageIds.has(message.messageId) &&
      isAgentMessage(message) &&
      message.parts.some((part) => Boolean(textFromPart(part))),
  )
}

async function hydrateTerminalTaskHistoryIfNeeded(
  client: StandardA2AClient,
  collected: CollectedClientResult,
  options: StandardInvocationOptions,
  budget: InvocationResultBudget,
  accumulator: CollectedResultAccumulator,
  onTask: (task: NonNullable<CollectedClientResult['result']['task']>) => void,
): Promise<CollectedClientResult> {
  const task = collected.result.task
  if (!task || !endsCurrentInvocation(task.state) || hasDisplayableCollectedResponse(accumulator)) {
    return collected
  }

  const hydratedTask = await client.getTask(
    GetTaskRequest.fromJSON({ id: task.taskId, historyLength: TERMINAL_TASK_HISTORY_LENGTH }),
    {
      signal: composeTimeoutSignal(options.signal, TASK_RPC_TIMEOUT_MS),
      serviceParameters: options.serviceParameters,
    },
  )
  enforceResultEventBudget(budget)
  const hydrated = taskToCollectedResult(hydratedTask, accumulator, options.onUpdate)
  if (hydrated.result.task) onTask(hydrated.result.task)
  enforceAccumulatedResultBudget(accumulator)
  return hydrated
}

function taskStateName(state: TaskState | undefined): string {
  return taskStateToJSON(state ?? TaskState.TASK_STATE_UNSPECIFIED)
}

interface TaskReadRetry {
  retryAfterMs?: number
}

function retryAfterFromHeaders(
  headers: Record<string, string | string[]> | undefined,
): number | undefined {
  if (!headers) return undefined
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after')
  const value = Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1]
  return parseRetryAfterMs(value)
}

function retryableTaskReadError(error: unknown): TaskReadRetry | null {
  if (error instanceof RemoteTaskReadHttpError) {
    return isRetryableHttpStatus(error.statusCode) ? { retryAfterMs: error.retryAfterMs } : null
  }
  const transportError =
    typeof error === 'object' && error !== null
      ? (error as {
          transport?: unknown
          envelopeCode?: unknown
          statusCode?: unknown
          headers?: Record<string, string | string[]>
        })
      : undefined
  const envelopeCode = isJsonRpcError(error)
    ? error.envelopeCode
    : transportError?.transport === 'jsonrpc'
      ? transportError.envelopeCode
      : undefined
  if (typeof envelopeCode === 'number') {
    return envelopeCode === A2A_ERROR_CODE.INTERNAL_ERROR ? {} : null
  }
  const restStatusCode = isRestError(error)
    ? error.statusCode
    : transportError?.transport === 'rest'
      ? transportError.statusCode
      : undefined
  if (typeof restStatusCode === 'number') {
    if (!isRetryableHttpStatus(restStatusCode)) return null
    const headers = isRestError(error) ? error.headers : transportError?.headers
    return { retryAfterMs: retryAfterFromHeaders(headers) }
  }

  const message = error instanceof Error ? error.message : String(error)
  const statusMatch = /(?:Status:\s*|HTTP\s+)(\d{3})/i.exec(message)
  if (statusMatch) {
    const statusCode = Number(statusMatch[1])
    return isRetryableHttpStatus(statusCode) ? {} : null
  }

  // The SDK reports network failures and per-request timeouts as ordinary
  // errors. Retry only recognizable transport failures: malformed payloads and
  // other deterministic client errors must escape to the one-shot recovery
  // path instead of polling forever.
  if (
    error instanceof DOMException &&
    (error.name === 'TimeoutError' || error.name === 'NetworkError')
  ) {
    return {}
  }
  const errorRecord =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown; cause?: { code?: unknown } })
      : undefined
  const code = errorRecord?.code ?? errorRecord?.cause?.code
  if (code === 'dns_resolution_failed') return {}
  if (
    typeof code === 'string' &&
    /^(ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|UND_ERR_)/.test(code)
  ) {
    return {}
  }
  return /\b(fetch failed|failed to fetch|network|socket|timed? ?out|connection (?:closed|reset))\b/i.test(
    message,
  )
    ? {}
    : null
}

function taskPollRetryDelayMs(consecutiveErrors: number, retryAfterMs?: number): number {
  const exponentialDelay = Math.min(
    MAX_TASK_POLL_RETRY_DELAY_MS,
    TASK_POLL_INTERVAL_MS * 2 ** Math.min(Math.max(0, consecutiveErrors - 1), 5),
  )
  const jitteredDelay = Math.min(
    MAX_TASK_POLL_RETRY_DELAY_MS,
    Math.round(exponentialDelay * (1 + Math.random() * 0.25)),
  )
  const serverDelay = Math.min(retryAfterMs ?? 0, MAX_TIMER_DELAY_MS)
  return Math.max(jitteredDelay, serverDelay)
}

async function pollTaskUntilTerminal(
  client: StandardA2AClient,
  taskId: string,
  options: StandardInvocationOptions,
  budget: InvocationResultBudget,
  accumulator: CollectedResultAccumulator,
  onTask: (task: NonNullable<CollectedClientResult['result']['task']>) => void,
  initialRetry?: TaskReadRetry,
): Promise<CollectedClientResult> {
  let consecutiveErrors = initialRetry ? 1 : 0
  let nextPollDelayMs = initialRetry
    ? taskPollRetryDelayMs(consecutiveErrors, initialRetry.retryAfterMs)
    : TASK_POLL_INTERVAL_MS
  if (initialRetry) {
    logTaskLifecycle('a2a.task.poll_retry', options.targetLabel, taskId, {
      attempt: consecutiveErrors,
    })
    await waitForPollInterval(nextPollDelayMs, options.signal)
  }
  while (true) {
    if (options.signal?.aborted) throw abortError(options.signal)
    try {
      const task = await client.getTask(GetTaskRequest.fromJSON({ id: taskId, historyLength: 0 }), {
        signal: composeTimeoutSignal(options.signal, TASK_RPC_TIMEOUT_MS),
        serviceParameters: options.serviceParameters,
      })
      enforceResultEventBudget(budget)
      let collected = taskToCollectedResult(task, accumulator, options.onUpdate)
      const state = collected.result.task?.state
      if (collected.result.task) onTask(collected.result.task)
      enforceAccumulatedResultBudget(accumulator)

      if (endsCurrentInvocation(state)) {
        collected = await hydrateTerminalTaskHistoryIfNeeded(
          client,
          collected,
          options,
          budget,
          accumulator,
          onTask,
        )
        if (endsCurrentInvocation(collected.result.task?.state)) return collected
      }
      consecutiveErrors = 0
      nextPollDelayMs = TASK_POLL_INTERVAL_MS
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal)
      const retry = retryableTaskReadError(error)
      if (!retry) throw error
      consecutiveErrors += 1
      nextPollDelayMs = taskPollRetryDelayMs(consecutiveErrors, retry.retryAfterMs)
      if (consecutiveErrors === 1 || consecutiveErrors % 10 === 0) {
        logTaskLifecycle('a2a.task.poll_retry', options.targetLabel, taskId, {
          attempt: consecutiveErrors,
        })
      }
    }
    await waitForPollInterval(nextPollDelayMs, options.signal)
  }
}

async function cancelKnownTask(
  client: StandardA2AClient,
  taskId: string,
  options: StandardInvocationOptions,
): Promise<{ state?: TaskState; error?: string }> {
  logTaskLifecycle('a2a.task.cancel_requested', options.targetLabel, taskId)
  try {
    // Cancellation must not reuse an already-aborted parent signal, otherwise
    // the downstream CancelTask request can never leave this process.
    const task = await client.cancelTask(CancelTaskRequest.fromJSON({ id: taskId }), {
      signal: AbortSignal.timeout(TASK_CANCEL_TIMEOUT_MS),
      serviceParameters: options.serviceParameters,
    })
    const state = task.status?.state
    logTaskLifecycle('a2a.task.cancel_result', options.targetLabel, taskId, {
      state: taskStateName(state),
    })
    return { state }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logTaskLifecycle('a2a.task.cancel_failed', options.targetLabel, taskId)
    return { error: message }
  }
}

async function canceledInvocationResult(
  client: StandardA2AClient,
  taskId: string,
  options: StandardInvocationOptions,
) {
  const cancellation = await cancelKnownTask(client, taskId, options)
  const detail = cancellation.error
    ? `downstream cancellation could not be confirmed: ${cancellation.error}`
    : `downstream state: ${taskStateName(cancellation.state)}`
  return {
    content: [
      {
        type: 'text' as const,
        text: `Parent invocation canceled; CancelTask was sent for taskId: ${taskId} (${detail})`,
      },
    ],
    isError: true,
  }
}

async function recoverKnownTask(
  client: StandardA2AClient,
  taskId: string,
  options: StandardInvocationOptions,
  budget: InvocationResultBudget,
  accumulator: CollectedResultAccumulator,
  onTask: (task: NonNullable<CollectedClientResult['result']['task']>) => void,
): Promise<CollectedClientResult> {
  logTaskLifecycle('a2a.task.reconnect', options.targetLabel, taskId)
  let observedTaskId = taskId
  let resubscribed: CollectedClientResult | null
  try {
    const streamController = new AbortController()
    resubscribed = await collectClientResult(
      client.resubscribeTask(SubscribeToTaskRequest.fromJSON({ id: taskId }), {
        signal: options.signal
          ? AbortSignal.any([options.signal, streamController.signal])
          : streamController.signal,
        serviceParameters: options.serviceParameters,
      }),
      budget,
      options.onUpdate,
      (task) => {
        observedTaskId = task.taskId
        onTask(task)
      },
      () => streamController.abort(new Error('A2A task stream idle')),
      true,
      accumulator,
    )
  } catch (error) {
    if (options.signal?.aborted) throw abortError(options.signal)
    if (error instanceof RemoteResultLimitError) throw error
    if (error instanceof RemoteTaskIdentityError) throw error
    logTaskLifecycle('a2a.task.resubscribe_failed', options.targetLabel, taskId)
    const terminal = await pollTaskUntilTerminal(
      client,
      taskId,
      options,
      budget,
      accumulator,
      onTask,
    )
    return terminal
  }

  const state = resubscribed?.result.task?.state
  if (resubscribed && endsCurrentInvocation(state)) {
    try {
      const hydrated = await hydrateTerminalTaskHistoryIfNeeded(
        client,
        resubscribed,
        options,
        budget,
        accumulator,
        onTask,
      )
      if (endsCurrentInvocation(hydrated.result.task?.state)) return hydrated
    } catch (error) {
      if (options.signal?.aborted) throw abortError(options.signal)
      const retry = retryableTaskReadError(error)
      if (!retry) throw error
      return pollTaskUntilTerminal(
        client,
        observedTaskId,
        options,
        budget,
        accumulator,
        onTask,
        retry,
      )
    }
  }
  const terminal = await pollTaskUntilTerminal(
    client,
    observedTaskId,
    options,
    budget,
    accumulator,
    onTask,
  )
  return terminal
}

async function executeStandardInvocation(
  client: StandardA2AClient,
  card: AgentCard,
  request: SendMessageRequest,
  options: StandardInvocationOptions,
): Promise<CollectedClientResult | null | Awaited<ReturnType<typeof canceledInvocationResult>>> {
  let knownTaskId: string | undefined
  let knownContextId: string | undefined
  let lastLoggedTaskId: string | undefined
  let lastLoggedTaskState: TaskState | undefined
  const budget = createInvocationResultBudget()
  const accumulator = createCollectedResultAccumulator()
  const rememberTask = (task: NonNullable<CollectedClientResult['result']['task']>) => {
    if (!knownTaskId) {
      knownTaskId = task.taskId
      knownContextId = task.contextId
      logTaskLifecycle('a2a.task.observed', options.targetLabel, task.taskId, {
        contextId: task.contextId,
      })
    } else if (task.taskId !== knownTaskId || task.contextId !== knownContextId) {
      throw new RemoteTaskIdentityError(
        `Remote A2A task changed identity from taskId ${knownTaskId}, contextId ${knownContextId} to taskId ${task.taskId}, contextId ${task.contextId}`,
      )
    }
    if (lastLoggedTaskId !== task.taskId) {
      lastLoggedTaskId = task.taskId
      lastLoggedTaskState = undefined
    }
    if (
      task.state !== undefined &&
      task.state !== TaskState.TASK_STATE_UNSPECIFIED &&
      task.state !== lastLoggedTaskState
    ) {
      logTaskLifecycle('a2a.task.state', options.targetLabel, task.taskId, {
        state: taskStateName(task.state),
      })
      lastLoggedTaskState = task.state
    }
  }

  try {
    let result: CollectedClientResult | null
    if (card.capabilities?.streaming) {
      const streamController = new AbortController()
      result = await collectClientResult(
        client.sendMessageStream(request, {
          signal: options.signal
            ? AbortSignal.any([options.signal, streamController.signal])
            : streamController.signal,
          serviceParameters: options.serviceParameters,
        }),
        budget,
        options.onUpdate,
        rememberTask,
        () => streamController.abort(new Error('A2A task stream idle')),
        false,
        accumulator,
      )
    } else {
      const response = await client.sendMessage(request, {
        signal: options.signal,
        serviceParameters: options.serviceParameters,
      })
      enforceResultEventBudget(budget)
      result = collectSendMessageResult(response, options.onUpdate, accumulator)
      if (result.result.task) rememberTask(result.result.task)
      enforceAccumulatedResultBudget(accumulator)
    }

    if (options.signal?.aborted && knownTaskId) {
      return canceledInvocationResult(client, knownTaskId, options)
    }
    let task = result?.result.task
    if (result && task && endsCurrentInvocation(task.state)) {
      result = await hydrateTerminalTaskHistoryIfNeeded(
        client,
        result,
        options,
        budget,
        accumulator,
        rememberTask,
      )
      task = result.result.task
    }
    if (task && !endsCurrentInvocation(task.state)) {
      const terminal = await pollTaskUntilTerminal(
        client,
        task.taskId,
        options,
        budget,
        accumulator,
        rememberTask,
      )
      return terminal
    }
    return result
  } catch (error) {
    if (error instanceof RemoteTaskIdentityError) {
      if (knownTaskId) await cancelKnownTask(client, knownTaskId, options)
      throw error
    }
    if (error instanceof RemoteResultLimitError) {
      if (knownTaskId) await cancelKnownTask(client, knownTaskId, options)
      throw error
    }
    if (!knownTaskId) throw error
    if (options.signal?.aborted) {
      return canceledInvocationResult(client, knownTaskId, options)
    }
    try {
      const recovered = await recoverKnownTask(
        client,
        knownTaskId,
        options,
        budget,
        accumulator,
        rememberTask,
      )
      return recovered
    } catch (recoveryError) {
      if (recoveryError instanceof RemoteTaskIdentityError) {
        await cancelKnownTask(client, knownTaskId, options)
        throw recoveryError
      }
      if (recoveryError instanceof RemoteResultLimitError) {
        await cancelKnownTask(client, knownTaskId, options)
        throw recoveryError
      }
      if (options.signal?.aborted) {
        return canceledInvocationResult(client, knownTaskId, options)
      }
      if (!endsCurrentInvocation(accumulator.task?.state)) {
        await cancelKnownTask(client, knownTaskId, options)
      }
      const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError)
      throw new Error(`Failed to recover remote task ${knownTaskId}: ${message}`)
    }
  }
}

function formatCollectedFailure(result: CollectedClientResult): string {
  const failure = result.failure ?? 'Remote task did not complete'
  const task = result.result.task
  return task ? `${failure} (taskId: ${task.taskId}, contextId: ${task.contextId})` : failure
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON responses
export function extractTextFromA2AResponse(result: any): {
  content: Array<{ type: 'text'; text: string }>
} {
  const artifacts = result?.result?.artifacts ?? []
  const artifactText = artifacts
    .map((artifact: { parts?: unknown[] }) =>
      (artifact.parts ?? []).map(textFromPart).filter(Boolean).join(''),
    )
    .filter(Boolean)
    .join('\n')
  if (artifactText) {
    return { content: [{ type: 'text' as const, text: artifactText }] }
  }

  const history = result?.result?.history ?? []
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]
    if (isAgentMessage(msg)) {
      const text = (msg.parts ?? []).map(textFromPart).filter(Boolean).join('')
      if (text) return { content: [{ type: 'text' as const, text }] }
    }
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  }
}

// biome-ignore lint/suspicious/noExplicitAny: JSON-RPC envelopes are runtime data
function extractProtocolResult(result: any) {
  if (result?.error) {
    const code = result.error.code !== undefined ? ` (${result.error.code})` : ''
    const message = result.error.message ?? 'Unknown A2A protocol error'
    return {
      content: [{ type: 'text' as const, text: `A2A protocol error${code}: ${message}` }],
      isError: true,
    }
  }
  const failure = result?.failure ?? legacyTaskFailure(result?.result?.status?.state)
  if (failure) {
    const extracted = extractTextFromA2AResponse(result)
    const responseText = extracted.content[0]?.text
    return {
      content: [
        {
          type: 'text' as const,
          text:
            responseText && responseText !== JSON.stringify(result, null, 2)
              ? `${failure}: ${responseText}`
              : failure,
        },
      ],
      isError: true,
    }
  }
  return extractTextFromA2AResponse(result)
}

export async function listAgentsHandler(targets: RouteTarget[] | null = routeTargets) {
  if (targets === null) {
    const result = await fetchJson('/api/internal/agents')
    const agents = result.data ?? []
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(agents, null, 2) }],
    }
  }

  const agents: Array<Record<string, unknown>> = []

  const localTargets = targets.filter((t) => t.type === 'local')
  if (localTargets.length > 0) {
    const ids = localTargets.map((t) => t.agentId).join(',')
    const result = await fetchJson(`/api/internal/agents?ids=${ids}`)
    const filteredAgents = result.data ?? []
    for (const agent of filteredAgents) {
      agents.push(agent)
    }
  }

  const remoteTargets = targets.filter((t) => t.type === 'remote')
  for (const target of remoteTargets) {
    agents.push({
      id: `remote:${target.name}`,
      name: target.name,
      description: target.description || null,
      type: 'remote',
    })
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(agents, null, 2) }],
  }
}

export async function getAgentCardHandler(
  { agentId }: { agentId: string },
  targets: RouteTarget[] | null = routeTargets,
) {
  if (agentId.startsWith('remote:')) {
    const remoteName = agentId.slice('remote:'.length)
    const target = targets?.find((t) => t.type === 'remote' && t.name === remoteName)
    if (!isRemoteRouteTarget(target)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Remote agent "${remoteName}" not found in route targets`,
          },
        ],
        isError: true,
      }
    }

    try {
      const card = await resolveRemoteAgentCard(target)
      if (target.connectionMode === 'agent_card') validateDiscoveredInterface(target, card)
      const serialized = AgentCard.toJSON(card) as Record<string, unknown>
      const response = {
        ...serialized,
        url: target.url,
        type: 'remote',
        connectionMode: target.connectionMode ?? 'direct',
        protocolVersion:
          target.connectionMode === 'agent_card'
            ? selectJsonRpcInterface(card)?.protocolVersion
            : (target.protocolVersion ?? '0.3'),
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response, null, 2) }],
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to resolve remote Agent Card for "${remoteName}": ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      }
    }
  }

  const card = await fetchJson(`/api/internal/a2a/${agentId}/card`)
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }],
  }
}

// biome-ignore lint/suspicious/noExplicitAny: dynamic SSE event data
export async function collectSSEResult(response: Response): Promise<any> {
  if (response.body) return streamSSEWithCallback(response)

  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_REMOTE_RESULT_BYTES) {
    throw new Error(`Remote A2A result exceeds the ${MAX_REMOTE_RESULT_BYTES}-byte limit`)
  }
  const artifactAccumulator = createArtifactAccumulator()
  // biome-ignore lint/suspicious/noExplicitAny: dynamic SSE event data
  const history: any[] = []
  // biome-ignore lint/suspicious/noExplicitAny: dynamic SSE event data
  let lastError: any = null
  let failure: string | undefined
  let eventCount = 0

  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice('data:'.length).trim()
    if (!data) continue
    eventCount += 1
    if (eventCount > MAX_REMOTE_RESULT_EVENTS) {
      throw new Error(`Remote A2A result exceeds the ${MAX_REMOTE_RESULT_EVENTS}-event limit`)
    }
    try {
      const parsed = JSON.parse(data)
      if (parsed.error) {
        lastError = parsed
        continue
      }
      const event = parsed.result
      if (!event) continue

      if (event.kind === 'artifact-update' && event.artifact) {
        mergeArtifact(artifactAccumulator, event.artifact as Artifact, {
          append: event.append,
          lastChunk: event.lastChunk,
        })
      } else if (event.kind === 'status-update') {
        if (event.status?.message) history.push(event.status.message)
        failure = legacyTaskFailure(event.status?.state) ?? failure
      }
    } catch (error) {
      if (error instanceof SyntaxError) continue
      throw error
    }
  }

  if (lastError) return lastError
  if (artifactAccumulator.artifacts.length === 0 && history.length === 0 && !failure) return null

  return {
    result: { artifacts: artifactAccumulator.artifacts, history },
    ...(failure && { failure }),
  }
}

function normalizeLegacyTaskState(state: unknown): string {
  return String(state ?? '')
    .toLowerCase()
    .replace(/^task_state_/, '')
    .replaceAll('_', '-')
}

function legacyTaskFailure(state: unknown): string | undefined {
  switch (normalizeLegacyTaskState(state)) {
    case 'failed':
      return 'Remote task failed'
    case 'canceled':
    case 'cancelled':
      return 'Remote task was canceled'
    case 'rejected':
      return 'Remote task was rejected'
    case 'auth-required':
      return 'Remote task requires authentication'
    case 'input-required':
      return 'Remote task requires additional input'
    default:
      return undefined
  }
}

function legacyEndsCurrentInvocation(state: unknown): boolean {
  return [
    'completed',
    'failed',
    'canceled',
    'cancelled',
    'rejected',
    'auth-required',
    'input-required',
  ].includes(normalizeLegacyTaskState(state))
}

/**
 * Resolves to the parsed SSE result payload. The shape is defined by the remote agent's
 * A2A response, not by us, and callers index into it directly — so it stays `any` rather
 * than forcing a cast at every call site.
 */
export async function streamSSEWithCallback(
  response: Response,
  onUpdate?: (content: string) => void,
  // biome-ignore lint/suspicious/noExplicitAny: remote-defined A2A payload, see above
): Promise<any> {
  if (!response.body) return collectSSEResult(response)

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const artifactAccumulator = createArtifactAccumulator()
  // biome-ignore lint/suspicious/noExplicitAny: dynamic SSE event data
  const history: any[] = []
  // biome-ignore lint/suspicious/noExplicitAny: dynamic SSE event data
  let lastError: any = null
  let failure: string | undefined
  let totalBytes = 0
  let eventCount = 0

  const processData = (data: string): boolean => {
    if (!data) return false
    eventCount += 1
    if (eventCount > MAX_REMOTE_RESULT_EVENTS) {
      throw new Error(`Remote A2A result exceeds the ${MAX_REMOTE_RESULT_EVENTS}-event limit`)
    }
    try {
      const parsed = JSON.parse(data)
      if (parsed.error) {
        lastError = parsed
        return true
      }
      const event = parsed.result
      if (!event) return false

      if (event.kind === 'artifact-update' && event.artifact) {
        mergeArtifact(artifactAccumulator, event.artifact as Artifact, {
          append: event.append,
          lastChunk: event.lastChunk,
        })
      } else if (event.kind === 'status-update') {
        if (event.status?.message) {
          history.push(event.status.message)
          const text = (event.status.message.parts ?? [])
            .filter((part: { kind?: string }) => part.kind === 'text')
            .map((part: { text?: string }) => part.text ?? '')
            .join('')
          if (text) onUpdate?.(text)
        }
        failure = legacyTaskFailure(event.status?.state) ?? failure
        return legacyEndsCurrentInvocation(event.status?.state)
      }
    } catch (error) {
      if (error instanceof SyntaxError) return false
      throw error
    }
    return false
  }

  let shouldStop = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_REMOTE_RESULT_BYTES) {
      await reader.cancel()
      throw new Error(`Remote A2A result exceeds the ${MAX_REMOTE_RESULT_BYTES}-byte limit`)
    }
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const data = line.slice('data:'.length).trim()
      shouldStop = processData(data) || shouldStop
      if (shouldStop) break
    }
    if (shouldStop) {
      await reader.cancel()
      break
    }
  }

  // Flush remaining buffer — the last line may lack a trailing newline
  if (!shouldStop && buffer.trim()) {
    const remaining = buffer.trim()
    if (remaining.startsWith('data:')) {
      const data = remaining.slice('data:'.length).trim()
      processData(data)
    }
  }

  if (lastError) return lastError
  if (artifactAccumulator.artifacts.length === 0 && history.length === 0 && !failure) return null
  return {
    result: { artifacts: artifactAccumulator.artifacts, history },
    ...(failure && { failure }),
  }
}

async function sendA2ARequest(
  url: string,
  rpcBody: unknown,
  init?: {
    headers?: Record<string, string>
    enforcePublicRedirects?: boolean
    signal?: AbortSignal
  },
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init?.headers }
  const reqInit: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcBody),
    signal: init?.signal,
  }
  // Remote owner-controlled targets use per-hop URL + DNS validation and
  // connection pinning while preserving long-lived SSE bodies. Local platform
  // calls keep the ordinary loopback fetch path.
  if (init?.enforcePublicRedirects) {
    return safeRemoteRouteFetch(url, reqInit)
  }
  return fetch(url, reqInit)
}

function withInternalContextHeaders(headers: Headers): Headers {
  const streamingCardId = process.env.A2WAVE_STREAMING_CARD_ID
  if (streamingCardId) headers.set('X-Streaming-Card-Id', streamingCardId)

  const callerAgentId = process.env.A2WAVE_CALLER_AGENT_ID
  if (callerAgentId) headers.set(A2WAVE_CALLER_AGENT_ID_HEADER, callerAgentId)

  const callerAgentName = process.env.A2WAVE_CALLER_AGENT_NAME
  if (callerAgentName) {
    headers.set(A2WAVE_CALLER_AGENT_NAME_B64_HEADER, encodeCallerAgentNameHeader(callerAgentName))
  }

  const channelB64 = process.env.A2WAVE_CHANNEL_B64
  if (channelB64) headers.set(X_A2WAVE_CHANNEL_B64_HEADER, channelB64)
  return headers
}

async function createInternalClient(agentId: string): Promise<RemoteClientContext> {
  const endpoint = `${apiUrl}/api/internal/a2a/${agentId}`
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const response = await fetch(input, {
      ...init,
      headers: withInternalContextHeaders(new Headers(init.headers)),
    })
    await throwForRetryableTaskReadResponse(response, init.body)
    return withResponseByteLimit(response, MAX_REMOTE_RESULT_BYTES, 'Remote A2A result')
  }
  const card = AgentCard.fromJSON({
    name: agentId,
    description: 'Internal a2wave Agent',
    supportedInterfaces: [
      { url: endpoint, protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
    ],
    version: '1.0.0',
    // Internal calls use polling so the first request returns the durable Task
    // id before a long execution can outlive its HTTP connection.
    capabilities: { streaming: false, extensions: [] },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [],
  })
  const factory = new ClientFactory({
    transports: [new JsonRpcTransportFactory({ fetchImpl })],
    preferredTransports: ['JSONRPC'],
    clientConfig: { polling: true },
  })
  return { client: await factory.createFromAgentCard(card), card }
}

function buildRpcBody(method: 'message/send' | 'message/stream', message: string) {
  return {
    jsonrpc: '2.0',
    id: `mcp-${Date.now()}`,
    method,
    params: {
      message: {
        kind: 'message',
        messageId: randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: message }],
      },
    },
  }
}

async function createRemoteUpdateCallback(
  remoteName: string,
): Promise<((content: string) => void) | undefined> {
  const streamingCardId = process.env.A2WAVE_STREAMING_CARD_ID
  if (!streamingCardId) return undefined

  const safeRemoteName = remoteName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const childId = `remote_${safeRemoteName}_${Date.now()}`
  await fetch(`${apiUrl}/api/internal/streaming-card/${streamingCardId}/child`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ childId, label: remoteName }),
  }).catch((err) => {
    console.warn(
      `[agent-router] Failed to create child section for remote agent "${remoteName}": ${err instanceof Error ? err.message : err}`,
    )
  })

  return (content: string) => {
    fetch(`${apiUrl}/api/internal/streaming-card/${streamingCardId}/child/${childId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }).catch((err) => {
      console.warn(
        `[agent-router] Failed to update child content for remote agent "${remoteName}": ${err instanceof Error ? err.message : err}`,
      )
    })
  }
}

function deduplicateUpdateCallback(
  onUpdate: ((content: string) => void) | undefined,
): ((content: string) => void) | undefined {
  if (!onUpdate) return undefined
  let previousContent: string | undefined
  return (content) => {
    if (content === previousContent) return
    previousContent = content
    onUpdate(content)
  }
}

function formatStandardInvocationResult(
  result: CollectedClientResult | null | Awaited<ReturnType<typeof canceledInvocationResult>>,
  emptyMessage: string,
) {
  if (result && 'content' in result) return result
  if (!result) {
    return {
      content: [{ type: 'text' as const, text: emptyMessage }],
      isError: true,
    }
  }

  const extracted = extractTextFromA2AResponse(result)
  if (!result.failure) return extracted
  const responseText = extracted.content[0]?.text
  const failure = formatCollectedFailure(result)
  return {
    content: [
      {
        type: 'text' as const,
        text:
          responseText && responseText !== JSON.stringify(result, null, 2)
            ? `${failure}: ${responseText}`
            : failure,
      },
    ],
    isError: true,
  }
}

async function invokeStandardRemoteAgent(
  target: RemoteRouteTarget,
  message: string,
  signal?: AbortSignal,
) {
  const { client, card } = await createRemoteClient(target)
  const onUpdate = deduplicateUpdateCallback(await createRemoteUpdateCallback(target.name))
  const supportsProvenance =
    client.protocolVersion === '1.0' &&
    card.capabilities?.extensions.some(
      (extension) => extension.uri === A2WAVE_CALLER_PROVENANCE_EXTENSION_URI,
    )
  const provenance = supportsProvenance ? buildOutboundA2AProvenance() : undefined
  const request = buildStandardSendRequest(
    message,
    provenance,
    card.capabilities?.streaming ? undefined : 0,
  )
  const serviceParameters = provenance
    ? ServiceParameters.create(withA2AExtensions(A2WAVE_CALLER_PROVENANCE_EXTENSION_URI))
    : undefined
  const result = await executeStandardInvocation(client, card, request, {
    signal,
    serviceParameters,
    onUpdate,
    targetLabel: target.name,
  })
  return formatStandardInvocationResult(result, 'No result received from remote agent')
}

export async function invokeAgentHandler(
  { agentId, message }: { agentId: string; message: string },
  targets: RouteTarget[] | null = routeTargets,
  options: { signal?: AbortSignal } = {},
) {
  if (agentId.startsWith('remote:')) {
    const remoteName = agentId.slice('remote:'.length)
    const target = targets?.find((t) => t.type === 'remote' && t.name === remoteName)
    if (!isRemoteRouteTarget(target)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Remote agent "${remoteName}" not found in route targets`,
          },
        ],
        isError: true,
      }
    }

    if (target.connectionMode === 'agent_card' || target.protocolVersion === '1.0') {
      try {
        return await invokeStandardRemoteAgent(target, message, options.signal)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return {
          content: [
            {
              type: 'text' as const,
              text: `Failed to invoke remote agent "${remoteName}": ${errorMessage}`,
            },
          ],
          isError: true,
        }
      }
    }

    const urlRejection = checkRemoteTargetUrl(target.url)
    if (urlRejection) {
      return {
        content: [{ type: 'text' as const, text: urlRejection }],
        isError: true,
      }
    }

    const headers: Record<string, string> = {}
    if (target.apiKey) {
      headers.Authorization = `Bearer ${target.apiKey}`
    }

    // Existing rows keep the direct v0.3 streaming request shape.
    const rpcBody = buildRpcBody('message/stream', message)

    try {
      const res = await sendA2ARequest(target.url, rpcBody, {
        headers,
        enforcePublicRedirects: true,
        signal: options.signal,
      })
      if (!res.ok) {
        const body = await readResponseTextWithLimit(
          res,
          MAX_REMOTE_RESULT_BYTES,
          'Remote A2A error response',
        ).catch(() => '')
        return {
          content: [
            { type: 'text' as const, text: `Remote agent returned HTTP ${res.status}: ${body}` },
          ],
          isError: true,
        }
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) {
        const onUpdate = await createRemoteUpdateCallback(remoteName)
        const result = onUpdate
          ? await streamSSEWithCallback(res, onUpdate)
          : await collectSSEResult(res)
        return result
          ? extractProtocolResult(result)
          : {
              content: [{ type: 'text' as const, text: 'No result received from remote agent' }],
              isError: true,
            }
      }

      const result = await readResponseJsonWithLimit(res)
      return extractProtocolResult(result)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to invoke remote agent "${remoteName}": ${errorMessage}`,
          },
        ],
        isError: true,
      }
    }
  }

  const { client, card } = await createInternalClient(agentId)
  const result = await executeStandardInvocation(
    client,
    card,
    buildStandardSendRequest(message, undefined, card.capabilities?.streaming ? undefined : 0),
    {
      signal: options.signal,
      targetLabel: agentId,
    },
  )
  return formatStandardInvocationResult(result, 'No result received from agent')
}

export async function invokeAgentsParallelHandler(
  { invocations }: { invocations: Array<{ agentId: string; message: string }> },
  targets: RouteTarget[] | null = routeTargets,
  options: { signal?: AbortSignal } = {},
) {
  const results = await Promise.all(
    invocations.map(async ({ agentId, message }) => {
      try {
        const result = await invokeAgentHandler({ agentId, message }, targets, options)
        const text = result.content?.[0]?.text ?? ''
        const isError = 'isError' in result ? result.isError : false
        return { agentId, success: !isError, text }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        return { agentId, success: false, text: `Error: ${errorMessage}` }
      }
    }),
  )

  const summary = results.map((r) => `### Agent: ${r.agentId}\n\n${r.text}`).join('\n\n---\n\n')
  const hasError = results.some((r) => !r.success)
  return { content: [{ type: 'text' as const, text: summary }], ...(hasError && { isError: true }) }
}

export function createRouterInvocationHandlers(
  targets: RouteTarget[] | null,
  registry: RouterInvocationRegistry,
) {
  return {
    invokeAgent(args: { agentId: string; message: string }, extra: { signal?: AbortSignal }) {
      return registry.run(extra.signal, (signal) => invokeAgentHandler(args, targets, { signal }))
    },
    invokeAgentsParallel(
      args: { invocations: Array<{ agentId: string; message: string }> },
      extra: { signal?: AbortSignal },
    ) {
      return registry.run(extra.signal, (signal) =>
        invokeAgentsParallelHandler(args, targets, { signal }),
      )
    },
  }
}

export async function startServer(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

  const server = new McpServer({
    name: 'a2wave-agent-router',
    version: '1.0.0',
  })
  const invocationRegistry = createRouterInvocationRegistry()
  const invocationHandlers = createRouterInvocationHandlers(routeTargets, invocationRegistry)

  server.tool(
    'list_agents',
    "List the Agents available to call. Returns each Agent's ID, name and description. Use this first to discover which Agents exist.",
    {},
    () => listAgentsHandler(),
  )

  server.tool(
    'get_agent_card',
    'Get the details of one Agent (its A2A Agent Card), including capability description and skill list. Use it to understand a target Agent before calling it.',
    {
      agentId: z.string().describe('Agent ID — local form agt_xxx, remote form remote:<name>'),
    },
    ({ agentId }) => getAgentCardHandler({ agentId }),
  )

  server.tool(
    'invoke_agent',
    'Send a message to an Agent over the A2A protocol and get its response. Long-running Tasks inherit the calling Agent run timeout and can reconnect by Task ID. Important: relay the complete returned result to the user — do not just reply "done".',
    {
      agentId: z
        .string()
        .describe('ID of the Agent to call — local form agt_xxx, remote form remote:<name>'),
      message: z
        .string()
        .describe('Natural-language message for the Agent, describing the task to complete'),
    },
    ({ agentId, message }, extra) => invocationHandlers.invokeAgent({ agentId, message }, extra),
  )

  server.tool(
    'invoke_agents_parallel',
    'Call several Agents in parallel: all invocations run at once and return together. Use it when sending independent requests to multiple Agents — far faster than calling invoke_agent serially. Important: relay each Agent\'s complete result to the user — do not just reply "done".',
    {
      invocations: z
        .array(
          z.object({
            agentId: z.string().describe('ID of the Agent to call'),
            message: z.string().describe('Message to send to that Agent'),
          }),
        )
        .min(1)
        .describe('List of Agents to call in parallel'),
    },
    ({ invocations }, extra) => invocationHandlers.invokeAgentsParallel({ invocations }, extra),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
  installRouterShutdownHooks(invocationRegistry, () => server.close())
}

const currentFile =
  typeof __filename !== 'undefined'
    ? __filename
    : import.meta.url
      ? fileURLToPath(import.meta.url)
      : undefined
const isDirectExecution =
  currentFile && process.argv[1] && resolve(process.argv[1]) === resolve(currentFile)

if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('[agent-router] Failed to start:', err)
    process.exit(1)
  })
}
