import AdmZip from 'adm-zip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const insertValues = vi.fn((_values: unknown) => asyncQuery({ run: vi.fn() }))
const selectWhere = vi.fn(() => asyncQuery({ get: () => undefined }))
const execute = vi.fn()
const txStub = {
  insert: vi.fn(() => ({ values: insertValues })),
  select: vi.fn(() => ({
    from: vi.fn(() => ({ where: selectWhere })),
  })),
  execute,
}

// `isPostgres: true` keeps `withTransaction` on the branch that calls
// `db.transaction`, so the callback still receives `txStub`. The SQLite branch
// would hand it the shared `db`, which here only carries `transaction`.
vi.mock('../../db/client.js', () => ({
  db: { transaction: (fn: (tx: unknown) => unknown) => fn(txStub) },
  isPostgres: true,
}))
vi.mock('../../db/schema.js', () => ({
  agents: {},
  kbDocuments: {},
  mcpServers: {},
  providers: {},
  scmSources: { name: 'scmSources.name', deletionRequestedAt: 'scmSources.deletionRequestedAt' },
  skills: {},
}))
vi.mock('../skill-storage.js', () => ({
  ensureDir: vi.fn(),
  getSkillStoragePath: (id: string) => `/tmp/skills/${id}`,
}))
vi.mock('../id.js', () => ({ createId: (prefix?: string) => `${prefix}_test` }))
vi.mock('../url-safety.js', () => ({ isBlockedHost: () => false }))

import { asyncQuery } from '../../test/async-query.js'
import { importAgentFromZip } from '../agent-import.js'

function buildNativeChatExportZip(
  a2aRouteTargets: unknown = null,
  extraAgentFields: Record<string, unknown> = {},
): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ version: '1.0', exportedAt: '2026-01-01' })),
  )
  zip.addFile(
    'agent.json',
    Buffer.from(
      JSON.stringify({
        name: 'Imported native chat Agent',
        description: null,
        type: 'cursor',
        icon: 'bot',
        systemPrompt: null,
        config: {},
        workspaceType: 'temp',
        maxConcurrency: 1,
        env: null,
        feishuConfig: null,
        slackConfig: {
          appId: 'A123',
          appToken: '********',
          botToken: '********',
        },
        discordConfig: {
          applicationId: 'D123',
          botToken: '********',
        },
        scheduleConfig: null,
        publishChannels: ['api', 'slack', 'discord'],
        oauthAccessMode: 'all_idaas_users',
        a2aSkills: null,
        a2aRouteTargets,
        showLocalChildOutput: null,
        showRemoteChildOutput: null,
        mcpServerRefs: [],
        skillRefs: [],
        kbDocumentRefs: [],
        providerRef: null,
        scmSourceRef: null,
        ...extraAgentFields,
      }),
    ),
  )
  return zip.toBuffer()
}

beforeEach(() => {
  insertValues.mockClear()
  selectWhere.mockClear()
  execute.mockClear()
})

describe('agent import native chat credentials', () => {
  it('resolves SCM bindings under the deletion lifecycle lock and excludes pending sources', async () => {
    const result = await importAgentFromZip(
      buildNativeChatExportZip(null, {
        workspaceType: 'scm',
        scmSourceRef: 'main-repo',
      }),
      'usr_test',
    )
    const insertedAgent = insertValues.mock.calls.at(-1)?.[0] as { scmSourceId: string | null }

    expect(execute).toHaveBeenCalledOnce()
    expect(JSON.stringify(selectWhere.mock.calls)).toContain('deletionRequestedAt')
    expect(insertedAgent.scmSourceId).toBeNull()
    expect(result.warnings).toContain(
      'SCM Source "main-repo" does not exist on the target instance; it was cleared and must be configured manually',
    )
  })

  it('disables Slack and Discord until credentials are reconfigured', async () => {
    const result = await importAgentFromZip(buildNativeChatExportZip(), 'usr_test')
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      publishChannels: string[]
      slackConfig: unknown
      discordConfig: unknown
    }

    expect(insertedAgent.publishChannels).toEqual(['api'])
    expect(insertedAgent.slackConfig).toBeNull()
    expect(insertedAgent.discordConfig).toBeNull()
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Slack.*credentials/i),
        expect.stringMatching(/Discord.*credentials/i),
      ]),
    )
  })

  it('drops masked remote A2A credentials instead of importing the placeholder', async () => {
    const result = await importAgentFromZip(
      buildNativeChatExportZip([
        {
          type: 'remote',
          name: 'Protected standard Agent',
          url: 'https://agent.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: '********',
        },
      ]),
      'usr_test',
    )
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      a2aRouteTargets: Array<Record<string, unknown>>
    }

    expect(insertedAgent.a2aRouteTargets).toEqual([
      {
        type: 'remote',
        name: 'Protected standard Agent',
        url: 'https://agent.example.com/.well-known/agent-card.json',
        connectionMode: 'agent_card',
      },
    ])
    expect(result.warnings).toContain(
      'Remote A2A route credentials are not imported; reconfigure protected routes before use',
    )
  })

  it('preserves a valid git trigger while dropping a masked A2A route credential', async () => {
    await importAgentFromZip(
      buildNativeChatExportZip(
        [
          {
            type: 'remote',
            name: 'Protected Agent',
            url: 'https://agent.example.com/a2a',
            connectionMode: 'direct',
            protocolVersion: '1.0',
            apiKey: '********',
          },
        ],
        {
          publishChannels: ['a2a', 'glab'],
          glabConfig: {
            provider: 'glab',
            repos: [{ project: 'group/repo' }],
            events: ['opened'],
            intent: 'Review {{url}}',
          },
        },
      ),
      'usr_test',
    )
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      publishChannels: string[]
      glabConfig: Record<string, unknown>
      a2aRouteTargets: Array<Record<string, unknown>>
    }

    expect(insertedAgent.publishChannels).toEqual(['a2a', 'glab'])
    expect(insertedAgent.glabConfig).toMatchObject({
      provider: 'glab',
      repos: [{ project: 'group/repo' }],
      events: ['opened'],
      intent: 'Review {{url}}',
    })
    expect(insertedAgent.a2aRouteTargets[0]).not.toHaveProperty('apiKey')
  })

  /**
   * Export masks sensitive env values to '********', so importing one verbatim
   * would hand the new Agent a literal placeholder as its credential — the run
   * fails to authenticate while the UI shows a configured-looking masked field.
   * Clear it instead, exactly as the masked A2A key is dropped above.
   */
  it('clears masked sensitive env values instead of importing the placeholder', async () => {
    const result = await importAgentFromZip(
      buildNativeChatExportZip(null, {
        env: {
          API_TOKEN: { value: '********', sensitive: true },
          LOG_LEVEL: { value: 'debug', sensitive: false },
        },
      }),
      'usr_test',
    )
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      env: Record<string, { value: string; sensitive: boolean }>
    }

    expect(insertedAgent.env).toEqual({
      API_TOKEN: { value: '', sensitive: true },
      LOG_LEVEL: { value: 'debug', sensitive: false },
    })
    expect(result.warnings).toContain(
      'Sensitive environment variable values are not imported; re-enter them before use',
    )
  })

  /**
   * Export masks on `v.sensitive || isSensitiveKey(k)`, so a key-name-detected secret
   * is exported as dots while keeping `sensitive: false`. Clearing only on the flag
   * would import that placeholder as the credential itself — and because the entry is
   * not sensitive the UI renders it in plaintext as '********', which reads as a
   * deliberate mask rather than the broken credential it is.
   */
  it('clears a key-name-detected masked value that carries sensitive:false', async () => {
    const result = await importAgentFromZip(
      buildNativeChatExportZip(null, {
        env: {
          API_KEY: { value: '********', sensitive: false },
          LOG_LEVEL: { value: 'debug', sensitive: false },
        },
      }),
      'usr_test',
    )
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      env: Record<string, { value: string; sensitive: boolean }>
    }

    // Promoted to sensitive: the export classified it as a secret by name, and dropping
    // that classification means the value the user retypes is stored unmasked and served
    // in plaintext by GET /agents/:id — a worse leak than the placeholder it replaced.
    expect(insertedAgent.env).toEqual({
      API_KEY: { value: '', sensitive: true },
      LOG_LEVEL: { value: 'debug', sensitive: false },
    })
    expect(result.warnings).toContain(
      'Sensitive environment variable values are not imported; re-enter them before use',
    )
  })

  /**
   * A non-sensitive variable whose name looks harmless may legitimately hold the
   * literal text — export never masked it, so import must not erase it.
   */
  it('keeps a literal placeholder typed into a non-secret-looking variable', async () => {
    await importAgentFromZip(
      buildNativeChatExportZip(null, {
        env: { MASK_STYLE: { value: '********', sensitive: false } },
      }),
      'usr_test',
    )
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      env: Record<string, { value: string; sensitive: boolean }>
    }

    expect(insertedAgent.env).toEqual({ MASK_STYLE: { value: '********', sensitive: false } })
  })

  /**
   * `sanitizeMcpServer` runs `maskAllStringRecord` over env and headers, replacing every
   * value unconditionally — so a masked value on import is never restorable. Writing it
   * back verbatim gives the new server '********' as its Authorization header: it renders
   * fully configured, and the only symptom is a 401 from the remote on every run.
   */
  it('clears masked MCP env and headers instead of importing the placeholders', async () => {
    const zip = new AdmZip()
    zip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify({ version: '1.0', exportedAt: '2026-01-01' })),
    )
    zip.addFile(
      'mcp-servers/remote.json',
      Buffer.from(
        JSON.stringify({
          name: 'Remote MCP',
          description: null,
          type: 'http',
          url: 'https://mcp.example.com/sse',
          headers: { Authorization: '********' },
          env: { API_TOKEN: '********' },
          isEnabled: true,
          groupConfig: null,
        }),
      ),
    )
    zip.addFile(
      'agent.json',
      Buffer.from(
        JSON.stringify({
          name: 'Agent with MCP',
          description: null,
          type: 'cursor',
          icon: 'bot',
          systemPrompt: null,
          config: {},
          workspaceType: 'temp',
          maxConcurrency: 1,
          env: null,
          feishuConfig: null,
          slackConfig: null,
          discordConfig: null,
          scheduleConfig: null,
          publishChannels: ['api'],
          oauthAccessMode: 'all_idaas_users',
          a2aSkills: null,
          a2aRouteTargets: null,
          showLocalChildOutput: null,
          showRemoteChildOutput: null,
          mcpServerRefs: ['remote.json'],
          skillRefs: [],
          kbDocumentRefs: [],
          providerRef: null,
          scmSourceRef: null,
        }),
      ),
    )

    const result = await importAgentFromZip(zip.toBuffer(), 'usr_test')
    const insertedMcp = insertValues.mock.calls[0]?.[0] as {
      headers: Record<string, string> | null
      env: Record<string, string> | null
    }

    expect(insertedMcp.headers).toEqual({ Authorization: '' })
    expect(insertedMcp.env).toEqual({ API_TOKEN: '' })
    expect(result.warnings).toContain(
      'MCP Server credentials are not imported; re-enter them before use',
    )
  })

  it('imports a plain env untouched and warns nothing about it', async () => {
    const result = await importAgentFromZip(
      buildNativeChatExportZip(null, {
        env: { LOG_LEVEL: { value: 'debug', sensitive: false } },
      }),
      'usr_test',
    )
    const insertedAgent = insertValues.mock.calls[0]?.[0] as {
      env: Record<string, { value: string; sensitive: boolean }>
    }

    expect(insertedAgent.env).toEqual({ LOG_LEVEL: { value: 'debug', sensitive: false } })
    expect(result.warnings).not.toContain(
      'Sensitive environment variable values are not imported; re-enter them before use',
    )
  })
})
