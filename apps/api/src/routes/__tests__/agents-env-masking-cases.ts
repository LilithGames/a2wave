import type { Hono } from 'hono'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuery } from '../../test/async-query.js'

interface EnvMaskingTestContext {
  SAMPLE_AGENT: Record<string, unknown>
  makeAgentsApp(route: unknown): Hono
  makeSelectChain(result: unknown): unknown
  mockDb: {
    select: { mockReturnValue(value: unknown): void }
    insert: { mockReturnValue(value: unknown): void }
    update: { mockReturnValue(value: unknown): void } & Mock
  }
}

/**
 * Sensitive-env masking cases for the agents routes.
 *
 * Split out of `agents.test.ts` rather than appended to it, matching
 * `agents-secret-redaction-cases.ts`: these additions pushed that file past the
 * repository's 3000-line ceiling. The describes are self-contained (they need only
 * the shared app factory and the Drizzle mock), so they move as one group.
 */
export function registerAgentEnvMaskingTests({
  SAMPLE_AGENT,
  makeAgentsApp,
  makeSelectChain,
  mockDb,
}: EnvMaskingTestContext): void {
  describe('PATCH /agents/:id - sensitive env masking', () => {
    let app: Hono

    beforeEach(async () => {
      vi.clearAllMocks()
      const mod = await import('../agents.js')
      app = makeAgentsApp(mod.default)
    })

    const AGENT_WITH_SECRET = {
      ...SAMPLE_AGENT,
      env: { API_TOKEN: { value: 'real-secret', sensitive: true } },
    }

    function captureUpdate() {
      const setCalls: Record<string, unknown>[] = []
      mockDb.update.mockReturnValue({
        set: vi.fn((payload: Record<string, unknown>) => {
          setCalls.push(payload)
          return {
            where: vi.fn().mockReturnValue(
              asyncQuery({
                returning: vi
                  .fn()
                  .mockReturnValue(asyncQuery({ get: vi.fn().mockReturnValue(AGENT_WITH_SECRET) })),
                run: vi.fn(),
              }),
            ),
          }
        }),
      })
      return setCalls
    }

    const patchEnv = (env: Record<string, { value: string; sensitive: boolean }>) =>
      app.request('/agents/agt_original', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env }),
      })

    it('restores the stored secret when the masked value comes back under the same key', async () => {
      mockDb.select.mockReturnValue(makeSelectChain(AGENT_WITH_SECRET))
      const setCalls = captureUpdate()

      const res = await patchEnv({ API_TOKEN: { value: '********', sensitive: true } })

      expect(res.status).toBe(200)
      expect(setCalls.at(-1)?.env).toEqual({
        API_TOKEN: { value: 'real-secret', sensitive: true },
      })
    })

    /**
     * The destructive path this guard exists for. The UI shows dots, not the secret,
     * so a user fixing a typo in the key has every reason to believe the value rides
     * along. Writing the placeholder through would overwrite the real secret with
     * '********' — unrecoverable, and invisible because the field still renders as dots.
     */
    it('rejects a renamed key carrying the masked placeholder, without writing', async () => {
      mockDb.select.mockReturnValue(makeSelectChain(AGENT_WITH_SECRET))
      captureUpdate()

      const res = await patchEnv({ API_TOKNE: { value: '********', sensitive: true } })

      expect(res.status).toBe(400)
      expect((await res.json()) as { code: string }).toMatchObject({
        code: 'MASKED_SECRET_WITHOUT_STORED_VALUE',
      })
      expect(mockDb.update).not.toHaveBeenCalled()
    })

    it('stores a rotated value typed over the mask', async () => {
      mockDb.select.mockReturnValue(makeSelectChain(AGENT_WITH_SECRET))
      const setCalls = captureUpdate()

      const res = await patchEnv({ API_TOKEN: { value: 'rotated', sensitive: true } })

      expect(res.status).toBe(200)
      expect(setCalls.at(-1)?.env).toEqual({ API_TOKEN: { value: 'rotated', sensitive: true } })
    })

    it('lets a renamed key through once its value is re-entered', async () => {
      mockDb.select.mockReturnValue(makeSelectChain(AGENT_WITH_SECRET))
      const setCalls = captureUpdate()

      const res = await patchEnv({ API_TOKNE: { value: 're-entered', sensitive: true } })

      expect(res.status).toBe(200)
      expect(setCalls.at(-1)?.env).toEqual({ API_TOKNE: { value: 're-entered', sensitive: true } })
    })

    /**
     * The same write-through the env guard exists to prevent, three fields away in this
     * handler: each channel secret restores only when a stored value exists, so a config
     * row present but with an empty secret persists the literal placeholder. The channel
     * then fails to authenticate while the edit page renders dots and reads as configured.
     */
    it('never persists the placeholder as a channel secret when nothing is stored', async () => {
      mockDb.select.mockReturnValue(
        makeSelectChain({
          ...SAMPLE_AGENT,
          feishuConfig: { appId: 'cli_x', appSecret: '' },
          slackConfig: { appId: 'A1', appToken: '', botToken: '' },
          discordConfig: { applicationId: 'D1', botToken: '' },
        }),
      )
      const setCalls = captureUpdate()

      const res = await app.request('/agents/agt_original', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          feishuConfig: { appId: 'cli_x', appSecret: '********' },
          slackConfig: { appId: 'A1', appToken: '********', botToken: '********' },
          discordConfig: { applicationId: 'D1', botToken: '********' },
        }),
      })

      expect(res.status).toBe(200)
      const saved = setCalls.at(-1) as Record<string, Record<string, string>>
      expect(saved.feishuConfig.appSecret).not.toBe('********')
      expect(saved.slackConfig.appToken).not.toBe('********')
      expect(saved.slackConfig.botToken).not.toBe('********')
      expect(saved.discordConfig.botToken).not.toBe('********')
    })
  })

  describe('POST /agents - sensitive env masking', () => {
    let app: Hono

    beforeEach(async () => {
      vi.clearAllMocks()
      const mod = await import('../agents.js')
      app = makeAgentsApp(mod.default)
    })

    /**
     * Nothing is stored on create, so no secret can be stranded — the placeholder is
     * blanked rather than rejected. A 400 here would only block a caller round-tripping
     * an exported config, telling them to "re-enter" a value that never existed on this
     * instance, while the literal placeholder must still never reach the database.
     */
    it('blanks a masked sensitive value on create instead of storing the placeholder', async () => {
      let inserted: Record<string, unknown> = {}
      mockDb.insert.mockReturnValue({
        values: vi.fn().mockImplementation((v: Record<string, unknown>) => {
          inserted = v
          return { returning: vi.fn().mockReturnValue(asyncQuery({ get: () => SAMPLE_AGENT })) }
        }),
      })
      // The suite-wide mock drops the body; echo it back so the guard sees the env.
      const { createAgentInput } = await import('@a2wave/shared')
      ;(createAgentInput.safeParse as Mock).mockImplementationOnce((input: unknown) => ({
        success: true,
        data: input,
      }))

      const res = await app.request('/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'New Agent',
          type: 'cursor',
          env: { API_TOKEN: { value: '********', sensitive: true } },
        }),
      })

      expect(res.status).toBe(201)
      expect(inserted.env).toEqual({ API_TOKEN: { value: '', sensitive: true } })
    })
  })
}
