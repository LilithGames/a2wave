/**
 * PATCH /agents/:id/channels/:channel — save one channel's config on its own.
 *
 * Extracted from agents.ts, which had grown past the 3000-line gate. This route
 * is the natural seam: it owns a self-contained registry (schema + column +
 * live-connection restart per channel) that nothing else in agents.ts reads, so
 * moving it leaves the publish path untouched.
 *
 * Mounted onto the agents router by agents.ts rather than exporting its own Hono
 * instance, so the `/agents` prefix and middleware stack stay declared in one place.
 */

import {
  chatAppConfigSchema,
  discordConfigSchema,
  ghTriggerConfigSchema,
  glabTriggerConfigSchema,
  qqOfficialConfigSchema,
  scheduleConfigSchema,
  slackConfigSchema,
  telegramConfigSchema,
} from '@a2wave/shared'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { agents } from '../db/schema.js'
import { requireAgentWrite } from '../lib/agent-access.js'
import { logAudit } from '../lib/audit.js'
import { discordConnectionManager } from '../lib/discord-service.js'
import { feishuConnectionManager, normalizeFeishuConfig } from '../lib/feishu-service.js'
import { gitTriggerManager } from '../lib/git-trigger-manager.js'
import { logger } from '../lib/logger.js'
import { qqOfficialConnectionManager } from '../lib/qq-official-service.js'
import type { ScheduleConfigInput } from '../lib/schedule-trigger.js'
import { scheduleTriggerManager } from '../lib/schedule-trigger.js'
import { slackConnectionManager } from '../lib/slack-service.js'
import { telegramConnectionManager } from '../lib/telegram-service.js'
import { maskAgentSecrets } from './agent-secret-masking.js'
import { feishuConfigBodySchema } from './publish-feishu-config.js'

/** Placeholder echoed back instead of a stored credential. */
const MASKED_SECRET = '********'

/**
 * 每个渠道各自的 config body。刻意不复用 publishBodySchema——它对 authType /
 * channels / ipWhitelist / description 都带 .default()，一旦复用，只想存飞书凭据
 * 的请求会把 publishChannels 静默重置成 ['api']（等于关掉其它所有渠道），并顺手
 * 轮换掉 endpointApiKey。
 */
const channelConfigSchemas = {
  feishu: feishuConfigBodySchema,
  slack: slackConfigSchema,
  discord: discordConfigSchema,
  telegram: telegramConfigSchema,
  qq_official: qqOfficialConfigSchema,
  chat_app: chatAppConfigSchema,
  schedule: scheduleConfigSchema,
  // Provider-bound, so a mismatched config is a 400 from schema validation
  // itself rather than something this route has to remember to check.
  glab: glabTriggerConfigSchema,
  gh: ghTriggerConfigSchema,
} as const

type ConfigurableChannel = keyof typeof channelConfigSchemas

/** config 值写到 agents 表的哪一列。 */
const CHANNEL_CONFIG_COLUMN: Record<ConfigurableChannel, string> = {
  feishu: 'feishuConfig',
  slack: 'slackConfig',
  discord: 'discordConfig',
  telegram: 'telegramConfig',
  qq_official: 'qqOfficialConfig',
  chat_app: 'chatAppConfig',
  schedule: 'scheduleConfig',
  glab: 'glabConfig',
  gh: 'ghConfig',
}

function isConfigurableChannel(value: string): value is ConfigurableChannel {
  return Object.hasOwn(channelConfigSchemas, value)
}

/**
 * PATCH /agents/:id/channels/:channel - 只保存单个渠道的配置。
 *
 * 与 POST /:id/publish 的关键区别：**配置 ≠ 发布**。publish 会把 Agent 置为
 * published、戳 publishedAt、轮换 API Key，并按 channels 数组重启所有渠道的长连接；
 * 而在卡片上点「配置」保存凭据不应触发其中任何一项——draft 仍是 draft，直到用户显式
 * 点「发布」。启用与否由 publishChannels 决定，不归这个接口管，所以「配置了但不启用」
 * 是完全合法的状态。
 *
 * 副作用也收窄到单个渠道：只有当 Agent 已发布**且**该渠道已在 publishChannels 中时，
 * 才重启它自己的连接。改飞书配置不会顺带把 Slack / Discord 的在线 socket 打断——
 * 这正是整份 publish payload 做不到的。
 */
export function registerAgentChannelConfigRoute(app: Hono): void {
  app.patch('/:id/channels/:channel', async (c) => {
    const { id, channel } = c.req.param()

    if (!isConfigurableChannel(channel)) {
      return c.json(
        { error: `Channel '${channel}' has no saveable config.`, code: 'UNKNOWN_CHANNEL' },
        400,
      )
    }

    const body = await c.req.json().catch(() => ({}))
    const parsed = z.object({ config: channelConfigSchemas[channel] }).safeParse(body)
    if (!parsed.success) {
      return c.json({ error: parsed.error.flatten() }, 400)
    }

    const { agent } = await requireAgentWrite(c, id)
    const column = CHANNEL_CONFIG_COLUMN[channel]

    /**
     * 脱敏哨兵回填：前端从不拿到明文凭据，未修改的字段会原样回传 '********'。
     *
     * 关键在于「无可回填的原值」必须报错，而不是把哨兵当成密钥写进去——那会让该字段
     * 读回来就已经是脱敏值，看着像已配置，实则每次调用都鉴权失败，且之后每次保存都会
     * 把哨兵再「还原」一遍，用户无法自行修复。草稿 Agent 正是这种「库里还没有原值」的
     * 状态，而配置弹窗恰恰是它录入凭据的主要入口。
     */
    const restoreSecret = (submitted: string | undefined, stored: string | undefined | null) => {
      if (submitted !== MASKED_SECRET) return { ok: true as const, value: submitted }
      if (!stored) return { ok: false as const, value: undefined }
      return { ok: true as const, value: stored }
    }

    const maskedWithoutStored = (field: string) =>
      c.json(
        {
          error: `${field} was sent masked but no stored value exists to restore.`,
          code: 'MASKED_SECRET_WITHOUT_STORED_VALUE',
        },
        400,
      )

    let config: unknown = parsed.data.config
    if (channel === 'feishu') {
      const next = normalizeFeishuConfig(config as Record<string, unknown>)
      const secret = restoreSecret(next.appSecret, agent.feishuConfig?.appSecret)
      if (!secret.ok) return maskedWithoutStored('appSecret')
      config = { ...next, appSecret: secret.value }
    } else if (channel === 'slack') {
      const next = config as { appToken?: string; botToken?: string }
      const appToken = restoreSecret(next.appToken, agent.slackConfig?.appToken)
      if (!appToken.ok) return maskedWithoutStored('appToken')
      const botToken = restoreSecret(next.botToken, agent.slackConfig?.botToken)
      if (!botToken.ok) return maskedWithoutStored('botToken')
      config = { ...next, appToken: appToken.value, botToken: botToken.value }
    } else if (channel === 'discord') {
      const next = config as { botToken?: string }
      const botToken = restoreSecret(next.botToken, agent.discordConfig?.botToken)
      if (!botToken.ok) return maskedWithoutStored('botToken')
      config = { ...next, botToken: botToken.value }
    } else if (channel === 'telegram') {
      const next = config as { botToken?: string }
      const botToken = restoreSecret(next.botToken, agent.telegramConfig?.botToken)
      if (!botToken.ok) return maskedWithoutStored('botToken')
      config = { ...next, botToken: botToken.value }
    } else if (channel === 'qq_official') {
      const next = config as { appSecret?: string }
      const appSecret = restoreSecret(next.appSecret, agent.qqOfficialConfig?.appSecret)
      if (!appSecret.ok) return maskedWithoutStored('appSecret')
      config = { ...next, appSecret: appSecret.value }
    }

    // 只有「已发布 + 该渠道已启用」才让改动即时生效；draft 或未启用时仅落库。
    const isLive =
      agent.publishStatus === 'published' && (agent.publishChannels ?? []).includes(channel)

    /**
     * 线上渠道不允许把凭据存成空值。
     *
     * 连接管理器的 start() 是「先 stop 再校验」：凭据为空时它已经把旧连接拆了才 return，
     * 而本路由仍会返回 200、前端显示「保存成功」。于是管理员只要在已上线渠道的配置弹窗里
     * 清空 App ID 保存，就会把正常在线的机器人静默下线，同时把无效配置写进库。
     *
     * 草稿 / 未启用的渠道不受此限制——编辑途中清空字段是正常操作，且没有连接可破坏。
     */
    if (isLive) {
      const required: Record<string, string | undefined> =
        channel === 'feishu'
          ? {
              appId: (config as { appId?: string }).appId,
              appSecret: (config as { appSecret?: string }).appSecret,
            }
          : channel === 'slack'
            ? {
                appId: (config as { appId?: string }).appId,
                appToken: (config as { appToken?: string }).appToken,
                botToken: (config as { botToken?: string }).botToken,
              }
            : channel === 'discord'
              ? {
                  applicationId: (config as { applicationId?: string }).applicationId,
                  botToken: (config as { botToken?: string }).botToken,
                }
              : channel === 'telegram'
                ? { botToken: (config as { botToken?: string }).botToken }
                : channel === 'qq_official'
                  ? {
                      appId: (config as { appId?: string }).appId,
                      appSecret: (config as { appSecret?: string }).appSecret,
                    }
                  : {}
      const blank = Object.entries(required).find(([, value]) => !value?.trim())
      if (blank) {
        return c.json(
          {
            error: `${blank[0]} cannot be empty while the ${channel} channel is live. Disable the channel first.`,
            code: 'LIVE_CHANNEL_REQUIRES_CREDENTIALS',
          },
          400,
        )
      }
    }

    const updated = (
      await db
        .update(agents)
        .set({ [column]: config, updatedAt: new Date() })
        .where(eq(agents.id, id))
        .returning()
    )[0]
    if (isLive) {
      if (channel === 'feishu') {
        feishuConnectionManager
          .start(id, config as Parameters<typeof feishuConnectionManager.start>[1])
          .catch((err) =>
            logger.error(
              { err, agentId: id },
              'Failed to restart Feishu connection on config save',
            ),
          )
      } else if (channel === 'slack') {
        slackConnectionManager
          .start(id, config as Parameters<typeof slackConnectionManager.start>[1])
          .catch((err) =>
            logger.error({ err, agentId: id }, 'Failed to restart Slack connection on config save'),
          )
      } else if (channel === 'discord') {
        discordConnectionManager
          .start(id, config as Parameters<typeof discordConnectionManager.start>[1])
          .catch((err) =>
            logger.error(
              { err, agentId: id },
              'Failed to restart Discord connection on config save',
            ),
          )
      } else if (channel === 'telegram') {
        telegramConnectionManager
          .start(id, config as Parameters<typeof telegramConnectionManager.start>[1])
          .catch((err) =>
            logger.error(
              { err, agentId: id },
              'Failed to restart Telegram connection on config save',
            ),
          )
      } else if (channel === 'qq_official') {
        qqOfficialConnectionManager
          .start(id, config as Parameters<typeof qqOfficialConnectionManager.start>[1])
          .catch((err) =>
            logger.error(
              { err, agentId: id },
              'Failed to restart QQ Official connection on config save',
            ),
          )
      } else if (channel === 'schedule') {
        scheduleTriggerManager.start(id, config as ScheduleConfigInput)
      } else if (channel === 'glab' || channel === 'gh') {
        gitTriggerManager.start(id, channel, config)
      }
    }

    logAudit(c, {
      action: 'agent.publish_channel',
      resource: 'agent',
      resourceId: id,
      // 只记渠道名——config 里有凭据，details 会原样展示给每个管理员。
      details: { channel },
    })

    return c.json({ data: maskAgentSecrets(updated) })
  })
}
