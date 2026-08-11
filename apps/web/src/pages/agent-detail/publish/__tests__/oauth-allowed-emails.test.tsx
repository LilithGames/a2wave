import { renderWithProviders, screen, userEvent } from '@/test/render'
import { describe, expect, it, vi } from 'vitest'
import { OauthAllowedEmails } from '../oauth-allowed-emails'

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: [] }) },
}))

function setup(emails: string[] = []) {
  const onChange = vi.fn()
  renderWithProviders(<OauthAllowedEmails emails={emails} onChange={onChange} />)
  return { onChange, user: userEvent.setup() }
}

describe('OauthAllowedEmails', () => {
  /**
   * Enter alone used to be the only way to commit an address. An owner who typed one and went
   * straight for "Publish" had it silently dropped — the text sat visibly in the box while the
   * saved list did not contain it.
   */
  it('adds the typed address via the Add button, without pressing Enter', async () => {
    const { onChange, user } = setup()

    await user.type(screen.getByTestId('oauth-email-input'), 'alice@example.com')
    await user.click(screen.getByTestId('oauth-email-add'))

    expect(onChange).toHaveBeenCalledWith(['alice@example.com'])
  })

  it('disables Add until something is typed', async () => {
    const { user } = setup()

    expect(screen.getByTestId('oauth-email-add')).toBeDisabled()
    await user.type(screen.getByTestId('oauth-email-input'), 'a')
    expect(screen.getByTestId('oauth-email-add')).toBeEnabled()
  })

  it('normalizes case and whitespace on add', async () => {
    const { onChange, user } = setup()

    await user.type(screen.getByTestId('oauth-email-input'), '  Alice@Example.COM  ')
    await user.click(screen.getByTestId('oauth-email-add'))

    expect(onChange).toHaveBeenCalledWith(['alice@example.com'])
  })

  /**
   * Validated with the server's own schema. A looser local regex let `a@b.c` become a chip and
   * deferred the rejection to publish time, surfacing as a bare 400 naming no address.
   */
  it('rejects an address the server would reject, and says so inline', async () => {
    const { onChange, user } = setup()

    await user.type(screen.getByTestId('oauth-email-input'), 'a@b.c')
    await user.click(screen.getByTestId('oauth-email-add'))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('请输入有效的邮箱地址')).toBeInTheDocument()
  })

  it('rejects a duplicate that differs only by case', async () => {
    const { onChange, user } = setup(['alice@example.com'])

    await user.type(screen.getByTestId('oauth-email-input'), 'ALICE@example.com')
    await user.click(screen.getByTestId('oauth-email-add'))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText('该邮箱已在名单中')).toBeInTheDocument()
  })

  // Empty means deny-all, which is where every migrated Agent starts — the owner has to see it.
  it('warns while the list is empty', () => {
    setup()
    expect(screen.getByTestId('oauth-allowed-emails-empty')).toBeInTheDocument()
  })

  // `warning-foreground` is the color for text placed ON a solid warning fill (white in the
  // light themes), so using it as body copy over a tint rendered the notice white-on-near-white.
  // The warning surface must come from the shared design tokens instead.
  it('styles the empty-list warning with the shared warning tokens, not warning-foreground', () => {
    setup()
    const notice = screen.getByTestId('oauth-allowed-emails-empty')

    expect(notice.className).not.toContain('text-warning-foreground')
    expect(notice.className).toContain('text-warning')
    expect(notice.className).toContain('bg-warning-subtle')
    expect(notice.className).toContain('border-warning/30')
  })

  it('removes a listed address', async () => {
    const { onChange, user } = setup(['alice@example.com', 'bob@example.com'])

    await user.click(screen.getByRole('button', { name: /移除 alice@example.com/ }))

    expect(onChange).toHaveBeenCalledWith(['bob@example.com'])
  })

  // A viewer may look at who is allowed but must not edit a list they cannot save.
  it('disables every control when read-only', () => {
    renderWithProviders(
      <OauthAllowedEmails emails={['alice@example.com']} onChange={vi.fn()} disabled />,
    )

    expect(screen.getByTestId('oauth-email-input')).toBeDisabled()
    expect(screen.getByTestId('oauth-email-add')).toBeDisabled()
    expect(screen.getByRole('button', { name: /移除 alice@example.com/ })).toBeDisabled()
  })
})
