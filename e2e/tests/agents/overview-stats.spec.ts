import { expect, test } from '@playwright/test'
import { createAgent, deleteAgentAs, getAdminToken } from '../../utils/api-helpers'
import { dismissOnboarding, loginAsAdmin } from '../../utils/auth'

test('keeps lifetime audience statistics above trends while filtering the lower cards', async ({
  page,
}) => {
  await loginAsAdmin(page)
  const token = await getAdminToken()
  const agent = await createAgent(token, `e2e-overview-stats-${Date.now()}`)

  try {
    await page.route(`**/api/agents/${agent.id}/stats{,?*}`, async (route) => {
      const params = new URL(route.request().url()).searchParams
      const from = params.get('from')
      const to = params.get('to')
      const count = from && to ? (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 : 101
      await route.fulfill({
        json: {
          total: 500,
          successRate: 100,
          avgDuration: 1000,
          todayRuns: 1,
          byStatus: { completed: 500, running: 0, failed: 0 },
          askerCount: count,
          topAskers: [{ name: from ? 'Range caller' : 'Lifetime caller', count }],
          channelBreakdown: [{ source: 'api', count }],
          tokens: {},
        },
      })
    })
    await page.route(`**/api/agents/${agent.id}/stats/timeseries?*`, async (route) => {
      const params = new URL(route.request().url()).searchParams
      await route.fulfill({
        json: {
          from: params.get('from'),
          to: params.get('to'),
          bucket: params.get('bucket'),
          points: [],
        },
      })
    })

    await page.goto(`/agents/${agent.id}?tab=overview`)
    await dismissOnboarding(page)
    const lifetime = page.getByTestId('lifetime-audience-stats')
    const filtered = page.getByTestId('range-audience-stats')
    const trends = page.getByRole('heading', { name: '趋势分析', exact: true })

    await expect(lifetime.getByText('101', { exact: true })).toBeVisible()
    await expect(lifetime.getByText('Lifetime caller')).toBeVisible()
    await expect(lifetime.getByText('101 · 100%')).toBeVisible()
    await expect(filtered.getByText('7', { exact: true })).toBeVisible()
    await expect(filtered.getByText('Range caller')).toBeVisible()
    await expect(filtered.getByText('7 · 100%')).toBeVisible()

    const lifetimeBox = await lifetime.boundingBox()
    const trendBox = await trends.boundingBox()
    const filteredBox = await filtered.boundingBox()
    expect(lifetimeBox && trendBox && filteredBox).toBeTruthy()
    expect((lifetimeBox?.y ?? 0) + (lifetimeBox?.height ?? 0)).toBeLessThan(trendBox?.y ?? 0)
    expect(filteredBox?.y).toBeGreaterThan(trendBox?.y ?? 0)

    await page.getByRole('button', { name: '近 30 天', exact: true }).click()
    await expect(filtered.getByText('30', { exact: true })).toBeVisible()
    await expect(filtered.getByText('30 · 100%')).toBeVisible()
    await expect(lifetime.getByText('101', { exact: true })).toBeVisible()
    await expect(lifetime.getByText('101 · 100%')).toBeVisible()
  } finally {
    await deleteAgentAs(token, agent.id)
  }
})
