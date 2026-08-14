/**
 * E2E coverage for the chat page channel (`chat_app`).
 *
 * Covers the two halves of the feature: enabling the channel in the publish tab
 * and surfacing the link, then opening that link and getting a usable chat page.
 * Also pins the access boundary — a disabled channel must read as unavailable
 * rather than rendering a chat window.
 */
import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { AGENT_ROUTES } from '../../utils/test-constants'

const CHAT_APP_PATH = AGENT_ROUTES.chatApp

test.describe('Chat page channel', () => {
  let agentId: string
  let token: string

  test.beforeEach(async ({ page }) => {
    token = await getAdminToken()
    const agent = await createAgent(token, `chat-app-e2e-${Date.now()}`)
    agentId = agent.id
    await loginAsAdmin(page)
  })

  test.afterEach(async () => {
    // Always clear the id: these agents appear in the shared /agents list, and a
    // leaked one would keep churning that list for every later spec.
    const id = agentId
    agentId = ''
    if (id) await deleteAgentAs(token, id)
  })

  test('page is unavailable while the channel is disabled', async ({ page }) => {
    await page.goto(CHAT_APP_PATH(agentId))
    await expect(page.getByText('页面不可用')).toBeVisible({ timeout: 10000 })
  })

  test('enabling the channel exposes the link and opens a working chat page', async ({ page }) => {
    await page.goto(AGENT_ROUTES.publishTab(agentId, 'chat_app'))

    // `?publishTab=` deep-links straight into the channel's config dialog, whose
    // overlay covers the card grid behind it. Close it to reach the card switch.
    await page.getByRole('button', { name: '取消' }).click()

    // Enable the channel, then publish so the config is persisted.
    const enableSwitch = page.getByRole('switch', { name: '启用对话网页' })
    await expect(enableSwitch).toBeVisible({ timeout: 10000 })
    await enableSwitch.click()

    await expect(page.getByText(`/agents/${agentId}/chat_app`)).toBeVisible()

    await page
      .getByRole('button', { name: /发布|更新渠道/ })
      .first()
      .click()

    // The link now resolves to the real page rather than the unavailable state.
    await page.goto(CHAT_APP_PATH(agentId))
    await expect(page.getByText('页面不可用')).toHaveCount(0)
    await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10000 })
  })

  test('chat page renders without the console sidebar', async ({ page }) => {
    await page.goto(AGENT_ROUTES.publishTab(agentId, 'chat_app'))
    await page.getByRole('button', { name: '取消' }).click()
    const enableSwitch = page.getByRole('switch', { name: '启用对话网页' })
    await expect(enableSwitch).toBeVisible({ timeout: 10000 })
    await enableSwitch.click()
    await page
      .getByRole('button', { name: /发布|更新渠道/ })
      .first()
      .click()

    await page.goto(CHAT_APP_PATH(agentId))
    await expect(page.getByRole('textbox')).toBeVisible({ timeout: 10000 })

    // The console nav is deliberately absent — the page has its own profile aside,
    // so assert on the nav links rather than on the <aside> element itself.
    const sidebar = page.locator('aside')
    await expect(sidebar.getByRole('link', { name: 'Agents' })).toHaveCount(0)
    await expect(sidebar.getByRole('link', { name: '运行记录' })).toHaveCount(0)
    // ...while the agent profile it replaces it with is present.
    await expect(sidebar.getByText('创建者')).toBeVisible()
  })
})
