import { cn } from '@/lib/utils'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from '../dialog'

describe('DialogTitle', () => {
  function renderTitle() {
    render(
      <Dialog open onOpenChange={() => {}}>
        <DialogContent>
          <DialogTitle>Create source</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    return screen.getByRole('heading', { name: 'Create source' })
  }

  /**
   * Modal titles sit at 1.4rem (22.4px) — 1.4x the 1rem they rendered at under
   * `text-base`. No stock rung carries that value (`xl` is 1.25rem, `2xl` is
   * 1.5rem), so it is a named `--text-*` rung rather than an arbitrary class.
   */
  it('renders as a semibold heading at the dialog-title size', () => {
    expect(renderTitle()).toHaveClass('text-dialog-title', 'font-semibold')
  })

  /**
   * `cn()` runs class names through tailwind-merge, which treats an unknown
   * `text-*` as a colour utility and drops it against `text-foreground`. The
   * custom rung must therefore be registered in the font-size group — without
   * that, the size silently vanishes at runtime while the source still reads
   * as if it were applied.
   */
  it('survives tailwind-merge alongside a text colour utility', () => {
    expect(cn('text-dialog-title', 'text-foreground')).toContain('text-dialog-title')
  })

  // DialogTitle is shared by every modal in the app, so its size must come from
  // the design-token scale. An arbitrary-value class here (text-[1.4rem])
  // resizes ~36 unrelated dialogs for whatever feature happened to touch it,
  // and pinning that value in a test locks the drift in instead of catching it.
  it('sizes from the type scale rather than an arbitrary value', () => {
    const className = renderTitle().className
    expect(className).not.toMatch(/text-\[/)
  })
})
