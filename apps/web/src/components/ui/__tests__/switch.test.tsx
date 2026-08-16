/**
 * The wrapper destructures its props rather than spreading them, so every
 * attribute it forwards has to be named. Anything missing is dropped in
 * silence — which is worse than a type error, because the switch still renders
 * and only the selector disappears.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Switch } from '../switch'

describe('Switch', () => {
  it('forwards data-testid to the DOM so a test can find it', () => {
    render(<Switch checked data-testid="fast-mode" aria-label="Fast mode" />)

    expect(screen.getByTestId('fast-mode')).toBeInTheDocument()
  })

  it('keeps the accessible name alongside the test id', () => {
    render(<Switch checked data-testid="fast-mode" aria-label="Fast mode" />)

    expect(screen.getByTestId('fast-mode')).toHaveAttribute('aria-label', 'Fast mode')
    expect(screen.getByTestId('fast-mode')).toHaveAttribute('aria-checked', 'true')
  })

  it('renders without a test id, which most call sites do', () => {
    render(<Switch checked={false} aria-label="Plain" />)

    expect(screen.getByLabelText('Plain')).toBeInTheDocument()
  })

  it('reports the new value, not the event', () => {
    const onCheckedChange = vi.fn()
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="Toggle" />)

    fireEvent.click(screen.getByLabelText('Toggle'))

    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything())
  })

  it('does not fire when disabled', () => {
    const onCheckedChange = vi.fn()
    render(
      <Switch checked={false} disabled onCheckedChange={onCheckedChange} aria-label="Toggle" />,
    )

    fireEvent.click(screen.getByLabelText('Toggle'))

    expect(onCheckedChange).not.toHaveBeenCalled()
  })
})
