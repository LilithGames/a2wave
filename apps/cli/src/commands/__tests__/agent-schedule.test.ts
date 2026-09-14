import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockGet = vi.fn()
const mockPost = vi.fn()
const mockResolveAgentId = vi.fn()

vi.mock('../../client.js', () => ({
  urlArg: {},
  createClient: () => ({
    get: mockGet,
    post: mockPost,
    resolveAgentId: mockResolveAgentId,
  }),
}))

const { CliError } = await import('../../errors.js')
const { agentScheduleCommand, renderScheduleIntent } = await import('../agent-schedule.js')

type SubCmd = {
  meta?: { name?: string; agentMeta?: { risk?: string } }
  run: (ctx: { args: Record<string, unknown> }) => Promise<void>
}
const subs = agentScheduleCommand.subCommands as Record<string, SubCmd>

const SCHEDULES = [
  {
    id: 'sch_morning',
    index: 0,
    cron: '0 9 * * *',
    timezone: 'UTC',
    intent: 'Morning review for {{date}} at {{time}} ({{iso}})',
    nextRun: '2026-09-15T09:00:00.000Z',
    stable: true,
  },
  {
    id: 'agt_1:1',
    index: 1,
    cron: 'bad',
    timezone: 'Asia/Shanghai',
    intent: 'x'.repeat(80),
    nextRun: null,
    stable: false,
  },
  {
    // Persisted before the timezone refine existed: the server cannot register
    // it, and a local render would throw a RangeError on the timezone.
    id: 'sch_badtz',
    index: 2,
    cron: '0 9 * * *',
    timezone: 'Asia/Shangai',
    intent: 'Stale {{date}}',
    nextRun: null,
    stable: true,
  },
]

describe('renderScheduleIntent', () => {
  it('renders {{date}}, {{time}} and {{iso}} in the schedule timezone like the server', () => {
    const now = new Date('2026-09-14T23:30:00.000Z')
    expect(renderScheduleIntent('{{date}} {{time}} {{iso}}', 'Asia/Shanghai', now)).toBe(
      '2026-09-15 07:30 2026-09-14T23:30:00.000Z',
    )
    expect(renderScheduleIntent('{{date}} {{time}}', 'UTC', now)).toBe('2026-09-14 23:30')
  })

  it('leaves a template without placeholders untouched', () => {
    expect(renderScheduleIntent('plain', 'UTC', new Date())).toBe('plain')
  })
})

describe('agents schedule', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockResolveAgentId.mockResolvedValue('agt_1')
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const printedLines = (): string[] => consoleSpy.mock.calls.map((c: unknown[]) => String(c[0]))

  it('labels list as read and run as write', () => {
    expect(agentScheduleCommand.meta).toMatchObject({ name: 'schedule' })
    expect(subs.list.meta?.agentMeta?.risk).toBe('read')
    expect(subs.run.meta?.agentMeta?.risk).toBe('write')
  })

  describe('list', () => {
    it('resolves the agent by name and prints one row per schedule', async () => {
      mockGet.mockResolvedValueOnce({ data: SCHEDULES })

      await subs.list.run({ args: { agent: 'Reviewer' } })

      expect(mockResolveAgentId).toHaveBeenCalledWith('Reviewer')
      expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/schedules')
      const lines = printedLines()
      const morning = lines.find((l) => l.includes('sch_morning'))
      expect(morning).toContain('0 9 * * *')
      expect(morning).toContain('UTC')
      expect(morning).toContain('2026-09-15T09:00:00.000Z')
      expect(morning).toContain('Morning review for {{date}}')
      const legacy = lines.find((l) => l.includes('agt_1:1'))
      expect(legacy).toContain('-')
      expect(legacy).not.toContain('x'.repeat(61))
      expect(legacy).toContain('…')
    })

    it('marks entries whose id is positional so a caller knows not to rehearse them', async () => {
      mockGet.mockResolvedValueOnce({ data: SCHEDULES })

      await subs.list.run({ args: { agent: 'agt_1' } })

      const lines = printedLines()
      expect(lines.find((l) => l.includes('agt_1:1'))).toContain('(positional)')
      expect(lines.find((l) => l.includes('sch_morning'))).not.toContain('(positional)')
      expect(lines.find((l) => l.includes('sch_badtz'))).not.toContain('(positional)')
    })

    it('says so when there are no schedules', async () => {
      mockGet.mockResolvedValueOnce({ data: [] })

      await subs.list.run({ args: { agent: 'agt_1' } })

      expect(consoleSpy).toHaveBeenCalledWith('No schedules configured')
    })

    it('emits the raw payload under --json', async () => {
      mockGet.mockResolvedValueOnce({ data: SCHEDULES })

      await subs.list.run({ args: { agent: 'agt_1', json: true } })

      expect(consoleSpy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual({ data: SCHEDULES })
    })
  })

  describe('run', () => {
    it('posts the run endpoint and prints the run id, status and a follow-up hint', async () => {
      mockPost.mockResolvedValueOnce({
        data: { runId: 'run_1', status: 'queued', intent: 'Morning review for 2026-09-14' },
      })

      await subs.run.run({ args: { agent: 'Reviewer', scheduleId: 'sch_morning' } })

      expect(mockPost).toHaveBeenCalledWith('/api/agents/agt_1/schedules/sch_morning/run', {})
      expect(mockGet).not.toHaveBeenCalled()
      const lines = printedLines()
      expect(lines.some((l) => l.includes('run_1'))).toBe(true)
      expect(lines.some((l) => l.includes('queued'))).toBe(true)
      expect(lines.some((l) => l.includes('a2wave runs get run_1'))).toBe(true)
    })

    it('emits the run payload under --json', async () => {
      const payload = { data: { runId: 'run_1', status: 'pending', intent: 'x' } }
      mockPost.mockResolvedValueOnce(payload)

      await subs.run.run({ args: { agent: 'agt_1', scheduleId: 'sch_morning', json: true } })

      expect(JSON.parse(String(consoleSpy.mock.calls[0][0]))).toEqual(payload)
    })

    it('--dry-run renders the intent locally without creating a run', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-14T23:30:00.000Z'))
      mockGet.mockResolvedValueOnce({ data: SCHEDULES })

      await subs.run.run({ args: { agent: 'agt_1', scheduleId: 'sch_morning', 'dry-run': true } })

      expect(mockGet).toHaveBeenCalledWith('/api/agents/agt_1/schedules')
      expect(mockPost).not.toHaveBeenCalled()
      const lines = printedLines()
      expect(lines).toContain('Morning review for 2026-09-14 at 23:30 (2026-09-14T23:30:00.000Z)')
      vi.useRealTimers()
    })

    it('--dry-run --json emits the schedule with the rendered intent', async () => {
      mockGet.mockResolvedValueOnce({ data: SCHEDULES })

      await subs.run.run({
        args: { agent: 'agt_1', scheduleId: 'sch_morning', 'dry-run': true, json: true },
      })

      const out = JSON.parse(String(consoleSpy.mock.calls[0][0]))
      expect(out.data).toMatchObject({ id: 'sch_morning', dryRun: true })
      expect(out.data.intent).toMatch(/^Morning review for \d{4}-\d{2}-\d{2} at \d{2}:\d{2}/)
    })

    it('surfaces the server message when the id is positional and the server refuses it', async () => {
      const serverMessage =
        'Schedule agt_1:1 has no persisted id; give the entry an `id` in scheduleConfig'
      mockPost.mockRejectedValueOnce(
        new CliError(
          `API Error (409): {"error":"${serverMessage}","code":"SCHEDULE_ID_REQUIRED"}`,
          {
            type: 'conflict',
            subtype: '409',
          },
        ),
      )

      await expect(
        subs.run.run({ args: { agent: 'agt_1', scheduleId: 'agt_1:1' } }),
      ).rejects.toMatchObject({ type: 'conflict', message: expect.stringContaining(serverMessage) })
      expect(consoleSpy).not.toHaveBeenCalled()
    })

    it('--dry-run fails with a CliError naming the entry when the server cannot register it', async () => {
      mockGet.mockResolvedValueOnce({ data: SCHEDULES })

      await expect(
        subs.run.run({ args: { agent: 'agt_1', scheduleId: 'sch_badtz', 'dry-run': true } }),
      ).rejects.toMatchObject({
        type: 'conflict',
        message: expect.stringContaining('sch_badtz'),
        hint: expect.stringContaining('agents schedule list'),
      })
      expect(mockPost).not.toHaveBeenCalled()
    })

    it('--dry-run fails with not_found when the schedule id is unknown', async () => {
      mockGet.mockResolvedValueOnce({ data: SCHEDULES })

      await expect(
        subs.run.run({ args: { agent: 'agt_1', scheduleId: 'sch_nope', 'dry-run': true } }),
      ).rejects.toMatchObject({ type: 'not_found', message: expect.stringContaining('sch_nope') })
      expect(mockPost).not.toHaveBeenCalled()
    })
  })
})
