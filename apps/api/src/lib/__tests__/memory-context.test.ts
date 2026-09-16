import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

const mockReadMemoryFile = vi.fn()
const mockGetRecallBehaviorInstruction = vi.fn()
vi.mock('../memory-storage.js', () => ({
  readMemoryFile: (...args: unknown[]) => mockReadMemoryFile(...args),
  getRecallBehaviorInstruction: (...args: unknown[]) => mockGetRecallBehaviorInstruction(...args),
}))

const mockIsConfigDisabled = vi.fn()
vi.mock('../memory-provider.js', () => ({
  isConfigDisabled: (...args: unknown[]) => mockIsConfigDisabled(...args),
}))

import {
  clearAgentTokenStoreForTest,
  RUNTIME_MEMORY_READ_ACTIONS,
  registerAgentToken,
} from '../agent-memory-token.js'
import { buildMemoryContext, buildRecallInstruction } from '../memory-context.js'

describe('buildMemoryContext', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockReadMemoryFile.mockImplementation(() => {
      throw new Error('File not found')
    })
    mockGetRecallBehaviorInstruction.mockImplementation(
      (level: string) => `## 回想策略（${level}）`,
    )
    mockIsConfigDisabled.mockImplementation((v: unknown) => v === false || v === 'false')
  })

  // ── contextMode: off ──────────────────────────────────────────────────────

  describe('contextMode: off', () => {
    it('returns null without reading any files', async () => {
      const result = await buildMemoryContext('agt_1', { memoryContextMode: 'off' })
      expect(result).toBeNull()
      expect(mockReadMemoryFile).not.toHaveBeenCalled()
    })
  })

  // ── contextMode: memory ───────────────────────────────────────────────────

  describe('contextMode: memory', () => {
    it('returns null when MEMORY.md does not exist', async () => {
      const result = await buildMemoryContext('agt_1', { memoryContextMode: 'memory' })
      expect(result).toBeNull()
    })

    it('returns MEMORY.md content with fixed-knowledge header', async () => {
      mockReadMemoryFile.mockReturnValue('- User prefers Chinese')
      const result = await buildMemoryContext('agt_1', { memoryContextMode: 'memory' })
      expect(result).toContain('长期记忆')
      expect(result).toContain('--- MEMORY.md ---')
      expect(result).toContain('User prefers Chinese')
      expect(result).toContain('a2wave-memory skill')
      expect(result).not.toContain('回想策略')
    })

    it('is the default when memoryContextMode is not set', async () => {
      mockReadMemoryFile.mockReturnValue('some memory')
      const result = await buildMemoryContext('agt_1', {})
      expect(result).toContain('some memory')
    })
  })

  // ── backward compatibility ─────────────────────────────────────────────────

  describe('backward compatibility', () => {
    it('full mode falls back to memory mode', async () => {
      mockReadMemoryFile.mockReturnValue('mem content')
      const result = await buildMemoryContext('agt_1', { memoryContextMode: 'full' })
      expect(result).toContain('mem content')
      expect(result).toContain('--- MEMORY.md ---')
    })

    it('respects legacy memoryContextInjection=false (boolean)', async () => {
      const result = await buildMemoryContext('agt_1', { memoryContextInjection: false })
      expect(result).toBeNull()
    })

    it('respects legacy memoryContextInjection="false" (string)', async () => {
      const result = await buildMemoryContext('agt_1', { memoryContextInjection: 'false' })
      expect(result).toBeNull()
    })

    it('memoryContextMode=memory takes precedence over legacy memoryContextInjection=false', async () => {
      mockReadMemoryFile.mockReturnValue('mem content')
      const result = await buildMemoryContext('agt_1', {
        memoryContextMode: 'memory',
        memoryContextInjection: false,
      })
      expect(result).toContain('mem content')
    })
  })
})

// ── buildRecallInstruction ────────────────────────────────────────────────────

describe('buildRecallInstruction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns medium instruction by default', async () => {
    const result = buildRecallInstruction({})
    expect(result).toBe('## 回想策略（medium）')
    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('medium', undefined, true, true)
  })

  it('returns weak instruction for memoryRecallLevel=weak', async () => {
    const result = buildRecallInstruction({ memoryRecallLevel: 'weak' })
    expect(result).toBe('## 回想策略（weak）')
    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('weak', undefined, true, true)
  })

  it('returns strong instruction for memoryRecallLevel=strong', async () => {
    const result = buildRecallInstruction({ memoryRecallLevel: 'strong' })
    expect(result).toBe('## 回想策略（strong）')
  })

  it('falls back to medium for unknown recallLevel', async () => {
    const result = buildRecallInstruction({ memoryRecallLevel: 'invalid' })
    expect(result).toBe('## 回想策略（medium）')
    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('medium', undefined, true, true)
  })

  it('computes scriptPath from skillsDir when provided', async () => {
    buildRecallInstruction({ skillsDir: '.cursor/skills' })
    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith(
      'medium',
      '.cursor/skills/a2wave-memory/scripts/memory-search.mjs',
      true,
      true,
    )
  })

  it('computes scriptPath for claude provider skillsDir', async () => {
    buildRecallInstruction({ skillsDir: '.claude/skills', memoryRecallLevel: 'strong' })
    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith(
      'strong',
      '.claude/skills/a2wave-memory/scripts/memory-search.mjs',
      true,
      true,
    )
  })

  it('passes memoryInjected=false when contextMode is off', async () => {
    buildRecallInstruction({ memoryContextMode: 'off' })
    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('medium', undefined, false, true)
  })

  it('passes memoryInjected=false when legacy memoryContextInjection is false', async () => {
    buildRecallInstruction({ memoryContextInjection: false })
    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('medium', undefined, false, true)
  })

  it('passes memoryInjected=true when contextMode is memory', async () => {
    buildRecallInstruction({ memoryContextMode: 'memory' })
    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('medium', undefined, true, true)
  })
})

// ── buildRecallInstruction: write authorization derived from the scoped token ──

describe('buildRecallInstruction write authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearAgentTokenStoreForTest()
  })

  it('passes writeAllowed=false when the scoped token has no explicit:write', async () => {
    const token = registerAgentToken('agt_ctx', {
      allowedActions: [...RUNTIME_MEMORY_READ_ACTIONS],
    })

    buildRecallInstruction({ agentEnv: { A2WAVE_MEMORY_TOKEN: token } })

    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('medium', undefined, true, false)
  })

  it('passes writeAllowed=true when the scoped token carries explicit:write', async () => {
    const token = registerAgentToken('agt_ctx', {
      allowedActions: [...RUNTIME_MEMORY_READ_ACTIONS, 'explicit:write'],
    })

    buildRecallInstruction({ agentEnv: { A2WAVE_MEMORY_TOKEN: token } })

    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('medium', undefined, true, true)
  })

  it('falls back to writeAllowed=true when no scoped token is present', async () => {
    buildRecallInstruction({})

    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('medium', undefined, true, true)
  })

  it('passes writeAllowed=false for an unknown or expired token', async () => {
    buildRecallInstruction({ agentEnv: { A2WAVE_MEMORY_TOKEN: 'amt_not_a_real_token' } })

    expect(mockGetRecallBehaviorInstruction).toHaveBeenCalledWith('medium', undefined, true, false)
  })
})
