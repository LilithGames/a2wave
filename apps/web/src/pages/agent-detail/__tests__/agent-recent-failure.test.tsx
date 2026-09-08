import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen, waitFor } from '@/test/render'

/**
 * The Provider section is where an operator goes when runs fail, and the
 * loudest evidence about a credential is not any probe — it is the error the
 * last real run reported. A CLI that answers "logged in" from a local file
 * cannot contradict a page full of 401s, so the failure is shown here too.
 */

const useRunsMock = vi.fn()

vi.mock('@/hooks/use-runs', () => ({
  useRuns: (...args: unknown[]) => useRunsMock(...args),
}))

const { AgentRecentFailureNotice } = await import('../agent-recent-failure')

function run(overrides: Record<string, unknown>) {
  return {
    id: 'run_1',
    status: 'failed',
    intent: 'do a thing',
    createdAt: new Date().toISOString(),
    result: { error: 'boom' },
    ...overrides,
  }
}

function resolveRuns(rows: unknown[]) {
  useRunsMock.mockReturnValue({ data: { data: rows }, isLoading: false })
}

describe('AgentRecentFailureNotice', () => {
  beforeEach(() => useRunsMock.mockReset())

  it('renders nothing while the Agent has no failed run', () => {
    resolveRuns([run({ status: 'completed', result: null })])
    const { container } = renderWithProviders(<AgentRecentFailureNotice agentId="agt_1" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the newest failure and its error', async () => {
    resolveRuns([
      run({ id: 'run_new', status: 'failed', result: { error: 'newest failure' } }),
      run({ id: 'run_old', status: 'failed', result: { error: 'older failure' } }),
    ])
    renderWithProviders(<AgentRecentFailureNotice agentId="agt_1" />)

    await waitFor(() => expect(screen.getByText(/newest failure/)).toBeInTheDocument())
    expect(screen.queryByText(/older failure/)).toBeNull()
  })

  it('calls out an error that looks like a dead credential', async () => {
    // The one case where the login chip is actively misleading: the CLI reports
    // a session from disk while the vendor is refusing the token.
    resolveRuns([
      run({
        result: { error: 'Your access token could not be refreshed because it was revoked.' },
      }),
    ])
    renderWithProviders(<AgentRecentFailureNotice agentId="agt_1" />)

    await waitFor(() =>
      expect(screen.getByText(i18n.t('agentDetail.recentFailureAuthHint'))).toBeInTheDocument(),
    )
  })

  it('does not cry credential on an unrelated failure', async () => {
    resolveRuns([run({ result: { error: 'workspace is dirty' } })])
    renderWithProviders(<AgentRecentFailureNotice agentId="agt_1" />)

    await waitFor(() => expect(screen.getByText(/workspace is dirty/)).toBeInTheDocument())
    expect(screen.queryByText(i18n.t('agentDetail.recentFailureAuthHint'))).toBeNull()
  })

  it('asks for only one page of runs, shared with the Runs tab', () => {
    resolveRuns([])
    renderWithProviders(<AgentRecentFailureNotice agentId="agt_1" />)
    expect(useRunsMock).toHaveBeenCalledWith({ agentId: 'agt_1', page: 1, pageSize: 15 })
  })
})
