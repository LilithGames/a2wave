import { renderWithProviders, screen, userEvent, within } from '@/test/render'
import { DEFAULT_MEMORY_INSIGHT_PROMPT, DEFAULT_MEMORY_WORKLOG_PROMPT } from '@a2wave/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useMemoryTopics: vi.fn(),
  useMemoryTopic: vi.fn(),
  mutate: vi.fn(),
}))

vi.mock('@/hooks/use-memories', () => ({
  useMemoryTopics: mocks.useMemoryTopics,
  useMemoryTopic: mocks.useMemoryTopic,
  useReorganizeMemoryTopics: () => ({ mutate: mocks.mutate, isPending: false }),
}))

import { DEFAULT_INSIGHT_PROMPT, DEFAULT_WORKLOG_PROMPT, TopicDirectoryCard } from '../memory-tab'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.useMemoryTopics.mockReturnValue({
    data: {
      data: {
        mode: 'topic_v2',
        invalidFiles: [],
        topics: [
          {
            topicId: 'tpc_a1b2c3d4',
            title: 'Campaign mail delivery',
            scope: 'Campaign mail creation and release behavior.',
            description: 'Campaign mail contracts and release checks.',
            keywords: ['campaign', 'release'],
            status: 'active',
            updatedAt: '2026-07-29T00:00:00.000Z',
            path: 'memory/topics/tpc_a1b2c3d4-campaign-mail-delivery.md',
            size: 400,
            tokenCount: 120,
            needsReorganization: false,
          },
        ],
      },
    },
    isFetching: false,
  })
  mocks.useMemoryTopic.mockImplementation((_agentId: string, topicId?: string) => ({
    data: topicId
      ? {
          data: {
            title: 'Campaign mail delivery',
            path: 'memory/topics/tpc_a1b2c3d4-campaign-mail-delivery.md',
            content: '# Campaign mail delivery\n\n- Validate item_id serialization.',
          },
        }
      : undefined,
    isFetching: false,
  }))
})

describe('MemoryTab defaults', () => {
  it('uses the shared memory prompts in the UI default editor', () => {
    expect(DEFAULT_WORKLOG_PROMPT).toBe(DEFAULT_MEMORY_WORKLOG_PROMPT)
    expect(DEFAULT_INSIGHT_PROMPT).toBe(DEFAULT_MEMORY_INSIGHT_PROMPT)
  })

  it('discloses one selected topic after rendering metadata only', async () => {
    const user = userEvent.setup()
    renderWithProviders(<TopicDirectoryCard agentId="agt_test" canWrite />)

    expect(screen.getByText('Campaign mail contracts and release checks.')).toBeInTheDocument()
    expect(screen.queryByText(/Validate item_id serialization/)).not.toBeInTheDocument()

    const topicButton = screen.getByRole('button', { name: /Campaign mail delivery/ })
    expect(topicButton).toHaveAttribute('aria-pressed', 'false')
    await user.click(topicButton)

    expect(topicButton).toHaveAttribute('aria-pressed', 'true')
    const detailRegion = screen.getByRole('region', { name: '主题正文' })
    expect(detailRegion).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Campaign mail delivery' })).toBeInTheDocument()
    expect(within(detailRegion).getByRole('listitem')).toHaveTextContent(
      'Validate item_id serialization',
    )
    expect(mocks.useMemoryTopic).toHaveBeenLastCalledWith('agt_test', 'tpc_a1b2c3d4')
  })

  it('offers a two-step preview for legacy single-file memory', async () => {
    const user = userEvent.setup()
    mocks.useMemoryTopics.mockReturnValue({
      data: { data: { mode: 'legacy_single_file', invalidFiles: [], topics: [] } },
      isFetching: false,
    })

    renderWithProviders(<TopicDirectoryCard agentId="agt_test" canWrite />)
    await user.click(screen.getByRole('button', { name: '预览主题化' }))

    expect(mocks.mutate).toHaveBeenCalledWith(
      { agentId: 'agt_test', request: { action: 'topicize-preview' } },
      expect.any(Object),
    )
  })
})
