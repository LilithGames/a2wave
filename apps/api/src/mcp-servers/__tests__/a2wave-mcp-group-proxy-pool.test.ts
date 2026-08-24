import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Backend pooling contract for the MCP group proxy.
 *
 * `getOrCreateClient` caches the promise `connectBackend` returns, and its `.catch`
 * evicts the entry only when that promise rejects. So whether a backend whose
 * initial `listTools()` failed can ever be retried comes down to one thing: does
 * `connectBackend` propagate that failure, or swallow it and return the client
 * anyway?
 *
 * It used to swallow it. The resolved promise was then cached for the process
 * lifetime, `ensureToolsLoaded` hit that entry forever, and the backend's tools
 * stayed permanently missing — while `list_tools` reported success, because it
 * flags an error only when the *whole group* is empty. An Agent calling a group
 * with one slow backend and two healthy ones silently saw an incomplete toolset
 * and concluded the missing tools did not exist.
 *
 * The full-module suite cannot reach this path: after a pool eviction its mocked
 * transports fail to reconnect (`_transport.start is not a function`), so every
 * backend errors out before the caching decision is made. These tests therefore
 * exercise the pooling rule directly, against a faithful transcription of the
 * two functions, plus a source assertion pinning the production behaviour they
 * model.
 */

interface PoolHarness {
  listToolsCalls: number
  toolsFor(key: string): string[] | undefined
  get(key: string): Promise<unknown>
}

/** Mirrors getOrCreateClient + connectBackend's tail (a2wave-mcp-group-proxy.ts). */
function makePool(options: { propagateFetchFailure: boolean }): PoolHarness {
  const clientPool = new Map<string, Promise<unknown>>()
  const toolCache = new Map<string, string[]>()
  let listToolsCalls = 0
  let failNextFetch = true

  async function connectBackend(key: string) {
    const client = { key }
    try {
      listToolsCalls++
      if (failNextFetch) {
        failNextFetch = false
        throw new Error('backend slow on first listTools')
      }
      toolCache.set(key, ['late_tool'])
    } catch (err) {
      if (options.propagateFetchFailure) throw err
      // Previous behaviour: log and return the client regardless.
    }
    return client
  }

  return {
    get listToolsCalls() {
      return listToolsCalls
    },
    toolsFor: (key) => toolCache.get(key),
    get(key: string) {
      const existing = clientPool.get(key)
      if (existing) return existing
      const promise = connectBackend(key).catch((err) => {
        clientPool.delete(key)
        throw err
      })
      clientPool.set(key, promise)
      return promise
    },
  }
}

describe('MCP group proxy backend pooling', () => {
  it('permanently strands a backend when the initial tool fetch failure is swallowed', async () => {
    const pool = makePool({ propagateFetchFailure: false })

    await pool.get('staging:svc-c')
    await pool.get('staging:svc-c')

    // The second call was served from the pool: no retry, no tools, ever.
    expect(pool.listToolsCalls).toBe(1)
    expect(pool.toolsFor('staging:svc-c')).toBeUndefined()
  })

  it('retries the backend on the next call when the failure propagates', async () => {
    const pool = makePool({ propagateFetchFailure: true })

    await expect(pool.get('staging:svc-c')).rejects.toThrow('backend slow on first listTools')
    await pool.get('staging:svc-c')

    expect(pool.listToolsCalls).toBe(2)
    expect(pool.toolsFor('staging:svc-c')).toEqual(['late_tool'])
  })

  it('production connectBackend propagates a failed initial tool fetch', () => {
    const source = readFileSync(
      join(import.meta.dirname, '..', 'a2wave-mcp-group-proxy.ts'),
      'utf8',
    )
    const initialFetch = source.slice(
      source.indexOf('// Fetch initial tools'),
      source.indexOf('async function createTransport'),
    )

    expect(initialFetch).toContain('tools fetch failed')
    // The rethrow is what evicts the pool entry; without it the two behaviours
    // above diverge and the first test becomes the live one.
    expect(initialFetch).toContain('throw err')
  })
})
