import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen, userEvent } from '@/test/render'
import { DashboardPage } from '../dashboard'

const runCounts = vi.hoisted(() => ({ failed: 0, recentFailed: 0, running: 0 }))

vi.mock('@/components/onboarding-welcome', () => ({
  OnboardingWelcome: () => null,
}))

vi.mock('@/hooks/use-agents', () => ({
  useAgents: () => ({ data: { data: [] }, isLoading: false }),
}))

vi.mock('@/hooks/use-runs', () => ({
  useRuns: () => ({ data: { data: [] }, isLoading: false }),
  useRunStats: () => ({
    data: {
      total: 0,
      successRate: 0,
      avgDuration: 0,
      todayRuns: 0,
      byStatus: {
        completed: 0,
        failed: runCounts.failed,
        running: runCounts.running,
        pending: 0,
        queued: 0,
        cancelled: 0,
      },
      todayByStatus: {
        completed: 0,
        failed: 0,
        running: 0,
        pending: 0,
        queued: 0,
        cancelled: 0,
      },
      askerCount: 0,
      todayAskerCount: 0,
      recentFailed: runCounts.recentFailed,
      tokens: { input: 5_000, output: 1_000, reasoning: 250, cacheRead: 10_000, cacheWrite: 500 },
      todayTokens: {
        input: 1_200,
        output: 300,
        reasoning: 50,
        cacheRead: 2_000,
        cacheWrite: 100,
      },
    },
    isLoading: false,
  }),
  useAgentRunLeaderboard: () => ({
    data: { byRuns: [], byUsers: [], byTokens: [] },
    isLoading: false,
  }),
}))

describe('DashboardPage token usage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it("shows today's token usage and reveals coverage rules on demand", async () => {
    const user = userEvent.setup()
    renderWithProviders(<DashboardPage />)

    expect(screen.getByText("Today's Tokens")).toBeInTheDocument()
    expect(screen.getByText('3.6K')).toBeInTheDocument()
    expect(screen.getByText('Input 1.2K / Output 300')).toBeInTheDocument()

    const coverageHelp = screen.getByRole('button', { name: 'Token usage statistics' })
    expect(coverageHelp).toHaveAttribute('aria-expanded', 'false')
    expect(coverageHelp).toHaveClass('size-6')
    expect(
      screen.queryByText(
        'Total = input + output + reasoning + cache read + cache write. Claude Code, Codex, OpenCode, and Pi report official token fields. Cursor, Qoder, Trae, and Kimi Code may not report tokens. A displayed 0 can mean no usage was reported, not zero consumption.',
      ),
    ).not.toBeInTheDocument()

    await user.click(coverageHelp)

    expect(coverageHelp).toHaveAttribute('aria-expanded', 'true')
    expect(
      screen.getByText(
        'Total = input + output + reasoning + cache read + cache write. Claude Code, Codex, OpenCode, and Pi report official token fields. Cursor, Qoder, Trae, and Kimi Code may not report tokens. A displayed 0 can mean no usage was reported, not zero consumption.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'View coverage details' })).toHaveAttribute(
      'href',
      '/wiki/runs',
    )
    expect(screen.getByText('No reported token data')).toBeInTheDocument()
  })

  it('uses the readable interaction token for small text links', () => {
    renderWithProviders(<DashboardPage />)

    for (const link of screen.getAllByRole('link', { name: 'View all' })) {
      expect(link).toHaveClass('text-interactive-foreground')
      expect(link.className).not.toMatch(/text-primary/)
    }
  })
})

describe('DashboardPage total runs card', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    runCounts.failed = 0
    runCounts.recentFailed = 0
    runCounts.running = 0
  })

  it('shows failures from the last 7 days, not the lifetime total, and highlights them', async () => {
    runCounts.failed = 543
    runCounts.recentFailed = 4
    runCounts.running = 2
    const user = userEvent.setup()
    renderWithProviders(<DashboardPage />)

    const totalRuns = screen.getByRole('link', { name: /Total Runs/ })
    expect(totalRuns).toHaveTextContent('2 running · 4 failed')
    expect(screen.getByText('4 failed')).toHaveClass('text-destructive')
    expect(screen.queryByText('543 failed')).toBeNull()

    await user.hover(screen.getByRole('img', { name: 'Failed runs in the last 7 days' }))
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Failed runs in the last 7 days')
  })

  it('does not highlight the failed count when nothing failed in the last 7 days', () => {
    runCounts.failed = 543
    renderWithProviders(<DashboardPage />)

    expect(screen.getByRole('link', { name: /Total Runs/ })).toHaveTextContent(
      '0 running · 0 failed',
    )
    expect(screen.getByText('0 failed')).not.toHaveClass('text-destructive')
  })
})
