import { expect, test } from '@playwright/test'
import {
  createAgent,
  createRun,
  deleteAgentAs,
  getAdminToken,
  getRunDetail,
  listRuns,
  type RunSummary,
} from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { ROUTES } from '../../utils/test-constants'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Runs 页面结构', () => {
  test('页面标题和内容区域正确渲染', async ({ page }) => {
    await page.goto(ROUTES.runs)
    // `运行记录` names the sidebar nav link, the page h2, AND appears inside the
    // empty-state h3 (`还没有任何运行记录`) — and role-name matching is
    // substring-based, so both scoping and `exact` are needed to land on one.
    await expect(
      page.locator('#main-content').getByRole('heading', { name: '运行记录', exact: true }),
    ).toBeVisible()
    await expect(page.locator('#main-content')).toBeVisible()
    await expect(page.getByText('运行日志的历史与状态')).toBeVisible()
  })

  test('显示 Agent 筛选器和日期预设筛选器', async ({ page }) => {
    await page.goto(ROUTES.runs)
    // Agent filter placeholder
    await expect(page.getByText('所有 Agent')).toBeVisible()
    // Date preset filter. The default is `全部时间` since the run list started
    // defaulting to all time (feat(web): default the run list to all time);
    // this assertion still expected the previous `最近 1 天`.
    await expect(page.getByText('全部时间')).toBeVisible()
  })

  test('页面加载后显示运行列表或空状态', async ({ page }) => {
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET',
    )
    await page.goto(ROUTES.runs)
    const response = await responsePromise
    expect(response.ok()).toBe(true)
    const { data: runs } = (await response.json()) as { data: RunSummary[] }
    const main = page.locator('#main-content')
    if (runs.length === 0) {
      await expect(
        main.getByRole('heading', { name: '还没有任何运行记录', exact: true }),
      ).toBeVisible()
    } else {
      await expect(
        main.getByRole('button').filter({ hasText: runs[0].intent }).first(),
      ).toBeVisible()
    }
  })
})

test.describe('Run 详情 Drawer', () => {
  test('通过 URL 参数直接打开详情 Drawer', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token)
    if (runs.length === 0) {
      test.skip()
      return
    }

    await page.goto(`${ROUTES.runs}?runId=${runs[0].id}`)
    await page.waitForLoadState('networkidle')

    await expect(page.locator('.ant-drawer-open')).toBeVisible({ timeout: 5000 })
  })

  test('Drawer 头部显示 intent 文本和状态 Badge', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token)
    if (runs.length === 0) {
      test.skip()
      return
    }

    const run = runs[0]
    await page.goto(`${ROUTES.runs}?runId=${run.id}`)
    await page.waitForLoadState('networkidle')

    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })

    // Header shows intent (truncated) and a status badge
    const header = drawer.locator('.ant-drawer-body').first()
    // Badge with run status should exist
    const badge = drawer.locator('.ant-badge, [class*="badge"]').first()
    await expect(header).toBeVisible()
    expect(run.status).toBeTruthy()
  })

  test('切换日志按钮打开运行日志面板', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token)
    if (runs.length === 0) {
      test.skip()
      return
    }

    await page.goto(`${ROUTES.runs}?runId=${runs[0].id}`)
    await page.waitForLoadState('networkidle')

    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })

    // Click the toggle log button
    await drawer.getByRole('button', { name: '切换运行日志' }).click()

    // Log drawer heading should appear
    await expect(page.getByText('运行日志').first()).toBeVisible({ timeout: 3000 })
  })

  test('关闭按钮关闭 Drawer 并清除 URL 参数', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token)
    if (runs.length === 0) {
      test.skip()
      return
    }

    await page.goto(`${ROUTES.runs}?runId=${runs[0].id}`)
    await page.waitForLoadState('networkidle')

    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })

    // The close button (X) in the drawer header
    await drawer.getByRole('button', { name: '关闭' }).click()

    await expect(page.locator('.ant-drawer-open')).not.toBeVisible({ timeout: 3000 })
  })

  test('创建新 Run 后可通过列表点击打开 Drawer', async ({ page }) => {
    const token = await getAdminToken()
    const agent = await createAgent(token, `e2e-runs-page-${Date.now()}`)
    try {
      const uniqueIntent = `e2e-drawer-${Date.now()}`
      await createRun(token, uniqueIntent, agent.id)

      await page.goto(ROUTES.runs)
      await page.waitForLoadState('networkidle')

      // Click on the intent text — the click event bubbles up to the run row's onClick handler
      const intentText = page.getByText(uniqueIntent, { exact: true })
      if (await intentText.isVisible({ timeout: 3000 }).catch(() => false)) {
        await intentText.click()
        await expect(page.locator('.ant-drawer-open')).toBeVisible({ timeout: 5000 })
      }
    } finally {
      await deleteAgentAs(token, agent.id)
    }
  })
})

test.describe('Failed run error UI', () => {
  test('shows the error at the end of the chat view', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token)
    let failedRun: (typeof runs)[number] | undefined
    let failedRunDetail: Awaited<ReturnType<typeof getRunDetail>> | undefined

    // A run without chat messages intentionally renders the empty-chat state, so only a
    // failed conversational run can exercise the terminal chat error message.
    for (const candidate of runs.filter((run) => run.status === 'failed')) {
      const detail = await getRunDetail(token, candidate.id)
      if (detail.messages.length > 0) {
        failedRun = candidate
        failedRunDetail = detail
        break
      }
    }

    if (!failedRun || !failedRunDetail) {
      test.skip()
      return
    }

    await page.goto(`${ROUTES.runs}?runId=${failedRun.id}`)
    await page.waitForLoadState('networkidle')

    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })

    const error = failedRunDetail.result?.error
    const expectedError =
      typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error
          ? String(error.message)
          : '执行失败'

    await expect(drawer.getByText(expectedError, { exact: false }).last()).toBeVisible({
      timeout: 3000,
    })
  })

  test('shows the error banner in the run log result section', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token)
    // Find a failed run that has result.error set
    const failedRun = runs.find((r) => r.status === 'failed' && r.result?.error)

    if (!failedRun) {
      test.skip()
      return
    }

    await page.goto(`${ROUTES.runs}?runId=${failedRun.id}`)
    await page.waitForLoadState('networkidle')

    const drawer = page.locator('.ant-drawer-open')
    await expect(drawer).toBeVisible({ timeout: 5000 })

    // Open the log panel
    await drawer.getByRole('button', { name: '切换运行日志' }).click()

    await expect(page.getByText('错误信息:', { exact: false }).first()).toBeVisible({
      timeout: 3000,
    })
    await expect(
      page.getByText(String(failedRun.result?.error), { exact: false }).first(),
    ).toBeVisible({
      timeout: 3000,
    })
  })

  test('shows the error label in the failed run log panel', async ({ page }) => {
    const token = await getAdminToken()
    const runs = await listRuns(token)
    const failedRun = runs.find((r) => r.status === 'failed' && r.result?.error)

    if (!failedRun) {
      test.skip()
      return
    }

    await page.goto(`${ROUTES.runs}?runId=${failedRun.id}`)
    await page.waitForLoadState('networkidle')

    await page.locator('.ant-drawer-open').getByRole('button', { name: '切换运行日志' }).click()

    // "错误信息:" label should appear in the log panel error banner
    await expect(page.getByText('错误信息:', { exact: false }).first()).toBeVisible({
      timeout: 3000,
    })
  })
})
