/**
 * Channel-sync and provider-guard helpers shared by the publish, per-channel and
 * generic-update routes.
 *
 * Tested here rather than through `PATCH /agents/:id`, which pulls in far more
 * of the app than this behaviour needs. These two helpers are the whole contract
 * those routes rely on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const start = vi.fn()
const stop = vi.fn()
vi.mock('../../lib/git-trigger-manager.js', () => ({
  gitTriggerManager: {
    start: (...a: unknown[]) => start(...a),
    stop: (...a: unknown[]) => stop(...a),
  },
}))
vi.mock('../../lib/git-trigger-cli.js', () => ({ probeGitTriggerCli: vi.fn() }))
vi.mock('../../lib/audit.js', () => ({ logAudit: vi.fn() }))
vi.mock('../../lib/slack-service.js', () => ({ slackConnectionManager: {} }))
vi.mock('../../lib/discord-service.js', () => ({ discordConnectionManager: {} }))

import { gitTriggerProviderMismatchError, syncGitTriggerChannels } from '../agent-git-trigger.js'

const CONFIG = {
  provider: 'glab',
  repos: [{ project: 'group/repo' }],
  events: ['opened'],
  intervalSeconds: 60,
  intent: 'x',
}

beforeEach(() => vi.clearAllMocks())

describe('gitTriggerProviderMismatchError', () => {
  it('accepts a config whose provider matches its column', () => {
    expect(gitTriggerProviderMismatchError([['glab', CONFIG]])).toBeNull()
  })

  it('rejects a glab-shaped config saved into the gh column', () => {
    // Both channels share one schema, so this validates — and then the poll
    // silently refuses to arm, leaving a channel that reads as configured.
    expect(gitTriggerProviderMismatchError([['gh', CONFIG]])).toMatchObject({
      code: 'CHANNEL_PROVIDER_MISMATCH',
    })
  })

  it('ignores absent configs', () => {
    expect(
      gitTriggerProviderMismatchError([
        ['glab', null],
        ['gh', undefined],
      ]),
    ).toBeNull()
  })
})

describe('syncGitTriggerChannels', () => {
  it('starts an enabled channel that has a config', () => {
    syncGitTriggerChannels({
      agentId: 'agt_1',
      channels: ['api', 'glab'],
      agent: { glabConfig: CONFIG },
    })

    expect(start).toHaveBeenCalledWith('agt_1', 'glab', CONFIG)
    expect(stop).toHaveBeenCalledWith('agt_1', 'gh')
  })

  it('stops a channel whose config was cleared while it stayed enabled', () => {
    // Regression: the earlier `else if (!channels.includes(provider))` left this
    // case unhandled, so the previous timer kept polling the removed repos.
    syncGitTriggerChannels({
      agentId: 'agt_1',
      channels: ['api', 'glab'],
      agent: { glabConfig: null },
    })

    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledWith('agt_1', 'glab')
  })

  it('prefers a pending payload value over the stored column', () => {
    const pending = { ...CONFIG, repos: [{ project: 'group/new' }] }

    syncGitTriggerChannels({
      agentId: 'agt_1',
      channels: ['glab'],
      updatePayload: { glabConfig: pending },
      agent: { glabConfig: CONFIG },
    })

    expect(start).toHaveBeenCalledWith('agt_1', 'glab', pending)
  })

  it('treats an explicit null payload as a clear, not a fallback', () => {
    // `??` would fall through to the stored value and restart the poll against
    // the very config the request just removed.
    syncGitTriggerChannels({
      agentId: 'agt_1',
      channels: ['glab'],
      updatePayload: { glabConfig: null },
      agent: { glabConfig: CONFIG },
    })

    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledWith('agt_1', 'glab')
  })

  it('stops both channels when the agent is stopped', () => {
    syncGitTriggerChannels({
      agentId: 'agt_1',
      channels: ['glab', 'gh'],
      isStopped: true,
      agent: { glabConfig: CONFIG, ghConfig: { ...CONFIG, provider: 'gh' } },
    })

    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(2)
  })
})
