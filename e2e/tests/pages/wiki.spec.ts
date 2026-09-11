/**
 * 使用手册（Wiki）页面
 *
 * 验证 /wiki 渲染、左侧目录可切换章节、深链可直达章节。
 */
import { expect, test } from '@playwright/test'
import { createTestUser, deleteTestUser, getAdminToken } from '../../utils/api-helpers'
import { dismissOnboarding, loginAs, loginAsAdmin } from '../../utils/auth'
import { NAV_LANDMARKS, ROUTES, TEST_IDS, USER_MENU_ITEMS } from '../../utils/test-constants'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Wiki: user manual page', () => {
  test('renders page and table of contents at /wiki', async ({ page }) => {
    await page.goto(ROUTES.wiki)

    await expect(page.locator('#main-content')).toBeVisible()
    await expect(page.getByRole('heading', { name: '使用手册' })).toBeVisible()

    // 目录里应能看到「快速开始」章节入口
    const toc = page.getByRole('navigation', { name: '目录' })
    await expect(toc.getByRole('link', { name: '快速开始' })).toBeVisible()

    // 落地页默认展示第一章「概览与导航」正文（Markdown 渲染出的一级标题）
    await expect(page.getByRole('heading', { name: '概览与导航', level: 1 })).toBeVisible()
  })

  test('clicking a TOC item switches the section and URL', async ({ page }) => {
    await page.goto(ROUTES.wiki)

    const toc = page.getByRole('navigation', { name: '目录' })
    await toc.getByRole('link', { name: '触发方式' }).click()

    await page.waitForURL('**/wiki/triggers')
    await expect(page.getByRole('heading', { name: '触发方式', level: 1 })).toBeVisible()
  })

  test('deep link to a section loads it directly', async ({ page }) => {
    await page.goto(`${ROUTES.wiki}/agents`)

    await expect(page.locator('#main-content')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Agent 管理', level: 1 })).toBeVisible()
  })

  test('appearance chapter documents personal theme controls', async ({ page }) => {
    await page.goto(`${ROUTES.wiki}/appearance`)

    await expect(page.getByRole('heading', { name: '外观与主题', level: 1 })).toBeVisible()
    await expect(page.getByText('跟随系统', { exact: true }).first()).toBeVisible()
    await expect(page.getByText('Neo Yellow', { exact: true }).first()).toBeVisible()
  })

  test('FAQ explains shared resource budgets and existing deployment upgrades', async ({
    page,
  }) => {
    await page.goto(`${ROUTES.wiki}/faq`)
    await expect(page.getByRole('heading', { name: '重型任务影响同机服务怎么办？' })).toBeVisible()
    await expect(page.getByText(/不是每个 Agent 各有一份/)).toBeVisible()
    await expect(page.getByText(/已有部署不会仅因拉取新镜像而自动获得限额/)).toBeVisible()
  })

  test('content cross-links navigate in-place (no new tab)', async ({ page, context }) => {
    await page.goto(ROUTES.wiki)
    await expect(page.locator('#main-content')).toBeVisible()

    // 正文区（卡片内）的站内交叉链接不应带 target=_blank，点击应原地跳转
    const link = page.locator('.bg-card a[href^="/wiki/"]').first()
    await expect(link).not.toHaveAttribute('target', '_blank')

    const pagesBefore = context.pages().length
    await link.click()
    await page.waitForURL('**/wiki/**')
    expect(context.pages().length).toBe(pagesBefore) // 未开新标签页
  })
})

test.describe('Wiki: entry lives in the user menu', () => {
  test('opens from the user menu and is no longer a main-nav item', async ({ page }) => {
    await page.goto(ROUTES.dashboard)
    // A fresh database shows the FTUE tour, whose mask swallows sidebar clicks.
    await dismissOnboarding(page)

    // The manual moved out of the main navigation into the user menu. Scoped to
    // the nav, not the whole <aside>: the user menu itself lives in the sidebar,
    // so an aside-wide query would match the very link this test then clicks.
    await expect(
      page
        .getByRole('navigation', { name: NAV_LANDMARKS.main })
        .getByRole('link', { name: USER_MENU_ITEMS.wiki }),
    ).toHaveCount(0)

    await page.locator('aside').getByRole('button', { name: /admin/i }).click()
    await page.getByRole('link', { name: USER_MENU_ITEMS.wiki }).click()

    await page.waitForURL(`**${ROUTES.wiki}`)
    await expect(page.getByRole('heading', { name: USER_MENU_ITEMS.wiki })).toBeVisible()
  })

  test('sits directly above the About entry', async ({ page }) => {
    await page.goto(ROUTES.dashboard)
    await dismissOnboarding(page)
    await page.locator('aside').getByRole('button', { name: /admin/i }).click()

    const manual = page.getByRole('link', { name: USER_MENU_ITEMS.wiki })
    const about = page.getByRole('button', { name: USER_MENU_ITEMS.about })
    await expect(manual).toBeVisible()
    await expect(about).toBeVisible()

    const [manualBox, aboutBox] = [await manual.boundingBox(), await about.boundingBox()]
    expect(manualBox && aboutBox && manualBox.y < aboutBox.y).toBe(true)
  })
})

test.describe('Sign out confirmation', () => {
  // Real logout bumps the user's tokenVersion server-side (POST /auth/logout),
  // revoking every outstanding JWT for that identity. Running this as the shared
  // admin would poison auth.ts's cached adminTokenPromise for the rest of the
  // worker — every later test relying on loginAsAdmin would bounce to /login.
  // A disposable per-test user keeps the blast radius to this test alone.
  const PASSWORD = 'TestPass123!'
  let username: string
  let userId: string

  test.beforeEach(async ({ page }) => {
    const adminToken = await getAdminToken()
    username = `e2e-signout-${Date.now()}`
    const user = await createTestUser(adminToken, { username, password: PASSWORD })
    userId = user.id
    await loginAs(page, username, PASSWORD)
  })

  test.afterEach(async () => {
    const adminToken = await getAdminToken()
    await deleteTestUser(adminToken, userId)
  })

  test('cancelling keeps the session, confirming actually signs out', async ({ page }) => {
    await page.goto(ROUTES.dashboard)
    await dismissOnboarding(page)

    // Scope the menu item to the popover (antd portals it to <body>, so it is NOT
    // inside <aside>). The confirmation dialog's button carries the SAME name, so a
    // page-wide locator resolves to two elements during antd's leave animation
    // (Modal destroyOnHidden + Popover fade) and .click() throws a strict-mode
    // violation. Targeted by data-testid rather than antd's private overlay class,
    // which would silently stop matching on a major-version upgrade.
    const openLogoutDialog = async () => {
      await page.locator('aside').getByRole('button', { name: username }).click()
      const menu = page.getByTestId(TEST_IDS.userMenuPopover)
      await menu.getByRole('button', { name: USER_MENU_ITEMS.logout }).click()
      return page.getByRole('dialog')
    }

    // Cancel must leave the session intact — this is the whole point of the
    // confirmation, and jsdom cannot cover it because it mocks useLogout away.
    const dialog = await openLogoutDialog()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: /取\s*消|Cancel/ }).click()
    // Wait for the dialog to actually leave before reopening, so the duplicate
    // "sign out" name cannot exist in two places at once.
    await expect(dialog).toBeHidden()
    await expect(page.locator('#main-content')).toBeVisible()
    expect(new URL(page.url()).pathname).not.toBe(ROUTES.login)

    // Confirm runs the real chain: POST /auth/logout → cache clear → redirect.
    const confirmDialog = await openLogoutDialog()
    await confirmDialog.getByRole('button', { name: USER_MENU_ITEMS.logout }).click()
    await page.waitForURL(`**${ROUTES.login}`)

    // The session cookie is genuinely revoked, not just navigated away from.
    await page.goto(ROUTES.dashboard)
    await page.waitForURL(
      (url) =>
        url.pathname === ROUTES.login && url.searchParams.get('returnTo') === ROUTES.dashboard,
    )
  })
})
