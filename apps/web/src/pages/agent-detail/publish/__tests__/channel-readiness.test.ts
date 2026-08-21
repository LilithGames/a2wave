import { describe, expect, it } from 'vitest'
import { type ChannelReadinessInput, getChannelBlockReason } from '../channel-readiness'

function input(overrides: Partial<ChannelReadinessInput> = {}): ChannelReadinessInput {
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
    // Both git-trigger channels ready by default: this file covers the other
    // channels, and their own gate is exercised in git-trigger-readiness.test.ts.
    glab: { repos: [{ project: 'g/r' }], events: ['opened'], intent: 'x', intervalSeconds: 60 },
    gh: { repos: [{ project: 'o/r' }], events: ['opened'], intent: 'x', intervalSeconds: 60 },
    ...overrides,
  }
}

describe('getChannelBlockReason: oauth', () => {
  // The OAuth channel used to borrow the Feishu app's visibility scope, so it was blocked
  // without Feishu credentials. It authorizes on its own now — an OAuth-only Agent must not
  // be forced to configure an unrelated channel.
  it('is ready in all_idaas_users mode with no credentials configured', () => {
    expect(getChannelBlockReason('oauth', input())).toBeNull()
  })

  it('is ready in specified_users mode once at least one address is listed', () => {
    expect(
      getChannelBlockReason(
        'oauth',
        input({ oauthAccessMode: 'specified_users', oauthAllowedEmails: ['alice@example.com'] }),
      ),
    ).toBeNull()
  })

  /**
   * Publishing an empty list produces a channel that is switched on but denies every call,
   * which reads as a broken Agent rather than a deliberate setting. Blocking here is what
   * makes the migrated `feishu_scope` Agents visibly need attention.
   */
  it('blocks specified_users mode while the list is empty', () => {
    expect(getChannelBlockReason('oauth', input({ oauthAccessMode: 'specified_users' }))).toBe(
      'agentPublish.oauthAllowedEmailsEmpty',
    )
  })

  it('ignores an empty list when the mode is all_idaas_users', () => {
    expect(
      getChannelBlockReason(
        'oauth',
        input({ oauthAccessMode: 'all_idaas_users', oauthAllowedEmails: [] }),
      ),
    ).toBeNull()
  })
})
