import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HardDrive } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { ModePicker } from '../mode-picker'

describe('ModePicker', () => {
  it('renders every option label', () => {
    render(
      <ModePicker
        value="a"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ]}
      />,
    )
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('Beta')).toBeInTheDocument()
  })

  it('reports the selected value', async () => {
    const onChange = vi.fn()
    render(
      <ModePicker
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ]}
      />,
    )
    await userEvent.click(screen.getByText('Beta'))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  it('wraps an icon option in the standard inline layout', () => {
    // The icon + label pairing is the documented Segmented convention, and it
    // was hand-repeated at every call site — with two different icon sizes.
    // Centralising it is the whole point of this component, so the markup it
    // produces is pinned rather than left to each caller to reproduce.
    const { container } = render(
      <ModePicker
        value="a"
        onChange={() => {}}
        options={[{ value: 'a', label: 'Alpha', icon: HardDrive }]}
      />,
    )
    const wrapper = container.querySelector('.inline-flex.items-center')
    expect(wrapper).not.toBeNull()
    expect(wrapper?.querySelector('svg')).not.toBeNull()
  })

  it('renders one consistent icon size for every option', () => {
    // Call sites used `h-4 w-4` in some places and `h-3.5 w-3.5` in others, so
    // two adjacent pickers did not line up. The size is the component's
    // decision now, not the caller's.
    const { container } = render(
      <ModePicker
        value="a"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'Alpha', icon: HardDrive },
          { value: 'b', label: 'Beta', icon: HardDrive },
        ]}
      />,
    )
    const sizes = [...container.querySelectorAll('svg')].map((svg) => svg.getAttribute('class'))
    expect(sizes.length).toBeGreaterThan(0)
    expect(new Set(sizes).size).toBe(1)
  })

  it('disables an option that asks to be disabled', () => {
    render(
      <ModePicker
        value="a"
        onChange={() => {}}
        options={[
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta', disabled: true },
        ]}
      />,
    )
    const beta = screen.getByText('Beta').closest('label')
    expect(beta?.className).toContain('disabled')
  })

  it('accepts a rich label so a tooltip-wrapped option still works', () => {
    // Not every option is plain text — one call site wraps the label in a
    // Tooltip. Forcing `string` would have made this component unusable there
    // and left that site on the raw antd control, defeating the consolidation.
    render(
      <ModePicker
        value="a"
        onChange={() => {}}
        options={[{ value: 'a', label: <span data-testid="rich">Rich</span> }]}
      />,
    )
    expect(screen.getByTestId('rich')).toBeInTheDocument()
  })
})
