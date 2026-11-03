import { expect, type Page, test } from '@playwright/test'
import {
  createAgentWithPayload,
  deleteAgentAs,
  getAdminToken,
  listProviders,
} from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'

const firstAccount = {
  id: 'poa_e2e_first',
  providerId: '',
  label: 'E2E primary',
  email: 'first@example.test',
  subject: 'sub_one',
  clientId: 'client_one',
  status: 'ready',
  canManage: true,
  createdByUserId: 'usr_e2e',
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const secondAccount = {
  ...firstAccount,
  id: 'poa_e2e_second',
  label: 'E2E secondary',
  email: 'second@example.test',
  subject: 'sub_two',
  clientId: 'client_two',
}

/** OAuth itself is external. These fixtures exercise the complete Web selection and save flow. */
async function mockAccounts(page: Page, providerId: string) {
  let connected = false
  await page.route(`**/api/providers/${providerId}/oauth-accounts**`, async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/login')) {
      return route.fulfill({
        json: {
          data: {
            loginId: 'pol_e2e',
            loginToken: 'e2e-one-time-code',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        },
      })
    }
    if (path.includes('/logins/'))
      return route.fulfill({
        json: {
          data: connected
            ? { status: 'completed', accountId: secondAccount.id }
            : { status: 'pending' },
        },
      })
    return route.fulfill({
      json: {
        data: (connected ? [firstAccount, secondAccount] : [firstAccount]).map((a) => ({
          ...a,
          providerId,
        })),
      },
    })
  })
  return () => {
    connected = true
  }
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test('Codex Provider manages multiple ChatGPT accounts without putting its connection code in the command', async ({
  page,
}, testInfo) => {
  const token = await getAdminToken()
  const provider = (await listProviders(token)).find((p) => p.kind === 'codex')
  if (!provider) throw new Error('Codex Provider is missing')
  const complete = await mockAccounts(page, provider.id)
  await page.goto(`/providers/${provider.id}`)
  const card = page.getByTestId('chatgpt-accounts-card')
  await expect(card.getByTestId(`chatgpt-account-row-${firstAccount.id}`)).toBeVisible()
  await card.getByTestId('chatgpt-connect-button').click()
  await page.getByTestId('chatgpt-generate-code').click()
  const command = page.getByTestId('chatgpt-login-command')
  await expect(command).toContainText('providers accounts login')
  await expect(command).not.toContainText('e2e-one-time-code')
  await page.screenshot({ path: testInfo.outputPath('chatgpt-login-dialog.png') })
  complete()
  await expect(card.getByTestId(`chatgpt-account-row-${secondAccount.id}`)).toBeVisible({
    timeout: 15_000,
  })
  await page.screenshot({ path: testInfo.outputPath('chatgpt-provider.png') })
})

test('an Agent can select an existing account and connect another before saving its account reference', async ({
  page,
}, testInfo) => {
  const token = await getAdminToken()
  const provider = (await listProviders(token)).find((p) => p.kind === 'codex')
  if (!provider) throw new Error('Codex Provider is missing')
  const agent = await createAgentWithPayload(token, {
    name: `e2e-chatgpt-${Date.now()}`,
    type: 'cursor',
    providerId: provider.id,
    authMode: 'apiKey',
    config: {
      model: 'test-model',
      providerChain: [
        {
          id: 'primary',
          providerId: provider.id,
          authMode: 'apiKey',
          enabled: true,
          model: 'test-model',
        },
      ],
    },
  })
  try {
    const complete = await mockAccounts(page, provider.id)
    const probedAccounts: string[] = []
    await page.route('**/api/providers/probe-models', async (route) => {
      const request = route.request().postDataJSON()
      if (request.authMode === 'oauth') probedAccounts.push(request.oauthAccountId)
      return route.fulfill({ json: { data: { models: ['gpt-e2e-codex'] } } })
    })
    let saved: Record<string, unknown> | undefined
    await page.route(`**/api/agents/${agent.id}`, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue()
      saved = route.request().postDataJSON()
      return route.fulfill({ json: { data: { ...agent, ...saved } } })
    })
    await page.goto(`/agents/${agent.id}`)
    await page.getByTestId('provider-chain-header-0').click()
    await page
      .getByTestId('provider-chain-auth-mode-0')
      .getByRole('radio', { name: /OAuth|ChatGPT/ })
      .check()
    const picker = page.getByTestId('chatgpt-account-picker')
    await picker.click()
    await page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
      .last()
      .getByText(/E2E primary/)
      .click()
    await expect(picker).toContainText('E2E primary')
    await page.getByTestId('provider-chain-item-0').getByTestId('chatgpt-connect-button').click()
    await page.getByTestId('chatgpt-generate-code').click()
    await expect(page.getByTestId('chatgpt-login-command')).toBeVisible()
    complete()
    await expect(picker).toContainText('E2E secondary', { timeout: 15_000 })
    await expect.poll(() => probedAccounts).toContain(secondAccount.id)
    const models = page.getByTestId('provider-chain-model-select-0')
    await models.click()
    await page
      .locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')
      .last()
      .locator('.ant-select-item-option')
      .filter({ hasText: 'gpt-e2e-codex' })
      .click()
    expect(saved).toBeUndefined()
    await page.screenshot({ path: testInfo.outputPath('chatgpt-agent.png') })
    await page.getByTestId('agent-detail-save').click()
    await expect.poll(() => saved?.providerOauthAccountId).toBe(secondAccount.id)
    const config = saved?.config as {
      providerChain: { providerOauthAccountId?: string; providerOauthToken?: string | null }[]
    }
    expect(config.providerChain[0].providerOauthAccountId).toBe(secondAccount.id)
    expect(config.providerChain[0].providerOauthToken).toBeFalsy()
  } finally {
    await deleteAgentAs(token, agent.id)
  }
})
