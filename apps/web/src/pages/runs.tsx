import { CalendarOutlined } from '@ant-design/icons'
import { DatePicker, Select } from 'antd'
import type { Dayjs } from 'dayjs'
import dayjs from 'dayjs'
import { Activity, CircleAlert, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { RunSessionDetailDrawer } from '@/components/run-session-detail-drawer'
import { RunSessionRow } from '@/components/run-session-row'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { useAllAgents } from '@/hooks/use-agents'
import { useRunSessions } from '@/hooks/use-runs'
import { DATE_PRESETS_WITH_ALL, type DatePreset, getPresetDateRange } from '@/lib/date-presets'

const { RangePicker } = DatePicker

const PAGE_SIZE = 20

type AgentFilterOption = {
  value: string
  searchText: string
  label: React.ReactNode
}

export function RunsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1)

  const [agentFilter, setAgentFilter] = useState<string | undefined>()
  const [datePreset, setDatePreset] = useState<DatePreset>('all')
  const [dateRange, setDateRange] = useState<{ start?: string; end?: string }>(() =>
    getPresetDateRange('all'),
  )
  const [showCustomPicker, setShowCustomPicker] = useState(false)

  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams)
    if (nextPage <= 1) {
      next.delete('page')
    } else {
      next.set('page', String(nextPage))
    }
    setSearchParams(next)
  }

  // Data fetching
  const { data: agentsResult } = useAllAgents()
  const {
    data: sessionsData,
    isLoading,
    isError,
    refetch,
  } = useRunSessions({
    agentId: agentFilter,
    startDate: dateRange.start,
    endDate: dateRange.end,
    page,
    pageSize: PAGE_SIZE,
  })

  const sessions = sessionsData?.data
  const pagination = sessionsData?.pagination

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const agentOptions = useMemo<AgentFilterOption[]>(
    () =>
      (agentsResult?.data ?? []).map((agent) => ({
        value: agent.id,
        searchText: `${agent.name} ${agent.id}`.toLowerCase(),
        label: (
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">{agent.icon}</span>
            <span className="truncate" title={agent.name}>
              {agent.name}
            </span>
          </span>
        ),
      })),
    [agentsResult?.data],
  )

  useEffect(() => {
    setSelectedRunId(searchParams.get('runId'))
  }, [searchParams])

  const handleCloseDetail = () => {
    setSelectedRunId(null)
    const newParams = new URLSearchParams(searchParams)
    newParams.delete('runId')
    setSearchParams(newParams, { replace: true })
  }

  // Handle date preset change
  const handleDatePresetChange = (value: DatePreset) => {
    setDatePreset(value)
    if (value !== 'custom') {
      setDateRange(getPresetDateRange(value))
      setShowCustomPicker(false)
    } else {
      setShowCustomPicker(true)
    }
    setPage(1)
  }

  // Handle custom date range change
  const handleDateRangeChange = (dates: [Dayjs | null, Dayjs | null] | null) => {
    if (dates?.[0] && dates[1]) {
      setDateRange({
        start: dates[0].startOf('day').toISOString(),
        end: dates[1].endOf('day').toISOString(),
      })
    }
    setPage(1)
  }

  // Handle agent filter change
  const handleAgentFilterChange = (value: string | undefined) => {
    setAgentFilter(value || undefined)
    setPage(1)
  }

  return (
    <div className="space-y-6">
      <div>
        <h2
          className="text-2xl font-semibold tracking-tight text-foreground"
          style={{ textWrap: 'balance' }}
        >
          {t('runs.title')}
        </h2>
        <p className="text-sm text-muted-foreground mt-1.5">{t('runs.subtitle')}</p>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select
          allowClear
          showSearch
          placeholder={t('runs.allAgents')}
          value={agentFilter}
          onChange={handleAgentFilterChange}
          filterOption={(input, option) => {
            const searchText = (option as AgentFilterOption | undefined)?.searchText ?? ''
            return searchText.includes(input.trim().toLowerCase())
          }}
          style={{ width: 280 }}
          options={agentOptions}
        />
        <Select
          value={datePreset}
          onChange={handleDatePresetChange}
          style={{ width: 140 }}
          suffixIcon={<CalendarOutlined />}
          options={DATE_PRESETS_WITH_ALL.map((p) => ({ value: p.value, label: t(p.labelKey) }))}
        />
        {showCustomPicker && (
          <RangePicker
            value={
              dateRange.start && dateRange.end
                ? [dayjs(dateRange.start), dayjs(dateRange.end)]
                : null
            }
            onChange={handleDateRangeChange}
            allowClear={false}
          />
        )}
      </div>

      {isLoading ? (
        <Card>
          <CardContent className="p-0" aria-live="polite">
            <span className="sr-only">{t('common.loading')}</span>
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
                key={i}
                className="flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-b-0"
              >
                <Skeleton className="h-4 w-4 rounded-full shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
                <Skeleton className="h-5 w-16 rounded-md" />
                <Skeleton className="h-3 w-16" />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : isError && !sessionsData ? (
        <Card>
          <CardContent
            className="flex flex-col items-center justify-center gap-3 px-8 py-20 text-center"
            role="alert"
          >
            <CircleAlert className="h-7 w-7 text-destructive" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{t('runs.loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              {t('runs.retryLoad')}
            </Button>
          </CardContent>
        </Card>
      ) : sessions?.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-20 px-8">
            <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground mb-5">
              <Activity className="h-7 w-7" aria-hidden="true" />
            </div>
            <h3 className="font-semibold text-base mb-1 text-foreground">{t('runs.emptyTitle')}</h3>
            <p
              className="text-sm text-muted-foreground mb-5 text-center max-w-xs"
              style={{ textWrap: 'pretty' }}
            >
              {t('runs.emptyDesc')}
            </p>
            <Button onClick={() => navigate('/agents')}>
              <Plus className="h-4 w-4" />
              {t('runs.triggerFirst')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="p-0">
              {sessions?.map((session, idx) => (
                <RunSessionRow
                  key={session.id}
                  session={session}
                  showAgent
                  showBorder={idx < sessions.length - 1}
                  onSelect={setSelectedRunId}
                />
              ))}
            </CardContent>
          </Card>

          {pagination && (
            <Pagination
              className="mt-4"
              pagination={pagination}
              onPageChange={setPage}
              totalLabel={t('runs.sessionPaginationTotal', { total: pagination.total })}
              previousLabel={t('runs.prevPage')}
              nextLabel={t('runs.nextPage')}
            />
          )}
        </>
      )}

      <RunSessionDetailDrawer
        runId={selectedRunId}
        open={!!selectedRunId}
        onClose={handleCloseDetail}
      />
    </div>
  )
}
