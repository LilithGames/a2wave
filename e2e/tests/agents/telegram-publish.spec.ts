import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { AGENT_ROUTES, API_BASE } from '../../utils/test-constants'

/**
 * Telegram is the only chat channel whose credential block is a single field —
 * the bot identity is the numeric prefix of the token itself, so there is no
 * separate application id to enter. This spec locks in that the card can be
 * configured, enabled and published from the UI alone.
 */
test.describe('Telegram publishing', () => {
  let agentId = ''
  let token = ''

  // A syntactically valid token that no real bot owns: the publish route stores
  // it without contacting Telegram, and the polling loop's getMe failure is
  // logged rather than surfaced, so the UI flow stays deterministic offline.
  const BOT_TOKEN = '123456789:e2e-telegram-token-not-a-real-secret'

  test.beforeEach(async ({ page }) => {
    token = await getAdminToken()
    agentId = (await createAgent(token, `telegram-e2e-${Date.now()}`)).id
    await loginAsAdmin(page)
  })

  test.afterEach(async () => {
    if (!agentId) return
    await fetch(`${API_BASE}/api/agents/${agentId}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => undefined)
    await deleteAgentAs(token, agentId)
    agentId = ''
  })

  test('saves the bot token and publishes the Telegram channel', async ({ page }) => {
    await page.goto(AGENT_ROUTES.publishTab(agentId, 'telegram'))

    // Group and private sections both render; Telegram has no "channel" scene
    // of the kind QQ exposes, so no third reply mode should appear.
    // `exact` matters: the card's own description also contains 「私聊」, so a
    // substring match resolves to two nodes and trips strict mode.
    await expect(page.getByText('群组消息', { exact: true })).toBeVisible()
    await expect(page.getByText('私聊', { exact: true })).toBeVisible()

    const enable = page.getByRole('switch', { name: /启用 Telegram 渠道/ })
    // Readiness gate: with no token saved the switch must stay disabled.
    await expect(enable).toBeDisabled()

    await page.getByLabel('Bot Token').fill(BOT_TOKEN)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('渠道配置已保存')).toBeVisible()

    await expect(enable).toBeEnabled()
    await enable.click()
    await page.locator('[data-tour="publish-btn"]').click()

    await expect
      .poll(async () => {
        const response = await fetch(`${API_BASE}/api/agents/${agentId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const body = (await response.json()) as {
          data: { publishChannels?: string[]; telegramConfig?: { botToken?: string } }
        }
        return {
          enabled: body.data.publishChannels?.includes('telegram'),
          // Owner/editor deliberately get the plaintext token back so the edit
          // form can prefill — the same contract Feishu/Slack/Discord/QQ use.
          // Masking for viewers is covered by the API unit tests.
          storedToken: body.data.telegramConfig?.botToken,
        }
      })
      .toEqual({ enabled: true, storedToken: BOT_TOKEN })
  })

  test('refuses to publish Telegram without a bot token', async ({ page }) => {
    const response = await fetch(`${API_BASE}/api/agents/${agentId}/publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channels: ['api', 'telegram'] }),
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as { code?: string }
    expect(body.code).toBe('TELEGRAM_CONFIG_REQUIRED')

    // The rejected publish must not have flipped the channel on.
    await page.goto(AGENT_ROUTES.publishTab(agentId, 'telegram'))
    await expect(page.getByRole('switch', { name: /启用 Telegram 渠道/ })).not.toBeChecked()
  })
})
