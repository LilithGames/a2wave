import { beforeEach, describe, expect, it } from 'vitest'
import type { StreamLogEntry } from '@/hooks/use-agents'
import i18n from '@/i18n'
import { renderWithProviders, screen } from '@/test/render'
import { StreamLogsTimeline } from '../stream-log-item'

describe('StreamLogsTimeline', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('shows A2A Task lifecycle metadata in the ordinary Run timeline', () => {
    const entry = {
      type: 'system',
      subtype: 'a2a.task.cancel_result',
      metadata: {
        target: 'Payment Agent',
        taskId: 'task-remote-123',
        state: 'TASK_STATE_CANCELED',
      },
      ts: 1_000,
    } as StreamLogEntry

    renderWithProviders(<StreamLogsTimeline logs={[entry]} defaultOpen />)

    expect(screen.getByText('A2A Task cancellation result')).toBeInTheDocument()
    expect(screen.getByText(/Payment Agent/)).toBeInTheDocument()
    expect(screen.getByText(/task-remote-123/)).toBeInTheDocument()
    expect(screen.getByText(/TASK_STATE_CANCELED/)).toBeInTheDocument()
  })

  /**
   * The result row is where the fast-mode verdict is stated in full. It exists
   * because the switch alone cannot answer "did this run actually get it" — the
   * model, the plan and the endpoint each hold a veto — so every state the
   * engines produce must render as a sentence rather than a raw token.
   */
  describe('fast mode verdict', () => {
    const resultWith = (fastModeState?: string) =>
      ({
        type: 'result',
        subtype: 'success',
        durationMs: 1200,
        ts: 2_000,
        ...(fastModeState ? { fastModeState } : {}),
      }) as StreamLogEntry

    it('states that the run was served the faster path', () => {
      renderWithProviders(<StreamLogsTimeline logs={[resultWith('on')]} defaultOpen />)

      expect(screen.getByText(/fast mode served/)).toBeInTheDocument()
    })

    it('states that the request was refused, which the switch cannot show', () => {
      renderWithProviders(<StreamLogsTimeline logs={[resultWith('denied')]} defaultOpen />)

      // Distinct from `off` (never asked) and from the Provider having no fast
      // mode at all — that case never renders the switch, let alone this row.
      expect(screen.getByText(/fast mode denied/)).toBeInTheDocument()
    })

    it('says nothing when the engine reported no verdict', () => {
      renderWithProviders(<StreamLogsTimeline logs={[resultWith()]} defaultOpen />)

      expect(screen.queryByText(/fast mode/i)).toBeNull()
    })

    it('falls back to naming an unrecognised state instead of printing a raw key', () => {
      // The API validates against the closed set, so this only reaches the UI if
      // that guard is ever relaxed — and then the operator must still see words.
      renderWithProviders(<StreamLogsTimeline logs={[resultWith('throttled')]} defaultOpen />)

      expect(screen.getByText(/fast mode: throttled/)).toBeInTheDocument()
      expect(screen.queryByText(/runLog\./)).toBeNull()
    })
  })

  /**
   * The collapsed summary is a one-line scan, so it carries only what the reader
   * is looking for: the model, the level, and whether fast mode plausibly applied.
   */
  describe('collapsed summary', () => {
    const logs = (fastModeState: string | undefined, reasoningEffort?: string) =>
      [
        { type: 'system', subtype: 'init', model: 'gpt-5.6-sol', ts: 1 },
        ...(reasoningEffort
          ? [{ type: 'exec_params', engine: 'codex', params: { reasoningEffort }, ts: 2 }]
          : []),
        {
          type: 'result',
          subtype: 'success',
          durationMs: 1200,
          ts: 3,
          ...(fastModeState ? { fastModeState } : {}),
        },
      ] as StreamLogEntry[]

    it('names the model and the level as bare tokens', () => {
      renderWithProviders(<StreamLogsTimeline logs={logs(undefined, 'ultra')} />)

      const summary = screen.getByRole('button').textContent ?? ''
      expect(summary).toContain('gpt-5.6-sol')
      expect(summary).toContain('ultra')
    })

    it('marks a run that was served the faster path', () => {
      expect(
        renderWithProviders(<StreamLogsTimeline logs={logs('on')} />) &&
          (screen.getByRole('button').textContent ?? ''),
      ).toContain('Fast')
    })

    it('marks a request no engine ever answered, which is all codex admits', () => {
      renderWithProviders(<StreamLogsTimeline logs={logs('requested')} />)

      expect(screen.getByRole('button').textContent ?? '').toContain('Fast')
    })

    it.each(['denied', 'cooldown', 'off'])(
      'drops the marker for %s, which is evidence it did not happen',
      (state) => {
        renderWithProviders(<StreamLogsTimeline logs={logs(state)} />)

        expect(screen.getByRole('button').textContent ?? '').not.toContain('Fast')
      },
    )
  })
})
