import { render, screen } from '@testing-library/react'
import { Input } from 'antd'
import { describe, expect, it } from 'vitest'

/**
 * Guards the jsdom selector shim installed by `src/test/setup.ts`.
 *
 * antd >= 6.6 styles borderless Inputs with `&:has(input:focus-visible)`. CSS-in-JS
 * expands `&` to the enclosing selector chain, so inside a Tailwind-classed container
 * the emitted rule carries an unescaped arbitrary-value class (`min-h-[7.5rem]`).
 * Computing a role runs jsdom's style cascade, whose `matchesDontThrow` guard is
 * defeated because nwsapi's `:has()` resolver re-enters `querySelector` with
 * `:scope input:focus-visible` — and that throw propagates.
 */
describe('jsdom selector shim', () => {
  it('computes a role inside a container antd styles with :has()', () => {
    render(
      <div className="min-h-[7.5rem]">
        <Input variant="borderless" aria-label="field" />
      </div>,
    )

    expect(screen.getByRole('textbox')).not.toBeNull()
  })

  it('still evaluates a valid selector normally', () => {
    const container = document.createElement('div')
    container.innerHTML = '<span class="target">hit</span>'
    document.body.appendChild(container)

    expect(container.querySelector('.target')?.textContent).toBe('hit')
    expect(container.querySelectorAll('.target')).toHaveLength(1)
    expect(container.querySelector('.absent')).toBeNull()

    container.remove()
  })

  it('still throws for a genuinely malformed selector passed by application code', () => {
    // Only the re-entrant `:scope …` shape is swallowed, so a real bug in an
    // application query keeps surfacing instead of silently matching nothing.
    expect(() => document.querySelector('##')).toThrow()
  })
})
