import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen } from '@/test/render'

/**
 * Retrying a FAILED run reuses its row, so the run the drawer is showing is
 * the same run that is now running. Closing the drawer (which is right when a
 * rerun files a separate row the operator would have to go find) would hide
 * the very thing they just asked to watch.
 */

const rerunMutate = vi.fn()
const runState: { current: Record<string, unknown> } = { current: {} }

vi.mock('@/hooks/use-runs', () => ({
  useRun: () => ({ data: runState.current, isLoading: false }),
  useCancelRun: () => ({ mutate: vi.fn(), isPending: false }),
  useRerunRun: () => ({ mutate: rerunMutate, isPending: false }),
}))

vi.mock('@/hooks/use-chat-history', () => ({ useChatHistory: () => ({ data: [] }) }))

const { RunDetailDrawer } = await import('../run-detail-drawer')

function renderDrawer(run: Record<string, unknown>) {
  runState.current = { id: 'run_1', intent: 'do a thing', status: 'failed', steps: [], ...run }
  return renderWithProviders(<RunDetailDrawer runId="run_1" open onClose={vi.fn()} />)
}

describe('RunDetailDrawer retry', () => {
  beforeEach(() => rerunMutate.mockReset())

  it('offers a retry (not a rerun) for a failed run and keeps the drawer on it', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    runState.current = { id: 'run_1', intent: 'do a thing', status: 'failed', steps: [] }
    renderWithProviders(<RunDetailDrawer runId="run_1" open onClose={onClose} />)

    const button = screen.getByRole('button', { name: i18n.t('runDetail.retry') })
    await user.click(button)

    expect(rerunMutate).toHaveBeenCalledTimes(1)
    // No onSuccess close callback: this row stays on screen and flips to running.
    expect(rerunMutate.mock.calls[0][1]).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still calls a replay of a completed run a rerun, and closes onto the new row', async () => {
    const user = userEvent.setup()
    renderDrawer({ status: 'completed' })

    await user.click(screen.getByRole('button', { name: i18n.t('runDetail.rerun') }))

    expect(rerunMutate).toHaveBeenCalledTimes(1)
    expect(rerunMutate.mock.calls[0][1]).toEqual(
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    )
  })
})
