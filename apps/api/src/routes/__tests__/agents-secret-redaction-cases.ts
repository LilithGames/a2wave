import { describe, expect, it } from 'vitest'

interface RedactionTestApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>
}

interface RedactionTestContext {
  SAMPLE_AGENT: Record<string, unknown>
  makeAgentsApp(route: unknown): RedactionTestApp
  makeSelectChain(result: unknown): unknown
  mockDb: { select: { mockReturnValue(value: unknown): void } }
}

/**
 * Credential-redaction cases for the agents routes.
 *
 * Split out of `agents.test.ts` rather than appended to it: merging the
 * dual-backend branch with main pushed that file to 3035 lines, past the
 * repository's 3000-line ceiling. These describes are self-contained (they only
 * need the shared app factory and the Drizzle mock), so they move as one group.
 */
export function registerAgentSecretRedactionTests({
  SAMPLE_AGENT,
  makeAgentsApp,
  makeSelectChain,
  mockDb,
}: RedactionTestContext): void {
  describe('maskAgentSecrets — feishuConfig.appSecret redaction', () => {
    it('reveals feishuConfig.appSecret as plaintext on the single-agent GET /agents/:id', async () => {
      const mod = await import('../agents.js')
      const app = makeAgentsApp(mod.default)
      const agentWithSecret = {
        ...SAMPLE_AGENT,
        feishuConfig: { appId: 'cli_x', appSecret: 'SUPER_SECRET', groupTriggerOnAt: true },
      }
      mockDb.select.mockReturnValue(makeSelectChain(agentWithSecret))

      const res = await app.request('/agents/agt_original', { method: 'GET' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        data: { feishuConfig: { appSecret: string; appId: string } }
      }
      // 编辑页需要回显真实密钥（点眼睛查看），故单个详情接口返回明文。
      expect(body.data.feishuConfig.appSecret).toBe('SUPER_SECRET')
      expect(body.data.feishuConfig.appId).toBe('cli_x')
    })

    it('leaves null feishuConfig untouched', async () => {
      const mod = await import('../agents.js')
      const app = makeAgentsApp(mod.default)
      const agentNoFeishu = { ...SAMPLE_AGENT, feishuConfig: null }
      mockDb.select.mockReturnValue(makeSelectChain(agentNoFeishu))

      const res = await app.request('/agents/agt_original', { method: 'GET' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { feishuConfig: unknown } }
      expect(body.data.feishuConfig).toBeNull()
    })
  })

  describe('maskAgentSecrets — native chat token redaction', () => {
    it('masks Slack, Discord and Telegram tokens outside the editable detail response', async () => {
      const { maskAgentSecrets } = await import('../agents.js')
      const agent = {
        ...SAMPLE_AGENT,
        slackConfig: {
          appId: 'A123',
          appToken: 'xapp-secret',
          botToken: 'xoxb-secret',
        },
        discordConfig: { applicationId: 'D123', botToken: 'discord-secret' },
        telegramConfig: { botToken: 'telegram-secret' },
      }

      const typedAgent = agent as unknown as Exclude<
        Parameters<typeof maskAgentSecrets>[0],
        undefined
      >
      const masked = maskAgentSecrets(typedAgent)
      expect(masked.slackConfig?.appToken).toBe('********')
      expect(masked.slackConfig?.botToken).toBe('********')
      expect(masked.discordConfig?.botToken).toBe('********')
      expect(masked.telegramConfig?.botToken).toBe('********')

      const revealed = maskAgentSecrets(typedAgent, { revealNativeChatSecrets: true })
      expect(revealed.slackConfig?.appToken).toBe('xapp-secret')
      expect(revealed.discordConfig?.botToken).toBe('discord-secret')
      expect(revealed.telegramConfig?.botToken).toBe('telegram-secret')
    })
  })

  describe('A2A route target credential redaction', () => {
    it('masks every remote target API key while leaving public fields and local targets intact', async () => {
      const { maskAgentSecrets } = await import('../agents.js')
      const agent = {
        ...SAMPLE_AGENT,
        a2aRouteTargets: [
          { type: 'local', agentId: 'agt_local' },
          {
            type: 'remote',
            name: 'standard-service',
            url: 'https://agents.example.com/.well-known/agent-card.json',
            connectionMode: 'agent_card',
            apiKey: 'route-secret',
          },
        ],
      } as unknown as Parameters<typeof maskAgentSecrets>[0]

      const masked = maskAgentSecrets(agent)
      expect(masked?.a2aRouteTargets).toEqual([
        { type: 'local', agentId: 'agt_local' },
        {
          type: 'remote',
          name: 'standard-service',
          url: 'https://agents.example.com/.well-known/agent-card.json',
          connectionMode: 'agent_card',
          apiKey: '********',
        },
      ])
    })
  })

  describe('maskAgentSecrets — providerOauthToken redaction', () => {
    it('reveals providerOauthToken as plaintext on the single-agent GET /agents/:id', async () => {
      const mod = await import('../agents.js')
      const app = makeAgentsApp(mod.default)
      const agentWithToken = {
        ...SAMPLE_AGENT,
        providerOauthToken: 'sk-ant-oat01-real-token',
      }
      mockDb.select.mockReturnValue(makeSelectChain(agentWithToken))

      const res = await app.request('/agents/agt_original', { method: 'GET' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { providerOauthToken: string | null } }
      expect(body.data.providerOauthToken).toBe('sk-ant-oat01-real-token')
    })

    it('leaves null providerOauthToken untouched', async () => {
      const mod = await import('../agents.js')
      const app = makeAgentsApp(mod.default)
      const agentNoToken = { ...SAMPLE_AGENT, providerOauthToken: null }
      mockDb.select.mockReturnValue(makeSelectChain(agentNoToken))

      const res = await app.request('/agents/agt_original', { method: 'GET' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: { providerOauthToken: string | null } }
      expect(body.data.providerOauthToken).toBeNull()
    })
  })

  describe('maskAgentSecrets — legacy top-level provider credentials (P0-2)', () => {
    it('masks providerApiKey/providerBaseUrl unconditionally, even with reveal opts on', async () => {
      const { maskAgentSecrets } = await import('../agents.js')
      const agent = {
        ...SAMPLE_AGENT,
        providerApiKey: 'sk-live-legacy-key',
        providerBaseUrl: 'https://internal-proxy.corp/anthropic',
      } as unknown as Parameters<typeof maskAgentSecrets>[0]

      // reveal opts unlock feishu/oauth for the edit page; the legacy provider
      // columns are NOT edit-page inputs and must never be revealed.
      const masked = maskAgentSecrets(agent, {
        revealFeishuSecret: true,
        revealOauthToken: true,
      })
      expect(masked?.providerApiKey).toBe('********')
      expect(masked?.providerBaseUrl).toBe('********')
    })

    it('leaves null legacy provider fields untouched', async () => {
      const { maskAgentSecrets } = await import('../agents.js')
      const agent = {
        ...SAMPLE_AGENT,
        providerApiKey: null,
        providerBaseUrl: null,
      } as unknown as Parameters<typeof maskAgentSecrets>[0]
      const masked = maskAgentSecrets(agent)
      expect(masked?.providerApiKey).toBeNull()
      expect(masked?.providerBaseUrl).toBeNull()
    })
  })
}
