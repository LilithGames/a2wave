import type { QQOfficialConfig } from '@a2wave/shared'
import type { Context } from 'hono'
import { z } from 'zod'
import { logAudit } from '../lib/audit.js'
import { logger } from '../lib/logger.js'
import {
  createQQOfficialRegistration,
  pollQQOfficialRegistration,
} from '../lib/qq-official-registration.js'
import { qqOfficialConnectionManager } from '../lib/qq-official-service.js'

const MASKED_SECRET = '********'

interface PreparedQQOfficialPublishConfig {
  effective: QQOfficialConfig | null | undefined
  update: QQOfficialConfig | null | undefined
  missingRequired: boolean
}

/** Restore a masked secret and validate the effective publish configuration. */
export function prepareQQOfficialPublishConfig(
  channels: string[],
  submitted: QQOfficialConfig | null | undefined,
  stored: QQOfficialConfig | null | undefined,
  wasSubmitted: boolean,
): PreparedQQOfficialPublishConfig {
  let update = submitted
  if (wasSubmitted && update?.appSecret === MASKED_SECRET) {
    update = { ...update, appSecret: stored?.appSecret ?? '' }
  }
  const effective = wasSubmitted ? update : stored
  return {
    effective,
    update,
    missingRequired:
      channels.includes('qq_official') && (!effective?.appId || !effective.appSecret),
  }
}

/** Reconcile the in-process QQ Gateway connection after publishing. */
export function syncQQOfficialConnectionAfterPublish(
  agentId: string,
  stopped: boolean,
  channels: string[],
  config: QQOfficialConfig | null | undefined,
): void {
  if (!stopped && channels.includes('qq_official') && config) {
    qqOfficialConnectionManager
      .start(agentId, config)
      .catch((error) =>
        logger.error({ error, agentId }, 'Failed to start QQ Official connection on publish'),
      )
  } else if (!channels.includes('qq_official')) {
    void qqOfficialConnectionManager.stop(agentId)
  }
}

/** Restore the QQ Gateway connection when a stopped Agent resumes. */
export async function resumeQQOfficialConnection(
  agentId: string,
  channels: string[],
  config: QQOfficialConfig | null | undefined,
): Promise<void> {
  if (!channels.includes('qq_official') || !config) return
  try {
    await qqOfficialConnectionManager.start(agentId, config)
  } catch (error) {
    logger.error({ error, agentId }, 'Failed to start QQ Official connection on resume')
  }
}

const registrationBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('start') }),
  z.object({
    action: z.literal('poll'),
    taskId: z.string().trim().min(1),
    bindKey: z.string().min(1),
  }),
])

/** Start or poll Tencent's official QR registration flow for a writable Agent. */
export async function handleQQOfficialRegistration(
  c: Context,
  requireWrite: (c: Context, id: string) => unknown,
): Promise<Response> {
  const { id } = c.req.param()
  requireWrite(c, id)
  const parsed = registrationBodySchema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  try {
    if (parsed.data.action === 'start') {
      const task = await createQQOfficialRegistration()
      logAudit(c, {
        action: 'agent.qq_official_registration_start',
        resource: 'agent',
        resourceId: id,
      })
      return c.json({ data: task })
    }
    const result = await pollQQOfficialRegistration(parsed.data)
    if (result.status === 'completed') {
      logAudit(c, {
        action: 'agent.qq_official_registration_complete',
        resource: 'agent',
        resourceId: id,
      })
    }
    return c.json({ data: result })
  } catch (error) {
    return c.json(
      {
        error: error instanceof Error ? error.message : 'QQ registration request failed',
        code: 'QQ_OFFICIAL_REGISTRATION_FAILED',
      },
      502,
    )
  }
}
