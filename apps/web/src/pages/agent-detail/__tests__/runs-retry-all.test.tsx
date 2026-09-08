import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'
import { renderWithProviders, screen, waitFor } from '@/test/render'

/**
 * When the single configured Provider loses its credentials every triggered Run
 * on the page fails for the same reason, and re-opening each drawer to press
 * "rerun" does not scale. This button is that recovery path, so what it replays
 * (only the failed Runs, oldest first) and what it reports back are pinned here.
 */

const apiPost = vi.fn()
const confirmMock = vi.fn()
const messageSuccess = vi.fn()
const messageError = vi.fn()

vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => apiPost(...args) },
}))

vi.mock('@/lib/confirm', () => ({
  confirm: (options: { onOk?: () => unknown }) => confirmMock(options),
}))

vi.mock('@/lib/antd-static', () => ({
  message: {
    success: (...a: unknown[]) => messageSuccess(...a),
    error: (...a: unknown[]) => messageError(...a),
  },
}))

const { RunsRetryAllButton, useRunsRetryAll } = await import('../runs-retry-all-button')

/**
 * Mirrors the page: the controller stays mounted while the button (which lives
 * in the tab bar) comes and goes with the active tab.
 */
function Harness({
  failedRunIds,
  canRetry = true,
  buttonMounted = true,
  listUpdatedAt = 1_000,
}: {
  failedRunIds: string[]
  canRetry?: boolean
  buttonMounted?: boolean
  /** When the list snapshot behind `failedRunIds` was fetched. */
  listUpdatedAt?: number
}) {
  const controller = useRunsRetryAll(failedRunIds, canRetry, listUpdatedAt)
  return buttonMounted ? <RunsRetryAllButton controller={controller} /> : null
}

/** Accepts the confirm dialog the button opens, the way an operator would. */
function autoConfirm() {
  confirmMock.mockImplementation(async (options: { onOk?: () => unknown }) => {
    await options.onOk?.()
  })
}

async function clickRetryAll() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: i18n.t('agentDetail.runsRetryAllFailed') }))
}

describe('RunsRetryAllButton', () => {
  beforeEach(() => {
    apiPost.mockReset()
    apiPost.mockResolvedValue({ data: { id: 'run_new' } })
    confirmMock.mockReset()
    messageSuccess.mockReset()
    messageError.mockReset()
    autoConfirm()
  })

  it('is disabled while the page holds no failed Run', () => {
    renderWithProviders(<Harness failedRunIds={[]} />)

    expect(
      screen.getByRole('button', { name: i18n.t('agentDetail.runsRetryAllFailed') }),
    ).toBeDisabled()
  })

  it('stays disabled for a viewer who cannot rerun this Agent', () => {
    // Every rerun is a write on the Agent, so a viewer clicking this would only
    // collect a page of 403s.
    renderWithProviders(<Harness failedRunIds={['run_a']} canRetry={false} />)

    expect(
      screen.getByRole('button', { name: i18n.t('agentDetail.runsRetryAllFailed') }),
    ).toBeDisabled()
  })

  it('replays every failed Run on the page, oldest first', async () => {
    // The list renders newest first, so replaying in reverse re-queues the runs
    // in the order they originally happened.
    renderWithProviders(<Harness failedRunIds={['run_new', 'run_mid', 'run_old']} />)

    await clickRetryAll()

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(3))
    expect(apiPost.mock.calls.map(([path]) => path)).toEqual([
      '/runs/run_old/rerun',
      '/runs/run_mid/rerun',
      '/runs/run_new/rerun',
    ])
    expect(messageSuccess).toHaveBeenCalledWith(
      i18n.t('agentDetail.runsRetryAllDone', { total: 3 }),
    )
  })

  it('never replays a Run it already resubmitted, even after it reappears', async () => {
    // The list keeps reporting a row as failed until the refetch that follows
    // the retry lands. Without this guard that stale snapshot replays work
    // already submitted — twice the token spend, twice the side effects.
    const { rerender } = renderWithProviders(<Harness failedRunIds={['run_a']} />)
    await clickRetryAll()
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))

    rerender(<Harness failedRunIds={['run_b', 'run_a']} />)
    await clickRetryAll()

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
    expect(apiPost.mock.calls.map(([path]) => path)).toEqual([
      '/runs/run_a/rerun',
      '/runs/run_b/rerun',
    ])
  })

  it('offers a run again once a fresher list still calls it failed', async () => {
    // The row can fail AGAIN under the same id now that a retry reuses it, and
    // a quick second failure may never be observed as anything else. What makes
    // it eligible is a list snapshot taken AFTER the batch that still reports
    // it failed — not having watched it pass through some other status.
    const { rerender } = renderWithProviders(
      <Harness failedRunIds={['run_a']} listUpdatedAt={1_000} />,
    )
    await clickRetryAll()
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))

    rerender(<Harness failedRunIds={['run_a']} listUpdatedAt={2_000} />)
    await clickRetryAll()

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
  })

  it('ignores a list snapshot older than the batch it is judging', async () => {
    // The in-flight refetch that was already running when the batch started
    // still shows the pre-retry state; acting on it would double-submit.
    const { rerender } = renderWithProviders(
      <Harness failedRunIds={['run_a']} listUpdatedAt={2_000} />,
    )
    await clickRetryAll()
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))

    rerender(<Harness failedRunIds={['run_a']} listUpdatedAt={1_000} />)

    expect(
      screen.getByRole('button', { name: i18n.t('agentDetail.runsRetryAllFailed') }),
    ).toBeDisabled()
  })

  it('remembers what it replayed across a tab switch', async () => {
    // The button lives in the Runs tab bar and unmounts when the operator looks
    // at another tab; coming back must not re-offer the batch just submitted.
    const { rerender } = renderWithProviders(<Harness failedRunIds={['run_a']} />)
    await clickRetryAll()
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1))

    rerender(<Harness failedRunIds={['run_a']} buttonMounted={false} />)
    rerender(<Harness failedRunIds={['run_a']} />)

    expect(
      screen.getByRole('button', { name: i18n.t('agentDetail.runsRetryAllFailed') }),
    ).toBeDisabled()
  })

  it('asks before replaying, and replays nothing when the operator declines', async () => {
    confirmMock.mockImplementation(() => undefined)
    renderWithProviders(<Harness failedRunIds={['run_a']} />)

    await clickRetryAll()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(apiPost).not.toHaveBeenCalled()
  })

  it('keeps going after one replay fails and reports the split', async () => {
    apiPost
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ data: { id: 'run_new' } })
    renderWithProviders(<Harness failedRunIds={['run_b', 'run_a']} />)

    await clickRetryAll()

    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2))
    expect(messageError).toHaveBeenCalledWith(
      i18n.t('agentDetail.runsRetryAllPartial', { succeeded: 1, failed: 1 }),
    )
  })
})
