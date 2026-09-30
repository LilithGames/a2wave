import { expect, it } from 'vitest'

interface OAuthBindingTestApp {
  request(path: string, init: RequestInit): Response | Promise<Response>
}

interface OAuthBindingTestContext {
  SAMPLE_AGENT: Record<string, unknown>
  createAgentsRouteApp(): Promise<OAuthBindingTestApp>
  mockDbForUpdate(existingAgent: Record<string, unknown>): {
    getCaptured(): Record<string, unknown>
  }
}

/** Preserve the account binding regression cases within the existing route suite. */
export function registerAgentOauthAccountBindingTests({
  SAMPLE_AGENT,
  createAgentsRouteApp,
  mockDbForUpdate,
}: OAuthBindingTestContext): void {
  it('saves a bound ChatGPT account without nesting SQLite serialization locks', async () => {
    const app = await createAgentsRouteApp()
    const { getCaptured } = mockDbForUpdate({
      ...SAMPLE_AGENT,
      providerId: 'prv_codex',
      authMode: 'oauth' as const,
      providerOauthAccountId: 'poa_account',
    })
    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed OAuth Agent' }),
    })
    expect(res.status).toBe(200)
    expect(getCaptured().name).toBe('Renamed OAuth Agent')
  })

  it('detaches the top-level ChatGPT account when switching away from OAuth', async () => {
    const app = await createAgentsRouteApp()
    const { getCaptured } = mockDbForUpdate({
      ...SAMPLE_AGENT,
      providerId: 'prv_codex',
      authMode: 'oauth' as const,
      providerOauthAccountId: 'poa_account',
    })
    const res = await app.request('/agents/agt_original', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authMode: 'apiKey' }),
    })
    expect(res.status).toBe(200)
    expect(getCaptured().providerOauthAccountId).toBeNull()
  })
}
