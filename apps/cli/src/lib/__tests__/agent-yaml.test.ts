import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CliError } from '../../errors.js'
import {
  type AgentYamlDoc,
  EXAMPLE_AGENT_YAML,
  type ResolveClient,
  computeDiff,
  expandEnvVars,
  parseAgentYaml,
  resolveRefs,
  toCreatePayload,
} from '../agent-yaml.js'

describe('expandEnvVars', () => {
  it('substitutes a present variable', () => {
    expect(expandEnvVars('hi ${NAME}', { NAME: 'world' })).toBe('hi world')
  })

  it('uses default when ${VAR:-default}', () => {
    expect(expandEnvVars('${MISSING:-fallback}', {})).toBe('fallback')
  })

  it('throws on missing var without default', () => {
    expect(() => expandEnvVars('${MISSING}', {})).toThrow(CliError)
    expect(() => expandEnvVars('${MISSING}', {})).toThrow(/MISSING/)
  })

  it('handles multiple substitutions in one string', () => {
    expect(expandEnvVars('${A}-${B}', { A: '1', B: '2' })).toBe('1-2')
  })

  it('does not interpret invalid placeholder syntax', () => {
    // ${lower-case} is not matched (we require uppercase + underscore start)
    expect(expandEnvVars('${not_var}', {})).toBe('${not_var}')
  })
})

describe('parseAgentYaml', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'a2wave-yaml-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeYaml(content: string): string {
    const p = join(dir, 'agent.yaml')
    writeFileSync(p, content)
    return p
  }

  it('parses minimal valid yaml', () => {
    const p = writeYaml('name: my-bot\n')
    const doc = parseAgentYaml(p, {})
    expect(doc.name).toBe('my-bot')
  })

  it('throws when file is missing', () => {
    expect(() => parseAgentYaml(join(dir, 'nope.yaml'), {})).toThrow(/Failed to read/)
  })

  it('throws on malformed yaml', () => {
    const p = writeYaml('name: [unclosed\n')
    expect(() => parseAgentYaml(p, {})).toThrow(/Failed to parse yaml/)
  })

  it('throws when name missing', () => {
    const p = writeYaml('description: foo\n')
    expect(() => parseAgentYaml(p, {})).toThrow(/required field 'name'/)
  })

  it('throws when top-level is array', () => {
    const p = writeYaml('- a\n- b\n')
    expect(() => parseAgentYaml(p, {})).toThrow(/yaml top level must be a mapping/)
  })

  it('expands env vars deeply (in nested objects + arrays)', () => {
    const p = writeYaml(`
name: bot-\${SUFFIX}
env:
  TOKEN:
    value: \${SECRET}
    sensitive: true
publish:
  channels:
    - \${CHANNEL}
`)
    const doc = parseAgentYaml(p, { SUFFIX: 'prod', SECRET: 'sk-xxx', CHANNEL: 'feishu' })
    expect(doc.name).toBe('bot-prod')
    expect(doc.env?.TOKEN.value).toBe('sk-xxx')
    expect(doc.publish?.channels).toEqual(['feishu'])
  })

  it('propagates missing env error with var name', () => {
    const p = writeYaml('name: x\nsystemPrompt: ${NOPE}\n')
    expect(() => parseAgentYaml(p, {})).toThrow(/NOPE/)
  })

  it('parses standard Agent Card and legacy direct A2A route targets', () => {
    const p = writeYaml(`
name: router
a2aRouteTargets:
  - type: remote
    name: standard-service
    url: https://agent.example.com/.well-known/agent-card.json
    connectionMode: agent_card
  - type: remote
    name: direct-v1
    url: https://agent.example.com/a2a
    connectionMode: direct
    protocolVersion: "1.0"
  - type: remote
    name: legacy
    url: https://legacy.example.com/api/a2a/agt_legacy
`)

    expect(parseAgentYaml(p, {}).a2aRouteTargets).toEqual([
      {
        type: 'remote',
        name: 'standard-service',
        url: 'https://agent.example.com/.well-known/agent-card.json',
        connectionMode: 'agent_card',
      },
      {
        type: 'remote',
        name: 'direct-v1',
        url: 'https://agent.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
      {
        type: 'remote',
        name: 'legacy',
        url: 'https://legacy.example.com/api/a2a/agt_legacy',
      },
    ])
  })
})

describe('EXAMPLE_AGENT_YAML', () => {
  it('leads with standard Agent Card discovery and documents direct 0.3 compatibility', () => {
    expect(EXAMPLE_AGENT_YAML).toContain(
      'url: https://agent.example.com/.well-known/agent-card.json',
    )
    expect(EXAMPLE_AGENT_YAML).toContain('connectionMode: agent_card')
    expect(EXAMPLE_AGENT_YAML).toContain('connectionMode: direct')
    expect(EXAMPLE_AGENT_YAML).toContain('protocolVersion: "0.3"')
    expect(EXAMPLE_AGENT_YAML).toContain('Omitting mode/version preserves legacy direct A2A 0.3')
  })

  // The two controls ride inside the free-form `config` passthrough, so nothing
  // in the CLI names them — the example is the only place a user can learn they
  // exist, and where the per-model (not per-Agent) placement is stated.
  it('documents the per-model reasoning effort and fast mode controls', () => {
    expect(EXAMPLE_AGENT_YAML).toContain('providerChain:')
    expect(EXAMPLE_AGENT_YAML).toContain('reasoningEffort:')
    expect(EXAMPLE_AGENT_YAML).toContain('fastMode:')
  })
})

describe('provider chain effort / fast mode passthrough', () => {
  it('carries both controls into the create payload untouched', () => {
    const doc: AgentYamlDoc = {
      name: 'bot',
      config: {
        providerChain: [
          { providerId: 'prv_1', model: 'gpt-5.6-sol', reasoningEffort: 'ultra', fastMode: true },
          { providerId: 'prv_2', model: 'claude-opus-4-8', reasoningEffort: 'high' },
        ],
      },
    }

    const payload = toCreatePayload(doc, {})

    expect(payload.config).toEqual(doc.config)
  })

  it('diffs a changed effort level so apply is not a no-op', () => {
    const existing = {
      config: { providerChain: [{ providerId: 'prv_1', reasoningEffort: 'low' }] },
    }
    const proposed = {
      config: { providerChain: [{ providerId: 'prv_1', reasoningEffort: 'ultra' }] },
    }

    expect(computeDiff(existing, proposed)).toEqual(proposed)
  })

  it('treats an unchanged chain as no diff regardless of key order', () => {
    const existing = { config: { providerChain: [{ reasoningEffort: 'ultra', fastMode: true }] } }
    const proposed = { config: { providerChain: [{ fastMode: true, reasoningEffort: 'ultra' }] } }

    expect(computeDiff(existing, proposed)).toEqual({})
  })
})

describe('resolveRefs', () => {
  function makeClient(overrides: Partial<ResolveClient> = {}): ResolveClient {
    return {
      resolveProviderId: async (n) => `prv_${n}`,
      resolveSkillId: async (n) => `skl_${n}`,
      resolveSkillGroupId: async (n) => `skg_${n}`,
      resolveMcpServerId: async (n) => `mcp_${n}`,
      resolveKbDocumentId: async (n) => `kbd_${n}`,
      resolveScmSourceId: async (n) => `scm_${n}`,
      ...overrides,
    }
  }

  it('returns all undefined when refs are absent', async () => {
    const refs = await resolveRefs(makeClient(), { name: 'x' })
    expect(refs).toEqual({
      providerId: undefined,
      skills: undefined,
      skillGroupIds: undefined,
      mcpServerIds: undefined,
      kbDocumentIds: undefined,
      scmSourceId: undefined,
    })
  })

  it('resolves names to IDs in parallel', async () => {
    const doc: AgentYamlDoc = {
      name: 'x',
      provider: 'claude',
      skills: ['a', 'b'],
      skillGroups: ['feishu-tools'],
      mcpServers: ['m'],
      kbDocuments: ['Q&A'],
      workspace: { type: 'scm', source: 'repo' },
    }
    const refs = await resolveRefs(makeClient(), doc)
    expect(refs).toEqual({
      providerId: 'prv_claude',
      skills: ['skl_a', 'skl_b'],
      skillGroupIds: ['skg_feishu-tools'],
      mcpServerIds: ['mcp_m'],
      kbDocumentIds: ['kbd_Q&A'],
      scmSourceId: 'scm_repo',
    })
  })

  it('skips scmSource when workspace.type !== "scm"', async () => {
    const doc: AgentYamlDoc = {
      name: 'x',
      workspace: { type: 'temp', source: 'should-be-ignored' },
    }
    const refs = await resolveRefs(makeClient(), doc)
    expect(refs.scmSourceId).toBeUndefined()
  })

  it('resolves only skillGroups when only that ref is set', async () => {
    const refs = await resolveRefs(makeClient(), { name: 'x', skillGroups: ['g1'] })
    expect(refs.skillGroupIds).toEqual(['skg_g1'])
    expect(refs.skills).toBeUndefined()
  })

  it('resolves only kbDocuments when only that ref is set', async () => {
    const refs = await resolveRefs(makeClient(), { name: 'x', kbDocuments: ['doc-1'] })
    expect(refs.kbDocumentIds).toEqual(['kbd_doc-1'])
  })

  it('propagates errors from the resolver', async () => {
    const client = makeClient({
      resolveSkillId: async (n) => {
        throw new CliError(`Skill not found: "${n}"`)
      },
    })
    await expect(resolveRefs(client, { name: 'x', skills: ['ghost'] })).rejects.toThrow(
      /Skill not found/,
    )
  })
})

describe('toCreatePayload', () => {
  it('passes through all set fields with defaults for env.sensitive', () => {
    const doc: AgentYamlDoc = {
      name: 'x',
      description: 'd',
      type: 'cursor',
      icon: '🤖',
      systemPrompt: 'sp',
      maxConcurrency: 2,
      env: { TOKEN: { value: 'v' }, OPEN: { value: 'o', sensitive: false } },
    }
    const payload = toCreatePayload(doc, {})
    expect(payload).toMatchObject({
      name: 'x',
      description: 'd',
      type: 'cursor',
      icon: '🤖',
      systemPrompt: 'sp',
      maxConcurrency: 2,
      env: { TOKEN: { value: 'v', sensitive: false }, OPEN: { value: 'o', sensitive: false } },
    })
  })

  it('omits unset fields entirely (no `undefined` keys)', () => {
    const payload = toCreatePayload({ name: 'x' }, {})
    expect(payload).toEqual({ name: 'x' })
  })

  it('writes resolved refs into the payload', () => {
    const payload = toCreatePayload(
      { name: 'x', workspace: { type: 'scm' } },
      {
        providerId: 'prv_a',
        skills: ['skl_b'],
        mcpServerIds: ['mcp_c'],
        scmSourceId: 'scm_d',
      },
    )
    expect(payload).toMatchObject({
      providerId: 'prv_a',
      skills: ['skl_b'],
      mcpServerIds: ['mcp_c'],
      workspaceType: 'scm',
      scmSourceId: 'scm_d',
    })
  })

  it('preserves env.sensitive when explicitly set', () => {
    const payload = toCreatePayload({ name: 'x', env: { S: { value: 'v', sensitive: true } } }, {})
    expect((payload.env as Record<string, { sensitive: boolean }>).S.sensitive).toBe(true)
  })

  it('passes through artifactPolicy', () => {
    const payload = toCreatePayload(
      {
        name: 'x',
        artifactPolicy: { autoShare: 'on', shareAccessLevel: 'public', shareExpiryDays: 30 },
      },
      {},
    )
    expect(payload.artifactPolicy).toEqual({
      autoShare: 'on',
      shareAccessLevel: 'public',
      shareExpiryDays: 30,
    })
  })

  it('fills artifactPolicy schema defaults for a partial policy (apply idempotency)', () => {
    // A partial policy must be expanded to the full server-persisted shape, otherwise
    // computeDiff reports a spurious diff and re-PATCHes on every apply.
    const payload = toCreatePayload({ name: 'x', artifactPolicy: { autoShare: 'on' } }, {})
    expect(payload.artifactPolicy).toEqual({
      autoShare: 'on',
      shareAccessLevel: 'authenticated',
      shareExpiryDays: 7,
    })
  })

  it('passes through child-output / embedding flags', () => {
    const payload = toCreatePayload(
      {
        name: 'x',
        showLocalChildOutput: true,
        showRemoteChildOutput: false,
        embeddingApiKey: 'sk-embed',
      },
      {},
    )
    expect(payload).toMatchObject({
      showLocalChildOutput: true,
      showRemoteChildOutput: false,
      embeddingApiKey: 'sk-embed',
    })
  })

  it('normalizes a2aSkills tags to [] when omitted', () => {
    const payload = toCreatePayload(
      { name: 'x', a2aSkills: [{ id: 's1', name: 'Sum', description: 'd' }] },
      {},
    )
    expect(payload.a2aSkills).toEqual([{ id: 's1', name: 'Sum', description: 'd', tags: [] }])
  })

  it('passes through standard and direct A2A connection settings', () => {
    const payload = toCreatePayload(
      {
        name: 'router',
        a2aRouteTargets: [
          {
            type: 'remote',
            name: 'standard',
            url: 'https://agent.example.com/.well-known/agent-card.json',
            connectionMode: 'agent_card',
          },
          {
            type: 'remote',
            name: 'direct',
            url: 'https://agent.example.com/a2a',
            connectionMode: 'direct',
            protocolVersion: '1.0',
          },
        ],
      },
      {},
    )

    expect(payload.a2aRouteTargets).toEqual([
      {
        type: 'remote',
        name: 'standard',
        url: 'https://agent.example.com/.well-known/agent-card.json',
        connectionMode: 'agent_card',
      },
      {
        type: 'remote',
        name: 'direct',
        url: 'https://agent.example.com/a2a',
        connectionMode: 'direct',
        protocolVersion: '1.0',
      },
    ])
  })
})

describe('computeDiff', () => {
  it('detects changed primitive fields', () => {
    const before = { name: 'x', description: 'old', maxConcurrency: 1 }
    const after = { name: 'x', description: 'new', maxConcurrency: 1 }
    expect(computeDiff(before, after)).toEqual({ description: 'new' })
  })

  it('returns empty when no changes', () => {
    expect(computeDiff({ a: 1, b: 2 }, { a: 1, b: 2 })).toEqual({})
  })

  it('treats arrays as equal regardless of identity', () => {
    expect(computeDiff({ skills: ['a', 'b'] }, { skills: ['a', 'b'] })).toEqual({})
  })

  it('detects array order changes', () => {
    expect(computeDiff({ skills: ['a', 'b'] }, { skills: ['b', 'a'] })).toEqual({
      skills: ['b', 'a'],
    })
  })

  it('detects nested object changes', () => {
    expect(computeDiff({ env: { A: { value: '1' } } }, { env: { A: { value: '2' } } })).toEqual({
      env: { A: { value: '2' } },
    })
  })

  it('treats nested object as equal regardless of key order', () => {
    expect(
      computeDiff(
        { env: { A: { value: '1', sensitive: false } } },
        { env: { A: { sensitive: false, value: '1' } } },
      ),
    ).toEqual({})
  })

  it('treats null and undefined as equivalent', () => {
    expect(computeDiff({ description: null }, { description: undefined })).toEqual({})
  })

  it('never patches name even if it appears to differ', () => {
    expect(computeDiff({ name: 'old' }, { name: 'new', description: 'd' })).toEqual({
      description: 'd',
    })
  })

  it('detects changes from missing → set', () => {
    expect(computeDiff({}, { systemPrompt: 'sp' })).toEqual({ systemPrompt: 'sp' })
  })

  it('skips secret fields the server returns masked, keeping apply idempotent', () => {
    // GET masks embeddingApiKey/providerOauthToken as '********'; yaml carries plaintext.
    // Without the skip these would diff forever and re-PATCH on every apply.
    expect(
      computeDiff(
        { embeddingApiKey: '********', providerOauthToken: '********', description: 'same' },
        { embeddingApiKey: 'sk-real-key', providerOauthToken: 'oauth-xyz', description: 'same' },
      ),
    ).toEqual({})
  })

  it('still diffs a masked secret when a non-secret field alongside it changed', () => {
    expect(
      computeDiff(
        { embeddingApiKey: '********', description: 'old' },
        { embeddingApiKey: 'sk-real-key', description: 'new' },
      ),
    ).toEqual({ description: 'new' })
  })

  it('treats a plaintext A2A route key as unchanged when the server returns its mask', () => {
    expect(
      computeDiff(
        {
          a2aRouteTargets: [
            {
              type: 'remote',
              name: 'standard',
              url: 'https://agent.example.com/.well-known/agent-card.json',
              connectionMode: 'agent_card',
              apiKey: '********',
            },
          ],
        },
        {
          a2aRouteTargets: [
            {
              type: 'remote',
              name: 'standard',
              url: 'https://agent.example.com/.well-known/agent-card.json',
              connectionMode: 'agent_card',
              apiKey: 'real-secret',
            },
          ],
        },
      ),
    ).toEqual({})
  })

  it('uses the route mask in a diff when only non-secret route fields change', () => {
    expect(
      computeDiff(
        {
          a2aRouteTargets: [
            {
              type: 'remote',
              name: 'before',
              url: 'https://agent.example.com/a2a',
              connectionMode: 'direct',
              protocolVersion: '1.0',
              apiKey: '********',
            },
          ],
        },
        {
          a2aRouteTargets: [
            {
              type: 'remote',
              name: 'after',
              url: 'https://agent.example.com/a2a',
              connectionMode: 'direct',
              protocolVersion: '1.0',
              apiKey: 'real-secret',
            },
          ],
        },
      ),
    ).toEqual({
      a2aRouteTargets: [
        {
          type: 'remote',
          name: 'after',
          url: 'https://agent.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
          apiKey: '********',
        },
      ],
    })
  })

  it('does not carry a masked route key across an endpoint change', () => {
    expect(
      computeDiff(
        {
          a2aRouteTargets: [
            {
              type: 'remote',
              name: 'standard',
              url: 'https://old.example.com/a2a',
              connectionMode: 'direct',
              protocolVersion: '1.0',
              apiKey: '********',
            },
          ],
        },
        {
          a2aRouteTargets: [
            {
              type: 'remote',
              name: 'standard',
              url: 'https://new.example.com/a2a',
              connectionMode: 'direct',
              protocolVersion: '1.0',
              apiKey: 'new-secret',
            },
          ],
        },
      ),
    ).toEqual({
      a2aRouteTargets: [
        {
          type: 'remote',
          name: 'standard',
          url: 'https://new.example.com/a2a',
          connectionMode: 'direct',
          protocolVersion: '1.0',
          apiKey: 'new-secret',
        },
      ],
    })
  })
})
