import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen, userEvent } from '@/test/render'
import { LoginPage } from '../login'

const { useOauthConfigMock, mutateAsyncMock } = vi.hoisted(() => ({
  useOauthConfigMock: vi.fn(),
  mutateAsyncMock: vi.fn(),
}))

vi.mock('@/hooks/use-auth', () => ({
  useAuthStatus: () => ({ data: { needSetup: false }, isLoading: false }),
  useOauthConfig: () => useOauthConfigMock(),
  useLogin: () => ({ mutateAsync: mutateAsyncMock, isPending: false }),
}))

const rememberLabel = i18n.t('auth.rememberMe')

async function fillCredentials() {
  await userEvent.type(screen.getByLabelText(i18n.t('auth.username')), 'bob')
  await userEvent.type(screen.getByLabelText(i18n.t('auth.password')), 'secret')
}

function submit() {
  return userEvent.click(screen.getByRole('button', { name: i18n.t('auth.loginButton') }))
}

describe('LoginPage "keep me signed in"', () => {
  beforeEach(() => {
    useOauthConfigMock.mockReset().mockReturnValue({
      data: { enabled: false },
      isLoading: false,
      isError: false,
    })
    mutateAsyncMock.mockReset().mockResolvedValue({ token: 't', user: {} })
  })

  it('renders the checkbox unchecked by default', async () => {
    renderWithProviders(<LoginPage />)

    // Defaulting to unchecked is the safe choice: the long-lived session must be
    // something the user opts into, not something they have to notice and undo.
    expect(screen.getByLabelText(rememberLabel)).not.toBeChecked()
  })

  it('sends remember=false when the box is left unchecked', async () => {
    renderWithProviders(<LoginPage />)
    await fillCredentials()
    await submit()

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      username: 'bob',
      password: 'secret',
      remember: false,
    })
  })

  it('sends remember=true after the user checks the box', async () => {
    renderWithProviders(<LoginPage />)
    await fillCredentials()
    await userEvent.click(screen.getByLabelText(rememberLabel))
    await submit()

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      username: 'bob',
      password: 'secret',
      remember: true,
    })
  })
})
