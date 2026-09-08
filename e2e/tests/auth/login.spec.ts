import { expect, test } from '@playwright/test'
import { getE2ePassword, ROUTES } from '../../utils/test-constants'

test.describe('Auth: login page', () => {
  test('login page renders with brand and form', async ({ page }) => {
    await page.goto(ROUTES.login)

    await expect(page.getByRole('heading', { name: 'A2WAVE' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
    const usernameInput = page.getByPlaceholder(
      /输入用户名|默认用户名|Enter username|Default username/i,
    )
    await expect(usernameInput).toBeVisible()
    await expect(page.getByPlaceholder(/输入密码|Enter password|Password/i)).toBeVisible()
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
  })

  test('unauthenticated access redirects to /login', async ({ page }) => {
    await page.goto(ROUTES.dashboard)
    await page.waitForURL(
      (url) =>
        url.pathname === ROUTES.login && url.searchParams.get('returnTo') === ROUTES.dashboard,
    )
    await expect(page.getByRole('heading', { name: '登录' })).toBeVisible()
  })

  test('wrong credentials show error message', async ({ page }) => {
    await page.goto(ROUTES.login)

    await page
      .getByPlaceholder(/输入用户名|默认用户名|Enter username|Default username/i)
      .fill('admin')
    await page.getByPlaceholder(/输入密码|Enter password|Password/i).fill('wrongpassword')
    await page.getByRole('button', { name: '登录', exact: true }).click()

    await expect(page.getByText(/用户名或密码错误|Invalid username or password/i)).toBeVisible()
  })

  test('correct credentials redirect to dashboard', async ({ page }) => {
    await page.goto(ROUTES.login)
    const password = getE2ePassword()

    await page
      .getByPlaceholder(/输入用户名|默认用户名|Enter username|Default username/i)
      .fill('admin')
    await page.getByPlaceholder(/输入密码|Enter password|Password/i).fill(password)
    await page.getByRole('button', { name: '登录', exact: true }).click()

    await page.waitForURL('**/')
    await expect(page.locator('aside')).toBeVisible()
    await expect(page.locator('#main-content')).toBeVisible()
  })
})
