import {
  type ChatMessage,
  isActiveRunStatus,
  type PaginatedResponse,
  type Run,
  type RunStep,
  type RunWithAgent,
} from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

const RUNS_KEY = ['runs'] as const
const RUNS_STATS_KEY = ['runs', 'stats'] as const

type StatusBreakdown = {
  completed: number
  failed: number
  running: number
  pending: number
  queued: number
  cancelled: number
}

export type TokenTotals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type RunStats = {
  total: number
  successRate: number
  avgDuration: number
  todayRuns: number
  byStatus: StatusBreakdown
  todayByStatus: StatusBreakdown
  askerCount: number
  todayAskerCount: number
  tokens: TokenTotals
  todayTokens: TokenTotals
}

export function useRunStats() {
  return useQuery({
    queryKey: RUNS_STATS_KEY,
    queryFn: async () => {
      const res = await fetch('/api/runs/stats', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch run stats')
      return res.json() as Promise<RunStats>
    },
    refetchInterval: 30_000,
  })
}

export type AgentLeaderboardEntry = {
  agentId: string
  name: string
  icon: string
  count: number
}

export type AgentLeaderboard = {
  /** 按运行次数倒序 Top 10 */
  byRuns: AgentLeaderboardEntry[]
  /** 按使用人数（去重触发者）倒序 Top 10 */
  byUsers: AgentLeaderboardEntry[]
  /** Top 10 agents by token usage. */
  byTokens: AgentLeaderboardEntry[]
}

/** Agent 排行榜：运行次数 + 使用人数（各 Top 10）。 */
export function useAgentRunLeaderboard() {
  return useQuery({
    queryKey: ['runs', 'leaderboard'] as const,
    queryFn: async () => {
      const res = await fetch('/api/runs/leaderboard', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch run leaderboard')
      return (await res.json()) as AgentLeaderboard
    },
    refetchInterval: 30_000,
  })
}

export type AgentStats = {
  total: number
  successRate: number
  avgDuration: number
  todayRuns: number
  byStatus: StatusBreakdown
  askerCount: number
  topAskers: { name: string; count: number }[]
  channelBreakdown: { source: string; count: number }[]
  tokens: TokenTotals
}

export function useAgentStats(agentId: string | undefined) {
  return useQuery({
    queryKey: ['agent-stats', agentId],
    queryFn: async () => {
      const res = await fetch(`/api/agents/${agentId}/stats`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch agent stats')
      return res.json() as Promise<AgentStats>
    },
    enabled: !!agentId,
    refetchInterval: 30_000,
  })
}

/** The viewer's UTC offset, in inverted minutes, on a given calendar date. */
function dayjsOffsetMinutes(isoDate: string): number {
  const at = new Date(`${isoDate}T12:00:00`)
  return Number.isNaN(at.getTime()) ? new Date().getTimezoneOffset() : at.getTimezoneOffset()
}

/**
 * The viewer's IANA zone (e.g. 'Asia/Shanghai'), or undefined if unavailable.
 *
 * Undefined is a supported answer, not a failure: the server falls back to the
 * numeric offset, which is exact except across a DST switch.
 */
function resolveViewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

export type TimeseriesBucket = 'day' | 'hour'

/** Inclusive calendar range (YYYY-MM-DD) plus the granularity to bucket by. */
export type TimeseriesRange = {
  from: string
  to: string
  bucket: TimeseriesBucket
}

export type AgentTimeseriesPoint = {
  /** Bucket start as an absolute instant, already aligned to the viewer's day. */
  ts: string
  runs: StatusBreakdown
  total: number
  askers: number
  tokens: TokenTotals
  /** null (not 0) when no completed turns landed in this bucket. */
  avgDurationMs: number | null
  durationSamples: number
}

export type AgentTimeseries = {
  bucket: TimeseriesBucket
  from: string
  to: string
  points: AgentTimeseriesPoint[]
}

export function useAgentTimeseries(
  agentId: string | undefined,
  range: TimeseriesRange | undefined,
) {
  // The IANA zone is what actually makes day buckets correct: the server
  // resolves each local midnight against it, so a range crossing a DST switch
  // keeps its boundaries and gets a 23- or 25-hour transition day. The UI offers
  // 30- and 90-day ranges, so crossing one is routine.
  const tz = resolveViewerTimeZone()

  // tzOffset stays as the fallback for a viewer whose zone we cannot resolve,
  // and is exact for hour buckets, which DST does not distort. Sampled at the
  // *start of the range* rather than "now", so a historical range viewed from
  // the other side of a transition is not shifted wholesale.
  const tzOffset = range ? -dayjsOffsetMinutes(range.from) * 60 : 0

  return useQuery({
    queryKey: [
      'agent-timeseries',
      agentId,
      range?.from,
      range?.to,
      range?.bucket,
      // Part of the key: the same range fetched from a different timezone (or
      // across a DST change) buckets differently, so it must not reuse the cache.
      tzOffset,
      tz,
    ] as const,
    queryFn: async () => {
      // `enabled` below keeps the query parked until both are set, so this guard
      // is unreachable in practice — it only narrows the types for the compiler.
      if (!agentId || !range) throw new Error('Failed to fetch agent timeseries')
      const params = new URLSearchParams({
        from: range.from,
        to: range.to,
        bucket: range.bucket,
        tzOffset: String(tzOffset),
        ...(tz ? { tz } : {}),
      })
      const res = await fetch(`/api/agents/${agentId}/stats/timeseries?${params}`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error('Failed to fetch agent timeseries')
      return res.json() as Promise<AgentTimeseries>
    },
    enabled: !!agentId && !!range,
    // Trends move far slower than the KPI cards, so no 30s poll here.
    staleTime: 60_000,
  })
}

export type RunsFilter = {
  agentId?: string
  startDate?: string // ISO date string
  endDate?: string
  page?: number
  pageSize?: number
}

export function useRuns(filter?: RunsFilter) {
  const params = new URLSearchParams()
  if (filter?.agentId) params.set('agentId', filter.agentId)
  if (filter?.startDate) params.set('startDate', filter.startDate)
  if (filter?.endDate) params.set('endDate', filter.endDate)
  if (filter?.page) params.set('page', String(filter.page))
  if (filter?.pageSize) params.set('pageSize', String(filter.pageSize))

  const queryString = params.toString()
  const url = queryString ? `/runs?${queryString}` : '/runs'

  return useQuery({
    queryKey: [...RUNS_KEY, filter],
    queryFn: async () => {
      const res = await fetch(`/api${url}`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch runs')
      return res.json() as Promise<PaginatedResponse<RunWithAgent>>
    },
    refetchInterval: (query) =>
      query.state.data?.data.some((run) => isActiveRunStatus(run.status)) ? 2_000 : false,
  })
}

export function useRun(id: string) {
  return useQuery({
    queryKey: [...RUNS_KEY, id],
    queryFn: () =>
      api.get<Run & { steps: RunStep[]; messages: ChatMessage[]; hasFullLog?: boolean }>(
        `/runs/${id}`,
      ),
    select: (res) => res.data,
    enabled: !!id,
    refetchInterval: (query) => {
      const status = query.state.data?.data?.status
      return isActiveRunStatus(status) ? 2_000 : false
    },
  })
}

export function useCancelRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => api.post(`/runs/${runId}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: RUNS_KEY }),
  })
}

export function useRerunRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => api.post<Run>(`/runs/${runId}/rerun`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: RUNS_KEY }),
  })
}
