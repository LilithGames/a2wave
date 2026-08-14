import { Agent as UndiciAgent } from 'undici'
import {
  type PublicHostnameResolver,
  type ResolvedPublicAddress,
  UnsafeUrlError,
  assertSafeHttpUrl,
  createPinnedLookup,
  prepareRedirectRequest,
  resolvePublicUrl,
} from './url-safety-core.js'

export { UnsafeUrlError } from './url-safety-core.js'

type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>

export interface PinnedDispatcher {
  destroy(): Promise<void> | void
}

export interface StreamingSafeFetchOptions {
  /** Exact DNS hostnames allowed to resolve to ordinary private/CGNAT/ULA addresses. */
  trustedHosts?: ReadonlySet<string>
  /** Allow ordinary enterprise-private targets while retaining all safe-fetch controls. */
  allowPrivateTargets?: boolean
  maxRedirects?: number
  resolveHostname?: PublicHostnameResolver
  fetchImpl?: FetchLike
  dispatcherFactory?: (addresses: readonly ResolvedPublicAddress[]) => PinnedDispatcher
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export function parseTrustedHostnames(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((hostname) => hostname.trim().toLowerCase())
      .filter(Boolean),
  )
}

function defaultDispatcherFactory(addresses: readonly ResolvedPublicAddress[]): PinnedDispatcher {
  return new UndiciAgent({ connect: { lookup: createPinnedLookup(addresses) } })
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
}

function awaitWithAbortSignal<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return operation()
  if (signal.aborted) return Promise.reject(abortReason(signal))

  const pending = operation()
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function releaseResponseWithDispatcher(upstream: Response, dispatcher: PinnedDispatcher): Response {
  let released = false
  const release = () => {
    if (released) return
    released = true
    void Promise.resolve(dispatcher.destroy()).catch(() => {})
  }

  if (!upstream.body) {
    release()
    return upstream
  }

  const reader = upstream.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          release()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        controller.error(error)
        release()
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        release()
      }
    },
  })

  const response = new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  })
  // The MCP SDK consumes status/headers/body, while a few fetch consumers also
  // inspect these metadata fields. Preserve them when the runtime permits it.
  try {
    Object.defineProperties(response, {
      url: { value: upstream.url },
      redirected: { value: upstream.redirected },
    })
  } catch {
    // Read-only response metadata is optional for the transport contract.
  }
  return response
}

/**
 * Create a streaming-safe fetch for MCP and A2A transports.
 *
 * Unlike `safePublicFetch`, this never buffers the response and applies no
 * fixed body deadline, so long-lived SSE streams remain usable. Every request
 * and redirect hop is resolved, validated, and pinned before the socket opens.
 */
export function createStreamingSafeFetch(options: StreamingSafeFetchOptions = {}): FetchLike {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const trustedHosts = new Set(
    [...(options.trustedHosts ?? [])].map((hostname) => hostname.trim().toLowerCase()),
  )
  const maxRedirects = options.maxRedirects ?? 5
  const dispatcherFactory = options.dispatcherFactory ?? defaultDispatcherFactory

  return async (input, init = {}) => {
    let current = input.toString()
    let request = { ...init, redirect: 'manual' as const }
    for (let hop = 0; ; hop++) {
      const parsed = assertSafeHttpUrl(current, {
        allowPrivateAddresses: options.allowPrivateTargets,
      })
      const { addresses } = await awaitWithAbortSignal(
        () =>
          resolvePublicUrl(current, options.resolveHostname, {
            allowPrivateAddresses: options.allowPrivateTargets,
            allowPrivateDnsAnswers: trustedHosts.has(parsed.hostname.toLowerCase()),
          }),
        request.signal,
      )
      const dispatcher = dispatcherFactory(addresses)
      let response: Response
      try {
        response = await fetchImpl(current, {
          ...request,
          // Undici's dispatcher extension is supported by Node fetch but absent
          // from the DOM RequestInit declaration.
          dispatcher,
        } as RequestInit)
      } catch (error) {
        void Promise.resolve(dispatcher.destroy()).catch(() => {})
        throw error
      }

      if (!REDIRECT_STATUSES.has(response.status)) {
        return releaseResponseWithDispatcher(response, dispatcher)
      }

      const location = response.headers.get('location')
      if (!location) return releaseResponseWithDispatcher(response, dispatcher)
      try {
        await response.body?.cancel()
      } finally {
        void Promise.resolve(dispatcher.destroy()).catch(() => {})
      }
      if (hop >= maxRedirects) {
        throw new UnsafeUrlError('blocked', `Too many redirects (>${maxRedirects})`)
      }

      const next = new URL(location, current).toString()
      request = prepareRedirectRequest(
        request,
        response.status,
        new URL(current).origin !== new URL(next).origin,
      ) as typeof request
      current = next
    }
  }
}
