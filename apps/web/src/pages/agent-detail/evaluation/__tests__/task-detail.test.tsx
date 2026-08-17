/**
 * The config snapshot is the whole point of a task: it is what lets one run be
 * compared against another. Reasoning effort and fast mode are frozen alongside
 * the model because they move a result as surely as swapping the model does, so
 * the detail view has to state them — a value recorded in the database and shown
 * nowhere is the same as not having recorded it.
 *
 * Both are optional, and a task frozen before they existed carries neither. They
 * therefore render only when actually frozen: two permanent empty columns on
 * every historical task would cost more than they explain.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvaluationTaskDetail } from '@/hooks/use-evaluation'
import { renderWithProviders, screen } from '@/test/render'
import { TaskDetail } from '../task-detail'

const useEvaluationTask = vi.fn()

vi.mock('@/hooks/use-evaluation', () => ({
  useEvaluationTask: (...args: unknown[]) => useEvaluationTask(...args),
  useReviewEvaluationResult: () => ({ mutate: vi.fn(), isPending: false }),
  REVIEWABLE_RESULT_STATUSES: ['completed', 'failed'],
}))

function makeTask(snapshot: Record<string, unknown> | null): EvaluationTaskDetail {
  return {
    id: 'evt_1',
    agentId: 'agt_1',
    setId: 'evs_1',
    setName: 'Smoke set',
    name: 'Nightly run',
    status: 'completed',
    configSnapshot: snapshot,
    summary: { total: 1, passed: 1, failed: 0, unreviewed: 0, passRate: 1 },
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString(),
    results: [],
  } as unknown as EvaluationTaskDetail
}

function renderTask(snapshot: Record<string, unknown> | null) {
  useEvaluationTask.mockReturnValue({ data: makeTask(snapshot), isLoading: false, isError: false })
  renderWithProviders(<TaskDetail agentId="agt_1" taskId="evt_1" canWrite onBack={vi.fn()} />)
}

const base = {
  providerId: 'prv_1',
  providerName: 'Anthropic',
  model: 'claude-opus-4-8',
  systemPrompt: '',
  capturedAt: new Date('2026-07-20T00:00:00Z'),
}

// The suite runs under the default locale, so match both wordings rather than
// pinning one language.
const EFFORT_LABEL = /推理档位|Reasoning effort/i
const FAST_LABEL = /快速模式|Fast mode/i

describe('TaskDetail config snapshot', () => {
  beforeEach(() => vi.clearAllMocks())

  it('states the reasoning level the task was frozen at', () => {
    renderTask({ ...base, reasoningEffort: 'ultra', fastMode: null })

    expect(screen.getByText(EFFORT_LABEL)).toBeInTheDocument()
    expect(screen.getByText('ultra')).toBeInTheDocument()
  })

  it('states fast mode as on when it was frozen on', () => {
    renderTask({ ...base, reasoningEffort: null, fastMode: true })

    expect(screen.getByText(FAST_LABEL)).toBeInTheDocument()
    expect(screen.getByText(/^(开|On)$/)).toBeInTheDocument()
  })

  /**
   * `false` is a real frozen answer, not a missing one — the snapshot exists so
   * that a task queued with fast mode off cannot inherit a later toggle. Hiding
   * it would make "off" and "never recorded" look identical in the one view
   * built for comparing runs.
   */
  it('states fast mode as off when it was frozen off', () => {
    renderTask({ ...base, reasoningEffort: null, fastMode: false })

    expect(screen.getByText(FAST_LABEL)).toBeInTheDocument()
    expect(screen.getByText(/^(关|Off)$/)).toBeInTheDocument()
  })

  it('shows neither row when the task configured neither', () => {
    renderTask({ ...base, reasoningEffort: null, fastMode: null })

    expect(screen.queryByText(EFFORT_LABEL)).toBeNull()
    expect(screen.queryByText(FAST_LABEL)).toBeNull()
  })

  it('shows neither row for a task frozen before the fields existed', () => {
    // No keys at all — the shape written before this feature landed.
    renderTask(base)

    expect(screen.queryByText(EFFORT_LABEL)).toBeNull()
    expect(screen.queryByText(FAST_LABEL)).toBeNull()
  })

  it('still renders provider and model when the whole snapshot is missing', () => {
    renderTask(null)

    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })
})
