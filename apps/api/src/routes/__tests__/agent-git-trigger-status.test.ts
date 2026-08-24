import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('../../lib/git-trigger-cli.js', () => ({ probeGitTriggerCli: mocks.probe }))
vi.mock('../../lib/audit.js', () => ({ logAudit: mocks.audit }))
vi.mock('../../lib/discord-service.js', () => ({ discordConnectionManager: {} }))
vi.mock('../../lib/git-trigger-manager.js', () => ({ gitTriggerManager: {} }))
vi.mock('../../lib/qq-official-service.js', () => ({ qqOfficialConnectionManager: {} }))
vi.mock('../../lib/slack-service.js', () => ({ slackConnectionManager: {} }))

import { AppError, ForbiddenError } from '../../lib/errors.js'
import { handleGitTriggerStatus } from '../agent-git-trigger.js'

/** Mirrors the global onError in index.ts, which maps AppError to its status. */
const withErrorMapping = (app: Hono) =>
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json({ error: err.message, code: err.code }, err.statusCode as 403)
      : c.json({ error: 'Internal Server Error' }, 500),
  )

describe('GET /agents/:id/git-trigger/status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.probe.mockResolvedValue({
      installed: true,
      authenticated: true,
      account: 'deploy-account',
    })
  })

  it('reports the probe result to a caller that holds write permission', async () => {
    const allow = vi.fn().mockResolvedValue({ permission: 'owner' })
    const app = new Hono().get('/agents/:id/git-trigger/status', (c) =>
      handleGitTriggerStatus(c, allow),
    )

    const response = await app.request('/agents/agt_1/git-trigger/status?provider=glab')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { installed: true, authenticated: true, account: 'deploy-account' },
    })
    expect(allow).toHaveBeenCalledWith(expect.anything(), 'agt_1')
  })

  // The guard is async and denies by throwing. An unawaited call detaches that
  // rejection and the handler answers anyway — leaking the deployment's CLI
  // auth state (including the logged-in forge account) to a viewer, spawning a
  // subprocess on their behalf, and auditing it against an Agent they cannot
  // write. A synchronous stub cannot catch that; this one rejects.
  it('does not probe or audit when the write guard denies the caller', async () => {
    const denied = vi.fn().mockRejectedValue(new ForbiddenError('Write access required'))
    const app = withErrorMapping(
      new Hono().get('/agents/:id/git-trigger/status', (c) => handleGitTriggerStatus(c, denied)),
    )

    const response = await app.request('/agents/agt_1/git-trigger/status?provider=glab')

    expect(response.status).toBe(403)
    expect(mocks.probe).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
