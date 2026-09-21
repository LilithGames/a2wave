/**
 * E2E tests for OpenTelemetry trace export settings (Settings → Tracing).
 *
 * Covers the secret contract end to end: auth headers are accepted once, persisted encrypted, and
 * only their NAMES come back (as read-only rows whose value stays empty). Also covers "test
 * connection" with an UNSAVED draft endpoint on a port nothing listens on.
 * Writes real global settings rows, so the original `otel` values are restored afterwards.
 */
import { expect, test } from '@playwright/test'
import { getAdminToken } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE, ROUTES } from '../../utils/test-constants'

// Port 9 (discard) is never an OTLP collector: the export fails fast with a connection error.
const UNREACHABLE_COLLECTOR = 'http://127.0.0.1:9'
const HEADER_VALUE = 'Bearer e2e-otel-secret-value'

async function patchOtel(token: string, otel: Record<string, string>) {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ otel }),
  })
  if (!res.ok) throw new Error(`restore otel settings failed: ${res.status}`)
}

test.describe
  .serial('Settings — OpenTelemetry trace export', () => {
    test.beforeEach(async ({ page }) => {
      await loginAsAdmin(page)
    })

    test.afterEach(async () => {
      const token = await getAdminToken()
      await patchOtel(token, {
        enabled: 'false',
        endpoint: '',
        headers: '',
        captureContent: 'false',
        serviceName: '',
      })
    })

    test('saved auth headers come back as names only', async ({ page }) => {
      await page.goto(`${ROUTES.settings}?tab=observability`)
      await page.waitForLoadState('networkidle')

      await page
        .getByRole('textbox', { name: /采集端地址|Collector endpoint/ })
        .fill(UNREACHABLE_COLLECTOR)
      await page.getByRole('button', { name: /添加请求头|Add header/ }).click()
      await page.getByRole('textbox', { name: /^(名称|Name)$/ }).fill('Authorization')
      await page.getByLabel(/^(值|Value)$/).fill(HEADER_VALUE)
      await page.getByRole('button', { name: /^(保存|Save)$/ }).click()

      // After a save the row becomes a saved row: name kept read-only, value cleared.
      const savedName = page.getByRole('textbox', { name: /^(名称|Name)$/ })
      await expect(savedName).toHaveValue('Authorization', { timeout: 5000 })
      await expect(page.getByLabel(/^(值|Value)$/)).toHaveValue('')

      await page.reload()
      await page.waitForLoadState('networkidle')
      await expect(page.getByRole('textbox', { name: /^(名称|Name)$/ })).toHaveValue(
        'Authorization',
      )
      await expect(page.getByRole('textbox', { name: /^(名称|Name)$/ })).not.toBeEditable()
      await expect(page.getByLabel(/^(值|Value)$/)).toHaveValue('')
      await expect(
        page.getByRole('textbox', { name: /采集端地址|Collector endpoint/ }),
      ).toHaveValue(UNREACHABLE_COLLECTOR)

      // No read endpoint may echo the secret back.
      const token = await getAdminToken()
      for (const path of ['/api/settings', '/api/settings/otel/status']) {
        const res = await fetch(`${API_BASE}${path}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(await res.text()).not.toContain('e2e-otel-secret-value')
      }
    })

    test('test connection uses the unsaved draft and explains a refused loopback address', async ({
      page,
    }) => {
      await page.goto(`${ROUTES.settings}?tab=observability`)
      await page.waitForLoadState('networkidle')
      // Typed but never saved: the test must exercise what is in the form.
      await page
        .getByRole('textbox', { name: /采集端地址|Collector endpoint/ })
        .fill(UNREACHABLE_COLLECTOR)
      await page.getByRole('button', { name: /测试连接|Test connection/ }).click()

      await expect(
        page
          .getByText(/host\.docker\.internal|上报失败|Export failed|响应超时|did not respond/)
          .last(),
      ).toBeVisible({ timeout: 15000 })

      // Nothing was persisted by the test.
      const token = await getAdminToken()
      const res = await fetch(`${API_BASE}/api/settings/otel/status`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      expect((await res.json()).data.endpoint).toBe('')
    })
  })
