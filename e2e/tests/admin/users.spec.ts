import { expect, test } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Admin: users page', () => {
  test('page renders with title and add button', async ({ page }) => {
    await page.goto(ROUTES.users)

    await expect(page.getByRole('heading', { name: '用户管理' })).toBeVisible()
    await expect(page.getByRole('button', { name: '邀请用户' })).toBeVisible()
  })

  test('users table shows existing users with correct columns', async ({ page }) => {
    await page.goto(ROUTES.users)

    const table = page.locator('.ant-table')
    await expect(table).toBeVisible()

    // Verify column headers
    await expect(table.getByRole('columnheader', { name: '用户名' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '显示名称' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '角色' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '状态' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '创建时间' })).toBeVisible()
    await expect(table.getByRole('columnheader', { name: '操作' })).toBeVisible()

    // 表格至少渲染一行；admin 用户的存在性通过 API 验证（避免累积 e2e 用户把 admin
    // 翻到下页造成断言失败）
    await expect(table.locator('tbody tr').first()).toBeVisible()

    const token = await getAdminToken()
    let foundAdmin = false
    for (let p = 1; p <= 20 && !foundAdmin; p++) {
      const res = await fetch(`${API_BASE}/api/users?page=${p}&pageSize=100`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect(res.ok).toBe(true)
      const body = (await res.json()) as {
        data: Array<{ username: string }>
        pagination: { totalPages: number }
      }
      if (body.data.some((u) => u.username === 'admin')) foundAdmin = true
      if (p >= body.pagination.totalPages) break
    }
    expect(foundAdmin).toBe(true)
  })

  test('invite flow: issue a link and see it listed', async ({ page }) => {
    await page.goto(ROUTES.users)

    await page.getByRole('button', { name: '邀请用户' }).click()

    const dialog = page.locator('[role="dialog"]')
    await expect(dialog.getByRole('heading', { name: '邀请用户' })).toBeVisible()

    const inviteEmail = `e2e_${Date.now()}@company.com`
    await dialog.getByLabel('邮箱').fill(inviteEmail)

    const submitBtn = dialog.getByRole('button', { name: '生成邀请链接' })
    await expect(submitBtn).toBeEnabled()
    await submitBtn.click()

    // Success keeps the dialog open and shows the link — that is the deliverable.
    await expect(dialog.getByText(/\/invite\//)).toBeVisible({ timeout: 5000 })
    await dialog.getByRole('button', { name: '关闭' }).click()

    // The invitation shows up in the invitations drawer, one click from the roster.
    await page.getByRole('button', { name: '邀请记录' }).click()
    await expect(page.getByText(inviteEmail)).toBeVisible({ timeout: 5000 })

    // Cleanup: revoke it so repeat runs do not accumulate live links.
    const row = page.locator('.ant-table-row', { hasText: inviteEmail })
    await row.getByRole('button', { name: '撤销邀请' }).click()
    const confirmModal = page.locator('.ant-modal').filter({ hasText: '撤销该邀请' })
    await confirmModal.locator('button.ant-btn-primary').click()
    await expect(row.getByText('已撤销')).toBeVisible({ timeout: 5000 })
  })

  test('invitee registers through the link and lands signed in', async ({ page, browser }) => {
    // Issue the invitation over the API: this case is about the *invitee's* page, and
    // driving the admin dialog again would only re-test the previous case.
    const token = await getAdminToken(page)
    const stamp = Date.now()
    const res = await page.request.post(`${API_BASE}/users/invitations`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { role: 'user', expiresInHours: 24 },
    })
    expect(res.ok()).toBe(true)
    const { data: invitation } = (await res.json()) as { data: { id: string; code: string } }

    // A fresh context: the invitee is not signed in, and must not inherit the admin cookie.
    const inviteeContext = await browser.newContext()
    const inviteePage = await inviteeContext.newPage()
    try {
      await inviteePage.goto(`/invite/${invitation.code}`)
      await expect(inviteePage.getByTestId('invite-card')).toBeVisible()

      const username = `e2einvitee_${stamp}`
      await inviteePage.getByLabel('用户名').fill(username)
      await inviteePage.getByLabel('邮箱').fill(`${username}@company.com`)
      await inviteePage.getByLabel('密码', { exact: false }).first().fill('TestPass1')
      await inviteePage.getByLabel('确认密码').fill('TestPass1')

      await inviteePage.getByRole('button', { name: '创建账号并登录' }).click()

      // Accept signs the account in, so the invitee lands inside the console, not on /login.
      await expect(inviteePage).not.toHaveURL(/\/login/, { timeout: 10_000 })
      await expect(inviteePage).toHaveURL(/\/$|\/#/, { timeout: 10_000 })

      // The link is single-use: revisiting it reports the invitation as already used.
      await inviteePage.goto(`/invite/${invitation.code}`)
      await expect(inviteePage.getByTestId('invite-unusable')).toBeVisible({ timeout: 5000 })
    } finally {
      await inviteeContext.close()
    }

    // Cleanup: remove the account this test created.
    const list = await page.request.get(`${API_BASE}/users?page=1&pageSize=100`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await list.json()) as { data: Array<{ id: string; username: string }> }
    const created = body.data.find((u) => u.username === `e2einvitee_${stamp}`)
    if (created) {
      await page.request.delete(`${API_BASE}/users/${created.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    }
  })

  test('the invitations drawer is deep-linkable and survives a reload', async ({ page }) => {
    await page.goto(`${ROUTES.users}?view=invitations`)

    // Opened straight from the URL, with no click.
    await expect(page.getByRole('heading', { name: '邀请记录' })).toBeVisible()

    await page.reload()
    await expect(page.getByRole('heading', { name: '邀请记录' })).toBeVisible()

    // Closing drops the param and returns to the roster.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '邀请记录' })).toBeHidden()
    await expect(page).not.toHaveURL(/view=invitations/)
  })

  test('an expired or unknown invite code shows a clear message, not a form', async ({
    browser,
  }) => {
    const context = await browser.newContext()
    const invitePage = await context.newPage()
    try {
      await invitePage.goto('/invite/definitely-not-a-real-code')
      await expect(invitePage.getByTestId('invite-unusable')).toBeVisible({ timeout: 5000 })
      // The registration fields must not render for a code the server rejected.
      await expect(invitePage.getByLabel('确认密码')).toBeHidden()
    } finally {
      await context.close()
    }
  })

  test('reset password dialog renders', async ({ page }) => {
    await page.goto(ROUTES.users)

    // Find the first reset password button in the table
    const resetBtn = page.locator('.ant-table').getByRole('button', { name: '重置密码' }).first()
    await resetBtn.click()

    // Dialog should appear — use heading role to avoid matching the button text
    const dialog = page.locator('[role="dialog"]')
    await expect(dialog.getByRole('heading', { name: '重置密码' })).toBeVisible()
    await expect(dialog.getByPlaceholder('输入新密码')).toBeVisible()
    await expect(dialog.getByRole('button', { name: '重置密码' })).toBeVisible()
  })
})
