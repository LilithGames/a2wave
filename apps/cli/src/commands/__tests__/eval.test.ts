import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockDel = vi.fn()
const mockResolveAgentId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    del: mockDel,
    resolveAgentId: mockResolveAgentId,
  }),
}))

vi.mock('../../lib/args.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/args.js')>()),
  confirmDestructive: vi.fn(),
}))

const { evalCommand, parseCasesFile, waitForTask } = await import('../eval.js')

type TestCommand = { run: (ctx: { args: Record<string, unknown> }) => Promise<void> }

function sub(...path: string[]): TestCommand {
  let node: Record<string, unknown> = evalCommand as unknown as Record<string, unknown>
  for (const p of path) {
    node = (node.subCommands as Record<string, Record<string, unknown>>)[p]
  }
  return node as unknown as TestCommand
}

describe('parseCasesFile', () => {
  it('parses a bare YAML list with explicit turns', () => {
    const cases = parseCasesFile(`
- name: greeting
  turns:
    - request: hi
      expectedResponse: hello
    - request: bye
      expectedResponse: goodbye
`)
    expect(cases).toHaveLength(1)
    expect(cases[0].name).toBe('greeting')
    expect(cases[0].turns).toHaveLength(2)
    expect(cases[0].turns[1]).toEqual({ request: 'bye', expectedResponse: 'goodbye' })
  })

  it('accepts a `cases:` wrapper object', () => {
    const cases = parseCasesFile(`
cases:
  - name: a
    request: q
    expectedResponse: r
`)
    expect(cases[0].turns).toEqual([{ request: 'q', expectedResponse: 'r' }])
  })

  it('promotes a case-level request into a single turn', () => {
    const cases = parseCasesFile('- name: solo\n  request: just this\n')
    expect(cases[0].turns).toEqual([{ request: 'just this', expectedResponse: '' }])
  })

  it('accepts JSON, since JSON is valid YAML', () => {
    const cases = parseCasesFile('[{"name":"j","request":"q","expectedResponse":"r"}]')
    expect(cases[0].name).toBe('j')
  })

  it('assigns positional sortOrder and a fallback name', () => {
    const cases = parseCasesFile('- request: one\n- request: two\n')
    expect(cases.map((c) => c.sortOrder)).toEqual([0, 1])
    expect(cases.map((c) => c.name)).toEqual(['case-1', 'case-2'])
  })

  it('honours an explicit sortOrder', () => {
    const cases = parseCasesFile('- request: one\n  sortOrder: 7\n')
    expect(cases[0].sortOrder).toBe(7)
  })

  it('rejects a file with no cases', () => {
    expect(() => parseCasesFile('[]')).toThrow(/no cases/)
  })

  it('rejects a shape that is neither a list nor a cases object', () => {
    expect(() => parseCasesFile('name: nope')).toThrow(/must be a list/)
  })

  it('rejects a case with no turns', () => {
    expect(() => parseCasesFile('- name: empty\n')).toThrow(/has no turns/)
  })

  it('rejects a turn missing its request', () => {
    expect(() => parseCasesFile('- name: bad\n  turns:\n    - expectedResponse: x\n')).toThrow(
      /missing `request`/,
    )
  })
})

describe('waitForTask', () => {
  it('polls until the task settles', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 'evt_1', status: 'queued' } })
      .mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })
      .mockResolvedValueOnce({ data: { id: 'evt_1', status: 'completed' } })

    const task = await waitForTask({ get }, 'agt_1', 'evt_1', { sleep: async () => {} })

    expect(task.status).toBe('completed')
    expect(get).toHaveBeenCalledWith('/api/agents/agt_1/evaluation-tasks/evt_1')
    expect(get).toHaveBeenCalledTimes(3)
  })

  it('throws when the timeout elapses', async () => {
    const get = vi.fn().mockResolvedValue({ data: { id: 'evt_1', status: 'running' } })
    await expect(
      waitForTask({ get }, 'agt_1', 'evt_1', { timeoutMs: 0, sleep: async () => {} }),
    ).rejects.toThrow(/Timed out/)
  })
})

describe('eval sets', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('lists sets', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({ data: [{ id: 'evs_1', name: 'regression' }] })

    await sub('sets', 'list').run({ args: { agent: 'Bot' } })

    expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/evaluation-sets')
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('evs_1'))
  })

  it('creates a set', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evs_1', name: 'regression' } })

    await sub('sets', 'create').run({ args: { agent: 'Bot', name: 'regression' } })

    expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/evaluation-sets', {
      name: 'regression',
      description: null,
    })
  })

  it('refuses an update with no fields', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    await expect(
      sub('sets', 'update').run({ args: { agent: 'Bot', set: 'evs_1' } }),
    ).rejects.toThrow(/Nothing to update/)
  })

  it('resolves a set by name', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet
      .mockResolvedValueOnce({ data: [{ id: 'evs_9', name: 'regression' }] })
      .mockResolvedValueOnce({ data: [] })

    await sub('cases', 'list').run({ args: { agent: 'Bot', set: 'regression' } })

    expect(mockGet).toHaveBeenLastCalledWith('/api/agents/agt_1/evaluation-sets/evs_9/cases')
  })

  it('errors on an ambiguous set name instead of guessing', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: [
        { id: 'evs_1', name: 'dup' },
        { id: 'evs_2', name: 'dup' },
      ],
    })

    await expect(sub('cases', 'list').run({ args: { agent: 'Bot', set: 'dup' } })).rejects.toThrow(
      /matches multiple/,
    )
  })

  it('errors with the available names when a set is missing', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({ data: [{ id: 'evs_1', name: 'other' }] })

    await expect(sub('cases', 'list').run({ args: { agent: 'Bot', set: 'nope' } })).rejects.toThrow(
      /Available: other/,
    )
  })
})

describe('eval run', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>
  let prevExitCode: string | number | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    prevExitCode = process.exitCode ?? undefined
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    process.exitCode = prevExitCode
    vi.restoreAllMocks()
  })

  it('starts a task and returns without --wait', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })

    await sub('run').run({ args: { agent: 'Bot', set: 'evs_1' } })

    expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/evaluation-tasks', {
      setId: 'evs_1',
      name: null,
    })
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('evt_1'))
  })

  it('exits non-zero when the task itself fails', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })
    mockGet.mockResolvedValueOnce({
      data: { id: 'evt_1', setName: 's', status: 'failed', results: [] },
    })

    await sub('run').run({ args: { agent: 'Bot', set: 'evs_1', wait: true } })

    expect(process.exitCode).toBe(1)
  })

  it('does not fail CI on failed verdicts unless --fail-on-fail is set', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'completed',
        summary: { total: 2, passed: 1, failed: 1, unreviewed: 0, passRate: 0.5 },
        results: [],
      },
    })

    await sub('run').run({ args: { agent: 'Bot', set: 'evs_1', wait: true } })

    expect(process.exitCode).not.toBe(1)
  })

  it('exits non-zero on failed verdicts with --fail-on-fail', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'completed',
        summary: { total: 2, passed: 1, failed: 1, unreviewed: 0, passRate: 0.5 },
        results: [],
      },
    })

    await sub('run').run({
      args: { agent: 'Bot', set: 'evs_1', wait: true, 'fail-on-fail': true },
    })

    expect(process.exitCode).toBe(1)
  })
})

describe('eval tasks', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('rejects an invalid verdict before calling the API', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')

    await expect(
      sub('tasks', 'verdict').run({
        args: { agent: 'Bot', task: 'evt_1', result: 'evr_1', verdict: 'maybe' },
      }),
    ).rejects.toThrow(/Invalid verdict/)
    expect(mockPatch).not.toHaveBeenCalled()
  })

  it('records a valid verdict', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPatch.mockResolvedValueOnce({ data: { id: 'evr_1' } })

    await sub('tasks', 'verdict').run({
      args: { agent: 'Bot', task: 'evt_1', result: 'evr_1', verdict: 'pass', note: 'ok' },
    })

    expect(mockPatch).toHaveBeenCalledWith(
      '/api/agents/agt_1/evaluation-tasks/evt_1/results/evr_1',
      { verdict: 'pass', note: 'ok' },
    )
  })

  it('describes cancellation as a request, since it lands between cases', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evt_1', cancelling: true } })

    await sub('tasks', 'cancel').run({ args: { agent: 'Bot', task: 'evt_1' } })

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Cancellation requested'))
  })
})

describe('eval cases import partial failure', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('reports how far it got when a case fails mid-import', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'evalcases-'))
    const file = join(dir, 'cases.yaml')
    writeFileSync(
      file,
      '- name: a\n  request: q1\n- name: b\n  request: q2\n- name: c\n  request: q3\n',
    )

    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({ data: [{ id: 'evs_1', name: 'set' }] })
    mockPost
      .mockResolvedValueOnce({ data: { id: 'evc_1', name: 'a', turns: [] } })
      .mockRejectedValueOnce(new Error('API Error (500): boom'))

    await expect(
      sub('cases', 'import').run({ args: { agent: 'Bot', set: 'set', file } }),
    ).rejects.toThrow(/boom/)

    const errors = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    // Without this the user cannot tell which cases already exist, and a blind
    // retry silently duplicates them.
    expect(errors).toContain('1/3')
    expect(errors).toContain('a')
  })
})

describe('eval run --wait --json exit codes', () => {
  let prevExitCode: string | number | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    prevExitCode = process.exitCode ?? undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    process.exitCode = prevExitCode
    vi.restoreAllMocks()
  })

  it('still exits non-zero when --json is combined with --wait', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })
    mockGet.mockResolvedValueOnce({
      data: { id: 'evt_1', setName: 's', status: 'failed', results: [] },
    })

    await sub('run').run({ args: { agent: 'Bot', set: 'evs_1', wait: true, json: true } })

    // --json returns early; the exit code must be set before that.
    expect(process.exitCode).toBe(1)
  })
})

describe('eval tasks get — real result row shape', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('reads the verdict from the nested review object, not a flat column', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'completed',
        results: [
          {
            id: 'evr_1',
            caseName: 'greeting',
            status: 'completed',
            // The DB column is `review: {verdict, note}` — not `verdict`/`note`.
            review: { verdict: 'fail', note: 'wrong tone' },
            error: 'boom',
            actualTurns: [{ request: 'hi', expectedResponse: 'hello', actualResponse: 'yo' }],
          },
        ],
      },
    })

    await sub('tasks', 'get').run({ args: { agent: 'Bot', task: 'evt_1' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('verdict=fail')
    expect(out).toContain('wrong tone')
    expect(out).toContain('boom')
    expect(out).toContain('yo')
  })

  it('falls back to turnsSnapshot for a case that never ran', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'cancelled',
        results: [
          {
            id: 'evr_1',
            caseName: 'never-ran',
            status: 'cancelled',
            actualTurns: null,
            turnsSnapshot: [{ request: 'q', expectedResponse: 'a' }],
          },
        ],
      },
    })

    await sub('tasks', 'get').run({ args: { agent: 'Bot', task: 'evt_1' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('q')
    expect(out).toContain('a')
  })
})

describe('eval tasks get — task-level failure reason', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  it('surfaces the task error and finishedAt (not a non-existent completedAt)', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'failed',
        // A whole task can fail before any case runs — e.g. its snapshotted
        // provider was unbound. Without this the CLI showed only "failed".
        error: 'Provider prv_x is no longer bound',
        finishedAt: '2026-07-27T10:00:00Z',
        results: [],
      },
    })

    await sub('tasks', 'get').run({ args: { agent: 'Bot', task: 'evt_1' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('no longer bound')
    expect(out).toContain('2026-07-27')
  })
})

describe('eval tasks get — frozen config snapshot', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  // The snapshot exists so two tasks can be compared. Effort and fast mode are
  // frozen alongside the model, so hiding them makes two runs that differed only
  // in reasoning depth print as identical.
  it('prints the frozen reasoning effort and fast mode next to provider/model', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'completed',
        configSnapshot: {
          providerName: 'Codex',
          model: 'gpt-5.6-sol',
          reasoningEffort: 'ultra',
          fastMode: true,
        },
        results: [],
      },
    })

    await sub('tasks', 'get').run({ args: { agent: 'Bot', task: 'evt_1' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('provider=Codex')
    expect(out).toContain('model=gpt-5.6-sol')
    expect(out).toContain('effort=ultra')
    expect(out).toContain('fastMode=true')
  })

  it('reports fast mode that was frozen off, which is not the same as unset', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'completed',
        configSnapshot: { providerName: 'Claude', model: 'opus', fastMode: false },
        results: [],
      },
    })

    await sub('tasks', 'get').run({ args: { agent: 'Bot', task: 'evt_1' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('fastMode=false')
    expect(out).not.toContain('effort=')
  })

  it('omits both controls when the snapshot froze neither', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'completed',
        configSnapshot: { providerName: 'Claude', model: 'opus' },
        results: [],
      },
    })

    await sub('tasks', 'get').run({ args: { agent: 'Bot', task: 'evt_1' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain('Snapshot: provider=Claude model=opus')
    expect(out).not.toContain('effort=')
    expect(out).not.toContain('fastMode=')
  })
})

describe('eval run --fail-on-fail gates on replay errors, not just verdicts', () => {
  let prevExitCode: string | number | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    prevExitCode = process.exitCode ?? undefined
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    process.exitCode = prevExitCode
    vi.restoreAllMocks()
  })

  /** A task where every case errored, yet the server settled it `completed`. */
  const allCasesErrored = {
    id: 'evt_1',
    setName: 's',
    status: 'completed',
    // summary.failed counts MANUAL verdicts only, so it is 0 on a fresh run.
    summary: { total: 2, passed: 0, failed: 0, unreviewed: 2, passRate: null },
    results: [
      { id: 'evr_1', caseName: 'a', status: 'failed', error: 'boom' },
      { id: 'evr_2', caseName: 'b', status: 'failed', error: 'boom' },
    ],
  }

  it('exits 1 when every case errored but summary.failed is 0', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })
    mockGet.mockResolvedValueOnce({ data: allCasesErrored })

    await sub('run').run({
      args: { agent: 'Bot', set: 'evs_1', wait: true, 'fail-on-fail': true },
    })

    // Gating on summary.failed alone made this exit 0 — a green CI gate over a
    // run in which nothing succeeded.
    expect(process.exitCode).toBe(1)
  })

  it('stays 0 without --fail-on-fail, since the task itself completed', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })
    mockGet.mockResolvedValueOnce({ data: allCasesErrored })

    await sub('run').run({ args: { agent: 'Bot', set: 'evs_1', wait: true } })

    expect(process.exitCode).not.toBe(1)
  })

  it('stays 0 when all cases genuinely succeeded', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockPost.mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })
    mockGet.mockResolvedValueOnce({
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'completed',
        summary: { total: 1, passed: 0, failed: 0, unreviewed: 1, passRate: null },
        results: [{ id: 'evr_1', caseName: 'a', status: 'completed' }],
      },
    })

    await sub('run').run({
      args: { agent: 'Bot', set: 'evs_1', wait: true, 'fail-on-fail': true },
    })

    expect(process.exitCode).not.toBe(1)
  })
})

describe('waitForTask cadence propagation', () => {
  it('keeps its 60-minute budget when opts carry an explicit undefined', async () => {
    // The exact regression: evaluation replays fan out into N sequential agent
    // invocations and are allowed 60min, but `{...cadence, ...opts}` let an
    // explicit undefined fall through to the helper's generic 30min default.
    const sleep = vi.fn().mockResolvedValue(undefined)
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: 'evt_1', status: 'running' } })
      .mockResolvedValueOnce({ data: { id: 'evt_1', status: 'completed' } })

    await waitForTask({ get }, 'agt_1', 'evt_1', {
      timeoutMs: undefined,
      intervalMs: undefined,
      sleep,
    })

    // 5000ms is the eval cadence; the helper's generic default is 2000, so a
    // spread reintroduced at this layer would surface as 2000 here.
    expect(sleep).toHaveBeenCalledWith(5000)
  })
})

// A 50-case x 3-turn task printed 750+ lines of full request/expected/actual
// text. The bodies are the bulk, and the reason to run `eval tasks get` is
// usually "which cases failed", not "replay every transcript".
describe('eval tasks get — output bounding', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => vi.restoreAllMocks())

  const longBody = 'x'.repeat(500)

  function taskWithTurns() {
    return {
      data: {
        id: 'evt_1',
        setName: 's',
        status: 'completed',
        results: [
          {
            id: 'evr_1',
            caseName: 'c1',
            status: 'completed',
            actualTurns: [
              { request: longBody, expectedResponse: longBody, actualResponse: longBody },
            ],
          },
        ],
      },
    }
  }

  it('truncates long turn bodies and marks the cut', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce(taskWithTurns())

    await sub('tasks', 'get').run({ args: { agent: 'Bot', task: 'evt_1' } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    // Still shows enough to identify the turn...
    expect(out).toContain('xxxx')
    // ...but not the whole 500-char body, and says it cut.
    expect(out).not.toContain(longBody)
    expect(out).toContain('…')
  })

  it('prints full bodies with --verbose', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce(taskWithTurns())

    await sub('tasks', 'get').run({ args: { agent: 'Bot', task: 'evt_1', verbose: true } })

    const out = consoleSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n')
    expect(out).toContain(longBody)
  })

  it('leaves --json untouched', async () => {
    mockResolveAgentId.mockResolvedValueOnce('agt_1')
    mockGet.mockResolvedValueOnce(taskWithTurns())

    await sub('tasks', 'get').run({ args: { agent: 'Bot', task: 'evt_1', json: true } })

    const parsed = JSON.parse(String(consoleSpy.mock.calls.at(-1)?.[0]))
    expect(parsed.data.results[0].actualTurns[0].request).toBe(longBody)
  })
})
