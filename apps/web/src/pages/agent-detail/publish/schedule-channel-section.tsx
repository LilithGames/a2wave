/**
 * Publish tab → 定时触发 (schedule trigger) channel section.
 *
 * Extracted from publish-tab.tsx to keep that file under the 3000-line gate.
 * The multi-schedule list helpers stay in the parent because `handlePublish`
 * shares `buildScheduleConfigsForPublish()` with them — splitting that here
 * would fork the source of truth for what actually gets published.
 */

import { SUPPORTED_SCHEDULE_CRON_EXAMPLES } from '@a2wave/shared'
import { Select, Switch, TimePicker, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { Info, Plus, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ModePicker } from '@/components/ui/mode-picker'
import { Textarea } from '@/components/ui/textarea'
import type { SchedulePublishConfig } from '@/hooks/use-agents'
import type { SchedulePreset } from '@/lib/cron-utils'
import { cn } from '@/lib/utils'
import { startSsoMethod } from '@/pages/login'

export type ScheduleMode = 'preset' | 'advanced'

export interface ScheduleChannelSectionProps {
  /** The full list; the editor below edits whichever entry is active. */
  configs: SchedulePublishConfig[]
  activeIndex: number
  onSelectConfig: (index: number) => void
  onAddConfig: () => void
  onRemoveConfig: (index: number) => void
  mode: ScheduleMode
  onModeChange: (value: ScheduleMode) => void
  preset: SchedulePreset
  onPresetChange: (value: SchedulePreset) => void
  /** `HH:mm` string, not a Dayjs — the picker converts on both ends. */
  time: string
  onTimeChange: (value: string) => void
  weekday: number
  onWeekdayChange: (value: number) => void
  monthDay: number
  onMonthDayChange: (value: number) => void
  cron: string
  onCronChange: (value: string) => void
  intent: string
  onIntentChange: (value: string) => void
  timezone: string
  onTimezoneChange: (value: string) => void
  runAsOwner: boolean
  onRunAsOwnerChange: (value: boolean) => void
  /** Resolved cron for the active entry (preset-derived or the raw advanced string). */
  activeCron: string
  isCronInvalid: boolean
  /** SSO method used to bind an identity for run-as-owner; null when unavailable. */
  bindMethod: Parameters<typeof startSsoMethod>[0] | null
  /** Whether the current user has a bound SSO identity (run-as-owner prerequisite). */
  identityBound: boolean
  /** Whether this agent has the outbound gateway enabled (run-as-owner prerequisite). */
}

export function ScheduleChannelSection({
  configs: scheduleConfigs,
  activeIndex: activeScheduleIndex,
  onSelectConfig: selectScheduleConfig,
  onAddConfig: addScheduleConfig,
  onRemoveConfig: removeScheduleConfig,
  mode: scheduleMode,
  onModeChange: setScheduleMode,
  preset: schedulePreset,
  onPresetChange: setSchedulePreset,
  time: scheduleTime,
  onTimeChange: setScheduleTime,
  weekday: scheduleWeekday,
  onWeekdayChange: setScheduleWeekday,
  monthDay: scheduleMonthDay,
  onMonthDayChange: setScheduleMonthDay,
  cron: scheduleCron,
  onCronChange: setScheduleCron,
  intent: scheduleIntent,
  onIntentChange: setScheduleIntent,
  timezone: scheduleTimezone,
  onTimezoneChange: setScheduleTimezone,
  runAsOwner: scheduleRunAsOwner,
  onRunAsOwnerChange: setScheduleRunAsOwner,
  activeCron: activeScheduleCron,
  isCronInvalid: isScheduleCronInvalid,
  bindMethod,
  identityBound,
}: ScheduleChannelSectionProps) {
  const { t, i18n } = useTranslation()

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.scheduleListTitle')}
          </Label>
          <Button type="button" variant="outline" size="sm" onClick={addScheduleConfig}>
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            {t('agentPublish.scheduleAdd')}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2">
          {scheduleConfigs.map((config, index) => {
            const isActive = index === activeScheduleIndex
            return (
              <div
                key={config.id ?? `${index}:${config.cron}`}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                  isActive
                    ? 'border-primary/60 bg-surface-selected'
                    : 'border-border bg-background hover:bg-surface-hover',
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => selectScheduleConfig(index)}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 text-xs font-medium text-muted-foreground">
                      {t('agentPublish.scheduleItemLabel', { index: index + 1 })}
                    </span>
                    <code className="truncate font-mono text-sm text-foreground">
                      {config.cron || '—'}
                    </code>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {config.intent || t('agentPublish.scheduleIntentEmpty')}
                  </p>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('agentPublish.scheduleRemove')}
                  disabled={scheduleConfigs.length <= 1}
                  onClick={() => removeScheduleConfig(index)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            )
          })}
        </div>
      </div>

      {/* Preset / Advanced mode toggle + panel */}
      <div className="flex flex-col gap-2">
        <Label className="text-sm font-medium text-foreground">
          {t('agentPublish.scheduleCronMode')}
        </Label>
        <div className="segmented-panel">
          {/* Tab header */}
          <div className="segmented-panel-header">
            <ModePicker
              value={scheduleMode}
              onChange={(v) => setScheduleMode(v as 'preset' | 'advanced')}
              options={[
                { value: 'preset', label: t('agentPublish.schedulePresetMode') },
                { value: 'advanced', label: t('agentPublish.scheduleAdvancedMode') },
              ]}
            />
          </div>

          {/* Tab content */}
          {scheduleMode === 'preset' ? (
            <div className="segmented-panel-body space-y-4">
              <div className="flex flex-col gap-2">
                <Label className="text-sm font-medium text-foreground">{t('common.preset')}</Label>
                <ModePicker
                  className="self-start"
                  value={schedulePreset}
                  onChange={(v) => setSchedulePreset(v as SchedulePreset)}
                  options={[
                    {
                      value: 'daily',
                      label: t('agentPublish.schedulePresetDaily'),
                    },
                    {
                      value: 'weekly',
                      label: t('agentPublish.schedulePresetWeekly'),
                    },
                    {
                      value: 'monthly',
                      label: t('agentPublish.schedulePresetMonthly'),
                    },
                  ]}
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label className="text-sm font-medium text-foreground">
                  {t('agentPublish.scheduleTime')}
                </Label>
                <TimePicker
                  value={dayjs(scheduleTime, 'HH:mm')}
                  format="HH:mm"
                  onChange={(val) => {
                    if (val) setScheduleTime(val.format('HH:mm'))
                  }}
                  className="w-32"
                />
              </div>

              {schedulePreset === 'weekly' && (
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-medium text-foreground">
                    {t('agentPublish.scheduleWeekday')}
                  </Label>
                  <Select
                    value={scheduleWeekday}
                    onChange={setScheduleWeekday}
                    className="w-32"
                    options={[
                      { value: 1, label: t('agentPublish.weekMon') },
                      { value: 2, label: t('agentPublish.weekTue') },
                      { value: 3, label: t('agentPublish.weekWed') },
                      { value: 4, label: t('agentPublish.weekThu') },
                      { value: 5, label: t('agentPublish.weekFri') },
                      { value: 6, label: t('agentPublish.weekSat') },
                      { value: 0, label: t('agentPublish.weekSun') },
                    ]}
                  />
                </div>
              )}

              {schedulePreset === 'monthly' && (
                <div className="flex flex-col gap-2">
                  <Label className="text-sm font-medium text-foreground">
                    {t('agentPublish.scheduleMonthDay')}
                  </Label>
                  <Select
                    value={scheduleMonthDay}
                    onChange={setScheduleMonthDay}
                    className="w-32"
                    options={Array.from({ length: 28 }, (_, i) => ({
                      value: i + 1,
                      label: `${i + 1}`,
                    }))}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="segmented-panel-body flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <Label className="text-sm font-medium text-foreground" required>
                  {t('agentPublish.scheduleCron')}
                </Label>
                <Tooltip
                  title={
                    <div className="space-y-1">
                      <div>{t('agentPublish.scheduleCronTipsTitle')}</div>
                      {SUPPORTED_SCHEDULE_CRON_EXAMPLES.map((example) => (
                        <div key={example.cron} className="font-mono text-xs">
                          {example.cron} —{' '}
                          {i18n.language.startsWith('zh') ? example.zh : example.en}
                        </div>
                      ))}
                    </div>
                  }
                >
                  <Info
                    className="h-4 w-4 cursor-help text-muted-foreground"
                    aria-label={t('agentPublish.scheduleCronTipsLabel')}
                  />
                </Tooltip>
              </div>
              <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
                <input
                  type="text"
                  value={scheduleCron}
                  onChange={(e) => setScheduleCron(e.target.value)}
                  placeholder={t('agentPublish.scheduleCronPlaceholder')}
                  className="flex-1 bg-transparent outline-none"
                />
              </div>
              <p className="text-xs text-muted-foreground">{t('agentPublish.scheduleCronHelp')}</p>
            </div>
          )}
        </div>
        {/* /tab panel */}
      </div>
      {/* /mode wrapper */}

      {/* Active cron preview */}
      <div
        className={cn(
          'flex items-center gap-2 info-panel px-3 py-2.5 text-sm',
          isScheduleCronInvalid && 'border border-destructive/50 bg-destructive/10',
        )}
      >
        <Info
          className={cn(
            'h-4 w-4 shrink-0 text-muted-foreground',
            isScheduleCronInvalid && 'text-destructive',
          )}
          aria-hidden="true"
        />
        {!isScheduleCronInvalid && (
          <span className="text-muted-foreground">{t('agentPublish.scheduleActiveCron')}</span>
        )}
        <code
          className={cn(
            'ml-1 font-mono font-medium text-foreground',
            isScheduleCronInvalid && 'text-destructive',
          )}
        >
          {isScheduleCronInvalid
            ? t('agentPublish.scheduleCronInvalidShort')
            : activeScheduleCron || '—'}
        </code>
      </div>

      {/* Intent */}
      <div className="flex flex-col gap-2">
        <Label required className="text-sm font-medium text-foreground">
          {t('agentPublish.scheduleIntent')}
        </Label>
        <Textarea
          value={scheduleIntent}
          onChange={(e) => setScheduleIntent(e.target.value)}
          placeholder={t('agentPublish.scheduleIntentPlaceholder')}
          rows={3}
          className="resize-none"
        />
        <p className="text-xs text-muted-foreground">{t('agentPublish.scheduleIntentHelp')}</p>
        <div className="flex flex-col gap-1 rounded-md border border-border/50 bg-muted/30 px-3 py-2 text-xs">
          <span className="font-medium text-foreground">{t('agentPublish.scheduleVarsTitle')}</span>
          <div className="flex flex-col gap-0.5 text-muted-foreground font-mono">
            <span>
              <code className="text-foreground">{'{{date}}'}</code> —{' '}
              {t('agentPublish.scheduleVarDate')}
            </span>
            <span>
              <code className="text-foreground">{'{{time}}'}</code> —{' '}
              {t('agentPublish.scheduleVarTime')}
            </span>
            <span>
              <code className="text-foreground">{'{{iso}}'}</code> —{' '}
              {t('agentPublish.scheduleVarIso')}
            </span>
          </div>
          <span className="font-medium text-foreground">
            {t('agentPublish.scheduleVarsTitle2')}
          </span>
          <div className="flex flex-col gap-0.5 text-muted-foreground font-mono">
            <span>
              <code className="text-foreground">{t('agentPublish.scheduleVarInput')}</code> —{' '}
              {t('agentPublish.scheduleExample')}
            </span>
            <span>
              <code className="text-foreground">{t('agentPublish.scheduleVarOutput')}</code> —{' '}
              {t('agentPublish.scheduleExample2')}
            </span>
          </div>
        </div>
      </div>

      {/* Timezone */}
      <div className="flex flex-col gap-2">
        <Label className="text-sm font-medium text-foreground">
          {t('agentPublish.scheduleTimezone')}
        </Label>
        <Select
          value={scheduleTimezone}
          onChange={setScheduleTimezone}
          className="w-64"
          showSearch
          options={[
            { value: 'Asia/Shanghai', label: 'Asia/Shanghai (CST)' },
            { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
            { value: 'Asia/Singapore', label: 'Asia/Singapore (SGT)' },
            { value: 'America/New_York', label: 'America/New_York (EST)' },
            { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PST)' },
            { value: 'America/Chicago', label: 'America/Chicago (CST)' },
            { value: 'Europe/London', label: 'Europe/London (GMT)' },
            { value: 'Europe/Berlin', label: 'Europe/Berlin (CET)' },
            { value: 'UTC', label: 'UTC' },
          ]}
        />
      </div>

      {/* 网关接入：定时任务以归属人 SSO 身份过网关 */}
      <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <Label className="text-sm font-medium text-foreground">
              {t('agentPublish.scheduleRunAsOwner')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('agentPublish.scheduleRunAsOwnerHelp')}
            </p>
          </div>
          {/* 始终可切换；前提不满足只提示，不硬禁用（避免跨 Tab / 异步值导致开关无故变灰）。
                  真正的拦截在触发期后端：未绑定 → fail-fast，网关未开 → 不签发。 */}
          <Switch
            checked={scheduleRunAsOwner}
            onChange={setScheduleRunAsOwner}
            aria-label={t('agentPublish.scheduleRunAsOwner')}
          />
        </div>
        {!identityBound && (
          <p className="text-xs text-amber-600">
            {t('agentPublish.scheduleRunAsOwnerNeedBind')}{' '}
            {bindMethod && (
              <button
                type="button"
                className="underline hover:text-amber-700"
                onClick={() =>
                  startSsoMethod(
                    bindMethod,
                    'bind',
                    window.location.pathname + window.location.search,
                  )
                }
              >
                {t('auth.bindIdaas')}
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  )
}
