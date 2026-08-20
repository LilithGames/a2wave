import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LinkifiedText } from '@/components/linkified-text'

describe('LinkifiedText', () => {
  it('renders plain text without links', () => {
    render(<LinkifiedText text="no url here" />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('no url here')).toBeInTheDocument()
  })

  it('turns an http(s) URL into a link opening in a new tab', () => {
    render(<LinkifiedText text="see https://example.com/a?b=1 for details" />)
    const link = screen.getByRole('link', { name: 'https://example.com/a?b=1' })
    expect(link).toHaveAttribute('href', 'https://example.com/a?b=1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('links every URL in multi-line text and keeps surrounding text', () => {
    const { container } = render(
      <LinkifiedText text={'链接: https://gitlab.example.com/g/p/-/merge_requests/68\n主机: x'} />,
    )
    expect(screen.getAllByRole('link')).toHaveLength(1)
    expect(container.textContent).toBe(
      '链接: https://gitlab.example.com/g/p/-/merge_requests/68\n主机: x',
    )
  })

  it('excludes trailing punctuation and CJK characters from the URL', () => {
    render(<LinkifiedText text="发生了 https://example.com/x。请查看 (https://example.com/y)." />)
    expect(screen.getByRole('link', { name: 'https://example.com/x' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://example.com/y' })).toBeInTheDocument()
  })

  it('ignores non-http schemes', () => {
    render(<LinkifiedText text="javascript:alert(1) and file:///etc/passwd" />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
