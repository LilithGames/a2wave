import type { PaginatedResponse } from '@a2wave/shared'
import { CalendarOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { DatePicker, Select, Table, Tag } from 'antd'
import dayjs, { type Dayjs } from 'dayjs'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Pagination } from '@/components/ui/pagination'
import { useUrlParam } from '@/hooks/use-url-state'
import { DATE_PRESETS_WITH_ALL, type DatePreset, getPresetDateRange } from '@/lib/date-presets'
import { idSuffix } from '@/lib/id-suffix'

interface AuditLog {
  id: string
  userId: string | null
  username: string | null
  action: string
  resource: string | null
  resourceId: string | null
  details: Record<string, unknown> | null
  ipAddress: string | null
  createdAt: string
}

const { RangePicker } = DatePicker

const PAGE_SIZE = 20

const ACTION_COLORS: Record<string, string> = {
  create: 'green',
  update: 'blue',
  delete: 'red',
  publish: 'purple',
  stop: 'orange',
  resume: 'cyan',
  login: 'default',
}

function getActionColor(action: string): string {
  const suffix = action.split('.').pop() ?? ''
  return ACTION_COLORS[suffix] ?? 'default'
}

function AuditLogDetailsToggle({
  expanded,
  onToggle,
}: {
  expanded: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()

  return (
    <button
      type="button"
      className="inline-flex items-center justify-center rounded p-1 -m-1 text-muted-foreground hover:bg-surface-hover hover:text-foreground transition-colors"
      aria-expanded={expanded}
      aria-label={t('auditLogs.details')}
      title={t('auditLogs.details')}
      onClick={onToggle}
    >
      <ChevronRight
        className={`h-3 w-3 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
      />
    </button>
  )
}

export function AuditLogsPage() {
  const { t, i18n } = useTranslation()

  // Actions and resources are free-form strings written by the API, so a new one
  // can reach the UI before its translation does. Fall back to the raw key rather
  // than an empty cell — an untranslated audit entry must still be readable.
  const actionLabel = (action: string) => t(`auditLogs.actions.${action}`, { defaultValue: action })
  const resourceLabel = (resource: string) =>
    t(`auditLogs.resources.${resource}`, { defaultValue: resource })
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1') || 1)
  const [actionFilter] = useUrlParam('action')

  // The second filter is a date range, not a resource type. Every resource is
  // already the prefix of its action (`agent.create` → agent), so a resource
  // select could only ever restate the action filter; narrowing by *when*
  // something happened is the question an audit trail actually gets asked.
  const [datePreset] = useUrlParam('range', {
    defaultValue: 'all',
    allowed: ['all', '1d', '7d', '30d', 'custom'],
  })
  const [customStart] = useUrlParam('start')
  const [customEnd] = useUrlParam('end')
  const [expandedRowKeys, setExpandedRowKeys] = useState<string[]>([])

  const toggleDetails = (id: string) =>
    setExpandedRowKeys((keys) =>
      keys.includes(id) ? keys.filter((key) => key !== id) : [...keys, id],
    )

  const dateRange =
    datePreset === 'custom'
      ? { start: customStart || undefined, end: customEnd || undefined }
      : getPresetDateRange(datePreset as DatePreset)

  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams)
    if (nextPage <= 1) {
      next.delete('page')
    } else {
      next.set('page', String(nextPage))
    }
    setSearchParams(next)
  }

  const { data: logsData, isLoading } = useQuery({
    queryKey: ['audit-logs', page, actionFilter, dateRange.start, dateRange.end],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      if (actionFilter) params.set('action', actionFilter)
      if (dateRange.start) params.set('startDate', dateRange.start)
      if (dateRange.end) params.set('endDate', dateRange.end)
      const res = await fetch(`/api/audit-logs?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch audit logs')
      return res.json() as Promise<PaginatedResponse<AuditLog>>
    },
  })

  const logs = logsData?.data ?? []
  const pagination = logsData?.pagination

  // Sorted by the visible label, not the raw key — with translations on, key
  // order looks arbitrary to the reader.
  const byLabel = (label: (value: string) => string) => (a: string, b: string) =>
    label(a).localeCompare(label(b), i18n.language)

  // Filter options come from the full translated catalogue, not from `logs`.
  // Deriving them from the current page made the filter circular: reaching an
  // action required already being on a page that happened to contain it. The
  // page's own values are unioned in so an entry the catalogue doesn't know
  // about yet is still selectable (R7 keeps that set empty in practice).
  const catalogue = Object.keys(
    (i18n.getResource(i18n.language, 'translation', 'auditLogs.actions') ?? {}) as Record<
      string,
      string
    >,
  )

  const allActions = [...new Set([...catalogue, ...logs.map((l) => l.action)])].sort(
    byLabel(actionLabel),
  )

  const columns = [
    {
      title: t('auditLogs.time'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      width: 170,
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
    },
    {
      title: t('auditLogs.user'),
      dataIndex: 'username',
      key: 'username',
      width: 120,
      render: (v: string | null) => v || '-',
    },
    {
      title: t('auditLogs.action'),
      dataIndex: 'action',
      key: 'action',
      width: 180,
      render: (action: string) => (
        <Tag color={getActionColor(action)} title={action}>
          {actionLabel(action)}
        </Tag>
      ),
    },
    {
      // The id shares this cell rather than owning a column: most entries log a
      // `resourceId` with no `details` (every `agent.*` action, and skill/mcp/provider
      // CRUD), so dropping it outright would leave "who deleted which Agent"
      // unanswerable. Only the random segment is shown — the prefix repeats the
      // resource name on the line above.
      title: t('auditLogs.resource'),
      dataIndex: 'resource',
      key: 'resource',
      width: 160,
      render: (v: string | null, record: AuditLog) => (
        <div className="flex flex-col">
          <span title={v ?? undefined}>{v ? resourceLabel(v) : '-'}</span>
          {record.resourceId && (
            <code
              className="text-xs font-mono text-muted-foreground break-all"
              title={record.resourceId}
            >
              {idSuffix(record.resourceId)}
            </code>
          )}
        </div>
      ),
    },
    {
      title: t('auditLogs.ipAddress'),
      dataIndex: 'ipAddress',
      key: 'ipAddress',
      width: 140,
      render: (v: string | null) => v || '-',
    },
    {
      // Only the toggle lives here — the payload itself expands into a full-width
      // row below, because a column narrow enough to fit alongside the others
      // shatters a realistic payload (masked SCM config with full repo URLs).
      title: t('auditLogs.details'),
      dataIndex: 'details',
      key: 'details',
      width: 80,
      render: (v: Record<string, unknown> | null, record: AuditLog) =>
        v ? (
          <AuditLogDetailsToggle
            expanded={expandedRowKeys.includes(record.id)}
            onToggle={() => toggleDetails(record.id)}
          />
        ) : (
          '-'
        ),
    },
  ]

  // Filter + page reset in one write. Two separate `setSearchParams` calls would
  // each build from the same stale snapshot, so the second would erase the first.
  const handleFilterChange = (key: 'action') => (value: string | undefined) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        if (value) params.set(key, value)
        else params.delete(key)
        params.delete('page') // a new filter invalidates the current page offset
        return params
      },
      { replace: true },
    )
  }

  const handleDatePresetChange = (value: string) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        if (value === 'all') params.delete('range')
        else params.set('range', value)
        // Leaving custom mode drops the explicit bounds, so a stale hand-picked
        // range cannot linger behind a relative preset.
        if (value !== 'custom') {
          params.delete('start')
          params.delete('end')
        }
        params.delete('page')
        return params
      },
      { replace: true },
    )
  }

  const handleDateRangeChange = (dates: [Dayjs | null, Dayjs | null] | null) => {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current)
        if (dates?.[0] && dates?.[1]) {
          params.set('start', dates[0].startOf('day').toISOString())
          params.set('end', dates[1].endOf('day').toISOString())
        } else {
          params.delete('start')
          params.delete('end')
        }
        params.delete('page')
        return params
      },
      { replace: true },
    )
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('auditLogs.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('auditLogs.subtitle')}</p>
        </div>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <Select
          value={actionFilter || undefined}
          onChange={handleFilterChange('action')}
          allowClear
          showSearch
          placeholder={t('auditLogs.allActions')}
          aria-label={t('auditLogs.action')}
          filterOption={(input, option) =>
            ((option?.label as string) ?? '').toLowerCase().includes(input.toLowerCase())
          }
          style={{ minWidth: 180 }}
          options={allActions.map((a) => ({ label: actionLabel(a), value: a }))}
        />

        <Select
          value={datePreset}
          onChange={handleDatePresetChange}
          aria-label={t('auditLogs.dateRange')}
          style={{ width: 140 }}
          suffixIcon={<CalendarOutlined />}
          options={DATE_PRESETS_WITH_ALL.map((p) => ({ value: p.value, label: t(p.labelKey) }))}
        />

        {datePreset === 'custom' && (
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

      <Table
        dataSource={logs}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={false}
        scroll={{ x: 850 }}
        size="small"
        expandable={{
          expandedRowKeys,
          rowExpandable: (record) => !!record.details,
          // The details column already carries the toggle; antd's own expand
          // column would put a second one next to it.
          showExpandColumn: false,
          // break-all is load-bearing, not cosmetic: this table resolves to
          // table-layout: auto, so the expanded cell's min-content width feeds
          // back into every column. Without it one unbreakable token past ~130
          // chars (a P4 depot path, a long localPath) widens the whole table.
          // overflow-auto does not save it — the <pre> grows instead of scrolling.
          expandedRowRender: (record) => (
            <pre className="text-xs font-mono bg-muted/50 rounded p-2 overflow-auto max-h-96 whitespace-pre-wrap break-all">
              {JSON.stringify(record.details, null, 2)}
            </pre>
          ),
        }}
      />

      {pagination && (
        <Pagination
          className="mt-4"
          pagination={pagination}
          onPageChange={setPage}
          totalLabel={t('auditLogs.paginationTotal', { total: pagination.total })}
          previousLabel={t('auditLogs.prevPage')}
          nextLabel={t('auditLogs.nextPage')}
        />
      )}
    </div>
  )
}
