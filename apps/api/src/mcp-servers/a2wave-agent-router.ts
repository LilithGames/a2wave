import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AgentCard,
  type Artifact,
  type Message,
  Role,
  SendMessageRequest,
  type SendMessageResult,
  type StreamResponse,
  TaskState,
} from '@a2a-js/sdk'
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  ServiceParameters,
  withA2AExtensions,
} from '@a2a-js/sdk/client'
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

const REMOTE_REQUEST_TIMEOUT_MS = 5 * 60 * 1000
const AGENT_CARD_TIMEOUT_MS = 15 * 1000
const MAX_AGENT_CARD_BYTES = 1024 * 1024
const MAX_REMOTE_RESULT_BYTES = 16 * 1024 * 1024
const MAX_REMOTE_RESULT_EVENTS = 10_000

function composeTimeoutSignal(signal: AbortSignal | null | undefined, timeoutMs: number) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

async function cancelBodyQuietly(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {})
}

function withResponseByteLimit(response: Response, maxBytes: number, label: string): Response {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    void cancelBodyQuietly(response)
    throw new Error(`${label} exceeds the ${maxBytes}-byte response limit`)
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
          controller.error(new Error(`${label} exceeds the ${maxBytes}-byte response limit`))
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
      throw new Error(`${label} exceeds the ${maxBytes}-byte response limit`)
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
      signal: composeTimeoutSignal(
        init.signal,
        isAgentCardRequest ? AGENT_CARD_TIMEOUT_MS : REMOTE_REQUEST_TIMEOUT_MS,
      ),
    })
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

function buildStandardSendRequest(message: string, provenance?: A2ACallerProvenance) {
  return SendMessageRequest.fromJSON({
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
}

function createArtifactAccumulator(): ArtifactAccumulator {
  return { artifacts: [], positions: new Map(), finalized: new Set() }
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
    accumulator.artifacts[position] = {
      ...previous,
      ...artifact,
      artifactId,
      parts: [...previous.parts, ...artifact.parts],
    }
  } else if (position !== undefined) {
    accumulator.artifacts[position] = { ...artifact, artifactId }
  } else {
    accumulator.positions.set(artifactId, accumulator.artifacts.length)
    accumulator.artifacts.push({ ...artifact, artifactId })
  }

  if (options.lastChunk) accumulator.finalized.add(artifactId)
  else accumulator.finalized.delete(artifactId)
}

function enforceResultBudget(payload: unknown, state: { events: number; bytes: number }): void {
  state.events += 1
  if (state.events > MAX_REMOTE_RESULT_EVENTS) {
    throw new Error(`Remote A2A result exceeds the ${MAX_REMOTE_RESULT_EVENTS}-event limit`)
  }
  state.bytes += new TextEncoder().encode(JSON.stringify(payload)).byteLength
  if (state.bytes > MAX_REMOTE_RESULT_BYTES) {
    throw new Error(`Remote A2A result exceeds the ${MAX_REMOTE_RESULT_BYTES}-byte limit`)
  }
}

async function collectClientResult(
  stream: AsyncGenerator<StreamResponse, void, undefined>,
  onUpdate?: (content: string) => void,
): Promise<CollectedClientResult | null> {
  const artifactAccumulator = createArtifactAccumulator()
  const history: Message[] = []
  let failure: string | undefined
  let task: CollectedClientResult['result']['task']
  const budget = { events: 0, bytes: 0 }

  const recordMessage = (message: Message | undefined) => {
    if (!message) return
    history.push(message)
    const text = message.parts
      .map(textFromPart)
      .filter((part): part is string => Boolean(part))
      .join('')
    if (text) onUpdate?.(text)
  }

  for await (const response of stream) {
    const payload = response.payload
    if (!payload) continue
    enforceResultBudget(payload, budget)
    let shouldStop = false
    switch (payload.$case) {
      case 'artifactUpdate':
        if (payload.value.artifact) {
          mergeArtifact(artifactAccumulator, payload.value.artifact, {
            append: payload.value.append,
            lastChunk: payload.value.lastChunk,
          })
        }
        break
      case 'statusUpdate':
        recordMessage(payload.value.status?.message)
        failure = taskFailure(payload.value.status?.state) ?? failure
        task = {
          taskId: payload.value.taskId,
          contextId: payload.value.contextId,
          state: payload.value.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
        }
        shouldStop = endsCurrentInvocation(payload.value.status?.state)
        break
      case 'task':
        for (const artifact of payload.value.artifacts) mergeArtifact(artifactAccumulator, artifact)
        history.push(...payload.value.history)
        recordMessage(payload.value.status?.message)
        failure = taskFailure(payload.value.status?.state) ?? failure
        task = {
          taskId: payload.value.id,
          contextId: payload.value.contextId,
          state: payload.value.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
        }
        shouldStop = endsCurrentInvocation(payload.value.status?.state)
        break
      case 'message':
        recordMessage(payload.value)
        break
    }
    // Interrupted states are final for this stateless router invocation. In
    // particular, the reference SDK intentionally keeps AUTH_REQUIRED streams
    // open for out-of-band credential injection; waiting for EOF would turn a
    // useful protocol response into a five-minute timeout.
    if (shouldStop) break
  }

  if (artifactAccumulator.artifacts.length === 0 && history.length === 0 && !failure && !task) {
    return null
  }
  return {
    result: { artifacts: artifactAccumulator.artifacts, history, ...(task && { task }) },
    ...(failure && { failure }),
  }
}

function collectSendMessageResult(
  response: SendMessageResult,
  onUpdate?: (content: string) => void,
): CollectedClientResult {
  if ('messageId' in response) {
    const text = response.parts.map(textFromPart).filter(Boolean).join('')
    if (text) onUpdate?.(text)
    return { result: { artifacts: [], history: [response] } }
  }

  const statusText = response.status?.message?.parts.map(textFromPart).filter(Boolean).join('')
  if (statusText) onUpdate?.(statusText)
  const history = [...response.history]
  if (
    response.status?.message &&
    !history.some((message) => message.messageId === response.status?.message?.messageId)
  ) {
    history.push(response.status.message)
  }
  const failure = taskFailure(response.status?.state)
  return {
    result: {
      artifacts: response.artifacts,
      history,
      task: {
        taskId: response.id,
        contextId: response.contextId,
        state: response.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED,
      },
    },
    ...(failure && { failure }),
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
    forwardInternalContext?: boolean
  },
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...init?.headers }
  // These headers are private a2wave hop context. Never disclose them to a
  // generic external A2A service; only the internal platform endpoint opts in.
  if (init?.forwardInternalContext) {
    const streamingCardId = process.env.A2WAVE_STREAMING_CARD_ID
    if (streamingCardId) headers['X-Streaming-Card-Id'] = streamingCardId

    const callerAgentId = process.env.A2WAVE_CALLER_AGENT_ID
    if (callerAgentId) headers[A2WAVE_CALLER_AGENT_ID_HEADER] = callerAgentId

    const callerAgentName = process.env.A2WAVE_CALLER_AGENT_NAME
    if (callerAgentName) {
      headers[A2WAVE_CALLER_AGENT_NAME_B64_HEADER] = encodeCallerAgentNameHeader(callerAgentName)
    }

    const channelB64 = process.env.A2WAVE_CHANNEL_B64
    if (channelB64) headers[X_A2WAVE_CHANNEL_B64_HEADER] = channelB64
  }
  const reqInit: RequestInit = {
    method: 'POST',
    headers,
    body: JSON.stringify(rpcBody),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  }
  // Remote owner-controlled targets use per-hop URL + DNS validation and
  // connection pinning while preserving long-lived SSE bodies. Local platform
  // calls keep the ordinary loopback fetch path.
  if (init?.enforcePublicRedirects) {
    return safeRemoteRouteFetch(url, reqInit)
  }
  return fetch(url, reqInit)
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

async function invokeStandardRemoteAgent(target: RemoteRouteTarget, message: string) {
  const { client, card } = await createRemoteClient(target)
  const onUpdate = await createRemoteUpdateCallback(target.name)
  const supportsProvenance =
    client.protocolVersion === '1.0' &&
    card.capabilities?.extensions.some(
      (extension) => extension.uri === A2WAVE_CALLER_PROVENANCE_EXTENSION_URI,
    )
  const provenance = supportsProvenance ? buildOutboundA2AProvenance() : undefined
  const request = buildStandardSendRequest(message, provenance)
  const signal = AbortSignal.timeout(REMOTE_REQUEST_TIMEOUT_MS)
  const serviceParameters = provenance
    ? ServiceParameters.create(withA2AExtensions(A2WAVE_CALLER_PROVENANCE_EXTENSION_URI))
    : undefined
  const result = card.capabilities?.streaming
    ? await collectClientResult(
        client.sendMessageStream(request, { signal, serviceParameters }),
        onUpdate,
      )
    : collectSendMessageResult(
        await client.sendMessage(request, { signal, serviceParameters }),
        onUpdate,
      )
  if (!result) {
    return {
      content: [{ type: 'text' as const, text: 'No result received from remote agent' }],
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

export async function invokeAgentHandler(
  { agentId, message }: { agentId: string; message: string },
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

    if (target.connectionMode === 'agent_card' || target.protocolVersion === '1.0') {
      try {
        return await invokeStandardRemoteAgent(target, message)
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

  // 本地调用也使用 message/stream，保持 SSE 连接活跃避免超时
  const rpcBody = buildRpcBody('message/stream', message)

  const res = await sendA2ARequest(`${apiUrl}/api/internal/a2a/${agentId}`, rpcBody, {
    forwardInternalContext: true,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${body}`)
  }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/event-stream')) {
    const result = await collectSSEResult(res)
    return result
      ? extractProtocolResult(result)
      : {
          content: [{ type: 'text' as const, text: 'No result received from agent' }],
          isError: true,
        }
  }

  const result = await res.json()
  return extractProtocolResult(result)
}

export async function invokeAgentsParallelHandler(
  { invocations }: { invocations: Array<{ agentId: string; message: string }> },
  targets: RouteTarget[] | null = routeTargets,
) {
  const results = await Promise.all(
    invocations.map(async ({ agentId, message }) => {
      try {
        const result = await invokeAgentHandler({ agentId, message }, targets)
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

export async function startServer(): Promise<void> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')

  const server = new McpServer({
    name: 'a2wave-agent-router',
    version: '1.0.0',
  })

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
    'Send a message to an Agent over the A2A protocol and get its response. The Agent processes your request and returns a result; this can take a while (up to 5 minutes). Important: relay the complete returned result to the user — do not just reply "done".',
    {
      agentId: z
        .string()
        .describe('ID of the Agent to call — local form agt_xxx, remote form remote:<name>'),
      message: z
        .string()
        .describe('Natural-language message for the Agent, describing the task to complete'),
    },
    ({ agentId, message }) => invokeAgentHandler({ agentId, message }),
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
    ({ invocations }) => invokeAgentsParallelHandler({ invocations }),
  )

  const transport = new StdioServerTransport()
  await server.connect(transport)
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
