import type { StreamLogEntry } from '@/hooks/use-agents'
import i18n from '@/i18n'
import { renderWithProviders, screen } from '@/test/render'
import { beforeEach, describe, expect, it } from 'vitest'
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
})
