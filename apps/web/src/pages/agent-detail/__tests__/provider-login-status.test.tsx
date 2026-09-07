import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen, waitFor } from '@/test/render'

/**
 * The localSession status strip is the only place the Agent config answers
 * "does the server this Agent runs on actually hold a login for this
 * Provider?". A single expired session takes every Agent bound to it down at
 * once, so both the automatic probe on expand and the manual re-check are
 * pinned here.
 */

const apiGet = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { get: (...args: unknown[]) => apiGet(...args) },
}))

const { LocalSessionGuideIcon, ProviderLoginSessionStatus } = await import(
  '../provider-login-status'
)

function resolveStatus(status: Record<string, unknown>) {
  apiGet.mockResolvedValue({ data: status })
}

function renderStatus() {
  return renderWithProviders(
    <ProviderLoginSessionStatus providerKind="claude-code" loginCommand="claude login" />,
  )
}

describe('ProviderLoginSessionStatus', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })

  it('probes the server session once when it mounts', async () => {
    resolveStatus({ installed: true, loggedIn: true, version: '2.1.0' })
    renderStatus()

    await screen.findByText(i18n.t('agentDetail.loginStatusLoggedIn'))
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(apiGet).toHaveBeenCalledWith('/providers/login-status/claude-code')
    expect(screen.getByText('2.1.0')).toBeInTheDocument()
  })

  it('names the login command to run when the server has no session', async () => {
    resolveStatus({ installed: true, loggedIn: false })
    renderStatus()

    await screen.findByText(i18n.t('agentDetail.loginStatusNotLoggedIn'))
    expect(
      screen.getByText(i18n.t('agentDetail.loginStatusRunHint', { command: 'claude login' })),
    ).toBeInTheDocument()
  })

  it('reports a missing CLI instead of a missing login', async () => {
    resolveStatus({ installed: false, loggedIn: false })
    renderStatus()

    await screen.findByText(i18n.t('agentDetail.loginStatusNotInstalled'))
  })

  it('re-probes on demand so a fresh server login can be confirmed here', async () => {
    const user = userEvent.setup()
    resolveStatus({ installed: true, loggedIn: false })
    renderStatus()

    await screen.findByText(i18n.t('agentDetail.loginStatusNotLoggedIn'))
    resolveStatus({ installed: true, loggedIn: true })
    await user.click(screen.getByRole('button', { name: i18n.t('agentDetail.loginStatusRecheck') }))

    await screen.findByText(i18n.t('agentDetail.loginStatusLoggedIn'))
    expect(apiGet).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected credential as an expired session, not as a missing login', async () => {
    // The distinction is the whole point: nothing needs installing and nothing
    // is missing — a credential is there and the vendor refused it, so the only
    // useful instruction is "log in again on the server".
    resolveStatus({
      installed: true,
      loggedIn: false,
      verified: true,
      code: 'CREDENTIALS_REJECTED',
      error: 'refresh token was revoked',
    })
    renderStatus()

    await screen.findByText(i18n.t('agentDetail.loginStatusInvalid'))
    expect(screen.queryByText(i18n.t('agentDetail.loginStatusNotInstalled'))).toBeNull()
    expect(screen.getByText('refresh token was revoked')).toBeInTheDocument()
    expect(
      screen.getByText(i18n.t('agentDetail.loginStatusRunHint', { command: 'claude login' })),
    ).toBeInTheDocument()
  })

  it('separates a session proven against the vendor from one merely present on disk', async () => {
    resolveStatus({ installed: true, loggedIn: true, verified: true })
    const { unmount } = renderStatus()
    await screen.findByText(i18n.t('agentDetail.loginStatusVerified'))
    unmount()

    resolveStatus({ installed: true, loggedIn: true })
    renderStatus()
    await screen.findByText(i18n.t('agentDetail.loginStatusUnverified'))
    expect(screen.queryByText(i18n.t('agentDetail.loginStatusVerified'))).toBeNull()
  })

  it('reports a server-side probe failure as a failed check, not a missing CLI', async () => {
    // The route answers 200 with installed:false when the probe itself throws —
    // the same shape the engine uses for "CLI not found". Only `code` tells
    // them apart, and telling an operator to install a CLI that is already
    // installed is the worst possible answer during an outage.
    resolveStatus({
      installed: false,
      loggedIn: false,
      error: 'spawn EACCES',
      code: 'PROBE_FAILED',
    })
    renderStatus()

    await screen.findByText(i18n.t('agentDetail.loginStatusError'))
    expect(screen.queryByText(i18n.t('agentDetail.loginStatusNotInstalled'))).toBeNull()
    expect(screen.getByText('spawn EACCES')).toBeInTheDocument()
  })

  it('shows why the server reports no session', async () => {
    resolveStatus({ installed: true, loggedIn: false, error: 'Not logged in' })
    renderStatus()

    await screen.findByText(i18n.t('agentDetail.loginStatusNotLoggedIn'))
    expect(screen.getByText('Not logged in')).toBeInTheDocument()
  })

  it('surfaces a failed probe rather than claiming the session is missing', async () => {
    apiGet.mockRejectedValue(new Error('boom'))
    renderStatus()

    await waitFor(() =>
      expect(screen.getByText(i18n.t('agentDetail.loginStatusError'))).toBeInTheDocument(),
    )
    expect(screen.queryByText(i18n.t('agentDetail.loginStatusNotLoggedIn'))).toBeNull()
  })
})

describe('LocalSessionGuideIcon', () => {
  it('explains on hover how the server session gets established', async () => {
    const user = userEvent.setup()
    renderWithProviders(<LocalSessionGuideIcon loginCommand="claude login" />)

    await user.hover(
      screen.getByRole('button', { name: i18n.t('agentDetail.localSessionGuideAria') }),
    )

    expect(
      await screen.findByText(i18n.t('agentDetail.localSessionGuideTitle')),
    ).toBeInTheDocument()
    expect(
      screen.getByText(i18n.t('agentDetail.localSessionGuideStep2', { command: 'claude login' })),
    ).toBeInTheDocument()
    expect(screen.getByText(i18n.t('agentDetail.localSessionGuideAgent'))).toBeInTheDocument()
  })
})
