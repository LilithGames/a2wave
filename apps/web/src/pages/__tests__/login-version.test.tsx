import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen, waitFor } from '@/test/render'
import { LoginPage } from '../login'

vi.mock('@/hooks/use-auth', () => ({
  useAuthStatus: () => ({ data: { needSetup: false }, isLoading: false }),
  useOauthConfig: () => ({ data: { enabled: false }, isLoading: false, isError: false }),
  useLogin: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

const { useVersionMock } = vi.hoisted(() => ({ useVersionMock: vi.fn() }))
vi.mock('@/hooks/use-version', () => ({ useVersion: () => useVersionMock() }))

const copyright = i18n.t('app.copyright')

describe('LoginPage version footer', () => {
  beforeEach(() => {
    useVersionMock.mockReset()
  })

  it('shows the version next to the copyright once loaded', async () => {
    useVersionMock.mockReturnValue({ data: 'v0.7.3' })

    renderWithProviders(<LoginPage />)

    const footer = await screen.findByTestId('login-footer')
    // Same line as the copyright — the footer is the page's meta-info zone.
    expect(footer).toHaveTextContent(copyright)
    expect(footer).toHaveTextContent('v0.7.3')
  })

  /**
   * The version is decorative: while it loads, or if the endpoint is
   * unreachable, the copyright must still render cleanly — with no orphaned
   * separator left dangling after it.
   */
  it('renders the copyright alone when no version is available', async () => {
    useVersionMock.mockReturnValue({ data: null })

    renderWithProviders(<LoginPage />)

    const footer = await screen.findByTestId('login-footer')
    expect(footer).toHaveTextContent(copyright)
    await waitFor(() => {
      expect(footer.textContent?.trim()).toBe(copyright)
    })
  })
})
