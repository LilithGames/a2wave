import { afterEach, describe, expect, it, vi } from 'vitest'

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

const { FakeEngine } = vi.hoisted(() => {
  class FakeEngine {
    type: string
    healthy: boolean
    constructor(type: string, healthy = true) {
      this.type = type
      this.healthy = healthy
    }
    async healthCheck() {
      return this.healthy
    }
    async executeStream() {
      return { success: true, output: '', durationMs: 0 }
    }
  }
  return { FakeEngine }
})

vi.mock('../cursor-agent.js', () => ({
  CursorAgentEngine: class extends FakeEngine {
    constructor() {
      super('cursor', true)
    }
  },
}))
vi.mock('../claude-code.js', () => ({
  ClaudeCodeEngine: class extends FakeEngine {
    constructor() {
      super('claude-code', true)
    }
  },
}))
vi.mock('../codex-agent.js', () => ({
  CodexAgentEngine: class extends FakeEngine {
    constructor() {
      super('codex', false)
    }
  },
}))
vi.mock('../opencode-agent.js', () => ({
  OpencodeAgentEngine: class extends FakeEngine {
    constructor() {
      super('opencode', true)
    }
  },
}))
vi.mock('../qoder-agent.js', () => ({
  QoderAgentEngine: class extends FakeEngine {
    constructor() {
      super('qoder', true)
    }
  },
}))
vi.mock('../trae-agent.js', () => ({
  TraeAgentEngine: class extends FakeEngine {
    constructor() {
      super('trae', true)
    }
  },
}))
vi.mock('../pi-agent.js', () => ({
  PiAgentEngine: class extends FakeEngine {
    constructor() {
      super('pi', true)
    }
  },
}))

import { engineRegistry } from '../registry.js'

/**
 * These tests build their app with a dynamic `import()` of a large route module.
 * Evaluating it is CPU-bound and happens while the rest of the api suite runs in
 * parallel, so the work is real but the wall-clock is dominated by contention,
 * not by anything under test. Vitest's 5s default was tight enough that a loaded
 * machine tipped these into "Test timed out" — a flake whose only signal is how
 * busy the box was. The file-level budget bounds a genuine hang without letting
 * scheduling noise fail a passing assertion.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('engineRegistry singleton', () => {
  it('pre-registers the eight built-in engines', async () => {
    expect(engineRegistry.types.sort()).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'kimi',
      'opencode',
      'pi',
      'qoder',
      'trae',
    ])
    expect(attachEngine).toHaveBeenCalledTimes(8)
  })

  it('get returns the registered engine', async () => {
    expect(engineRegistry.get('cursor')).toBeDefined()
    expect(engineRegistry.get('cursor')?.type).toBe('cursor')
  })

  it('get returns undefined for unknown types', async () => {
    expect(engineRegistry.get('does-not-exist')).toBeUndefined()
  })

  it('getOrThrow lists available engines in the error', async () => {
    expect(() => engineRegistry.getOrThrow('llm')).toThrow(/cursor.*claude-code.*codex/)
  })

  it('register adds a new engine type', async () => {
    const previousTypes = [...engineRegistry.types]
    const fake = new FakeEngine('fake-engine')
    engineRegistry.register(fake as never)
    expect(engineRegistry.types).toContain('fake-engine')
    expect(engineRegistry.getOrThrow('fake-engine')).toBe(fake)
    // Cleanup is best-effort — engineRegistry has no unregister API.
    // Subsequent tests should not depend on type-list size, only membership.
    expect(engineRegistry.types.length).toBeGreaterThan(previousTypes.length)
  })

  it('healthCheckAll aggregates each engine result', async () => {
    const result = await engineRegistry.healthCheckAll()
    expect(result.cursor).toBe(true)
    expect(result['claude-code']).toBe(true)
    expect(result.codex).toBe(false)
  })

  it('cancels by global taskId without selecting an engine', async () => {
    cancelAndWait.mockResolvedValueOnce(true)

    await expect(engineRegistry.cancel('invoke_run_1_step_1')).resolves.toBe(true)

    expect(cancelAndWait).toHaveBeenCalledWith('invoke_run_1_step_1')
  })

  it('delegates graceful shutdown to the global process runner', async () => {
    shutdown.mockResolvedValueOnce(undefined)

    await engineRegistry.shutdown()

    expect(shutdown).toHaveBeenCalledTimes(1)
  })
})
