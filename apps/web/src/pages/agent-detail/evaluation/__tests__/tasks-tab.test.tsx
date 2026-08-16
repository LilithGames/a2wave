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
