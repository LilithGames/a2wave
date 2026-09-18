import { expect, test } from '@playwright/test'
import { getAdminToken, listProviders } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { ROUTES } from '../../utils/test-constants'

test('Codex provider shows server account quota without refresh controls', async ({ page }) => {
  test.skip(process.env.A2WAVE_FAKE_PROVIDER_E2E === '0', 'Requires deterministic fake Codex quota')
  const providers = await listProviders(await getAdminToken())
  const codex = providers.find((provider) => provider.kind === 'codex')
  if (!codex) throw new Error('Codex preset is required')
  await loginAsAdmin(page)
  await page.goto(`${ROUTES.providers}/${codex.id}`)
  const quota = page.getByRole('region', { name: '账号额度' })
  await expect(quota.getByText('剩余 76%')).toBeVisible()
  await expect(quota.getByRole('progressbar', { name: /每周额度/ })).toHaveAttribute(
    'aria-valuenow',
    '76',
  )
  await expect(quota.getByRole('progressbar')).toHaveCount(1)
  await expect(quota.locator('time')).toHaveAttribute(
    'datetime',
    new Date(1800000000000).toISOString(),
  )
  await expect(quota.getByText(/包含在 a2wave 之外的使用/)).toBeVisible()
  await expect(quota.getByRole('button')).toHaveCount(0)
  await quota.screenshot({ path: test.info().outputPath('codex-quota.png') })
})
