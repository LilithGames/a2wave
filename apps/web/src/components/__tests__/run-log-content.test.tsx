/**
 * The overview copy button is the only way to get a run's identity out of the
 * log panel. Copying the intent without the id produces text nobody can trace
 * back to a run, so the id has to lead the payload.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

const copyText = vi.hoisted(() => vi.fn(async (_text: string) => true))

vi.mock('@/lib/clipboard', () => ({ copyText }))

const run = {
  id: 'run_v_HdrN4kMdaDR6wO',
  status: 'running',
  intent: 'review this MR and comment back',
  createdAt: new Date('2026-08-20T03:32:11Z').toISOString(),
  steps: [],
  result: null,
  hasFullLog: false,
}

vi.mock('@/hooks/use-runs', () => ({ useRun: () => ({ data: run, isLoading: false }) }))
vi.mock('@/hooks/use-artifacts', () => ({
  useArtifacts: () => ({ data: [] }),
  useDeleteArtifact: () => ({ mutate: vi.fn(), isPending: false }),
  getArtifactDownloadUrl: (id: string) => `/api/artifacts/${id}/download`,
}))

import { RunLogContent } from '../run-log-content'

describe('RunLogContent copy', () => {
  beforeEach(() => copyText.mockClear())

  it('copies the run id together with the intent', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <RunLogContent runId={run.id} />
      </I18nextProvider>,
    )

    await userEvent.click(screen.getByRole('button', { name: i18n.t('runLog.copyRunId') }))

    const copied = copyText.mock.calls[0][0]
    expect(copied).toContain(run.id)
    expect(copied).toContain(run.intent)
    expect(copied.indexOf(run.id)).toBeLessThan(copied.indexOf(run.intent))
  })
})
