import { describe, expect, it } from 'vitest'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import {
  type ChannelReadinessInput,
  getChannelBlockReason,
  isChannelReady,
} from '../channel-readiness'
import { CHANNEL_REGISTRY } from '../channel-registry'

function baseInput(overrides: Partial<ChannelReadinessInput> = {}): ChannelReadinessInput {
  return {
    feishuAppId: '',
    feishuAppSecret: '',
    feishuSecretExists: false,
    slackAppId: '',
    slackAppToken: '',
    slackBotToken: '',
    discordApplicationId: '',
    discordBotToken: '',
    qqOfficialAppId: '',
    qqOfficialAppSecret: '',
    oauthAccessMode: 'all_idaas_users',
    oauthAllowedEmails: [],
    scheduleConfigs: [],
    glab: {
      repos: [{ project: 'group/repo' }],
      events: ['opened'],
      intent: 'review it',
      intervalSeconds: 60,
    },
    gh: {
      repos: [{ project: 'owner/repo' }],
      events: ['opened'],
      intent: 'review it',
      intervalSeconds: 60,
    },
    ...overrides,
  }
}

describe('git trigger channel readiness', () => {
  it('is ready with a repo, an event, an intent and a valid interval', () => {
    expect(isChannelReady('glab', baseInput())).toBe(true)
    expect(isChannelReady('gh', baseInput())).toBe(true)
  })

  it('blocks when no repository is configured', () => {
    const input = baseInput({
      glab: { repos: [], events: ['opened'], intent: 'x', intervalSeconds: 60 },
    })
    expect(getChannelBlockReason('glab', input)).toBe('agentPublish.gitTriggerRepoRequired')
  })

  it('blocks when every repository row is blank', () => {
    // The form seeds one empty row, so "untouched" must not read as ready.
    const input = baseInput({
      glab: { repos: [{ project: '   ' }], events: ['opened'], intent: 'x', intervalSeconds: 60 },
    })
    expect(getChannelBlockReason('glab', input)).toBe('agentPublish.gitTriggerRepoRequired')
  })

  it('still blocks a group row with no path', () => {
    // A group names a namespace, so a blank one is genuinely incomplete rather
    // than deliberately empty.
    const input = baseInput({
      glab: {
        repos: [{ project: '  ', scope: 'group' }],
        events: ['opened'],
        intent: 'x',
        intervalSeconds: 60,
      },
    })
    expect(getChannelBlockReason('glab', input)).toBe('agentPublish.gitTriggerRepoRequired')
  })

  it('blocks when a repository URL was typed but could not be parsed', () => {
    /**
     * An unparseable row has a `url` the user typed and an empty `project`.
     * Filtering on `project` alone treated it exactly like an untouched blank
     * row: Save stayed enabled and the row was silently dropped from the
     * payload, so the user published a channel that watches fewer repositories
     * than the form shows — while an inline error sat right next to the
     * clickable Save button.
     */
    const input = baseInput({
      glab: {
        repos: [{ project: 'group/repo', url: 'https://gitlab.example.com/group/repo' }],
        events: ['opened'],
        intent: 'x',
        intervalSeconds: 60,
      },
    })
    expect(getChannelBlockReason('glab', input)).toBeNull()

    const withGarbage = baseInput({
      glab: {
        repos: [
          { project: 'group/repo', url: 'https://gitlab.example.com/group/repo' },
          { project: '', url: 'not a url' },
        ],
        events: ['opened'],
        intent: 'x',
        intervalSeconds: 60,
      },
    })
    expect(getChannelBlockReason('glab', withGarbage)).toBe('agentPublish.gitTriggerRepoInvalid')
  })

  it('ignores a still-blank row so the seeded empty row is not an error', () => {
    // Adding a row and not filling it yet must not block the whole form.
    const input = baseInput({
      glab: {
        repos: [
          { project: 'group/repo', url: 'https://gitlab.example.com/group/repo' },
          { project: '', url: '   ' },
        ],
        events: ['opened'],
        intent: 'x',
        intervalSeconds: 60,
      },
    })
    expect(getChannelBlockReason('glab', input)).toBeNull()
  })

  it('blocks when no event is selected', () => {
    const input = baseInput({
      glab: { repos: [{ project: 'a/b' }], events: [], intent: 'x', intervalSeconds: 60 },
    })
    expect(getChannelBlockReason('glab', input)).toBe('agentPublish.gitTriggerEventRequired')
  })

  it('blocks when the intent is blank', () => {
    const input = baseInput({
      glab: { repos: [{ project: 'a/b' }], events: ['opened'], intent: '  ', intervalSeconds: 60 },
    })
    expect(getChannelBlockReason('glab', input)).toBe('agentPublish.gitTriggerIntentRequired')
  })

  it.each([29, 601, Number.NaN])('blocks an out-of-range interval (%s)', (intervalSeconds) => {
    const input = baseInput({
      glab: { repos: [{ project: 'a/b' }], events: ['opened'], intent: 'x', intervalSeconds },
    })
    expect(getChannelBlockReason('glab', input)).toBe('agentPublish.gitTriggerIntervalInvalid')
  })

  it.each([30, 600])('accepts the boundary interval %s', (intervalSeconds) => {
    const input = baseInput({
      glab: { repos: [{ project: 'a/b' }], events: ['opened'], intent: 'x', intervalSeconds },
    })
    expect(getChannelBlockReason('glab', input)).toBeNull()
  })

  it('gates the two channels independently', () => {
    // A broken glab config must not block publishing gh.
    const input = baseInput({
      glab: { repos: [], events: [], intent: '', intervalSeconds: 60 },
    })
    expect(isChannelReady('glab', input)).toBe(false)
    expect(isChannelReady('gh', input)).toBe(true)
  })

  it('does not gate on CLI installation or authentication', () => {
    // Those are host properties that can change after publish and are reported
    // as live status instead; gating on them would make the channel
    // unpublishable on a deployment that authenticates the CLI later.
    expect(isChannelReady('glab', baseInput())).toBe(true)
  })

  it('resolves every block-reason key in both locales', () => {
    const bundles = { en, zh } as unknown as Record<string, Record<string, unknown>>
    const reasons = [
      'agentPublish.gitTriggerRepoRequired',
      'agentPublish.gitTriggerEventRequired',
      'agentPublish.gitTriggerIntentRequired',
      'agentPublish.gitTriggerIntervalInvalid',
    ]
    for (const [locale, bundle] of Object.entries(bundles)) {
      for (const key of reasons) {
        const value = key
          .split('.')
          .reduce<unknown>(
            (node, part) =>
              node && typeof node === 'object'
                ? (node as Record<string, unknown>)[part]
                : undefined,
            bundle,
          )
        expect(value, `${key} missing in ${locale}.json`).toEqual(expect.any(String))
      }
    }
  })
})

describe('git trigger channel registry entries', () => {
  it('registers both channels under the git repository filter', () => {
    const gitChannels = CHANNEL_REGISTRY.filter((c) => c.category === 'gitRepo').map((c) => c.key)
    expect(gitChannels.sort()).toEqual(['gh', 'glab'])
  })

  it('keeps both channels switchable rather than always-on', () => {
    for (const key of ['glab', 'gh'] as const) {
      expect(CHANNEL_REGISTRY.find((c) => c.key === key)?.alwaysOn).toBeUndefined()
    }
  })
})
