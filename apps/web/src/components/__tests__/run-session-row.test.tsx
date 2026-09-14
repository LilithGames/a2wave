import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen } from '@/test/render'
import { RunSessionRow } from '../run-session-row'

const session = {
  id: 'run_2',
  conversationId: 'cvs_1',
  status: 'completed' as const,
  latestRun: {
    id: 'run_2',
    intent: 'Please finish the release notes',
    status: 'completed' as const,
    initiatorAgentId: 'agt_1',
    agentName: 'Release Agent',
    agentIcon: '🚀',
    triggerSource: 'feishu' as const,
    triggerUserName: 'Alex',
    triggerAgentName: null,
    createdAt: new Date('2026-08-14T00:00:00.000Z'),
    updatedAt: new Date('2026-08-14T00:00:00.000Z'),
  },
  runCount: 2,
  turnCount: 4,
  failedCount: 1,
  failedRunIds: ['run_1'],
  hasActiveRun: false,
  activeRunId: null,
  createdAt: new Date('2026-08-14T00:00:00.000Z'),
  updatedAt: new Date(),
}

describe('RunSessionRow', () => {
  it('shows the latest question, turn count, failures, status and Agent', () => {
    renderWithProviders(<RunSessionRow session={session} showAgent onSelect={vi.fn()} />)

    expect(screen.getByText('Release Agent')).toBeInTheDocument()
    expect(screen.getByText('Please finish the release notes')).toBeInTheDocument()
    expect(screen.getByText(i18n.t('runs.turnCount', { count: 4 }))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('runs.failedTurnCount', { count: 1 }))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('dashboard.statusCompleted'))).toBeInTheDocument()
  })

  it('uses a semantic button and selects the representative run', async () => {
    const onSelect = vi.fn()
    const user = userEvent.setup()
    renderWithProviders(<RunSessionRow session={session} onSelect={onSelect} />)

    const row = screen.getByRole('button', {
      name: i18n.t('runs.openSession', {
        intent: session.latestRun.intent,
        turns: i18n.t('runs.turnCount', { count: session.turnCount }),
        failures: i18n.t('runs.failedTurnCount', { count: session.failedCount }),
        status: i18n.t('dashboard.statusCompleted'),
      }),
    })
    await user.click(row)

    expect(onSelect).toHaveBeenCalledWith('run_2')
  })

  it('uses the aggregate session status instead of the latest Run status', () => {
    renderWithProviders(
      <RunSessionRow
        session={{ ...session, status: 'running', hasActiveRun: true, activeRunId: 'run_1' }}
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getByText(i18n.t('dashboard.statusRunning'))).toBeInTheDocument()
    expect(screen.queryByText(i18n.t('dashboard.statusCompleted'))).not.toBeInTheDocument()
  })

  it('keeps turn and failure metadata in the compact mobile layout', () => {
    renderWithProviders(<RunSessionRow session={session} onSelect={vi.fn()} />)

    const turns = screen.getByText(i18n.t('runs.turnCount', { count: session.turnCount }))
    const failures = screen.getByText(
      i18n.t('runs.failedTurnCount', { count: session.failedCount }),
    )
    expect(turns.parentElement).not.toHaveClass('hidden')
    expect(failures.parentElement).not.toHaveClass('hidden')
    expect(screen.getByRole('button')).toHaveAccessibleName(
      i18n.t('runs.openSession', {
        intent: session.latestRun.intent,
        turns: i18n.t('runs.turnCount', { count: session.turnCount }),
        failures: i18n.t('runs.failedTurnCount', { count: session.failedCount }),
        status: i18n.t('dashboard.statusCompleted'),
      }),
    )
  })
})
