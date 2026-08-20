/**
 * Device login (RFC 8628): a headless CLI starts a login, a signed-in browser
 * approves it, and the CLI's poll yields a working token.
 */
import { expect, test } from '@playwright/test'
import { pollDeviceToken, startDeviceLogin } from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'
import { API_BASE } from '../../utils/test-constants'

test.describe('Device login', () => {
  test('approving in the browser issues a token to the waiting CLI', async ({ page }) => {
    const device = await startDeviceLogin()

    // Before approval the CLI is told to keep waiting, not to give up.
    expect((await pollDeviceToken(device.deviceCode)).error).toBe('authorization_pending')

    await loginAsAdmin(page)
    await page.goto(`/device?code=${device.userCode}`)

    // The approver must be shown what they are authorizing.
    await expect(page.getByText(device.userCode)).toBeVisible()
    await expect(page.getByText(/绝不要批准别人发给你的验证码/)).toBeVisible()

    await page.getByRole('button', { name: '批准' }).click()
    await expect(page.getByText('设备已授权')).toBeVisible()

    // Polled immediately after approval, inside the 5s pacing window: pacing must
    // gate pending grants only, or a fast approval is punished with a backoff.
    const claimed = await pollDeviceToken(device.deviceCode)
    expect(claimed.error).toBeUndefined()
    expect(claimed.token).toBeTruthy()

    // The token must be a real session, not just a well-formed string.
    const me = await fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${claimed.token}` },
    })
    expect(me.ok).toBe(true)

    // Single use: replaying the device code must not mint a second token.
    expect((await pollDeviceToken(device.deviceCode)).error).toBe('expired_token')
  })

  test('denying leaves the CLI without a token', async ({ page }) => {
    const device = await startDeviceLogin()

    await loginAsAdmin(page)
    await page.goto(`/device?code=${device.userCode}`)
    await page.getByRole('button', { name: '拒绝' }).click()
    await expect(page.getByText('已拒绝设备登录')).toBeVisible()

    expect((await pollDeviceToken(device.deviceCode)).error).toBe('access_denied')
  })

  test('an unknown code is refused without revealing that it is unknown', async ({ page }) => {
    await loginAsAdmin(page)
    await page.goto('/device?code=ZZZZ-ZZZZ')
    await expect(page.getByText(/已过期或已被使用/)).toBeVisible()
  })

  test('the approve page requires a session', async ({ page }) => {
    // Lending a session to a device presupposes having one.
    await page.goto('/device')
    await page.waitForURL('**/login')
  })
})
