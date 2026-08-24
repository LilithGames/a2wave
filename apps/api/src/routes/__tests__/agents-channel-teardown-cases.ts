import { describe, expect, it } from 'vitest'

interface TeardownTestApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>
}

interface ChannelTeardownTestContext {
  /** A getter, not the value: the suite rebuilds `app` in its own `beforeEach`, so capturing
   *  it at registration time would pin every case to a stale, pre-`clearAllMocks` instance. */
  getApp(): TeardownTestApp
  SAMPLE_AGENT: Record<string, unknown>
  mockDb: {
    select: { mockReturnValue(v: unknown): void }
    update: { mockReturnValue(v: unknown): void; mockImplementation(fn: unknown): void }
    delete: { mockReturnValue(v: unknown): void } & unknown
  }
  makeSelectChain(result: unknown): unknown
  makeUpdateChain(): unknown
  makeUpdateReturningChain(returnValue?: unknown): unknown
  makeDeleteChain(): unknown
}

/**
 * Publish/delete teardown cases, registered beside the route suite so `agents.test.ts` stays
 * under the repository's file-length limit — the split its allowlist entry asks for. Same pattern
 * as `agents-oauth-publish-cases.ts`: the context is passed in rather than re-mocked here, since
 * these cases exercise the real routes and duplicating the mock scaffolding would let the two
 * drift apart.
 */
export function registerChannelTeardownTests(ctx: ChannelTeardownTestContext): void {
  const { SAMPLE_AGENT, mockDb, makeSelectChain } = ctx
  const app = {
    request: (path: string, init?: RequestInit) => ctx.getApp().request(path, init),
  }

  // Stopping a channel tears its connection down synchronously, so the restart that follows
  // cannot reuse it and Telegram long-polling resumes from offset 0 — replaying buffered
  // updates as fresh messages. Republishing a telegram-only Agent must therefore never route
  // through another channel's stop branch.
  it('keeps the Telegram connection alive when republishing without Discord', async () => {
    const { telegramConnectionManager } = await import('../../lib/telegram-service.js')
    const draftAgent = {
      ...SAMPLE_AGENT,
      publishStatus: 'draft' as const,
      endpointApiKey: null,
      telegramConfig: { botToken: 'tg-token' },
    }

    mockDb.select.mockReturnValue(makeSelectChain(draftAgent))
    mockDb.update.mockReturnValue(
      ctx.makeUpdateReturningChain({ ...draftAgent, publishStatus: 'published' }),
    )

    const res = await app.request('/agents/agt_original/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authType: 'api_key',
        channels: ['telegram'],
        telegramConfig: { botToken: 'tg-token' },
      }),
    })

    expect(res.status).toBe(200)
    expect(telegramConnectionManager.start).toHaveBeenCalledWith(
      'agt_original',
      expect.objectContaining({ botToken: 'tg-token' }),
    )
    expect(telegramConnectionManager.stop).not.toHaveBeenCalled()
  })
}

interface AgentDeleteTestContext extends ChannelTeardownTestContext {
  mockFindActiveAgentScmWorkload: { mockResolvedValueOnce(v: unknown): void }
}

/** The `DELETE /agents/:id` suite, moved out of `agents.test.ts` for the same reason. */
export function registerAgentDeleteTests(ctx: AgentDeleteTestContext): void {
  const { SAMPLE_AGENT, mockDb, makeSelectChain } = ctx
  const app = {
    request: (path: string, init?: RequestInit) => ctx.getApp().request(path, init),
  }

  describe('DELETE /agents/:id - connection cleanup', () => {
    it('stops both feishu and schedule connections on delete', async () => {
      const { feishuConnectionManager } = await import('../../lib/feishu-service.js')
      const { scheduleTriggerManager } = await import('../../lib/schedule-trigger.js')

      // A stopped fixture reaches connection cleanup; published Agents return 409 earlier.
      mockDb.select.mockReturnValue(makeSelectChain({ ...SAMPLE_AGENT, publishStatus: 'stopped' }))
      mockDb.update.mockReturnValue(ctx.makeUpdateChain())
      mockDb.delete.mockReturnValue(ctx.makeDeleteChain())

      await app.request('/agents/agt_original', { method: 'DELETE' })

      expect(feishuConnectionManager.stop).toHaveBeenCalledWith('agt_original')
      expect(scheduleTriggerManager.stop).toHaveBeenCalledWith('agt_original')
    })

    // artifacts.agent_id references agents.id with no ON DELETE action, and the SQLite client
    // runs with `PRAGMA foreign_keys = ON`. If the delete does not null it the way it nulls
    // run_steps/runs, the DELETE aborts with a foreign key violation — so any Agent that ever
    // produced an artifact becomes permanently undeletable.
    it('detaches artifacts before deleting, so an Agent with artifacts stays deletable', async () => {
      const { artifacts, runSteps, runs } = await import('../../db/schema.js')

      mockDb.select.mockReturnValue(makeSelectChain({ ...SAMPLE_AGENT, publishStatus: 'stopped' }))
      const updatedTables: unknown[] = []
      mockDb.update.mockImplementation((table: unknown) => {
        updatedTables.push(table)
        return ctx.makeUpdateChain()
      })
      mockDb.delete.mockReturnValue(ctx.makeDeleteChain())

      await app.request('/agents/agt_original', { method: 'DELETE' })

      expect(updatedTables).toContain(runSteps)
      expect(updatedTables).toContain(runs)
      expect(updatedTables).toContain(artifacts)
    })

    it('blocks deleting a published agent with 409 and skips all cleanup', async () => {
      const { feishuConnectionManager } = await import('../../lib/feishu-service.js')
      const { scheduleTriggerManager } = await import('../../lib/schedule-trigger.js')

      // Published Agents must be stopped before deletion; 409 must skip every cleanup.
      mockDb.select.mockReturnValue(
        makeSelectChain({ ...SAMPLE_AGENT, publishStatus: 'published' }),
      )

      const res = await app.request('/agents/agt_original', { method: 'DELETE' })

      expect(res.status).toBe(409)
      expect(feishuConnectionManager.stop).not.toHaveBeenCalled()
      expect(scheduleTriggerManager.stop).not.toHaveBeenCalled()
      expect(mockDb.delete).not.toHaveBeenCalled()
    })

    it('blocks deleting a stopped SCM Agent while an Evaluation uses its checkout', async () => {
      mockDb.select.mockReturnValue(
        makeSelectChain({ ...SAMPLE_AGENT, publishStatus: 'stopped' as const }),
      )
      ctx.mockFindActiveAgentScmWorkload.mockResolvedValueOnce({
        type: 'evaluation',
        id: 'evt_active',
      })

      const res = await app.request('/agents/agt_original', { method: 'DELETE' })

      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({
        error: 'Cannot delete the Agent while Evaluation evt_active is active',
      })
      expect(mockDb.delete).not.toHaveBeenCalled()
    })
  })
}
