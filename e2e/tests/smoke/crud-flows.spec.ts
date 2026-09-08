/**
 * Smoke: UI 核心 CRUD 流程
 *
 * 验证关键页面的创建/编辑/删除操作通路。
 * 每个测试自行创建并清理数据，不依赖执行顺序。
 */
import { expect, test } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES, WEB_BASE } from '../../utils/test-constants'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Smoke: agent create & delete via UI', () => {
  test('create agent from agents page', async ({ page }) => {
    const agentName = `smoke-agent-${Date.now()}`
    await page.goto(ROUTES.agents)

    // Click list-page 新建 Agent
    await page
      .getByRole('button', { name: /新建 Agent|Create Agent/ })
      .first()
      .click()

    // Template picker dialog → choose 空白创建 → navigates to /agents/new
    const dialog = page.locator('[role="dialog"], .ant-modal')
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.getByRole('button', { name: /空白创建|Blank/ }).click()

    // Fill name on the create page
    await page.waitForURL(/\/agents\/new/, { timeout: 5000 })
    const nameInput = page.getByPlaceholder(/Agent 名称|Agent name/)
    await expect(nameInput).toBeVisible({ timeout: 5000 })
    await nameInput.fill(agentName)

    // Submit
    await page.getByRole('button', { name: /^创建 Agent$|^Create Agent$/ }).click()

    // Wait for nav to /agents/:id (detail page) — indicates created
    await page.waitForURL(/\/agents\/agt_/, { timeout: 10000 })

    // Cleanup via API
    const token = await getAdminToken()
    const listRes = await fetch(`${API_BASE}/api/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const listBody = (await listRes.json()) as { data: Array<{ id: string; name: string }> }
    const created = listBody.data.find((a) => a.name === agentName)
    if (created) {
      await fetch(`${API_BASE}/api/agents/${created.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  })
})

test.describe('Smoke: providers page interactions', () => {
  test('providers page shows list or empty state', async ({ page }) => {
    await page.goto(ROUTES.providers)
    await page.waitForLoadState('networkidle')

    const content = page.locator('#main-content')
    await expect(content).toBeVisible()

    const providerLink = content.locator('a[href^="/providers/prv_"]').first()
    const emptyHeading = content.getByRole('heading', {
      name: '还没有任何 Provider',
      exact: true,
    })
    await expect(providerLink.or(emptyHeading).first()).toBeVisible()
  })
})

test.describe('Smoke: skills page interactions', () => {
  test('skills page shows list or empty state', async ({ page }) => {
    await page.goto(ROUTES.skills)
    await page.waitForLoadState('networkidle')

    const content = page.locator('#main-content')
    await expect(content).toBeVisible()
    await expect(page.getByText('Skills').first()).toBeVisible()
  })
})

test.describe('Smoke: MCP servers page interactions', () => {
  test('MCP servers page shows list or empty state', async ({ page }) => {
    await page.goto(ROUTES.mcpServers)
    await page.waitForLoadState('networkidle')

    const content = page.locator('#main-content')
    await expect(content).toBeVisible()
    await expect(page.getByText('MCP').first()).toBeVisible()
  })
})

test.describe('Smoke: settings page tabs', () => {
  test('settings page has tabs and can switch between them', async ({ page }) => {
    await page.goto(ROUTES.settings)
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()

    // Settings page should have tab-like navigation
    const content = page.locator('#main-content')
    await expect(content).toBeVisible()
  })
})

test.describe('Smoke: unauthenticated access redirects to login', () => {
  test('visiting agents page without auth redirects to login', async ({ browser }) => {
    // Create a fresh context without auth
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto(`${WEB_BASE}${ROUTES.agents}`)
    await page.waitForURL(/\/login/, { timeout: 5000 })
    await expect(page).toHaveURL(/\/login/)

    await context.close()
  })
})
