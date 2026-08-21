import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  poll: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('../../lib/qq-official-registration.js', () => ({
  createQQOfficialRegistration: mocks.create,
  pollQQOfficialRegistration: mocks.poll,
}))
vi.mock('../../lib/audit.js', () => ({ logAudit: mocks.audit }))

import { AppError, ForbiddenError } from '../../lib/errors.js'
import {
  handleQQOfficialRegistration,
  prepareQQOfficialPublishConfig,
} from '../agent-qq-official.js'

/** Mirrors the global onError in index.ts, which maps AppError to its status. */
const withErrorMapping = (app: Hono) =>
  app.onError((err, c) =>
    err instanceof AppError
      ? c.json({ error: err.message, code: err.code }, err.statusCode as 403)
      : c.json({ error: 'Internal Server Error' }, 500),
  )

describe('QQ Official publish config', () => {
  const stored = { appId: '102000000', appSecret: 'stored-secret' }

  it('restores a masked Secret from the stored configuration', () => {
    expect(
      prepareQQOfficialPublishConfig(
        ['qq_official'],
        { appId: stored.appId, appSecret: '********' },
        stored,
        true,
      ),
    ).toEqual({
      effective: stored,
      update: stored,
      missingRequired: false,
    })
  })

  it('reports a missing effective configuration only when the channel is enabled', () => {
    expect(prepareQQOfficialPublishConfig(['qq_official'], undefined, null, false)).toMatchObject({
      missingRequired: true,
    })
    expect(prepareQQOfficialPublishConfig([], undefined, null, false)).toMatchObject({
      missingRequired: false,
    })
  })

  it('does not accept a masked Secret when there is no stored credential to restore', () => {
    expect(
      prepareQQOfficialPublishConfig(
        ['qq_official'],
        { appId: '102000000', appSecret: '********' },
        null,
        true,
      ),
    ).toEqual({
      effective: { appId: '102000000', appSecret: '' },
      update: { appId: '102000000', appSecret: '' },
      missingRequired: true,
    })
  })
})

describe('QQ Official registration route', () => {
  const requireWrite = vi.fn()
  const app = new Hono().post('/agents/:id/qq-official/registration', (c) =>
    handleQQOfficialRegistration(c, requireWrite),
  )

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts a QR registration task and audits the external mutation', async () => {
    mocks.create.mockResolvedValue({
      taskId: 'task-1',
      bindKey: 'key',
      qrCodeUrl: 'https://q.qq.com/connect',
      intervalMs: 2_000,
    })

    const response = await app.request('/agents/agent-1/qq-official/registration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    })

    expect(response.status).toBe(200)
    expect(requireWrite).toHaveBeenCalledWith(expect.anything(), 'agent-1')
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'agent.qq_official_registration_start' }),
    )
  })

  // The guard is async and signals denial by throwing. If the handler forgets to
  // await it, the rejection detaches and the handler runs on regardless — a
  // viewer would start a real QR registration against Tencent on an Agent they
  // cannot write. A synchronous stub cannot catch that; this one rejects.
  it('does not touch Tencent or the audit trail when the write guard denies the caller', async () => {
    const denied = vi.fn().mockRejectedValue(new ForbiddenError('Write access required'))
    const guarded = withErrorMapping(
      new Hono().post('/agents/:id/qq-official/registration', (c) =>
        handleQQOfficialRegistration(c, denied),
      ),
    )

    const response = await guarded.request('/agents/agent-1/qq-official/registration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    })

    expect(response.status).toBe(403)
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })

  it('audits completed registration without exposing credentials to the audit log', async () => {
    mocks.poll.mockResolvedValue({
      status: 'completed',
      appId: '102000000',
      appSecret: 'secret',
    })
    const response = await app.request('/agents/agent-1/qq-official/registration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'poll', taskId: 'task-1', bindKey: 'key' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { status: 'completed', appId: '102000000', appSecret: 'secret' },
    })
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'agent.qq_official_registration_complete',
        resource: 'agent',
        resourceId: 'agent-1',
      }),
    )
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('secret')
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('key')
  })

  it('rejects malformed requests and maps Tencent failures to 502', async () => {
    const malformed = await app.request('/agents/agent-1/qq-official/registration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(malformed.status).toBe(400)

    mocks.create.mockRejectedValue(new Error('Tencent unavailable'))
    const failed = await app.request('/agents/agent-1/qq-official/registration', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'start' }),
    })
    expect(failed.status).toBe(502)
  })
})
