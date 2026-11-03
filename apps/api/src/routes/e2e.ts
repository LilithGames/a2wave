import { KB_DOCUMENT_NAME_MAX } from '@a2wave/shared'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { agents, kbDocuments, runSteps, runs } from '../db/schema.js'
import { env } from '../env.js'
import { buildAgentConfig } from '../lib/agent-helpers.js'
import {
  type FeishuConfig,
  feishuConnectionManager,
  normalizeFeishuConfig,
} from '../lib/feishu-service.js'
import { createId } from '../lib/id.js'
import { getCurrentUserId } from '../lib/owner-filter.js'
import type { LifecyclePlugin, PipelineError, RunCtx, RunOutcome } from '../lib/pipeline/types.js'

const app = new Hono()

const seedKbDocumentSchema = z.object({
  name: z.string().min(1).max(KB_DOCUMENT_NAME_MAX),
  notionUrl: z.string().min(1),
  notionPageId: z.string().min(1),
  notionToken: z.string().min(1),
})

app.post('/kb-documents', async (c) => {
  if (env.NODE_ENV === 'production' || !env.E2E_STRICT_AUTH) {
    return c.json({ error: 'E2E route disabled' }, 404)
  }

  const parsed = seedKbDocumentSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const id = createId('kbd')
  await db.insert(kbDocuments).values({
    id,
    name: parsed.data.name,
    sourceType: 'notion',
    notionUrl: parsed.data.notionUrl,
    notionPageId: parsed.data.notionPageId,
    notionToken: parsed.data.notionToken,
    syncStatus: 'synced',
    contentHash: 'e2e-seed',
    fileSize: 0,
    userId: getCurrentUserId(c),
  })

  return c.json({ data: { id } }, 201)
})

const injectSchema = z.object({
  text: z.string(),
  messageId: z.string().optional(),
  chatId: z.string().optional(),
  chatType: z.enum(['p2p', 'group']).default('p2p'),
  threadId: z.string().optional(),
  root: z.object({ messageId: z.string(), text: z.string() }).optional(),
  rootId: z.string().optional(),
  feishuConfig: z.record(z.string(), z.unknown()).optional(),
  cardCreateFails: z.boolean().default(false),
  probe: z
    .enum([
      'none',
      'abort-before-run',
      'patch-after-run',
      'patch-after-run-error',
      'throw-after-run',
      'observe-broadcast',
      'multi-patch-chain',
    ])
    .default('none'),
})

type Probe = z.infer<typeof injectSchema>['probe']

function feishuText(text: string): string {
  return JSON.stringify({ text })
}

function readContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>
    if (typeof parsed.text === 'string') return parsed.text
    if (parsed.zh_cn && typeof parsed.zh_cn === 'object') {
      return JSON.stringify(parsed.zh_cn)
    }
    return content
  } catch {
    return content
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function makeTerminalObserver(events: string[], resolveTerminal: () => void): LifecyclePlugin {
  return {
    name: 'e2e:terminal-observer',
    priority: 1000,
    onRunSucceeded(_ctx: RunCtx, outcome: RunOutcome) {
      events.push(`runSucceeded:${outcome.output}`)
      resolveTerminal()
    },
    onRunFailed(_ctx: RunCtx, error: PipelineError) {
      events.push(`runFailed:${error.error}`)
      resolveTerminal()
    },
    onAfterReply() {
      events.push('afterReply')
      resolveTerminal()
    },
  }
}

function makeProbePlugins(
  probe: Probe,
  events: string[],
  resolveTerminal: () => void,
): LifecyclePlugin[] {
  const plugins: LifecyclePlugin[] = [makeTerminalObserver(events, resolveTerminal)]

  if (probe === 'abort-before-run') {
    plugins.push({
      name: 'e2e:abort-before-run',
      priority: 20,
      onBeforeRun() {
        events.push('beforeRun:abort')
        resolveTerminal()
        return { abort: { code: 'e2e_abort_before_run', reason: 'E2E abort before run' } }
      },
    })
  }
  if (probe === 'patch-after-run') {
    plugins.push({
      name: 'e2e:patch-after-run',
      priority: 20,
      onAfterRun(_ctx: RunCtx, outcome: RunOutcome | PipelineError) {
        events.push(`afterRun:${outcome.success ? 'success' : 'failed'}`)
        if (!outcome.success) return null
        return { patch: { output: `[afterRun patched] ${outcome.output}` } }
      },
      onBeforeReply(ctx) {
        events.push(`beforeReply:${ctx.content?.text ?? ''}`)
        return null
      },
    })
  }
  if (probe === 'patch-after-run-error') {
    plugins.push({
      name: 'e2e:patch-after-run-error',
      priority: 20,
      onAfterRun(_ctx: RunCtx, outcome: RunOutcome | PipelineError) {
        events.push(`afterRun:${outcome.success ? 'success' : 'failed'}`)
        if (outcome.success) return null
        return { patch: { error: `[afterRun patched error] ${outcome.error}` } } as never
      },
    })
  }
  if (probe === 'throw-after-run') {
    plugins.push({
      name: 'e2e:throw-after-run',
      priority: 20,
      onAfterRun() {
        events.push('afterRun:throw')
        throw new Error('E2E transform throw')
      },
    })
  }
  if (probe === 'multi-patch-chain') {
    plugins.push(
      {
        name: 'e2e:reply-patch-1',
        priority: 10,
        onBeforeReply(ctx) {
          events.push(`beforeReply:p1:${ctx.content?.text ?? ''}`)
          return { patch: { text: `[p1] ${ctx.content?.text ?? ''}` } }
        },
      },
      {
        name: 'e2e:reply-patch-2',
        priority: 20,
        onBeforeReply(ctx) {
          events.push(`beforeReply:p2:${ctx.content?.text ?? ''}`)
          return { patch: { text: `[p2] ${ctx.content?.text ?? ''}` } }
        },
      },
    )
  }

  return plugins
}

app.post('/feishu/:agentId/message', async (c) => {
  if (env.NODE_ENV === 'production' || !env.E2E_STRICT_AUTH) {
    return c.json({ error: 'E2E route disabled' }, 404)
  }

  const agentId = c.req.param('agentId')
  const parsed = injectSchema.safeParse(await c.req.json())
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

  const agent = (await db.select().from(agents).where(eq(agents.id, agentId)).limit(1))[0]
  if (!agent) return c.json({ error: 'Agent not found' }, 404)

  const messageId = parsed.data.messageId ?? `om_e2e_${Date.now()}`
  const chatId = parsed.data.chatId ?? `oc_e2e_${agentId}`
  const events: string[] = []
  const replies: Array<{ kind: string; msgType: string; text: string }> = []
  const cardContentUpdates: string[] = []
  const cardSettingsCalls: string[] = []
  const rootGetIds: string[] = []
  const rootMessage = parsed.data.root
  const terminal = deferred()

  const client = {
    im: {
      messageReaction: { create: async () => ({ data: {} }) },
      message: {
        get: async ({ path }: { path: { message_id: string } }) => {
          rootGetIds.push(path.message_id)
          return {
            data: {
              items: rootMessage
                ? [{ msg_type: 'text', body: { content: feishuText(rootMessage.text) } }]
                : [],
            },
          }
        },
        reply: async (req: { data: { content: string; msg_type: string } }) => {
          replies.push({
            kind: 'reply',
            msgType: req.data.msg_type,
            text: readContent(req.data.content),
          })
          if (parsed.data.cardCreateFails && req.data.msg_type === 'post') terminal.resolve()
          return { data: { message_id: `reply_${Date.now()}` } }
        },
        create: async (req: { data: { content: string; msg_type: string } }) => {
          replies.push({
            kind: 'create',
            msgType: req.data.msg_type,
            text: readContent(req.data.content),
          })
          if (parsed.data.cardCreateFails && req.data.msg_type === 'post') terminal.resolve()
          return { data: { message_id: `create_${Date.now()}` } }
        },
        patch: async (req: { data: { content: string } }) => {
          replies.push({
            kind: 'patch',
            msgType: 'interactive',
            text: readContent(req.data.content),
          })
          return { data: {} }
        },
      },
    },
    cardkit: {
      v1: {
        card: {
          create: async () => {
            if (parsed.data.cardCreateFails) throw new Error('E2E card.create failed')
            return { data: { card_id: `card_${Date.now()}` } }
          },
          settings: async () => {
            cardSettingsCalls.push('settings')
            return { data: {} }
          },
        },
        cardElement: {
          content: async (req: { data: { content: string } }) => {
            cardContentUpdates.push(req.data.content)
            return { data: {} }
          },
          create: async () => ({ data: {} }),
        },
      },
    },
  } as never

  const feishuConfig = normalizeFeishuConfig({
    appId: 'cli_e2e',
    appSecret: 'secret_e2e',
    groupTriggerOnAt: true,
    groupTriggerOnNewMessage: true,
    topicTriggerOnAt: true,
    topicTriggerOnNewTopic: true,
    topicTriggerOnNewComment: true,
    p2pReplyMode: 'quote',
    groupReplyMode: 'quote',
    topicReplyMode: 'topic_reply',
    replyContentType: 'text',
    sendArtifactsAsFile: false,
    ...((agent.feishuConfig as Record<string, unknown> | null) ?? {}),
    ...(parsed.data.feishuConfig ?? {}),
  }) as FeishuConfig

  const plugins = makeProbePlugins(parsed.data.probe, events, terminal.resolve)
  const previousRunIds = new Set(
    await (
      await db.select({ id: runs.id }).from(runs).where(eq(runs.initiatorAgentId, agentId))
    ).map((run) => run.id),
  )

  await feishuConnectionManager.injectE2eMessage(
    agentId,
    client,
    feishuConfig,
    {
      sender: { sender_id: { user_id: 'usr_e2e', open_id: 'ou_e2e' } },
      message: {
        message_id: messageId,
        root_id: parsed.data.root?.messageId ?? parsed.data.rootId,
        thread_id: parsed.data.threadId,
        chat_id: chatId,
        chat_type: parsed.data.chatType,
        message_type: 'text',
        content: feishuText(parsed.data.text),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot_e2e' } }],
      },
    },
    { botOpenId: 'ou_bot_e2e', extraPlugins: plugins },
  )

  await Promise.race([
    terminal.promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for E2E Feishu terminal hook')), 5000),
    ),
  ])

  const latestRun =
    (await (
      await db.select().from(runs).where(eq(runs.initiatorAgentId, agentId))
    )
      .filter((run) => !previousRunIds.has(run.id))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]) ??
    (
      await db
        .select()
        .from(runs)
        .where(eq(runs.initiatorAgentId, agentId))
        .orderBy(desc(runs.createdAt))
        .limit(1)
    )[0]
  const latestStep = latestRun
    ? (
        await db
          .select()
          .from(runSteps)
          .where(eq(runSteps.runId, latestRun.id))
          .orderBy(desc(runSteps.createdAt))
          .limit(1)
      )[0]
    : null

  return c.json({
    data: {
      replies,
      rootGetIds,
      cardContentUpdates,
      cardSettingsCalls,
      probeEvents: events,
      latestRun,
      latestStep,
      agentConfig: await buildAgentConfig(agent),
    },
  })
})

export default app
