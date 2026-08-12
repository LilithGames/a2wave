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

  it('renders as a semibold heading on the shared type scale', () => {
    expect(renderTitle()).toHaveClass('text-base', 'font-semibold')
  })

  // DialogTitle is shared by every modal in the app, so its size must come from
  // the Tailwind type scale the design-token conventions define. An
  // arbitrary-value class here (text-[1.4rem]) resizes ~36 unrelated dialogs
  // for whatever feature happened to touch it, and pinning that value in a test
  // locks the drift in instead of catching it.
  it('sizes from the type scale rather than an arbitrary value', () => {
    const className = renderTitle().className
    expect(className).not.toMatch(/text-\[/)
  })
})
