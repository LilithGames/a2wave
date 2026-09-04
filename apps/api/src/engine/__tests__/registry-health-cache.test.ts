/**
 * `GET /api/health` is unauthenticated and mounted ahead of the rate limiter, so
 * every request used to spawn one `--version` CLI process per registered engine,
 * sequentially. These tests pin the three properties that make that safe:
 * concurrent callers share a single probe, a probe result is reused within the
 * TTL, and the probes run in parallel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { attachEngine, cancelAndWait, shutdown } = vi.hoisted(() => ({
  attachEngine: vi.fn(),
  cancelAndWait: vi.fn(),
  shutdown: vi.fn(),
}))

vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../provider-catalog.js', () => ({ providerCatalog: { attachEngine } }))
vi.mock('../cli-process-runner.js', () => ({
  cliProcessRunner: { cancelAndWait, shutdown },
}))

const { FakeEngine, probeState } = vi.hoisted(() => {
  const probeState = {
    started: 0,
    finished: 0,
    /** Set to hold every probe open, so parallelism is observable. */
    gate: null as null | Promise<void>,
    release: null as null | (() => void),
  }
  class FakeEngine {
    type: string
    constructor(type: string) {
      this.type = type
    }
    async healthCheck() {
      probeState.started += 1
      if (probeState.gate) await probeState.gate
      probeState.finished += 1
      return true
    }
    async executeStream() {
      return { success: true, output: '', durationMs: 0 }
    }
  }
  return { FakeEngine, probeState }
})

function mockEngine(type: string) {
  return class extends FakeEngine {
    constructor() {
      super(type)
    }
  }
}

vi.mock('../cursor-agent.js', () => ({ CursorAgentEngine: mockEngine('cursor') }))
vi.mock('../claude-code.js', () => ({ ClaudeCodeEngine: mockEngine('claude-code') }))
vi.mock('../codex-agent.js', () => ({ CodexAgentEngine: mockEngine('codex') }))
vi.mock('../opencode-agent.js', () => ({ OpencodeAgentEngine: mockEngine('opencode') }))
vi.mock('../qoder-agent.js', () => ({ QoderAgentEngine: mockEngine('qoder') }))
vi.mock('../trae-agent.js', () => ({ TraeAgentEngine: mockEngine('trae') }))
vi.mock('../kimi-agent.js', () => ({ KimiAgentEngine: mockEngine('kimi') }))
vi.mock('../pi-agent.js', () => ({ PiAgentEngine: mockEngine('pi') }))

import { ENGINE_HEALTH_CACHE_TTL_MS, engineRegistry } from '../registry.js'

const ENGINE_COUNT = 8

beforeEach(() => {
  probeState.started = 0
  probeState.finished = 0
  probeState.gate = null
  probeState.release = null
  // A fresh registration drops the cache, which is also how each test starts
  // from a known state without an unregister API.
  engineRegistry.register(new FakeEngine('cursor') as never)
  probeState.started = 0
})

afterEach(() => {
  probeState.release?.()
  vi.useRealTimers()
})

describe('engineRegistry.healthCheckAll caching', () => {
  it('coalesces concurrent callers into a single probe round', async () => {
    const [a, b] = await Promise.all([
      engineRegistry.healthCheckAll(),
      engineRegistry.healthCheckAll(),
    ])

    expect(probeState.started).toBe(ENGINE_COUNT)
    expect(a).toEqual(b)
    expect(a.cursor).toBe(true)
  })

  it('serves a cached result within the TTL', async () => {
    await engineRegistry.healthCheckAll()
    const startedAfterFirst = probeState.started

    await engineRegistry.healthCheckAll()

    expect(probeState.started).toBe(startedAfterFirst)
  })

  it('re-probes once the TTL has elapsed', async () => {
    const now = Date.now()
    vi.useFakeTimers()
    vi.setSystemTime(now)
    await engineRegistry.healthCheckAll()
    const startedAfterFirst = probeState.started

    vi.setSystemTime(now + ENGINE_HEALTH_CACHE_TTL_MS + 1)
    await engineRegistry.healthCheckAll()

    expect(probeState.started).toBe(startedAfterFirst + ENGINE_COUNT)
  })

  it('runs the per-engine probes in parallel', async () => {
    probeState.gate = new Promise<void>((resolve) => {
      probeState.release = resolve
    })

    const pending = engineRegistry.healthCheckAll()
    await Promise.resolve()
    await Promise.resolve()

    // Every probe is started while none has finished — a sequential loop would
    // show exactly one started.
    expect(probeState.started).toBe(ENGINE_COUNT)
    expect(probeState.finished).toBe(0)

    probeState.release?.()
    await expect(pending).resolves.toHaveProperty('cursor', true)
  })
})
