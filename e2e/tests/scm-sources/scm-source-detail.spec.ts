import { expect, test } from '@playwright/test'
import {
  createScmSource,
  deleteScmSource,
  getAdminToken,
  listScmSources,
  type ScmSourceSummary,
} from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { ROUTES } from '../../utils/test-constants'

// The SCM source create/edit flow is now a MODAL (opened from the list page),
// not a /scm-sources/:id route. This covers the modal's two-tab structure:
//   1) opening the modal by clicking a source card
//   2) Config / Sync & Workspaces tabs both visible and switchable
//   3) the Workspaces list (inside Sync & Workspaces) shows its empty state

let scmSource: ScmSourceSummary

test.beforeAll(async () => {
  const token = await getAdminToken()
  const existing = await listScmSources(token)
  scmSource =
    existing.find((s) => s.type === 'git') ?? (await createScmSource(token, 'E2E SCM Detail Test'))
})

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('SCM Source edit modal — Sync & Workspaces tab', () => {
  test('opening a source shows Config and Sync & Workspaces tabs', async ({ page }) => {
    await page.goto(ROUTES.scmSources)
    await expect(page.locator('#main-content')).toBeVisible()

    // Open the edit modal by clicking the source card.
    await page.getByText(scmSource.name).first().click()

    // Both top-level switches are visible (zh: 配置 / 同步与工作区; en: Config /
    // Sync & Workspaces). They are an antd Segmented control: a radiogroup whose
    // `radio` inputs are visually hidden, so assert on the labels the user sees
    // rather than on getByRole('tab') (which matches nothing) or the inputs.
    const segmented = page.getByRole('dialog').getByRole('radiogroup')
    await expect(segmented.getByText(/^(配置|Config)$/)).toBeVisible()
    await expect(segmented.getByText(/^(同步与工作区|Sync & Workspaces)$/)).toBeVisible()
  })

  test('Sync & Workspaces tab renders the workspaces empty state', async ({ page }) => {
    await page.goto(ROUTES.scmSources)
    await page.getByText(scmSource.name).first().click()

    await page
      .getByRole('dialog')
      .getByRole('radiogroup')
      .getByText(/^(同步与工作区|Sync & Workspaces)$/)
      .click()

    // empty-state copy comes from scmSources.workspaces.empty — verifies the i18n key.
    await expect(page.getByText(/暂无 workspace|No workspaces yet/)).toBeVisible({ timeout: 5000 })
  })
})

test.describe('SCM Source managed storage', () => {
  test('creates a Git source without asking for a container path', async ({ page }) => {
    const token = await getAdminToken()
    const name = `E2E managed SCM ${Date.now()}`
    let created: ScmSourceSummary | undefined
    try {
      await page.goto(ROUTES.scmSources)
      await page.getByRole('button', { name: /创建代码源|Create Source/ }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('radio', { name: /托管存储|Managed storage/ })).toBeVisible()
      await expect(dialog.getByLabel(/本地路径|Local Path/)).toHaveCount(0)
      await dialog.getByLabel(/^名称|^Name/).fill(name)
      await dialog.getByLabel(/仓库地址|Repository URL/).fill('https://github.com/example/repo.git')
      await dialog.getByRole('button', { name: /^创建$|^Create$/ }).click()
      await expect(dialog).toBeHidden()

      created = (await listScmSources(token)).find((source) => source.name === name)
      expect(created?.localPath).toMatch(/sources\//)
    } finally {
      if (created) await deleteScmSource(token, created.id)
    }
  })
})
