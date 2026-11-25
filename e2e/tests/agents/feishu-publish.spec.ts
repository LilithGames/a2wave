import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { AGENT_ROUTES, ROUTES } from '../../utils/test-constants'

let token: string
let agentId: string

/**
 * Opens the Feishu channel's config dialog.
 *
 * Publish is a channel card grid now, so this deep-links via `?publishTab=`
 * (which auto-opens the dialog) instead of clicking a sub-tab.
 */
async function navigateToFeishuTab(page: import('@playwright/test').Page) {
  if (!agentId) {
    test.skip(true, 'No Feishu test agent exists')
    return
  }
  await page.goto(AGENT_ROUTES.publishTab(agentId, 'feishu'))
  await page.waitForLoadState('networkidle')
  await expect(page.locator('[data-page="agent-detail"]')).toBeVisible({ timeout: 5000 })
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10000 })
}

/** The enable switch lives on the card, not in the dialog. */
function getFeishuEnableSwitch(page: import('@playwright/test').Page) {
  return page.getByTestId('channel-card-feishu').getByRole('switch', { name: '启用飞书机器人' })
}

function getFeishuSendArtifactsSwitch(page: import('@playwright/test').Page) {
  return page
    .locator('div')
    .filter({ has: page.getByText('通过文件发送产物') })
    .filter({ has: page.getByRole('switch') })
    .getByRole('switch')
    .first()
}

/**
 * No-op kept for readability: the config form now renders whether or not the
 * channel is switched on, because configuring before enabling is the normal
 * order. Enabling itself is asserted separately, on the card.
 */
async function enableFeishuChannel(_page: import('@playwright/test').Page) {
  // intentionally empty
}

test.describe('Feishu publish tab', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    token = await getAdminToken()
    const agent = await createAgent(token, `E2E Feishu Test Agent ${Date.now()}`)
    agentId = agent.id
  })

  test.afterAll(async () => {
    if (token && agentId) await deleteAgentAs(token, agentId)
  })

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
  })

  test('the Feishu card exposes a named enable switch', async ({ page }) => {
    await navigateToFeishuTab(page)
    await page.getByRole('button', { name: '取消' }).click()

    await expect(getFeishuEnableSwitch(page)).toBeVisible()
  })

  test('config dialog shows permissions, events and credential inputs', async ({ page }) => {
    await navigateToFeishuTab(page)

    await enableFeishuChannel(page)

    await expect(page.getByText('所需权限')).toBeVisible()
    await expect(page.getByText('事件与回调')).toBeVisible()
    await expect(page.getByText('im:message:send_as_bot')).toBeVisible()
    await expect(page.getByText('im:resource')).toBeVisible()
    await expect(page.getByText('cardkit:card:write')).toBeVisible()
    await expect(page.getByRole('button', { name: '复制 JSON' })).toBeVisible()
    await expect(page.locator('[data-tour="feishu-app-id"]')).toBeVisible()
    await expect(page.locator('[data-tour="feishu-app-secret"]')).toBeVisible()
  })

  test('send artifacts as file switch is visible in the config dialog', async ({ page }) => {
    await navigateToFeishuTab(page)

    await enableFeishuChannel(page)

    await expect(page.getByText('通过文件发送产物')).toBeVisible()
    await expect(
      page.getByText('开启后，Agent 生成的产物将以文件形式直接发送到飞书聊天中'),
    ).toBeVisible()
    await expect(getFeishuSendArtifactsSwitch(page)).toBeVisible()
  })

  test('send artifacts as file switch defaults to on', async ({ page }) => {
    await navigateToFeishuTab(page)

    await enableFeishuChannel(page)

    const sendAsFileSwitch = getFeishuSendArtifactsSwitch(page)
    await expect(sendAsFileSwitch).toHaveAttribute('aria-checked', 'true')
  })

  test('im:resource permission is listed in required permissions', async ({ page }) => {
    await navigateToFeishuTab(page)

    await enableFeishuChannel(page)

    const permissionsSection = page.locator('ul').filter({ hasText: 'im:resource' })
    await expect(permissionsSection.getByText('im:resource')).toBeVisible()
  })

  test('reply mode options are visible in the config dialog', async ({ page }) => {
    await navigateToFeishuTab(page)

    await enableFeishuChannel(page)

    await expect(page.getByText('普通群回复配置')).toBeVisible()
    await expect(page.getByText('话题群回复配置')).toBeVisible()
    const normalSection = page
      .locator('div')
      .filter({ has: page.getByText('普通群回复配置', { exact: true }) })
      .last()
    await expect(normalSection.getByRole('radio', { name: '引用原消息回复' })).toBeVisible()
    await expect(
      normalSection.getByRole('radio', { name: '在原消息下创建话题并回复' }),
    ).toBeVisible()
    await expect(normalSection.getByRole('radio', { name: '新增消息回复' })).toBeVisible()
    await expect(normalSection.getByRole('radio', { name: /无需回复/ })).toBeVisible()
  })

  test('topic reply mention targets are visible in the config dialog', async ({ page }) => {
    await navigateToFeishuTab(page)

    const topicSection = page
      .locator('div')
      .filter({ has: page.getByText('话题群回复配置', { exact: true }) })
      .last()
    await expect(topicSection.getByText('回复时提醒')).toBeVisible()
    await expect(topicSection.getByRole('radio', { name: '@ 当前触发者' })).toBeVisible()
    await expect(topicSection.getByRole('radio', { name: '@ 话题发起人' })).toBeVisible()
    await expect(topicSection.getByRole('radio', { name: '不 @任何人' })).toBeVisible()
  })

  test('an unconfigured Feishu channel cannot be enabled from the card', async ({ page }) => {
    await navigateToFeishuTab(page)

    await page.getByPlaceholder('cli_xxx').clear()
    await page.getByRole('button', { name: '取消' }).click()

    // Replaces the old "publish shows an error" assertion: without credentials
    // the channel is not ready, so the switch is disabled and the user can never
    // reach the state the publish route would reject.
    await expect(getFeishuEnableSwitch(page)).toBeDisabled()
  })
})
