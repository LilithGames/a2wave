import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockFindAgentByName = vi.fn()
const mockResolveProviderId = vi.fn(async (n: string) => `prv_${n}`)
const mockResolveSkillId = vi.fn(async (n: string) => `skl_${n}`)
const mockResolveSkillGroupId = vi.fn(async (n: string) => `skg_${n}`)
const mockResolveMcpServerId = vi.fn(async (n: string) => `mcp_${n}`)
const mockResolveKbDocumentId = vi.fn(async (n: string) => `kbd_${n}`)
const mockResolveScmSourceId = vi.fn(async (n: string) => `scm_${n}`)

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    findAgentByName: mockFindAgentByName,
    resolveProviderId: mockResolveProviderId,
    resolveSkillId: mockResolveSkillId,
    resolveSkillGroupId: mockResolveSkillGroupId,
    resolveMcpServerId: mockResolveMcpServerId,
    resolveKbDocumentId: mockResolveKbDocumentId,
    resolveScmSourceId: mockResolveScmSourceId,
  }),
}))

const { agentsCommand } = await import('../agents.js')

type SubCmd = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }
const apply = (agentsCommand.subCommands as Record<string, SubCmd>).apply

describe('agents apply', () => {
  let dir: string
  let yamlPath: string
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // `mockReset`, not `clearAllMocks`: clear wipes recorded calls but NOT the
    // one-shot queue, so a `...Once` a test queued and never consumed fires in
    // whichever test runs next. Three tests abort before their queued value is
    // reached — `throws on unknown skill name` rejects at the resolver, and the
    // two `${ENV}` / missing-arg tests throw during parsing — each stranding a
    // `mockFindAgentByName.mockResolvedValueOnce(null)`. The next test then
    // sees "no such agent" and takes the CREATE path, so `Unchanged agt_x`
    // reads `Created agt_x`. Reset drops the queue; the resolver defaults are
    // re-applied below since reset also clears the implementation.
    for (const m of [mockGet, mockPost, mockPatch, mockFindAgentByName]) m.mockReset()
    mockResolveProviderId.mockReset().mockImplementation(async (n: string) => `prv_${n}`)
    mockResolveSkillId.mockReset().mockImplementation(async (n: string) => `skl_${n}`)
    mockResolveSkillGroupId.mockReset().mockImplementation(async (n: string) => `skg_${n}`)
    mockResolveMcpServerId.mockReset().mockImplementation(async (n: string) => `mcp_${n}`)
    mockResolveKbDocumentId.mockReset().mockImplementation(async (n: string) => `kbd_${n}`)
    mockResolveScmSourceId.mockReset().mockImplementation(async (n: string) => `scm_${n}`)
    dir = mkdtempSync(join(tmpdir(), 'a2wave-apply-test-'))
    yamlPath = join(dir, 'agent.yaml')
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  function writeYaml(yaml: string) {
    writeFileSync(yamlPath, yaml)
  }

  it('CREATE path: agent does not exist → POST /api/agents', async () => {
    writeYaml('name: my-bot\ndescription: hi\nprovider: claude-code\nskills: [lark-mail]\n')
    mockFindAgentByName.mockResolvedValueOnce(null)
    mockPost.mockResolvedValueOnce({ data: { id: 'agt_new' } })

    await apply.run({ args: { file: yamlPath } })

    expect(mockResolveProviderId).toHaveBeenCalledWith('claude-code')
    expect(mockResolveSkillId).toHaveBeenCalledWith('lark-mail')
    expect(mockPost).toHaveBeenCalledWith(
      '/api/agents',
      expect.objectContaining({
        name: 'my-bot',
        description: 'hi',
        providerId: 'prv_claude-code',
        skills: ['skl_lark-mail'],
      }),
    )
    expect(consoleSpy).toHaveBeenCalledWith('Created agt_new (my-bot)')
  })

  it('UPDATE path: agent exists with diff → PATCH only changed fields', async () => {
    writeYaml('name: my-bot\ndescription: NEW\n')
    mockFindAgentByName.mockResolvedValueOnce({ id: 'agt_existing', name: 'my-bot' })
    mockGet.mockResolvedValueOnce({
      data: { id: 'agt_existing', name: 'my-bot', description: 'OLD' },
    })

    await apply.run({ args: { file: yamlPath } })

    expect(mockPatch).toHaveBeenCalledWith('/api/agents/agt_existing', { description: 'NEW' })
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('Updated agt_existing (my-bot) — fields: description'),
    )
  })

  it('UNCHANGED path: agent exists, payload matches → no PATCH', async () => {
    writeYaml('name: my-bot\ndescription: same\n')
    mockFindAgentByName.mockResolvedValueOnce({ id: 'agt_x', name: 'my-bot' })
    mockGet.mockResolvedValueOnce({ data: { id: 'agt_x', name: 'my-bot', description: 'same' } })

    await apply.run({ args: { file: yamlPath } })

    expect(mockPatch).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith('Unchanged agt_x (my-bot)')
  })

  it('DRY-RUN create: prints plan, does not POST', async () => {
    writeYaml(`name: my-bot
a2aRouteTargets:
  - type: remote
    name: protected-agent
    url: https://agent.example.com/.well-known/agent-card.json
    connectionMode: agent_card
    apiKey: route-secret
`)
    mockFindAgentByName.mockResolvedValueOnce(null)

    await apply.run({ args: { file: yamlPath, 'dry-run': true } })

    expect(mockPost).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith('[dry-run] Would CREATE agent "my-bot"')
    const output = consoleSpy.mock.calls.flat().join('\n')
    expect(output).toContain('"apiKey": "********"')
    expect(output).not.toContain('route-secret')
  })

  it('DRY-RUN update: prints diff, does not PATCH', async () => {
    writeYaml('name: my-bot\ndescription: NEW\n')
    mockFindAgentByName.mockResolvedValueOnce({ id: 'agt_x', name: 'my-bot' })
    mockGet.mockResolvedValueOnce({ data: { id: 'agt_x', description: 'OLD' } })

    await apply.run({ args: { file: yamlPath, 'dry-run': true } })

    expect(mockPatch).not.toHaveBeenCalled()
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('[dry-run] Would UPDATE agt_x — fields: description'),
    )
  })

  it('publishes after create when yaml.publish is set', async () => {
    writeYaml(`name: my-bot
publish:
  channels: [feishu]
  authType: api_key
`)
    mockFindAgentByName.mockResolvedValueOnce(null)
    mockPost.mockResolvedValueOnce({ data: { id: 'agt_p' } }) // create
    mockPost.mockResolvedValueOnce({ data: {} }) // publish

    await apply.run({ args: { file: yamlPath } })

    expect(mockPost).toHaveBeenCalledTimes(2)
    expect(mockPost).toHaveBeenNthCalledWith(
      2,
      '/api/agents/agt_p/publish',
      expect.objectContaining({
        channels: ['feishu'],
        authType: 'api_key',
      }),
    )
  })

  it('--example prints sample YAML to stdout and exits without calling API', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await apply.run({ args: { example: true } })
      expect(writeSpy).toHaveBeenCalled()
      const printed = writeSpy.mock.calls[0]?.[0] as string
      expect(printed).toMatch(/name: my-bot/)
      expect(printed).toMatch(/feishuConfig/)
      expect(printed).toMatch(/scheduleConfig/)
      expect(printed).toMatch(/skillGroups/)
      expect(printed).toMatch(/kbDocuments/)
      expect(mockPost).not.toHaveBeenCalled()
      expect(mockFindAgentByName).not.toHaveBeenCalled()
    } finally {
      writeSpy.mockRestore()
    }
  })

  it('errors when neither -f nor --example is given', async () => {
    await expect(apply.run({ args: {} })).rejects.toThrow(/-f.*--example/)
  })

  it('passes typed feishuConfig + scheduleConfig + new refs through to /api/agents', async () => {
    writeYaml(`name: my-bot
provider: claude-code
skillGroups: [feishu-tools]
kbDocuments: [Q&A]
feishuConfig:
  appId: cli_xxx
  appSecret: secret_xxx
  groupReplyMode: quote
  replyContentType: text
scheduleConfig:
  cron: "0 9 * * 1-5"
  intent: Remind at 9 AM
  timezone: Asia/Shanghai
`)
    mockFindAgentByName.mockResolvedValueOnce(null)
    mockPost.mockResolvedValueOnce({ data: { id: 'agt_z' } })

    await apply.run({ args: { file: yamlPath } })

    const createCall = mockPost.mock.calls[0]
    expect(createCall[0]).toBe('/api/agents')
    const payload = createCall[1] as Record<string, unknown>
    expect(payload).toMatchObject({
      name: 'my-bot',
      providerId: 'prv_claude-code',
      skillGroupIds: ['skg_feishu-tools'],
      kbDocumentIds: ['kbd_Q&A'],
      feishuConfig: {
        appId: 'cli_xxx',
        appSecret: 'secret_xxx',
        groupReplyMode: 'quote',
        replyContentType: 'text',
      },
      scheduleConfig: {
        cron: '0 9 * * 1-5',
        intent: 'Remind at 9 AM',
        timezone: 'Asia/Shanghai',
      },
    })
  })

  it('passes multiple schedule configs through to /api/agents', async () => {
    writeYaml(`name: my-bot
scheduleConfig:
  - id: sch_morning
    cron: "0 9 * * 1-5"
    intent: morning report
    timezone: Asia/Shanghai
  - id: sch_evening
    cron: "0 18 * * 1-5"
    intent: evening report
    timezone: Asia/Shanghai
`)
    mockFindAgentByName.mockResolvedValueOnce(null)
    mockPost.mockResolvedValueOnce({ data: { id: 'agt_z' } })

    await apply.run({ args: { file: yamlPath } })

    const payload = mockPost.mock.calls[0][1] as Record<string, unknown>
    expect(payload.scheduleConfig).toEqual([
      {
        id: 'sch_morning',
        cron: '0 9 * * 1-5',
        intent: 'morning report',
        timezone: 'Asia/Shanghai',
      },
      {
        id: 'sch_evening',
        cron: '0 18 * * 1-5',
        intent: 'evening report',
        timezone: 'Asia/Shanghai',
      },
    ])
  })

  it('--no-publish suppresses the publish call even when yaml has it', async () => {
    writeYaml(`name: my-bot
publish:
  channels: [feishu]
`)
    mockFindAgentByName.mockResolvedValueOnce(null)
    mockPost.mockResolvedValueOnce({ data: { id: 'agt_x' } })

    // citty parses `--no-publish` into `publish: false` — it never produces an
    // arg literally named "no-publish", so passing that key tested nothing.
    await apply.run({ args: { file: yamlPath, publish: false } })

    expect(mockPost).toHaveBeenCalledTimes(1) // only create, no publish
  })

  it('throws on unknown skill name (resolver error propagates)', async () => {
    writeYaml('name: my-bot\nskills: [ghost]\n')
    mockFindAgentByName.mockResolvedValueOnce(null)
    mockResolveSkillId.mockRejectedValueOnce(new Error('Skill not found: "ghost"'))

    await expect(apply.run({ args: { file: yamlPath } })).rejects.toThrow(/Skill not found/)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it('throws when ${ENV} variable is missing', async () => {
    writeYaml('name: ${MISSING_VAR}\n')

    await expect(apply.run({ args: { file: yamlPath } })).rejects.toThrow(/MISSING_VAR/)
  })

  it('expands ${ENV} variables before calling the API', async () => {
    process.env.A2WAVE_TEST_TOKEN = 'sk-secret'
    try {
      writeYaml(`name: my-bot
env:
  TOKEN:
    value: \${A2WAVE_TEST_TOKEN}
    sensitive: true
`)
      mockFindAgentByName.mockResolvedValueOnce(null)
      mockPost.mockResolvedValueOnce({ data: { id: 'agt_e' } })

      await apply.run({ args: { file: yamlPath } })

      expect(mockPost).toHaveBeenCalledWith(
        '/api/agents',
        expect.objectContaining({
          env: { TOKEN: { value: 'sk-secret', sensitive: true } },
        }),
      )
    } finally {
      delete process.env.A2WAVE_TEST_TOKEN
    }
  })
})

describe('agents apply — destructive diff', () => {
  let dir: string
  let yamlPath: string
  const originalIsTTY = process.stdin.isTTY

  beforeEach(() => {
    for (const m of [mockGet, mockPost, mockPatch, mockFindAgentByName]) m.mockReset()
    mockResolveSkillId.mockReset().mockImplementation(async (n: string) => `skl_${n}`)
    dir = mkdtempSync(join(tmpdir(), 'a2wave-apply-destructive-'))
    yamlPath = join(dir, 'bot.yaml')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // No TTY, matching an agent: a confirmation must throw, never prompt.
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true })
    vi.restoreAllMocks()
  })

  function stageRemoval(): void {
    writeFileSync(yamlPath, 'name: my-bot\nskills: [keep]\n')
    mockFindAgentByName.mockResolvedValue({ id: 'agt_x', name: 'my-bot' })
    mockGet.mockResolvedValue({ data: { id: 'agt_x', skills: ['skl_keep', 'skl_drop'] } })
  }

  it('refuses a diff that removes a mounted resource without --yes', async () => {
    // An apply that only adds is recoverable from the YAML in hand; one that
    // unmounts is not, because the YAML no longer names what it removed.
    stageRemoval()
    const err = await apply.run({ args: { file: yamlPath } }).catch((e) => e)

    expect((err as { type?: string }).type).toBe('confirmation')
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it('proceeds with --yes', async () => {
    stageRemoval()
    await apply.run({ args: { file: yamlPath, yes: true } })
    expect(mockPatch).toHaveBeenCalled()
  })

  it('never confirms under --dry-run, which writes nothing', async () => {
    stageRemoval()
    await apply.run({ args: { file: yamlPath, 'dry-run': true } })
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it('does not confirm a purely additive diff', async () => {
    writeFileSync(yamlPath, 'name: my-bot\nskills: [keep, extra]\n')
    mockFindAgentByName.mockResolvedValue({ id: 'agt_x', name: 'my-bot' })
    mockGet.mockResolvedValue({ data: { id: 'agt_x', skills: ['skl_keep'] } })

    await apply.run({ args: { file: yamlPath } })
    expect(mockPatch).toHaveBeenCalled()
  })
})
