/**
 * Agent Evaluation: end-to-end flow for evaluation sets and cases.
 *
 * Each test creates its own Agent and cleans it up afterwards, so nothing
 * depends on execution order.
 *
 * Only paths that do not start a real engine are covered — launching an
 * evaluation task spawns a CLI subprocess whose duration depends on external
 * credentials, which does not belong in a smoke test.
 */
import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { ROUTES } from '../../utils/test-constants'

test.describe('Agent evaluation', () => {
  let token: string
  let agentId: string

  test.beforeEach(async ({ page }) => {
    token = await getAdminToken()
    const agent = await createAgent(token, `eval-agent-${Date.now()}`)
    agentId = agent.id
    await loginAsAdmin(page)
  })

  test.afterEach(async () => {
    if (agentId) await deleteAgentAs(token, agentId)
  })

  test('evaluation tab sits after channels', async ({ page }) => {
    await page.goto(`${ROUTES.agents}/${agentId}`)

    const tabs = page.getByRole('tab')
    await expect(tabs.filter({ hasText: /评测|Evaluation/ })).toBeVisible()

    const labels = await tabs.allInnerTexts()
    const configIndex = labels.findIndex((l) => /配置|Config/.test(l))
    const channelsIndex = labels.findIndex((l) => /渠道|Channels/.test(l))
    const evalIndex = labels.findIndex((l) => /评测|Evaluation/.test(l))

    expect(configIndex).toBeGreaterThanOrEqual(0)
    expect(channelsIndex).toBeGreaterThan(configIndex)
    expect(evalIndex).toBeGreaterThan(channelsIndex)
  })

  test('deep link opens the evaluation tab directly', async ({ page }) => {
    await page.goto(`${ROUTES.agents}/${agentId}?tab=evaluation`)

    await expect(page.getByRole('button', { name: /新建评测集|New Set/ })).toBeVisible({
      timeout: 5000,
    })
  })

  test('creates a set, then a multi-turn case', async ({ page }) => {
    await page.goto(`${ROUTES.agents}/${agentId}?tab=evaluation`)

    // --- Create an evaluation set ---
    await page.getByRole('button', { name: /新建评测集|New Set/ }).click()

    const setName = `set-${Date.now()}`
    const setDialog = page.getByRole('dialog')
    await setDialog.getByLabel(/名称|Name/).fill(setName)
    await setDialog.getByRole('button', { name: /^创建$|^Create$/ }).click()

    await expect(page.getByRole('heading', { name: setName })).toBeVisible({ timeout: 5000 })

    // --- Create a two-turn case ---
    await page.getByRole('button', { name: /新建用例|New Case/ }).click()

    // No name field: the case name is derived from its first request.
    await page
      .getByLabel(/^请求$|^Request$/)
      .first()
      .fill('我要退款')
    await page
      .getByLabel(/期望应答|Expected reply/)
      .first()
      .fill('先询问下单日期')

    // Add a second turn to exercise multi-turn editing.
    await page.getByRole('button', { name: /添加一轮|Add turn/ }).click()
    await page
      .getByLabel(/^请求$|^Request$/)
      .nth(1)
      .fill('40 天前')
    await page
      .getByLabel(/期望应答|Expected reply/)
      .nth(1)
      .fill('说明超过退货期')

    await page
      .getByRole('button', { name: /^保存$|^Save$/ })
      .last()
      .click()

    // Once persisted, the case takes its name from the first turn's request and shows the turn count.
    await expect(page.getByText('我要退款').first()).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/2 轮|2 turns/)).toBeVisible()
  })

  test('empty state prompts creating a set', async ({ page }) => {
    await page.goto(`${ROUTES.agents}/${agentId}?tab=evaluation`)

    await expect(page.getByText(/未选择评测集|No evaluation set selected/)).toBeVisible({
      timeout: 5000,
    })
  })

  test('tasks sub-tab shows an empty state before any run', async ({ page }) => {
    await page.goto(`${ROUTES.agents}/${agentId}?tab=evaluation&evalTab=tasks`)

    await expect(page.getByText(/还没有评测记录|No evaluation runs yet/)).toBeVisible({
      timeout: 5000,
    })
  })
})
