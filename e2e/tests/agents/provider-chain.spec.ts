import { expect, test } from '@playwright/test'
import {
  createAgentWithPayload,
  deleteAgentAs,
  getAdminToken,
  getAgent,
  listProviders,
  type ProviderSummary,
} from '../../utils/api-helpers'
import { loginAsAdmin } from '../../utils/auth'

/**
 * Providers no longer carry a model catalog — the list is probed from the CLI
 * against each Agent's own credentials — so these API-level fixtures name a
 * model per kind instead of reading one off the Provider.
 */
const E2E_MODEL_BY_KIND: Record<string, string> = {
  'claude-code': 'claude-sonnet-4-6',
  cursor: 'composer-1',
  codex: 'gpt-5.3-codex',
}

function enabledModel(provider: ProviderSummary): string | undefined {
  return E2E_MODEL_BY_KIND[provider.kind]
}

async function selectAntdOption(
  page: import('@playwright/test').Page,
  testId: string,
  label: string,
) {
  await page.getByTestId(testId).click()
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last()
  await expect(dropdown).toBeVisible({ timeout: 5000 })
  await dropdown.getByTitle(label).click()
}

async function dragProviderRow(
  page: import('@playwright/test').Page,
  fromIndex: number,
  toIndex: number,
) {
  const handle = page.getByTestId(`provider-chain-drag-${fromIndex}`)
  const target = page.getByTestId(`provider-chain-item-${toIndex}`)
  const handleBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  if (!handleBox || !targetBox) throw new Error('Provider drag target not visible')

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + handleBox.width / 2, targetBox.y + targetBox.height * 0.75, {
    steps: 18,
  })
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await loginAsAdmin(page)
})

test.describe('Agent provider chain compatibility', () => {
  test('opens legacy provider config as a chain item and saves without losing old config', async ({
    page,
  }) => {
    const token = await getAdminToken()
    const providers = await listProviders(token)
    const primary = providers.find((p) => p.name === 'Claude Code') ?? providers[0]
    const secondary = providers.find((p) => p.id !== primary.id) ?? providers[1]
    expect(primary, 'primary provider fixture').toBeTruthy()
    expect(secondary, 'secondary provider fixture').toBeTruthy()

    const agent = await createAgentWithPayload(token, {
      name: `e2e-legacy-provider-${Date.now()}`,
      type: 'cursor',
      providerId: primary.id,
      authMode: 'apiKey',
      providerApiKey: 'legacy-api-key',
      providerBaseUrl: 'https://legacy.example.com',
      config: {
        model: enabledModel(primary),
        force: true,
        timeoutMinutes: 10,
        maxRetries: 2,
      },
    })

    try {
      const before = await getAgent(token, agent.id)
      expect(Array.isArray(before.config?.providerChain)).toBe(false)

      await page.goto(`/agents/${agent.id}`)
      await expect(page.getByTestId('provider-chain-list')).toBeVisible({ timeout: 8000 })
      await expect(page.getByTestId('provider-chain-item-0')).toContainText(primary.name)
      await expect(page.getByTestId('provider-chain-item-0')).toContainText(
        /使用 API Key|Use API Key/,
      )
      await expect(page.getByTestId('provider-chain-item-1')).toHaveCount(0)

      await page.getByTestId('provider-chain-add').click()
      await selectAntdOption(page, 'provider-chain-provider-select-1', secondary.name)
      await page
        .getByTestId('provider-chain-auth-mode-1')
        .getByText(/使用服务器登录态|Use server's login session/)
        .click()

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/agents/${agent.id}`) &&
          response.request().method() === 'PATCH',
      )
      await page.getByTestId('agent-detail-save').click()
      const response = await responsePromise
      expect(response.ok()).toBe(true)

      const after = await getAgent(token, agent.id)
      const chain = after.config?.providerChain as Array<Record<string, unknown>>
      expect(chain).toHaveLength(2)
      expect(chain[0]).toMatchObject({ providerId: primary.id, authMode: 'apiKey' })
      expect(chain[0]?.providerApiKey).toBeTruthy()
      expect(chain[1]).toMatchObject({ providerId: secondary.id, authMode: 'localSession' })
      expect(chain[1]?.providerApiKey ?? null).toBeNull()
      expect(after.providerId).toBe(primary.id)
      expect(after.authMode).toBe('apiKey')
    } finally {
      await deleteAgentAs(token, agent.id)
    }
  })

  /**
   * The level list is discovered per credential, and in an environment where no
   * CLI or key is present it cannot be discovered at all — the same situation as
   * a self-hosted proxy that reports bare model ids. A stored level must survive
   * that: the control degrades to disabled, but saving the page must not silently
   * drop a setting the operator configured elsewhere.
   */
  test('keeps a stored reasoning level and fast mode through a save that cannot probe levels', async ({
    page,
  }) => {
    const token = await getAdminToken()
    const providers = await listProviders(token)
    const claude = providers.find((p) => p.kind === 'claude-code')
    expect(claude, 'claude-code provider fixture').toBeTruthy()
    if (!claude) return

    const agent = await createAgentWithPayload(token, {
      name: `e2e-reasoning-controls-${Date.now()}`,
      type: 'cursor',
      providerId: claude.id,
      authMode: 'apiKey',
      providerApiKey: 'primary-api-key',
      config: {
        model: enabledModel(claude),
        providerChain: [
          {
            id: 'pc_primary',
            providerId: claude.id,
            model: enabledModel(claude),
            authMode: 'apiKey',
            providerApiKey: 'primary-api-key',
            reasoningEffort: 'xhigh',
            fastMode: true,
            enabled: true,
          },
        ],
        force: true,
        timeoutMinutes: 10,
        maxRetries: 2,
      },
    })

    try {
      await page.goto(`/agents/${agent.id}`)
      await expect(page.getByTestId('provider-chain-item-0')).toContainText(claude.name, {
        timeout: 8000,
      })

      // Both controls live in the entry's collapsed body — a saved chain renders
      // every entry closed, so the row has to be opened before either exists.
      const header = page.getByTestId('provider-chain-header-0')
      await expect(header).toHaveAttribute('aria-expanded', 'false')
      await header.click()
      await expect(header).toHaveAttribute('aria-expanded', 'true')

      const fastMode = page.getByTestId('provider-chain-fast-mode-0')
      await expect(fastMode).toBeVisible()
      await expect(fastMode).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByTestId('provider-chain-reasoning-effort-0')).toContainText('xhigh')

      const save = async () => {
        const responsePromise = page.waitForResponse(
          (response) =>
            response.url().includes(`/api/agents/${agent.id}`) &&
            response.request().method() === 'PATCH',
        )
        await page.getByTestId('agent-detail-save').click()
        expect((await responsePromise).ok()).toBe(true)
        const after = await getAgent(token, agent.id)
        const chain = (after.config?.providerChain ?? []) as Array<Record<string, unknown>>
        return chain[0]
      }

      // Off first. Asserted as ABSENT rather than `?? false`: the serializer
      // writes `undefined` for off, and `?? false` would read a chain that lost
      // the field entirely as the expected result.
      await fastMode.click()
      await expect(fastMode).toHaveAttribute('aria-checked', 'false')
      const afterOff = await save()
      expect(afterOff?.reasoningEffort).toBe('xhigh')
      expect(afterOff?.fastMode).toBeUndefined()

      // Then back on, through the real UI rather than an API seed — otherwise
      // nothing proves the switch can turn fast mode ON at all.
      await fastMode.click()
      await expect(fastMode).toHaveAttribute('aria-checked', 'true')
      const afterOn = await save()
      expect(afterOn?.fastMode).toBe(true)
      expect(afterOn?.reasoningEffort).toBe('xhigh')
    } finally {
      await deleteAgentAs(token, agent.id)
    }
  })

  test('reorders provider chain with drag and persists the new fallback order', async ({
    page,
  }) => {
    const token = await getAdminToken()
    const providers = await listProviders(token)
    const primary = providers.find((p) => p.name === 'Claude Code') ?? providers[0]
    const secondary =
      providers.find((p) => p.name === 'Codex CLI') ?? providers.find((p) => p.id !== primary.id)
    expect(primary, 'primary provider fixture').toBeTruthy()
    expect(secondary, 'secondary provider fixture').toBeTruthy()

    const agent = await createAgentWithPayload(token, {
      name: `e2e-provider-chain-drag-${Date.now()}`,
      type: 'cursor',
      providerId: primary.id,
      authMode: 'apiKey',
      providerApiKey: 'primary-api-key',
      config: {
        model: enabledModel(primary),
        providerChain: [
          {
            id: 'pc_primary',
            providerId: primary.id,
            model: enabledModel(primary),
            authMode: 'apiKey',
            providerApiKey: 'primary-api-key',
            enabled: true,
          },
          {
            id: 'pc_secondary',
            providerId: secondary.id,
            model: enabledModel(secondary),
            authMode: 'localSession',
            enabled: true,
          },
        ],
        force: true,
        timeoutMinutes: 10,
        maxRetries: 2,
      },
    })

    try {
      await page.goto(`/agents/${agent.id}`)
      await expect(page.getByTestId('provider-chain-item-0')).toContainText(primary.name, {
        timeout: 8000,
      })
      await expect(page.getByTestId('provider-chain-item-1')).toContainText(secondary.name)

      await dragProviderRow(page, 0, 1)
      await expect(page.getByTestId('provider-chain-item-0')).toContainText(secondary.name)
      await expect(page.getByTestId('provider-chain-item-1')).toContainText(primary.name)

      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes(`/api/agents/${agent.id}`) &&
          response.request().method() === 'PATCH',
      )
      await page.getByTestId('agent-detail-save').click()
      const response = await responsePromise
      expect(response.ok()).toBe(true)

      const after = await getAgent(token, agent.id)
      const chain = after.config?.providerChain as Array<Record<string, unknown>>
      expect(chain.map((item) => item.providerId)).toEqual([secondary.id, primary.id])
      expect(after.providerId).toBe(secondary.id)
      expect(after.authMode).toBe('localSession')
    } finally {
      await deleteAgentAs(token, agent.id)
    }
  })
})
