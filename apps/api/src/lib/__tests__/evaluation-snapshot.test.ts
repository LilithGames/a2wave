import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestAgent } from '../../test/index.js'

const buildAgentConfigMock = vi.fn()

vi.mock('../agent-helpers.js', () => ({
  buildAgentConfig: (...args: unknown[]) => buildAgentConfigMock(...args),
  // The real one: these tests care that the snapshot's binding really lands on
  // the config, not that some stub was called.
  applyProviderBinding: (config: Record<string, unknown>, binding: Record<string, unknown>) => {
    config.providerId = binding.providerId
    config.providerName = binding.providerName
    config.engineType = binding.engineType
    config.model = binding.model
  },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { applyEvaluationSnapshot, buildEvaluationSnapshot, buildStoredEvaluationSnapshot } =
  await import('../evaluation-snapshot.js')

type AgentRow = ReturnType<typeof createTestAgent>

function snapshotOf(agent: AgentRow, config: Record<string, unknown>) {
  buildAgentConfigMock.mockReturnValue(config)
  return buildEvaluationSnapshot(agent as never)
}

describe('buildEvaluationSnapshot', () => {
  beforeEach(() => {
    buildAgentConfigMock.mockReset()
  })

  it('captures provider, model and system prompt', async () => {
    const agent = createTestAgent({ systemPrompt: 'You are a support agent.' })
    const snapshot = await snapshotOf(agent, {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      systemPrompt: 'You are a support agent.',
    })

    expect(snapshot.providerId).toBe('prv_1')
    expect(snapshot.providerName).toBe('Claude Code')
    expect(snapshot.model).toBe('claude-opus-4-8')
    expect(snapshot.systemPrompt).toBe('You are a support agent.')
    expect(snapshot.capturedAt).toBeInstanceOf(Date)
  })

  // The security-critical test: buildAgentConfig returns plaintext credentials
  // both at the top level and inside providerChain entries. None may survive.
  it('never persists provider credentials from the top level', async () => {
    const snapshot = await snapshotOf(createTestAgent(), {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'm',
      systemPrompt: '',
      providerApiKey: 'sk-super-secret',
      providerOauthToken: 'oauth-super-secret',
      providerBaseUrl: 'https://internal.example.com',
    })

    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('sk-super-secret')
    expect(serialized).not.toContain('oauth-super-secret')
    expect(serialized).not.toContain('internal.example.com')
    expect(snapshot).not.toHaveProperty('providerApiKey')
    expect(snapshot).not.toHaveProperty('providerOauthToken')
    expect(snapshot).not.toHaveProperty('providerBaseUrl')
  })

  it('never persists credentials nested inside providerChain', async () => {
    const snapshot = await snapshotOf(createTestAgent(), {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'm',
      systemPrompt: '',
      providerChain: [
        {
          providerId: 'prv_1',
          providerName: 'Claude Code',
          model: 'm',
          providerApiKey: 'sk-chain-secret',
          providerOauthToken: 'oauth-chain-secret',
          providerBaseUrl: 'https://chain.example.com',
        },
      ],
    })

    const serialized = JSON.stringify(snapshot)
    expect(serialized).not.toContain('sk-chain-secret')
    expect(serialized).not.toContain('oauth-chain-secret')
    expect(serialized).not.toContain('chain.example.com')
    expect(snapshot).not.toHaveProperty('providerChain')
  })

  it('exposes exactly the allowlisted keys and nothing else', async () => {
    const snapshot = await snapshotOf(createTestAgent(), {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'm',
      systemPrompt: 'prompt',
      agentEnv: { SECRET_TOKEN: 'leak-me' },
      resolvedSkills: [{ name: 'skill', content: 'x' }],
      resolvedMcpServers: [{ name: 'mcp' }],
    })

    expect(Object.keys(snapshot).sort()).toEqual([
      'capturedAt',
      'fastMode',
      'model',
      'providerId',
      'providerName',
      'reasoningEffort',
      'systemPrompt',
    ])
    expect(JSON.stringify(snapshot)).not.toContain('leak-me')
  })

  it('falls back to the agent row system prompt when config omits it', async () => {
    const agent = createTestAgent({ systemPrompt: 'row-level prompt' })
    const snapshot = await snapshotOf(agent, { providerId: 'prv_1', model: 'm' })
    expect(snapshot.systemPrompt).toBe('row-level prompt')
  })

  it('normalizes a missing provider/model to null rather than undefined', async () => {
    const agent = createTestAgent({ systemPrompt: null })
    const snapshot = await snapshotOf(agent, {})

    expect(snapshot.providerId).toBeNull()
    expect(snapshot.providerName).toBeNull()
    expect(snapshot.model).toBeNull()
    expect(snapshot.systemPrompt).toBe('')
  })
})

describe('buildStoredEvaluationSnapshot', () => {
  beforeEach(() => {
    buildAgentConfigMock.mockReset()
  })

  it('carries the same allowlisted fields as the in-memory snapshot', async () => {
    buildAgentConfigMock.mockReturnValue({
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      systemPrompt: 'You are a support agent.',
      providerApiKey: 'sk-super-secret',
    })

    const stored = await buildStoredEvaluationSnapshot(createTestAgent() as never)

    expect(stored.providerId).toBe('prv_1')
    expect(stored.providerName).toBe('Claude Code')
    expect(stored.model).toBe('claude-opus-4-8')
    expect(stored.systemPrompt).toBe('You are a support agent.')
    expect(JSON.stringify(stored)).not.toContain('sk-super-secret')
    expect(Object.keys(stored).sort()).toEqual([
      'capturedAt',
      'fastMode',
      'model',
      'providerId',
      'providerName',
      'reasoningEffort',
      'systemPrompt',
    ])
  })

  /**
   * The `config_snapshot` column is JSON, so a `Date` would be written as an ISO
   * string and read back as one. Modelling that explicitly is what lets the
   * insert type-check without the `as never` cast that used to hide the missing
   * `await` behind it.
   */
  it('serialises capturedAt as an ISO string for the JSON column', async () => {
    buildAgentConfigMock.mockReturnValue({ providerId: 'prv_1', model: 'm', systemPrompt: '' })

    const stored = await buildStoredEvaluationSnapshot(createTestAgent() as never)

    expect(typeof stored.capturedAt).toBe('string')
    expect(new Date(stored.capturedAt).toISOString()).toBe(stored.capturedAt)
  })
})

describe('applyEvaluationSnapshot', () => {
  const agent = createTestAgent() as never
  const SNAPSHOT = {
    providerId: 'prv_old',
    model: 'old-model',
    systemPrompt: 'frozen prompt',
  }

  it('pins the provider chain, not just the top-level binding', () => {
    const config = applyEvaluationSnapshot(
      {
        providerId: 'prv_new',
        model: 'new-model',
        systemPrompt: 'live prompt',
        providerChain: [
          { providerId: 'prv_new', engineType: 'claude-code', model: 'new-model' },
          { providerId: 'prv_old', engineType: 'codex', model: 'old-model' },
        ],
      } as never,
      SNAPSHOT,
      agent,
    )

    // executeWithRetry re-reads providerChain and reapplies its first entry, so
    // leaving the live chain in place would silently undo the snapshot.
    expect(config.providerId).toBe('prv_old')
    expect(config.model).toBe('old-model')
    expect(config.providerChain).toHaveLength(1)
    expect((config.providerChain as { providerId: string }[])[0].providerId).toBe('prv_old')
  })

  it('fails rather than silently running on a substitute provider', () => {
    const run = () =>
      applyEvaluationSnapshot(
        {
          providerId: 'prv_new',
          model: 'new-model',
          systemPrompt: 'live prompt',
          providerChain: [{ providerId: 'prv_new', engineType: 'claude-code', model: 'new-model' }],
        } as never,
        SNAPSHOT,
        agent,
      )

    // The task row permanently records the snapshot's provider and the detail
    // page presents results as having come from it, so running on a different
    // provider would attribute one provider's answers to another.
    expect(run).toThrow(/prv_old/)
  })

  it('restores the snapshot model when the provider has not changed', () => {
    const config = applyEvaluationSnapshot(
      { providerId: 'prv_old', model: 'drifted-model', systemPrompt: 'live' } as never,
      SNAPSHOT,
      agent,
    )

    expect(config.model).toBe('old-model')
  })
})

describe('reasoning controls in the snapshot', () => {
  beforeEach(() => {
    buildAgentConfigMock.mockReset()
  })

  it('captures the effort and fast mode the run will actually use', async () => {
    const snapshot = await snapshotOf(createTestAgent(), {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      systemPrompt: '',
      reasoningEffort: 'xhigh',
      fastMode: true,
    })

    expect(snapshot.reasoningEffort).toBe('xhigh')
    expect(snapshot.fastMode).toBe(true)
  })

  it('records "not configured" rather than inventing a level', async () => {
    const snapshot = await snapshotOf(createTestAgent(), {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      systemPrompt: '',
    })

    expect(snapshot.reasoningEffort).toBeNull()
    expect(snapshot.fastMode).toBeNull()
  })

  it('restores the captured effort over an Agent edited after the task was created', async () => {
    // Effort changes what a run costs and how it answers. Replaying a set at a
    // different level and filing the results under the same task would publish a
    // comparison whose variables silently moved.
    const agent = createTestAgent()
    const live = {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      reasoningEffort: 'low',
      providerChain: [
        {
          providerId: 'prv_1',
          providerName: 'Claude Code',
          engineType: 'claude-code',
          model: 'claude-opus-4-8',
          reasoningEffort: 'low',
        },
      ],
    }

    const config = applyEvaluationSnapshot(
      live as never,
      {
        providerId: 'prv_1',
        model: 'claude-opus-4-8',
        systemPrompt: '',
        reasoningEffort: 'xhigh',
        fastMode: true,
      } as never,
      agent as never,
    )

    expect(config.reasoningEffort).toBe('xhigh')
    expect(config.fastMode).toBe(true)
    // executeWithRetry re-reads providerChain and reapplies its first entry, so
    // pinning only the top level would be undone before the first turn runs.
    const chain = config.providerChain as Array<Record<string, unknown>>
    expect(chain[0]?.reasoningEffort).toBe('xhigh')
    expect(chain[0]?.fastMode).toBe(true)
  })

  it('leaves a task created before these fields existed on the live configuration', async () => {
    const agent = createTestAgent()
    const live = {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      reasoningEffort: 'high',
      providerChain: [
        {
          providerId: 'prv_1',
          providerName: 'Claude Code',
          engineType: 'claude-code',
          model: 'claude-opus-4-8',
          reasoningEffort: 'high',
        },
      ],
    }

    const config = applyEvaluationSnapshot(
      live as never,
      { providerId: 'prv_1', model: 'claude-opus-4-8', systemPrompt: '' } as never,
      agent as never,
    )

    expect(config.reasoningEffort).toBe('high')
  })

  /**
   * `null` is a real answer — "captured while the control was unset" — and it
   * must NOT be read as the pre-change "no opinion". Key presence is what tells
   * them apart, because a task queued with fast mode off that then inherits a
   * later toggle is exactly the drift the snapshot exists to prevent.
   */
  it('keeps a control that was frozen as unset, even if the Agent turned it on since', async () => {
    const agent = createTestAgent()
    const live = {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      reasoningEffort: 'ultra',
      fastMode: true,
      providerChain: [
        {
          providerId: 'prv_1',
          providerName: 'Claude Code',
          engineType: 'claude-code',
          model: 'claude-opus-4-8',
          reasoningEffort: 'ultra',
          fastMode: true,
        },
      ],
    }

    const config = applyEvaluationSnapshot(
      live as never,
      {
        providerId: 'prv_1',
        model: 'claude-opus-4-8',
        systemPrompt: '',
        reasoningEffort: null,
        fastMode: null,
      } as never,
      agent as never,
    )

    expect(config.reasoningEffort).toBeUndefined()
    expect(config.fastMode).toBeUndefined()
    const chain = config.providerChain as Array<Record<string, unknown>>
    expect(chain[0]?.reasoningEffort).toBeUndefined()
    expect(chain[0]?.fastMode).toBeUndefined()
  })

  it('still inherits when the row predates the fields entirely', async () => {
    const agent = createTestAgent()
    const live = {
      providerId: 'prv_1',
      providerName: 'Claude Code',
      model: 'claude-opus-4-8',
      fastMode: true,
      providerChain: [
        {
          providerId: 'prv_1',
          providerName: 'Claude Code',
          engineType: 'claude-code',
          model: 'claude-opus-4-8',
          fastMode: true,
        },
      ],
    }

    // No `fastMode` key at all — the shape written before this feature landed.
    const config = applyEvaluationSnapshot(
      live as never,
      { providerId: 'prv_1', model: 'claude-opus-4-8', systemPrompt: '' } as never,
      agent as never,
    )

    expect(config.fastMode).toBe(true)
  })
})
