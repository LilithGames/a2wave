/**
 * OpenTelemetry trace export card (Settings → Tracing).
 *
 * a2wave exports Agent run traces to exactly one OTLP/HTTP endpoint and stores no telemetry.
 *
 * Auth headers follow the settings secret convention: read endpoints return header NAMES only, so
 * saved headers are listed as rows with an empty value ("leave empty to keep"). The submitted map
 * is the complete new set — see buildOtelPatch. "Test connection" posts the unsaved draft.
 */

import {
  isLoopbackOtelEndpoint,
  normalizeOtelEndpoint,
  OTEL_KEEP_HEADER_VALUE,
  type OtelTestResult,
  resolveOtelTracesUrl,
} from '@a2wave/shared'
import { Activity, Check, ChevronRight, Loader2, Plus, Trash2, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useOtelStatus, useOtelTest, useUpdateOtel } from '@/hooks/use-settings'
import {
  buildOtelPatch,
  buildOtelTestDraft,
  EMPTY_OTEL_FORM,
  markOtelHeadersSaved,
  type OtelFormValues,
  type OtelHeaderRow,
  otelFormFromStatus,
} from '@/lib/otel-config-form'

function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-6 px-6 py-5">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  )
}

/** The traces URL the draft endpoint resolves to, or '' while it is empty or invalid. */
function draftTracesUrl(endpoint: string): string {
  const normalized = normalizeOtelEndpoint(endpoint)
  return normalized ? resolveOtelTracesUrl(normalized) : ''
}

function TestResultLine({ result }: { result: OtelTestResult }) {
  const { t } = useTranslation()
  const Icon = result.ok ? Check : X
  return (
    <div
      className={`flex items-start gap-1.5 text-xs ${result.ok ? 'text-success' : 'text-destructive'}`}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p>
          {result.ok
            ? t('settings.otel.testOk')
            : t(`settings.otel.testFailed.${result.reason ?? 'EXPORT_FAILED'}`, {
                error: result.error ?? '',
              })}
        </p>
        {result.traceId && (
          <p className="text-muted-foreground">
            {t('settings.otel.testTraceId')}
            <code className="select-all break-all font-mono text-foreground">{result.traceId}</code>
          </p>
        )}
        {result.testedUrl && (
          <p className="break-all text-muted-foreground">
            {t('settings.otel.testedUrl', { url: result.testedUrl })}
          </p>
        )}
      </div>
    </div>
  )
}

export function OtelExportCard() {
  const { t } = useTranslation()
  const { data: status, isLoading } = useOtelStatus()
  const update = useUpdateOtel()
  const test = useOtelTest()
  const [form, setForm] = useState<OtelFormValues>(EMPTY_OTEL_FORM)
  const [error, setError] = useState<string | null>(null)
  const [focusedHeader, setFocusedHeader] = useState<number | null>(null)
  // Header names the server stores, as of the last load or save — what "unchanged" is judged against.
  const [savedHeaderNames, setSavedHeaderNames] = useState<string[]>([])
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const endpointId = useId()
  const serviceNameId = useId()
  const resourceAttributesId = useId()
  const headerIdPrefix = useId()

  // Prefill once from the server; later status refetches (after save / test) must not wipe
  // what the admin is typing.
  const prefilled = useRef(false)
  useEffect(() => {
    if (!status || prefilled.current) return
    prefilled.current = true
    setForm(otelFormFromStatus(status))
    setSavedHeaderNames(status.headerNames)
    setAdvancedOpen(Boolean(status.serviceName || status.resourceAttributes))
  }, [status])

  if (isLoading || !status) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 px-6 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t('common.loading')}
        </CardContent>
      </Card>
    )
  }

  const setHeader = (index: number, patch: Partial<OtelHeaderRow>) =>
    setForm((prev) => ({
      ...prev,
      headers: prev.headers.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    }))

  const save = () => {
    const built = buildOtelPatch(form, savedHeaderNames)
    if (!built.ok) {
      setError(t(built.error))
      return
    }
    setError(null)
    const submittedRows = form.headers
    update.mutate(built.value, {
      onSuccess: () => {
        const savedRows = markOtelHeadersSaved(submittedRows)
        setSavedHeaderNames(savedRows.map((row) => row.name))
        setForm((prev) => ({ ...prev, headers: savedRows }))
      },
    })
  }

  const runTest = () => {
    const draft = buildOtelTestDraft(form, savedHeaderNames)
    if (!draft.ok) {
      setError(t(draft.error))
      return
    }
    setError(null)
    test.mutate(draft.value)
  }

  const tracesUrl = draftTracesUrl(form.endpoint)
  const scopeHint = t('settings.otel.status.scopeHint')

  return (
    <Card>
      <CardHeader className="border-b border-border/50">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="size-4 text-interactive-foreground" />
            {t('settings.otel.title')}
          </CardTitle>
          {status.active ? (
            <span
              title={scopeHint}
              className="inline-flex w-fit items-center gap-1.5 rounded-full border border-success/25 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success"
            >
              <span className="size-1.5 rounded-full bg-success" />
              {t('settings.otel.status.badgeActive')}
            </span>
          ) : (
            <span
              title={scopeHint}
              className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              <span className="size-1.5 rounded-full bg-muted-foreground/50" />
              {t('settings.otel.status.badgeInactive')}
            </span>
          )}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          {t('settings.otel.description')}
        </p>
      </CardHeader>

      <CardContent className="divide-y divide-border/50 p-0">
        <SwitchRow
          label={t('settings.otel.enabled')}
          checked={form.enabled}
          onChange={(enabled) => setForm({ ...form, enabled })}
        />

        <div className="space-y-4 px-6 py-5">
          <div>
            <Label htmlFor={endpointId} className="text-sm font-medium">
              {t('settings.otel.endpoint')}
            </Label>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t('settings.otel.endpointHint')}
            </p>
            <Input
              id={endpointId}
              className="mt-1.5"
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              placeholder="http://otel-collector:4318"
            />
            {tracesUrl && (
              <p className="mt-1.5 break-all text-xs text-muted-foreground">
                {t('settings.otel.tracesUrl', { url: tracesUrl })}
              </p>
            )}
            {isLoopbackOtelEndpoint(form.endpoint.trim()) && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t('settings.otel.loopbackNote')}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3 px-6 py-5">
          <div>
            <p className="text-sm font-medium">{t('settings.otel.headers')}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t('settings.otel.headersHint')}
            </p>
          </div>
          {form.headers.map((row, index) => {
            const nameId = `${headerIdPrefix}-name-${index}`
            const valueId = `${headerIdPrefix}-value-${index}`
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity besides their position
              <div key={index} className="flex items-end gap-2">
                <div className="w-2/5">
                  <Label htmlFor={nameId} className="text-xs text-muted-foreground">
                    {t('settings.otel.headerName')}
                  </Label>
                  <Input
                    id={nameId}
                    className="mt-1"
                    value={row.name}
                    readOnly={row.saved}
                    onChange={(e) => setHeader(index, { name: e.target.value })}
                    placeholder="Authorization"
                  />
                </div>
                <div className="flex-1">
                  <Label htmlFor={valueId} className="text-xs text-muted-foreground">
                    {t('settings.otel.headerValue')}
                  </Label>
                  <Input
                    id={valueId}
                    type="password"
                    autoComplete="off"
                    className="mt-1"
                    // A saved value never reaches the browser. While the row is untouched and
                    // not focused, show a display-only mask so the box does not read as "empty";
                    // focusing clears it so a replacement can be typed straight away.
                    value={
                      row.saved && row.value === '' && focusedHeader !== index
                        ? OTEL_KEEP_HEADER_VALUE
                        : row.value
                    }
                    onFocus={() => setFocusedHeader(index)}
                    onBlur={() => setFocusedHeader(null)}
                    onChange={(e) => setHeader(index, { value: e.target.value })}
                    placeholder={row.saved ? t('settings.otel.savedValuePlaceholder') : undefined}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('settings.otel.removeHeader', { name: row.name }).trim()}
                  onClick={() =>
                    setForm({ ...form, headers: form.headers.filter((_, i) => i !== index) })
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            )
          })}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setForm({
                  ...form,
                  headers: [...form.headers, { name: '', value: '', saved: false }],
                })
              }
            >
              <Plus className="size-3.5" />
              {t('settings.otel.addHeader')}
            </Button>
          </div>
        </div>

        <div>
          <SwitchRow
            label={t('settings.otel.captureContent')}
            hint={t('settings.otel.captureContentHint')}
            checked={form.captureContent}
            onChange={(captureContent) => setForm({ ...form, captureContent })}
          />
          {form.captureContent && (
            <p className="px-6 pb-5 text-xs leading-relaxed text-warning">
              {t('settings.otel.captureContentWarning')}
            </p>
          )}
        </div>

        <details
          className="group px-6 py-4"
          open={advancedOpen}
          onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
            {t('settings.otel.advanced')}
          </summary>
          <div className="mt-4 space-y-4">
            <div>
              <Label htmlFor={serviceNameId} className="text-sm font-medium">
                {t('settings.otel.serviceName')}
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('settings.otel.serviceNameHint')}
              </p>
              <Input
                id={serviceNameId}
                className="mt-1.5"
                value={form.serviceName}
                onChange={(e) => setForm({ ...form, serviceName: e.target.value })}
                placeholder="a2wave"
              />
            </div>
            <div>
              <Label htmlFor={resourceAttributesId} className="text-sm font-medium">
                {t('settings.otel.resourceAttributes')}
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('settings.otel.resourceAttributesHint')}
              </p>
              <Input
                id={resourceAttributesId}
                className="mt-1.5"
                value={form.resourceAttributes}
                onChange={(e) => setForm({ ...form, resourceAttributes: e.target.value })}
                placeholder="deployment.environment=prod,team=platform"
              />
            </div>
          </div>
        </details>

        <div className="space-y-3 px-6 py-5">
          <div className="space-y-1 text-xs text-muted-foreground">
            <p>
              {t('settings.otel.status.lastExportAt', {
                time: status.lastExportAt
                  ? new Date(status.lastExportAt).toLocaleString()
                  : t('settings.otel.status.never'),
              })}
            </p>
            {status.lastError && (
              <p className="text-destructive">
                {t('settings.otel.status.lastError', { error: status.lastError })}
              </p>
            )}
            {status.droppedSpans > 0 && (
              <p>{t('settings.otel.status.droppedSpans', { count: status.droppedSpans })}</p>
            )}
          </div>

          {test.data && <TestResultLine result={test.data} />}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={test.isPending}
                onClick={runTest}
              >
                {test.isPending && <Loader2 className="size-3.5 animate-spin" />}
                {t('settings.otel.test')}
              </Button>
              <p className="text-xs text-muted-foreground">{t('settings.otel.testHint')}</p>
            </div>
            <Button type="button" size="sm" disabled={update.isPending} onClick={save}>
              {update.isPending && <Loader2 className="size-3.5 animate-spin" />}
              {t('settings.otel.save')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
