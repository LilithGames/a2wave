import { describe, expect, it } from 'vitest'
import {
  isRetiredOauthAccessMode,
  isSensitiveKey,
  sanitizeAgent,
  sanitizeMcpServer,
} from '../agent-export.js'

describe('isRetiredOauthAccessMode', () => {
  it('is true for an explicit feishu_scope', () => {
    expect(isRetiredOauthAccessMode('feishu_scope')).toBe(true)
  })

  /**
   * The case that made the import path inconsistent with the migration: a bundle exported
   * before migration 0071 added the column carries no mode at all, yet its source Agent ran on
   * that column's DEFAULT — `feishu_scope`, i.e. restricted. Reading absence as the new open
   * default would republish it open to every OIDC-authenticated user.
   */
  it('is true for a missing mode (pre-0071 bundle ran on the feishu_scope default)', () => {
    expect(isRetiredOauthAccessMode(undefined)).toBe(true)
  })

  it('is false for the current modes', () => {
    expect(isRetiredOauthAccessMode('all_idaas_users')).toBe(false)
    expect(isRetiredOauthAccessMode('specified_users')).toBe(false)
  })
})

describe('isSensitiveKey', () => {
  it('detects token-related keys', async () => {
    expect(isSensitiveKey('TOKEN')).toBe(true)
    expect(isSensitiveKey('api_token')).toBe(true)
    expect(isSensitiveKey('ACCESS_TOKEN')).toBe(true)
  })

  it('detects secret-related keys', async () => {
    expect(isSensitiveKey('APP_SECRET')).toBe(true)
    expect(isSensitiveKey('clientSecret')).toBe(true)
  })

  it('detects key-related keys', async () => {
    expect(isSensitiveKey('API_KEY')).toBe(true)
    expect(isSensitiveKey('apiKey')).toBe(true)
    expect(isSensitiveKey('OPENAI_API_KEY')).toBe(true)
  })

  it('detects password-related keys', async () => {
    expect(isSensitiveKey('PASSWORD')).toBe(true)
    expect(isSensitiveKey('P4PASSWD')).toBe(true)
    expect(isSensitiveKey('db_password')).toBe(true)
  })

  it('detects auth-related keys', async () => {
    expect(isSensitiveKey('Authorization')).toBe(true)
    expect(isSensitiveKey('AUTH_HEADER')).toBe(true)
  })

  it('detects credential-related keys', async () => {
    expect(isSensitiveKey('CREDENTIAL')).toBe(true)
    expect(isSensitiveKey('credentials')).toBe(true)
  })

  it('does NOT false-positive on words containing "key"', async () => {
    expect(isSensitiveKey('MONKEY_COUNT')).toBe(false)
    expect(isSensitiveKey('HOTKEY_ENABLED')).toBe(false)
    expect(isSensitiveKey('TURKEY_MODE')).toBe(false)
    expect(isSensitiveKey('keyboard')).toBe(false)
  })

  it('returns false for safe keys', async () => {
    expect(isSensitiveKey('NODE_ENV')).toBe(false)
    expect(isSensitiveKey('PORT')).toBe(false)
    expect(isSensitiveKey('HOST')).toBe(false)
    expect(isSensitiveKey('DATABASE_URL')).toBe(false)
    expect(isSensitiveKey('LOG_LEVEL')).toBe(false)
  })
})

describe('sanitizeAgent', () => {
  // sanitizeAgent only reads the fields below; cast rather than enumerate
  // every nullable agent-row column that the DB schema defines.
  const baseAgent = {
    id: 'agt_test',
    name: 'Test Agent',
    description: 'Test description',
    type: 'cursor' as const,
    config: { model: 'claude-sonnet' },
    status: 'active' as const,
    icon: '🤖',
    systemPrompt: 'You are a helper',
    skills: ['skl_1'],
    mcpServerIds: ['mcp_1'],
    kbDocumentIds: [],
    publishStatus: 'draft' as const,
    providerApiKey: 'sk-secret-key-123',
    providerBaseUrl: 'https://api.example.com',
    endpointApiKey: 'ak_endpoint_key',
    publishAuthType: 'api_key' as const,
    publishIpWhitelist: [],
    publishDescription: null,
    publishChannels: ['api'] as string[],
    oauthAccessMode: 'all_idaas_users' as const,
    a2aSkills: null,
    a2aRouteTargets: [
      {
        type: 'remote' as const,
        name: 'Target',
        url: 'https://example.com',
        apiKey: 'secret-api-key',
      },
    ],
    showLocalChildOutput: null,
    showRemoteChildOutput: null,
    feishuConfig: {
      appId: 'cli_123',
      appSecret: 'my-secret-456',
      groupTriggerOnAt: true,
      groupTriggerOnNewMessage: false,
      groupReplyMode: 'quote' as const,
      topicTriggerOnAt: true,
      topicTriggerOnNewTopic: false,
      topicTriggerOnNewComment: false,
      topicReplyMode: 'topic_reply' as const,
      replyContentType: 'text' as const,
      sendArtifactsAsFile: true,
    },
    slackConfig: {
      appId: 'A123',
      appToken: 'xapp-secret',
      botToken: 'xoxb-secret',
      groupTriggerOnAt: true,
      groupTriggerOnNewMessage: false,
      groupReplyMode: 'thread' as const,
      p2pReplyMode: 'new' as const,
    },
    discordConfig: {
      applicationId: 'D123',
      botToken: 'discord-secret',
      guildTriggerOnMention: true,
      guildTriggerOnNewMessage: false,
      guildReplyMode: 'reply' as const,
      dmReplyMode: 'reply' as const,
    },
    scheduleConfig: null,
    glabConfig: {
      provider: 'glab' as const,
      repos: [{ project: 'group/repo' }],
      events: ['opened' as const],
      intent: 'Review {{url}}',
    },
    ghConfig: null,
    publishedAt: new Date(),
    providerId: 'prv_1',
    env: {
      SAFE_VAR: { value: 'hello', sensitive: false },
      SECRET_VAR: { value: 'super-secret', sensitive: true },
      API_KEY: { value: 'sk-leaked', sensitive: false },
    },
    workspaceType: 'temp' as const,
    scmSourceId: null,
    maxConcurrency: 1,
    userId: 'usr_1',
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it('masks env entries with sensitive flag', async () => {
    const result = sanitizeAgent(baseAgent as unknown as Parameters<typeof sanitizeAgent>[0])
    expect(result.env!.SAFE_VAR.value).toBe('hello')
    expect(result.env!.SECRET_VAR.value).toBe('********')
  })

  it('masks env entries with sensitive key name even if sensitive=false', async () => {
    const result = sanitizeAgent(baseAgent as unknown as Parameters<typeof sanitizeAgent>[0])
    expect(result.env!.API_KEY.value).toBe('********')
  })

  it('masks feishu appSecret', async () => {
    const result = sanitizeAgent(baseAgent as unknown as Parameters<typeof sanitizeAgent>[0])
    expect(result.feishuConfig!.appSecret).toBe('********')
    expect(result.feishuConfig!.appId).toBe('cli_123')
  })

  it('masks Slack and Discord tokens', async () => {
    const result = sanitizeAgent(baseAgent as unknown as Parameters<typeof sanitizeAgent>[0])
    expect(result.slackConfig?.appToken).toBe('********')
    expect(result.slackConfig?.botToken).toBe('********')
    expect(result.slackConfig?.appId).toBe('A123')
    expect(result.discordConfig?.botToken).toBe('********')
    expect(result.discordConfig?.applicationId).toBe('D123')
  })

  it('masks a2aRouteTargets apiKey', async () => {
    const result = sanitizeAgent(baseAgent as unknown as Parameters<typeof sanitizeAgent>[0])
    const target = result.a2aRouteTargets![0] as Record<string, unknown>
    expect(target.apiKey).toBe('********')
    expect(target.name).toBe('Target')
  })

  it('preserves credential-free git trigger config while masking A2A route keys', () => {
    const result = sanitizeAgent(baseAgent as unknown as Parameters<typeof sanitizeAgent>[0])
    expect(result.glabConfig).toMatchObject({
      provider: 'glab',
      repos: [{ project: 'group/repo' }],
    })
    expect(result.a2aRouteTargets?.[0]).toMatchObject({ apiKey: '********' })
  })

  it('excludes runtime fields', () => {
    const result = sanitizeAgent(baseAgent as unknown as Parameters<typeof sanitizeAgent>[0])
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('userId')
    expect(result).not.toHaveProperty('publishedAt')
    expect(result).not.toHaveProperty('endpointApiKey')
    expect(result).not.toHaveProperty('providerApiKey')
  })

  it('preserves non-sensitive fields', async () => {
    const result = sanitizeAgent(baseAgent as unknown as Parameters<typeof sanitizeAgent>[0])
    expect(result.name).toBe('Test Agent')
    expect(result.description).toBe('Test description')
    expect(result.systemPrompt).toBe('You are a helper')
    expect(result.type).toBe('cursor')
    expect(result.icon).toBe('🤖')
    expect(result.maxConcurrency).toBe(1)
  })

  it('preserves OAuth access mode for export/import round-trip', async () => {
    const result = sanitizeAgent({
      ...baseAgent,
      oauthAccessMode: 'all_idaas_users' as const,
    } as unknown as Parameters<typeof sanitizeAgent>[0])

    expect(result.oauthAccessMode).toBe('all_idaas_users')
  })
})

describe('sanitizeMcpServer', () => {
  const baseMcp = {
    id: 'mcp_test',
    name: 'Test MCP',
    description: 'A test server',
    type: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@test/mcp'],
    cwd: null,
    url: null,
    headers: {
      Authorization: 'Bearer secret-token',
      'X-Custom': 'safe-value',
    },
    env: {
      API_KEY: 'sk-12345',
      NODE_ENV: 'production',
      GITHUB_TOKEN: 'ghp_abc123',
    },
    isEnabled: true,
    groupConfig: null,
    usageScope: 'admin-only' as const,
    userId: 'usr_1',
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it('masks env entries with sensitive key names', async () => {
    const result = sanitizeMcpServer(baseMcp)
    expect(result.env!.API_KEY).toBe('********')
    expect(result.env!.GITHUB_TOKEN).toBe('********')
    expect(result.env!.NODE_ENV).toBe('********')
  })

  it('masks headers with sensitive key names', async () => {
    const result = sanitizeMcpServer(baseMcp)
    expect(result.headers!.Authorization).toBe('********')
    expect(result.headers!['X-Custom']).toBe('********')
  })

  it('masks every env/header value and strips secret-bearing URL parts', async () => {
    const result = sanitizeMcpServer({
      ...baseMcp,
      type: 'http',
      url: 'https://alice:password@mcp.example.com/private/sse?api_key=query-secret#fragment',
      env: { CUSTOM_VALUE: 'credential-under-an-innocent-key' },
      headers: { 'X-Custom': 'bearer-under-an-innocent-key' },
    })

    expect(result.url).toBe('https://mcp.example.com/********')
    expect(result.env).toEqual({ CUSTOM_VALUE: '********' })
    expect(result.headers).toEqual({ 'X-Custom': '********' })
    expect(JSON.stringify(result)).not.toContain('query-secret')
    expect(JSON.stringify(result)).not.toContain('credential-under-an-innocent-key')
    expect(JSON.stringify(result)).not.toContain('bearer-under-an-innocent-key')
  })

  it('excludes runtime fields', async () => {
    const result = sanitizeMcpServer(baseMcp)
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('userId')
    // Access scope is instance-specific and re-derived on import via the create
    // gate, so it must not be carried in the exported config.
    expect(result).not.toHaveProperty('usageScope')
  })

  it('preserves non-sensitive fields', async () => {
    const result = sanitizeMcpServer(baseMcp)
    expect(result.name).toBe('Test MCP')
    expect(result.command).toBe('npx')
    expect(result.args).toEqual(['-y', '@test/mcp'])
  })

  it('returns null groupConfig for non-group types', async () => {
    const result = sanitizeMcpServer(baseMcp)
    expect(result.groupConfig).toBeNull()
  })

  describe('group type', () => {
    const groupMcp = {
      ...baseMcp,
      id: 'mcp_group1',
      name: 'Group MCP',
      type: 'group' as const,
      command: null,
      args: [] as string[],
      env: null,
      headers: null,
      groupConfig: {
        backends: {
          default: [
            {
              mode: 'inline',
              name: 'svc-a',
              type: 'stdio',
              command: 'npx',
              args: ['-y', 'server-a'],
              env: { API_KEY: 'sk-secret', NODE_ENV: 'production' },
              headers: { Authorization: 'Bearer token', 'X-Safe': 'ok' },
            },
            {
              mode: 'ref',
              mcpServerId: 'mcp_ref1',
            },
          ],
          analytics: [
            {
              mode: 'inline',
              name: 'svc-b',
              type: 'sse',
              url: 'https://example.com/sse',
              env: null,
              headers: null,
            },
          ],
        },
      },
    }

    it('masks sensitive env/headers in inline backends', async () => {
      const result = sanitizeMcpServer(
        groupMcp as unknown as Parameters<typeof sanitizeMcpServer>[0],
      )
      const defaultBackends = result.groupConfig!.backends.default as Array<Record<string, unknown>>
      // Only inline backends should remain (ref dropped)
      const inlineBackend = defaultBackends.find((b) => b.name === 'svc-a') as Record<
        string,
        unknown
      >
      expect(inlineBackend).toBeDefined()
      const env = inlineBackend.env as Record<string, string>
      expect(env.API_KEY).toBe('********')
      expect(env.NODE_ENV).toBe('********')
      const headers = inlineBackend.headers as Record<string, string>
      expect(headers.Authorization).toBe('********')
      expect(headers['X-Safe']).toBe('********')
    })

    it('drops ref backends from exported groupConfig', async () => {
      const result = sanitizeMcpServer(
        groupMcp as unknown as Parameters<typeof sanitizeMcpServer>[0],
      )
      const defaultBackends = result.groupConfig!.backends.default as Array<Record<string, unknown>>
      const refBackend = defaultBackends.find((b) => b.mode === 'ref')
      expect(refBackend).toBeUndefined()
    })

    it('preserves inline backends with null env/headers', async () => {
      const result = sanitizeMcpServer(
        groupMcp as unknown as Parameters<typeof sanitizeMcpServer>[0],
      )
      const analyticsBackends = result.groupConfig!.backends.analytics as Array<
        Record<string, unknown>
      >
      expect(analyticsBackends).toHaveLength(1)
      expect(analyticsBackends[0].name).toBe('svc-b')
      expect(analyticsBackends[0].env).toBeNull()
      expect(analyticsBackends[0].headers).toBeNull()
    })

    it('strips secret-bearing URL parts and masks all inline record values', async () => {
      const result = sanitizeMcpServer({
        ...groupMcp,
        groupConfig: {
          backends: {
            default: [
              {
                mode: 'inline',
                name: 'remote-secret',
                type: 'http',
                url: 'https://user:pass@mcp.example.com/sse/opaque?tenant=secret#token',
                env: { CUSTOM_VALUE: 'hidden-env-secret' },
                headers: { 'X-Custom': 'hidden-header-secret' },
              },
            ],
          },
        },
      } as unknown as Parameters<typeof sanitizeMcpServer>[0])
      const backend = result.groupConfig!.backends.default[0] as Record<string, unknown>

      expect(backend.url).toBe('https://mcp.example.com/********')
      expect(backend.env).toEqual({ CUSTOM_VALUE: '********' })
      expect(backend.headers).toEqual({ 'X-Custom': '********' })
      expect(JSON.stringify(result)).not.toContain('hidden-env-secret')
      expect(JSON.stringify(result)).not.toContain('hidden-header-secret')
    })

    it('includes groupConfig in export output', async () => {
      const result = sanitizeMcpServer(
        groupMcp as unknown as Parameters<typeof sanitizeMcpServer>[0],
      )
      expect(result.groupConfig).not.toBeNull()
      expect(result.groupConfig!.backends).toBeDefined()
    })
  })
})
