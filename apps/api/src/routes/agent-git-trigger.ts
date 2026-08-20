/**
 * `glab` / `gh` CLI status probe for the git repository trigger channels.
 *
 * Lives outside routes/agents.ts purely to keep that file under the 3000-line
 * gate; it is mounted onto the same `/agents` router, so the URL is unchanged.
 */
import type { Context } from 'hono'
import type { agents } from '../db/schema.js'
import { logAudit } from '../lib/audit.js'
import { discordConnectionManager } from '../lib/discord-service.js'
import type { DiagnoseSeverity } from '../lib/feishu-diagnose.js'
import { probeGitTriggerCli } from '../lib/git-trigger-cli.js'
import { gitTriggerManager } from '../lib/git-trigger-manager.js'
import { qqOfficialConnectionManager } from '../lib/qq-official-service.js'
import { slackConnectionManager } from '../lib/slack-service.js'

type AgentRow = typeof agents.$inferSelect

/**
 * GET /agents/:id/git-trigger/status — 探测 glab / gh CLI 的安装与认证状态。
 *
 * 平台**只探测、不安装**：这两个 CLI 不在 provider-cli-lock.json 里，凭据也留在
 * CLI 自己的 keyring 中，a2wave 从不接触 forge token。所以这里唯一能做、也唯一
 * 该做的事，就是把「装没装 / 登没登」如实报给配置弹窗——否则用户只能靠一串失败
 * 的轮询日志才发现自己没执行 `glab auth login`。
 *
 * 需要写权限（由调用方注入 requireWrite）：探测会 spawn 子进程，且认证详情属于部署环境信息。
 */
export async function handleGitTriggerStatus(
  c: Context,
  requireWrite: (c: Context, id: string) => unknown,
): Promise<Response> {
  const { id } = c.req.param()
  requireWrite(c, id)

  const provider = c.req.query('provider')
  if (provider !== 'glab' && provider !== 'gh') {
    return c.json({ error: "provider must be 'glab' or 'gh'", code: 'INVALID_PROVIDER' }, 400)
  }
  const host = c.req.query('host')?.trim() || undefined

  const status = await probeGitTriggerCli(provider, host)

  logAudit(c, {
    action: 'agent.git_trigger_probe',
    resource: 'agent',
    resourceId: id,
    details: {
      provider,
      ...(host ? { host } : {}),
      installed: status.installed,
      authenticated: status.authenticated,
    },
  })

  return c.json({ data: status })
}

/**
 * Per-channel long-connection checks for the Agent diagnosis report.
 *
 * Extracted from routes/agents.ts alongside the git-trigger probe: both answer
 * "is this channel actually working right now?", and both were pushing that
 * file past the 3000-line gate.
 */
export function collectNativeChatConnectionChecks(agent: AgentRow): Array<{
  id: string
  severity: DiagnoseSeverity
  message: string
}> {
  const checks: Array<{ id: string; severity: DiagnoseSeverity; message: string }> = []
  const channels = agent.publishChannels ?? []
  const entries = [
    {
      channel: 'slack' as const,
      configured: Boolean(agent.slackConfig),
      registered: slackConnectionManager.isRegistered(agent.id),
      open: slackConnectionManager.isSocketOpen(agent.id),
    },
    {
      channel: 'discord' as const,
      configured: Boolean(agent.discordConfig),
      registered: discordConnectionManager.isRegistered(agent.id),
      open: discordConnectionManager.isSocketOpen(agent.id),
    },
    {
      channel: 'qq_official' as const,
      configured: Boolean(agent.qqOfficialConfig),
      registered: qqOfficialConnectionManager.isRegistered(agent.id),
      open: qqOfficialConnectionManager.isSocketOpen(agent.id),
    },
  ]
  for (const entry of entries) {
    if (!channels.includes(entry.channel)) continue
    const label = {
      slack: 'Slack',
      discord: 'Discord',
      qq_official: 'QQ Official',
    }[entry.channel]
    if (!entry.configured) {
      checks.push({
        id: `${entry.channel}_config_missing`,
        severity: 'error',
        message: `${label} is enabled but its credentials are missing.`,
      })
    } else if (agent.publishStatus !== 'published') {
      checks.push({
        id: `${entry.channel}_connection_stopped`,
        severity: 'info',
        message: `${label} is configured but the Agent is not running.`,
      })
    } else if (!entry.registered || !entry.open) {
      checks.push({
        id: `${entry.channel}_connection_closed`,
        severity: 'error',
        message: `${label} is enabled but its connection is not open in this API process.`,
      })
    } else {
      checks.push({
        id: `${entry.channel}_connection_open`,
        severity: 'info',
        message: `${label} connection is open in this API process.`,
      })
    }
  }
  return checks
}

/**
 * Returns the first channel whose config carries a mismatched `provider`.
 *
 * Both git channels share one schema, so a `provider: 'glab'` config saved into
 * `ghConfig` validates cleanly — and then `gitTriggerManager.start()` refuses to
 * arm a timer, leaving a channel that reads as configured and published while
 * never polling once. Rejecting at the route boundary turns that silent no-op
 * into an explicit 400. Returns null when everything matches.
 */
export function findGitTriggerProviderMismatch(
  entries: readonly (readonly ['glab' | 'gh', unknown])[],
): 'glab' | 'gh' | null {
  for (const [expected, config] of entries) {
    if (!config) continue
    if ((config as { provider?: string }).provider !== expected) return expected
  }
  return null
}

/**
 * 400 body when either git-trigger config in a payload names the wrong provider.
 *
 * Convenience over `gitTriggerProviderMismatchError` for the two routes that
 * carry both columns in one body.
 */
export function gitTriggerPayloadMismatchError(payload: {
  glabConfig?: unknown
  ghConfig?: unknown
}): { error: string; code: string } | null {
  return gitTriggerProviderMismatchError([
    ['glab', payload.glabConfig],
    ['gh', payload.ghConfig],
  ])
}

/** 400 body for a mismatched git-trigger config, or null when everything matches. */
export function gitTriggerProviderMismatchError(
  entries: readonly (readonly ['glab' | 'gh', unknown])[],
): { error: string; code: string } | null {
  const mismatch = findGitTriggerProviderMismatch(entries)
  if (!mismatch) return null
  return {
    error: `${mismatch}Config.provider must be '${mismatch}'.`,
    code: 'CHANNEL_PROVIDER_MISMATCH',
  }
}

/**
 * Starts or stops both git-trigger polls to match the published channel set.
 *
 * Deliberately exhaustive: start when the channel can actually run, stop in
 * every other case. An earlier `else if (!channels.includes(provider))` left a
 * third case unhandled — channel still enabled but its config cleared to null —
 * where neither branch ran and the previous in-memory timer kept polling the
 * removed repositories until the process restarted.
 */
export function syncGitTriggerChannels(params: {
  agentId: string
  channels: string[]
  /** Defaults to false — resume and publish both arrive here in a live state. */
  isStopped?: boolean
  /** Pending column writes; omit when resuming from the persisted row alone. */
  updatePayload?: Record<string, unknown>
  agent: Record<string, unknown>
}): void {
  const { agentId, channels, agent } = params
  const isStopped = params.isStopped ?? false
  const updatePayload = params.updatePayload ?? {}
  for (const provider of ['glab', 'gh'] as const) {
    const column = provider === 'glab' ? 'glabConfig' : 'ghConfig'
    // `!== undefined`, not `??`: an explicit null means "clear this config", and
    // `??` would fall through to the stored value and restart a poll against the
    // config the request just removed.
    const savedConfig = updatePayload[column] !== undefined ? updatePayload[column] : agent[column]
    if (!isStopped && channels.includes(provider) && savedConfig) {
      gitTriggerManager.start(agentId, provider, savedConfig)
    } else {
      gitTriggerManager.stop(agentId, provider)
    }
  }
}

/**
 * Re-arms the polls after a generic `PATCH /agents/:id` touched either config.
 *
 * Without it the in-memory timer keeps running the previous repository list
 * until the process restarts, so an edit made here appears saved while the poll
 * continues against what it replaced.
 */
export function resyncGitTriggerAfterUpdate(
  agentId: string,
  patch: { glabConfig?: unknown; ghConfig?: unknown },
  updated: Record<string, unknown> | undefined,
): void {
  if (patch.glabConfig === undefined && patch.ghConfig === undefined) return
  syncGitTriggerChannels({
    agentId,
    channels: (updated?.publishChannels as string[]) ?? [],
    isStopped: updated?.publishStatus !== 'published',
    agent: updated ?? {},
  })
}

/**
 * Both publish-time git-trigger checks in one call: provider match, then config
 * presence. Combined so a route cannot apply one and forget the other.
 */
export function gitTriggerPublishError(
  channels: readonly string[],
  updatePayload: Record<string, unknown>,
  agent: Record<string, unknown>,
): { error: string; code: string } | null {
  return (
    gitTriggerPayloadMismatchError({
      glabConfig: updatePayload.glabConfig,
      ghConfig: updatePayload.ghConfig,
    }) ?? missingGitTriggerConfigError(channels, updatePayload, agent)
  )
}

/**
 * 400 body when a git-trigger channel is being published without a config.
 *
 * Such a publish returns 200 and then never polls: `syncGitTriggerChannels`
 * finds nothing to start and quietly calls `stop()`, so the channel reads as
 * live everywhere while no merge request ever fires a Run — and nothing errors,
 * because nothing was started that could fail. Slack and Discord reject the
 * equivalent state, and import repairs it by stripping the channel; this closes
 * the third entry point.
 */
export function missingGitTriggerConfigError(
  channels: readonly string[],
  updatePayload: Record<string, unknown>,
  agent: Record<string, unknown>,
): { error: string; code: string } | null {
  for (const provider of ['glab', 'gh'] as const) {
    if (!channels.includes(provider)) continue
    const column = provider === 'glab' ? 'glabConfig' : 'ghConfig'
    const effective = updatePayload[column] === undefined ? agent[column] : updatePayload[column]
    if (!effective) {
      return {
        error: `${provider} channel requires a trigger config (repositories, events and intent).`,
        code: 'GIT_TRIGGER_CONFIG_REQUIRED',
      }
    }
  }
  return null
}
