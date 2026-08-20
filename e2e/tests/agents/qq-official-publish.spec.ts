import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { AGENT_ROUTES, API_BASE } from '../../utils/test-constants'

test.describe('QQ Official Bot publishing', () => {
  let agentId = ''
  let token = ''

  test.beforeEach(async ({ page }) => {
    token = await getAdminToken()
    agentId = (await createAgent(token, `qq-official-e2e-${Date.now()}`)).id
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

  test('creates by QR code, saves credentials, and publishes the QQ channel', async ({ page }) => {
    let polls = 0
    await page.route(`**/api/agents/${agentId}/qq-official/registration`, async (route) => {
      const body = route.request().postDataJSON() as { action: string }
      if (body.action === 'start') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            data: {
              taskId: 'task-e2e',
              bindKey: 'bind-key-e2e',
              qrCodeUrl: 'https://q.qq.com/connect?task_id=task-e2e',
              intervalMs: 10,
            },
          }),
        })
        return
      }
      polls += 1
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          data:
            polls < 2
              ? { status: 'pending' }
              : { status: 'completed', appId: '102000000', appSecret: 'e2e-secret' },
        }),
      })
    })

    await page.goto(AGENT_ROUTES.publishTab(agentId, 'qq_official'))
    await expect(page.getByText('群聊回复方式')).toBeVisible()
    await expect(page.getByText('单聊回复方式')).toBeVisible()
    await expect(page.getByText('频道回复方式')).toHaveCount(0)
    await expect(page.getByText('频道私信回复方式')).toHaveCount(0)
    await page.getByRole('button', { name: '扫码创建' }).click()
    await expect(page.getByTestId('qq-official-registration-qr')).toBeVisible()
    await expect(page.getByLabel('App ID')).toHaveValue('102000000', { timeout: 10_000 })
    await expect(page.getByLabel('App Secret')).toHaveValue('e2e-secret')

    await page.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByText('渠道配置已保存')).toBeVisible()

    const enable = page.getByRole('switch', { name: '启用 QQ 官方机器人' })
    await expect(enable).toBeEnabled()
    await enable.click()
    await page.locator('[data-tour="publish-btn"]').click()

    await expect
      .poll(async () => {
        const response = await fetch(`${API_BASE}/api/agents/${agentId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        const body = (await response.json()) as {
          data: { publishChannels?: string[]; qqOfficialConfig?: { appId?: string } }
        }
        return {
          enabled: body.data.publishChannels?.includes('qq_official'),
          appId: body.data.qqOfficialConfig?.appId,
        }
      })
      .toEqual({ enabled: true, appId: '102000000' })
  })
})
