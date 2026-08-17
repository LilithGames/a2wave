import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvaluationTaskRow } from '@/hooks/use-evaluation'
import { renderWithProviders, screen } from '@/test/render'
import { TasksTab } from '../tasks-tab'

const useEvaluationTasks = vi.fn()
// Both hooks nest the payload under `.data`, and useAgent nests the agent one
// level deeper still ({ data: { data: agent } }) — flattening either here would
// hide a component reading the wrong level.
type AgentFields = { workspaceType: string; scmSourceId: string | null }
type ScmSourceFields = { id: string; type: string; name: string }

const useAgent = vi.fn<() => { data: { data: AgentFields } }>(() => ({
  data: { data: { workspaceType: 'local', scmSourceId: null } },
}))
const useScmSources = vi.fn<() => { data: { data: ScmSourceFields[] } }>(() => ({
  data: { data: [] },
}))

vi.mock('@/hooks/use-agents', () => ({
  useAgent: (...args: unknown[]) => useAgent(...(args as [])),
}))

vi.mock('@/hooks/use-scm-sources', () => ({
  useScmSources: (...args: unknown[]) => useScmSources(...(args as [])),
}))

vi.mock('@/hooks/use-evaluation', () => ({
  useEvaluationTasks: (...args: unknown[]) => useEvaluationTasks(...args),
  useEvaluationSets: () => ({ data: [] }),
  useCreateEvaluationTask: () => ({ mutate: vi.fn(), isPending: false }),
  useCancelEvaluationTask: () => ({ mutate: vi.fn() }),
  useDeleteEvaluationTask: () => ({ mutate: vi.fn() }),
}))

function makeTask(overrides: Partial<EvaluationTaskRow> = {}): EvaluationTaskRow {
  return {
    id: 'evt_1',
    agentId: 'agt_1',
    setId: 'evs_1',
    setName: 'Smoke set',
    name: 'Nightly run',
    status: 'completed',
    configSnapshot: {
      providerId: 'prv_1',
      providerName: 'Anthropic',
      model: 'claude-opus-4-8',
      systemPrompt: '',
      capturedAt: new Date('2026-07-20T00:00:00Z'),
    },
    summary: { total: 4, passed: 3, failed: 1, unreviewed: 0, passRate: 0.75 },
    error: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as EvaluationTaskRow
}

function renderTasks(tasks: EvaluationTaskRow[]) {
  useEvaluationTasks.mockReturnValue({ data: tasks, isLoading: false })
  renderWithProviders(<TasksTab agentId="agt_1" canWrite />)
}

describe('TasksTab', () => {
  beforeEach(() => vi.clearAllMocks())

  // Provider, model and time are what make two runs comparable, so they belong
  // on the row itself rather than only inside the task detail view.
  it('shows provider, model and when the run happened', () => {
    renderTasks([makeTask()])

    expect(screen.getByText(/Anthropic/).textContent).toContain('claude-opus-4-8')
    expect(screen.getByText(/刚刚|just now/i)).toBeInTheDocument()
  })

  // Provider and model answer "what was run"; the timestamp answers "when".
  // Keeping them in separate columns is what stops the row reading as one long
  // run-on chain of dot-separated facts.
  it('keeps the timestamp out of the provider/model line', () => {
    renderTasks([makeTask()])

    expect(screen.getByText(/Anthropic/).textContent).not.toMatch(/刚刚|just now/i)
  })

  // The percentage column already states the result, so repeating "1/1 passed"
  // next to a "100%" is the same fact twice.
  it('does not repeat the pass count next to the pass rate', () => {
    renderTasks([makeTask()])

    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.queryByText(/3\s*\/\s*4/)).toBeNull()
  })

  // A task created before its provider was named must not render a meta line
  // that starts with a stray separator.
  it('omits missing snapshot fields instead of leaving dangling separators', () => {
    renderTasks([
      makeTask({
        summary: null,
        configSnapshot: {
          providerId: null,
          providerName: null,
          model: null,
          reasoningEffort: null,
          fastMode: null,
          systemPrompt: '',
          capturedAt: new Date('2026-07-20T00:00:00Z'),
        },
      }),
    ])

    expect(screen.queryByText(/·/)).toBeNull()
  })
})

/**
 * The "config changed" flag is what stops a pass-rate drop being read as a model
 * regression when something else moved. Reasoning effort and fast mode ride with
 * the model, so a change to either has to raise it — two tasks that differ only
 * in reasoning depth are exactly the pair the frozen fields were added for.
 */
describe('TasksTab config-change flag', () => {
  beforeEach(() => vi.clearAllMocks())

  // The suite runs under the default locale, so match both wordings rather than
  // pinning one language.
  const CHANGED_MODEL = /模型有变更|model changed/i
  const CHANGED_ANY = /模型有变更|提示词有变更|model changed|prompt changed/i

  const snapshot = (overrides: Record<string, unknown> = {}) => ({
    providerId: 'prv_1',
    providerName: 'Anthropic',
    model: 'claude-opus-4-8',
    reasoningEffort: 'low',
    fastMode: false,
    systemPrompt: '',
    capturedAt: new Date('2026-07-20T00:00:00Z'),
    ...overrides,
  })

  /** Newest first, matching the list order the component reads `previous` from. */
  const renderPair = (newer: Record<string, unknown>, older: Record<string, unknown>) =>
    renderTasks([
      makeTask({ id: 'evt_new', configSnapshot: snapshot(newer) as never }),
      makeTask({ id: 'evt_old', configSnapshot: snapshot(older) as never }),
    ])

  it('flags a task whose reasoning level differs from the previous run', () => {
    renderPair({ reasoningEffort: 'ultra' }, { reasoningEffort: 'low' })

    expect(screen.getByText(CHANGED_MODEL)).toBeInTheDocument()
  })

  it('flags a task whose fast mode differs', () => {
    renderPair({ fastMode: true }, { fastMode: false })

    expect(screen.getByText(CHANGED_MODEL)).toBeInTheDocument()
  })

  it('stays quiet when both runs used the same configuration', () => {
    renderPair({}, {})

    expect(screen.queryByText(CHANGED_ANY)).toBeNull()
  })

  /**
   * The regression this guards: a task frozen before these fields existed
   * carries `undefined` where a new one carries `null`. Compared directly, every
   * pair straddling the change would be flagged — a warning about a difference
   * that is entirely in the storage format.
   */
  it('does not flag a pre-change task against a new one that configured nothing', () => {
    renderTasks([
      // New row: the fields exist and were frozen as "not configured".
      makeTask({
        id: 'evt_new',
        configSnapshot: snapshot({ reasoningEffort: null, fastMode: null }) as never,
      }),
      // Older row: written before the fields existed, so it carries neither key.
      makeTask({
        id: 'evt_old',
        configSnapshot: {
          providerId: 'prv_1',
          providerName: 'Anthropic',
          model: 'claude-opus-4-8',
          systemPrompt: '',
          capturedAt: new Date('2026-07-19T00:00:00Z'),
        } as never,
      }),
    ])

    // `undefined` vs `null` is a storage-format difference, not a config change.
    expect(screen.queryByText(CHANGED_MODEL)).toBeNull()
  })
})

/**
 * A P4 Agent evaluates inside the one shared checkout: a P4 client is
 * server-side state bound to a single Root, so a2wave has no worktree to hand
 * the task. Anything else touching that source mid-run — a chat run, a sync —
 * changes what is being measured, and only the user knows whether that is
 * happening. Git and local Agents get real isolation and must stay quiet.
 */
describe('TasksTab shared-workspace warning', () => {
  beforeEach(() => vi.clearAllMocks())

  // The warning belongs where the user commits to a run, so it only exists once
  // the create dialog is open.
  async function renderForSource(agent: AgentFields, sources: ScmSourceFields[]) {
    useAgent.mockReturnValue({ data: { data: agent } })
    useScmSources.mockReturnValue({ data: { data: sources } })
    useEvaluationTasks.mockReturnValue({ data: [], isLoading: false })
    renderWithProviders(<TasksTab agentId="agt_1" canWrite />)
    await userEvent.click(screen.getAllByRole('button', { name: /发起评测|New evaluation/i })[0])
  }

  const P4_SOURCE = { id: 'scm_1', type: 'p4', name: 'depot' }
  const GIT_SOURCE = { id: 'scm_1', type: 'git', name: 'repo' }

  it('warns when the agent runs on a P4 source', async () => {
    await renderForSource({ workspaceType: 'scm', scmSourceId: 'scm_1' }, [P4_SOURCE])

    expect(screen.getByText(/P4/)).toBeInTheDocument()
  })

  it('stays quiet for a git source, which gets its own worktree', async () => {
    await renderForSource({ workspaceType: 'scm', scmSourceId: 'scm_1' }, [GIT_SOURCE])

    expect(screen.queryByText(/P4/)).toBeNull()
  })

  it('stays quiet for a local agent', async () => {
    await renderForSource({ workspaceType: 'local', scmSourceId: null }, [P4_SOURCE])

    expect(screen.queryByText(/P4/)).toBeNull()
  })
})
