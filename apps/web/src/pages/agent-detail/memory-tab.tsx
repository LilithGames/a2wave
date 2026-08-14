import { DEFAULT_MEMORY_INSIGHT_PROMPT, DEFAULT_MEMORY_WORKLOG_PROMPT } from '@a2wave/shared'
import { useQueryClient } from '@tanstack/react-query'
import { Input as AntInput, Select, Tooltip } from 'antd'
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  File,
  FileText,
  Globe,
  Hash,
  Key,
  Layers3,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MarkdownContent } from '@/components/markdown-content'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModePicker } from '@/components/ui/mode-picker'
import { Switch } from '@/components/ui/switch'
import {
  type MemoryTopicizationPreview,
  useDeleteMemoryFile,
  useMemoryFileContent,
  useMemoryFiles,
  useMemoryStats,
  useMemoryTopic,
  useMemoryTopics,
  useReindexMemory,
  useReorganizeMemoryTopics,
  useSearchMemories,
  useUpdateMemoryFile,
} from '@/hooks/use-memories'
import { selectFilterOption } from '@/lib/select-filter'
import { cn } from '@/lib/utils'

/**
 * One setting inside the main Memory card. Its heading (text-sm semibold) sits
 * one rung above the inner field labels (text-xs muted) so the eight settings
 * read as distinct sections instead of a flat list. `action` renders a trailing
 * control (e.g. a Switch) aligned with the heading. Sections are separated by a
 * hairline via the parent's `divide-y`.
 */
function SettingSection({
  title,
  desc,
  action,
  children,
}: {
  title: string
  desc?: string
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="space-y-2.5 py-5 last:pb-0">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h4 className="text-sm font-semibold text-foreground">{title}</h4>
          {desc && <p className="text-xs text-muted-foreground">{desc}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  )
}

interface MemoryTabProps {
  agentId: string | undefined
  canWrite?: boolean
  memoryEnabled: boolean
  onToggleMemory: (enabled: boolean) => void
  memoryRecallLevel?: string
  memoryModel?: string
  inheritedMemoryModel?: string
  memoryModelOptions?: string[]
  memorySearchDecay?: boolean
  memorySearchDecayHalfLife?: number
  memorySearchMmr?: boolean
  memorySearchMmrLambda?: number
  embeddingEnabled?: boolean
  embeddingApiKey?: string
  embeddingBaseUrl?: string
  embeddingModel?: string
  memoryContextMode?: string
  memoryWorklogEnabled?: boolean
  memoryWorklogPrompt?: string | null
  memoryAutoInsight?: boolean
  memoryInsightPrompt?: string | null
  memoryConsolidationEnabled?: boolean
  onUpdateMemoryProvider: (fields: Record<string, unknown>) => void
}

function MemoryModelCard({
  t,
  memoryModel,
  inheritedMemoryModel,
  memoryModelOptions,
  onUpdateMemoryProvider,
}: {
  t: (key: string, opts?: Record<string, unknown>) => string
  memoryModel?: string
  inheritedMemoryModel?: string
  memoryModelOptions?: string[]
  onUpdateMemoryProvider: (fields: Record<string, unknown>) => void
}) {
  const [localModel, setLocalModel] = useState(memoryModel || '')

  useEffect(() => {
    setLocalModel(memoryModel || '')
  }, [memoryModel])

  const options = (memoryModelOptions ?? []).map((model) => ({ value: model, label: model }))
  const isDirty = localModel !== (memoryModel || '')

  const handleSave = useCallback(() => {
    onUpdateMemoryProvider({
      memoryModel: localModel || null,
      memoryProviderModel: null,
    })
  }, [localModel, onUpdateMemoryProvider])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('memory.modelTitle')}</CardTitle>
        <CardDescription>{t('memory.modelDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">{t('memory.modelLabel')}</Label>
            {options.length > 0 ? (
              /* `mode="tags"` keeps this open to any model id. Providers no
                 longer store a catalog, so the suggestions here are only the
                 models this Agent already selected — without free entry, a
                 cheaper summarization model (the reason this field exists)
                 would be unreachable.

                 Single-value is enforced in the handler rather than with
                 `maxCount={1}`: at the limit rc-select disables the remaining
                 options and refuses new tags, so picking a different model
                 produced no onChange at all and the field read as frozen. Taking
                 the last entry lets a second pick simply replace the first. */
              <Select
                showSearch
                allowClear
                mode="tags"
                placeholder={t('memory.modelPlaceholder', {
                  model: inheritedMemoryModel || t('memory.modelInherit'),
                })}
                value={localModel ? [localModel] : undefined}
                onChange={(value) => setLocalModel(value?.[value.length - 1] ?? '')}
                filterOption={selectFilterOption}
                options={options}
                className="w-full [&_.ant-select-selector]:!min-h-9"
                popupMatchSelectWidth
                getPopupContainer={(trigger) => trigger.parentElement || document.body}
              />
            ) : (
              <Input
                value={localModel}
                onChange={(event) => setLocalModel(event.target.value)}
                placeholder={t('memory.modelPlaceholder', {
                  model: inheritedMemoryModel || t('memory.modelInherit'),
                })}
                className="font-mono text-sm"
              />
            )}
            <p className="text-xs text-muted-foreground">
              {localModel
                ? t('memory.modelOverrideDesc')
                : t('memory.modelInheritedDesc', {
                    model: inheritedMemoryModel || t('memory.modelInherit'),
                  })}
            </p>
          </div>

          <div className="flex justify-end">
            <Button type="button" size="sm" disabled={!isDirty} onClick={handleSave}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function EmbeddingConfigCard({
  t,
  embeddingEnabled,
  embeddingApiKey,
  embeddingBaseUrl,
  embeddingModel,
  onUpdateMemoryProvider,
}: {
  t: (key: string) => string
  embeddingEnabled?: boolean
  embeddingApiKey?: string
  embeddingBaseUrl?: string
  embeddingModel?: string
  onUpdateMemoryProvider: (fields: Record<string, unknown>) => void
}) {
  const [localEnabled, setLocalEnabled] = useState(!!embeddingEnabled)
  const [localApiKey, setLocalApiKey] = useState(embeddingApiKey || '')
  const [localBaseUrl, setLocalBaseUrl] = useState(embeddingBaseUrl || '')
  const [localModel, setLocalModel] = useState(embeddingModel || 'text-embedding-3-large')

  useEffect(() => {
    setLocalEnabled(!!embeddingEnabled)
  }, [embeddingEnabled])
  useEffect(() => {
    setLocalApiKey(embeddingApiKey || '')
  }, [embeddingApiKey])
  useEffect(() => {
    setLocalBaseUrl(embeddingBaseUrl || '')
  }, [embeddingBaseUrl])
  useEffect(() => {
    setLocalModel(embeddingModel || 'text-embedding-3-large')
  }, [embeddingModel])

  const isDirty =
    localEnabled !== !!embeddingEnabled ||
    localApiKey !== (embeddingApiKey || '') ||
    localBaseUrl !== (embeddingBaseUrl || '') ||
    localModel !== (embeddingModel || 'text-embedding-3-large')

  const handleSave = useCallback(() => {
    onUpdateMemoryProvider({
      embeddingEnabled: localEnabled,
      embeddingApiKey: localApiKey,
      embeddingBaseUrl: localBaseUrl,
      embeddingModel: localModel,
    })
  }, [localEnabled, localApiKey, localBaseUrl, localModel, onUpdateMemoryProvider])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('memory.embeddingTitle')}</CardTitle>
        <CardDescription>{t('memory.embeddingDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label className="text-sm font-medium text-foreground">
                {t('memory.embeddingEnable')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('memory.embeddingEnableDesc')}</p>
            </div>
            <Switch checked={localEnabled} onCheckedChange={setLocalEnabled} />
          </div>

          {localEnabled && (
            <>
              {/* Base URL */}
              <div className="space-y-2">
                <Label
                  htmlFor="embBaseUrl"
                  className="text-sm font-medium text-foreground flex items-center gap-1.5"
                >
                  <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  Base URL
                </Label>
                <Input
                  id="embBaseUrl"
                  placeholder="https://your-api.example.com"
                  value={localBaseUrl}
                  onChange={(e) => setLocalBaseUrl(e.target.value)}
                  className="font-mono text-sm"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">{t('memory.embeddingBaseUrlDesc')}</p>
              </div>

              {/* API Key */}
              <div className="space-y-2">
                <Label
                  htmlFor="embApiKey"
                  className="text-sm font-medium text-foreground flex items-center gap-1.5"
                >
                  <Key className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  {t('memory.embeddingApiKey')}
                </Label>
                <Input
                  id="embApiKey"
                  type="password"
                  placeholder="sk-…"
                  value={localApiKey}
                  onChange={(e) => setLocalApiKey(e.target.value)}
                  className="font-mono text-sm"
                  autoComplete="new-password"
                  spellCheck={false}
                />
              </div>

              {/* Model */}
              <div className="space-y-2">
                <Label htmlFor="embModel" className="text-sm font-medium text-foreground">
                  {t('memory.embeddingModel')}
                </Label>
                <Input
                  id="embModel"
                  placeholder="text-embedding-3-large"
                  value={localModel}
                  onChange={(e) => setLocalModel(e.target.value)}
                  className="font-mono text-sm"
                />
              </div>
            </>
          )}

          {/* Save Button */}
          <div className="mt-5 flex justify-end">
            <Button type="button" size="sm" disabled={!isDirty} onClick={handleSave}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export const DEFAULT_WORKLOG_PROMPT = DEFAULT_MEMORY_WORKLOG_PROMPT
export const DEFAULT_INSIGHT_PROMPT = DEFAULT_MEMORY_INSIGHT_PROMPT

/** 单个可编辑提示词区域，带 Save / Reset 按钮 */
function PromptEditor({
  id,
  label,
  desc,
  value,
  defaultValue,
  onSave,
}: {
  id: string
  label: string
  desc: string
  value: string
  defaultValue: string
  onSave: (val: string | null) => void
}) {
  const { t } = useTranslation()
  // 未自定义时展示默认提示词
  const [local, setLocal] = useState(value || defaultValue)
  useEffect(() => {
    setLocal(value || defaultValue)
  }, [value, defaultValue])
  const isDefault = local === defaultValue
  const isDirty = local !== (value || defaultValue)

  const handleSave = () => {
    // 若内容与默认相同，存 null 让后端用默认值
    onSave(isDefault ? null : local)
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <textarea
        id={id}
        rows={6}
        className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs resize-y focus:outline-none focus:ring-1 focus:ring-ring"
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        spellCheck={false}
      />
      <p className="text-xs text-muted-foreground">{desc}</p>
      <div className="flex justify-end gap-2">
        {!isDefault && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-xs h-7"
            onClick={() => setLocal(defaultValue)}
          >
            {t('common.reset')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          className="text-xs h-7"
          disabled={!isDirty || !local.trim()}
          onClick={handleSave}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  )
}

function SearchConfigCard({
  t,
  memorySearchDecay,
  memorySearchDecayHalfLife,
  memorySearchMmr,
  memorySearchMmrLambda,
  onUpdateMemoryProvider,
}: {
  t: (key: string) => string
  memorySearchDecay?: boolean
  memorySearchDecayHalfLife?: number
  memorySearchMmr?: boolean
  memorySearchMmrLambda?: number
  onUpdateMemoryProvider: (fields: Record<string, unknown>) => void
}) {
  const [localDecay, setLocalDecay] = useState(memorySearchDecay !== false)
  const [localHalfLife, setLocalHalfLife] = useState(String(memorySearchDecayHalfLife ?? 14))
  const [localMmr, setLocalMmr] = useState(memorySearchMmr !== false)
  const [localMmrLambda, setLocalMmrLambda] = useState(String(memorySearchMmrLambda ?? 0.7))

  useEffect(() => {
    setLocalDecay(memorySearchDecay !== false)
  }, [memorySearchDecay])
  useEffect(() => {
    setLocalHalfLife(String(memorySearchDecayHalfLife ?? 14))
  }, [memorySearchDecayHalfLife])
  useEffect(() => {
    setLocalMmr(memorySearchMmr !== false)
  }, [memorySearchMmr])
  useEffect(() => {
    setLocalMmrLambda(String(memorySearchMmrLambda ?? 0.7))
  }, [memorySearchMmrLambda])

  const isDirty =
    localDecay !== (memorySearchDecay !== false) ||
    localHalfLife !== String(memorySearchDecayHalfLife ?? 14) ||
    localMmr !== (memorySearchMmr !== false) ||
    localMmrLambda !== String(memorySearchMmrLambda ?? 0.7)

  const handleSave = useCallback(() => {
    onUpdateMemoryProvider({
      memorySearchDecay: localDecay,
      memorySearchDecayHalfLife: localHalfLife,
      memorySearchMmr: localMmr,
      memorySearchMmrLambda: localMmrLambda,
    })
  }, [localDecay, localHalfLife, localMmr, localMmrLambda, onUpdateMemoryProvider])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('memory.searchConfigTitle')}</CardTitle>
        <CardDescription>{t('memory.searchConfigDesc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* Temporal Decay */}
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label className="text-sm font-medium text-foreground">
                {t('memory.decayLabel')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('memory.decayDesc')}</p>
            </div>
            <Switch checked={localDecay} onCheckedChange={setLocalDecay} />
          </div>
          {localDecay && (
            <div className="space-y-2">
              <Label htmlFor="memDecayHalfLife" className="text-sm font-medium text-foreground">
                {t('memory.decayHalfLife')}
              </Label>
              <Input
                id="memDecayHalfLife"
                type="number"
                min={0}
                max={365}
                value={localHalfLife}
                onChange={(e) => setLocalHalfLife(e.target.value)}
                className="w-24 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">{t('memory.decayHalfLifeDesc')}</p>
            </div>
          )}

          {/* MMR */}
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label className="text-sm font-medium text-foreground">{t('memory.mmrLabel')}</Label>
              <p className="text-xs text-muted-foreground">{t('memory.mmrDesc')}</p>
            </div>
            <Switch checked={localMmr} onCheckedChange={setLocalMmr} />
          </div>
          {localMmr && (
            <div className="space-y-2">
              <Label htmlFor="memMmrLambda" className="text-sm font-medium text-foreground">
                {t('memory.mmrLambda')}
              </Label>
              <Input
                id="memMmrLambda"
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={localMmrLambda}
                onChange={(e) => setLocalMmrLambda(e.target.value)}
                className="w-24 font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">{t('memory.mmrLambdaDesc')}</p>
            </div>
          )}

          {/* Save Button */}
          <div className="mt-5 flex justify-end">
            <Button type="button" size="sm" disabled={!isDirty} onClick={handleSave}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

export function TopicDirectoryCard({
  agentId,
  canWrite,
}: {
  agentId: string | undefined
  canWrite: boolean
}) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'active' | 'archived'>('active')
  const [selectedTopicId, setSelectedTopicId] = useState<string>()
  const [preview, setPreview] = useState<MemoryTopicizationPreview>()
  const { data: topicsData, isFetching } = useMemoryTopics(agentId, status)
  const { data: topicData, isFetching: isReadingTopic } = useMemoryTopic(
    agentId,
    status === 'active' ? selectedTopicId : undefined,
  )
  const reorganize = useReorganizeMemoryTopics()
  const mode = topicsData?.data?.mode ?? 'empty'
  const topics = topicsData?.data?.topics ?? []

  const runLifecycle = (request: { action: 'archive' | 'reactivate'; topicId: string }) => {
    if (!agentId) return
    reorganize.mutate(
      { agentId, request },
      {
        onSuccess: () => {
          if (selectedTopicId === request.topicId) setSelectedTopicId(undefined)
        },
      },
    )
  }

  const previewTopicization = () => {
    if (!agentId) return
    reorganize.mutate(
      { agentId, request: { action: 'topicize-preview' } },
      {
        onSuccess: (response) => setPreview(response.data as MemoryTopicizationPreview),
      },
    )
  }

  const commitTopicization = () => {
    if (!agentId || !preview) return
    reorganize.mutate(
      { agentId, request: { action: 'topicize-commit', proposalId: preview.proposalId } },
      { onSuccess: () => setPreview(undefined) },
    )
  }

  return (
    <>
      <Card data-testid="memory-topic-directory">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <Layers3 className="h-4 w-4" aria-hidden="true" />
                {t('memory.topicsTitle')}
              </CardTitle>
              <CardDescription>{t('memory.topicsDesc')}</CardDescription>
            </div>
            {mode === 'topic_v2' && (
              <ModePicker
                value={status}
                onChange={(value) => {
                  setStatus(value as 'active' | 'archived')
                  setSelectedTopicId(undefined)
                }}
                options={[
                  { value: 'active', label: t('memory.topicsActive') },
                  { value: 'archived', label: t('memory.topicsArchived') },
                ]}
              />
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="info-panel flex gap-2 px-3 py-2.5 text-xs text-muted-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{t('memory.sharedAgentWarning')}</span>
          </div>

          {mode === 'legacy_single_file' ? (
            <div className="rounded-md border border-border bg-muted/30 p-4">
              <p className="text-sm font-medium text-foreground">{t('memory.legacyTitle')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('memory.legacyDesc')}</p>
              {canWrite && (
                <Button
                  type="button"
                  size="sm"
                  className="mt-3"
                  disabled={reorganize.isPending}
                  onClick={previewTopicization}
                >
                  {t('memory.topicizePreview')}
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <ul
                aria-label={t('memory.topicListLabel')}
                className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3"
              >
                {isFetching && topics.length === 0 ? (
                  <li className="col-span-full flex min-h-32 items-center justify-center gap-2 rounded-xl border border-dashed border-border text-sm text-muted-foreground">
                    <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t('memory.topicsLoading')}
                  </li>
                ) : topics.length === 0 ? (
                  <li className="col-span-full flex min-h-32 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-6 py-8 text-center">
                    <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground shadow-sm">
                      {status === 'active' ? (
                        <BookOpen className="h-4 w-4" aria-hidden="true" />
                      ) : (
                        <Archive className="h-4 w-4" aria-hidden="true" />
                      )}
                    </div>
                    <p className="max-w-xl text-sm text-muted-foreground">
                      {t(status === 'active' ? 'memory.topicsEmpty' : 'memory.topicsArchiveEmpty')}
                    </p>
                  </li>
                ) : (
                  topics.map((topic) => (
                    <li
                      key={topic.topicId}
                      className={cn(
                        'relative overflow-hidden rounded-xl border bg-card transition-all',
                        selectedTopicId === topic.topicId
                          ? 'border-primary/40 bg-surface-selected shadow-sm ring-1 ring-primary/10'
                          : 'border-border/80 hover:border-primary/30 hover:bg-surface-hover hover:shadow-sm',
                      )}
                    >
                      {selectedTopicId === topic.topicId && (
                        <span
                          className="absolute inset-y-0 left-0 w-0.5 bg-primary"
                          aria-hidden="true"
                        />
                      )}
                      <button
                        type="button"
                        aria-pressed={selectedTopicId === topic.topicId}
                        className="flex h-full w-full flex-col p-4 pr-12 text-left disabled:cursor-default"
                        disabled={status === 'archived'}
                        onClick={() => setSelectedTopicId(topic.topicId)}
                      >
                        <span className="text-sm font-semibold leading-5 text-foreground">
                          {topic.title}
                        </span>
                        <span className="mt-1.5 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
                          {topic.description}
                        </span>
                        {topic.keywords.length > 0 && (
                          <span className="mt-3 flex flex-wrap gap-1.5">
                            {topic.keywords.map((keyword) => (
                              <span
                                key={keyword}
                                className="rounded-full border border-border/60 bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground"
                              >
                                {keyword}
                              </span>
                            ))}
                          </span>
                        )}
                        <span className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-4 text-[11px] text-muted-foreground">
                          <span className="flex min-w-0 items-center gap-1 font-mono">
                            <Hash className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{topic.topicId}</span>
                          </span>
                          <span className="flex items-center gap-1">
                            <FileText className="h-3 w-3" aria-hidden="true" />
                            {t('memory.topicTokens', { count: topic.tokenCount })}
                          </span>
                          {topic.needsReorganization && (
                            <span className="text-warning">
                              {t('memory.topicNeedsReorganization')}
                            </span>
                          )}
                        </span>
                      </button>
                      {canWrite && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="absolute right-3 top-3 h-8 w-8 rounded-lg p-0 text-muted-foreground hover:text-foreground"
                          aria-label={t(
                            status === 'active' ? 'memory.topicArchive' : 'memory.topicReactivate',
                          )}
                          title={t(
                            status === 'active' ? 'memory.topicArchive' : 'memory.topicReactivate',
                          )}
                          disabled={reorganize.isPending}
                          onClick={() =>
                            runLifecycle({
                              action: status === 'active' ? 'archive' : 'reactivate',
                              topicId: topic.topicId,
                            })
                          }
                        >
                          {status === 'active' ? (
                            <Archive className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <ArchiveRestore className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                        </Button>
                      )}
                    </li>
                  ))
                )}
              </ul>

              <section
                aria-label={t('memory.topicDetailLabel')}
                className="min-h-80 overflow-hidden rounded-xl border border-border bg-card shadow-sm"
              >
                {status === 'archived' ? (
                  <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted/30 text-muted-foreground">
                      <Archive className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <p className="max-w-lg text-sm leading-6 text-muted-foreground">
                      {t('memory.archivedTopicHint')}
                    </p>
                  </div>
                ) : isReadingTopic ? (
                  <div className="flex min-h-80 items-center justify-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t('memory.topicLoading')}
                  </div>
                ) : topicData?.data ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/20 px-5 py-3.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        {t('memory.topicDetailLabel')}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                        <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{topicData.data.path}</span>
                      </span>
                    </div>
                    <div className="max-h-[34rem] overflow-auto px-5 py-4 sm:px-6 sm:py-5">
                      <MarkdownContent content={topicData.data.content} />
                    </div>
                  </>
                ) : (
                  <div className="flex min-h-80 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
                    <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-muted/30 text-muted-foreground">
                      <BookOpen className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">
                        {t('memory.topicSelectTitle')}
                      </p>
                      <p className="max-w-lg text-sm leading-6 text-muted-foreground">
                        {t('memory.topicSelect')}
                      </p>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(undefined)} width={640}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('memory.topicizeDialogTitle')}</DialogTitle>
            <DialogDescription>{t('memory.topicizeDialogDesc')}</DialogDescription>
          </DialogHeader>
          {preview && (
            <div className="mt-4 max-h-80 space-y-2 overflow-auto pr-1">
              <div className="info-panel px-3 py-2 text-sm text-muted-foreground">
                {t('memory.topicizeCoverage', {
                  covered: preview.manifest.length,
                  total: preview.sourceBlockCount,
                  topics: preview.topics.length,
                })}
              </div>
              {preview.topics.map((topic) => (
                <div key={topic.topicId} className="rounded-md border border-border p-3">
                  <p className="text-sm font-medium text-foreground">{topic.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{topic.scope}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('memory.topicizeTopicBlocks', {
                      count: topic.sourceBlockCount,
                      tokens: topic.tokenCount,
                    })}
                  </p>
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPreview(undefined)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled={reorganize.isPending} onClick={commitTopicization}>
              {t('memory.topicizeCommit')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function MemoryTab({
  agentId,
  canWrite = false,
  memoryEnabled,
  onToggleMemory,
  memoryRecallLevel,
  memoryModel,
  inheritedMemoryModel,
  memoryModelOptions,
  memorySearchDecay,
  memorySearchDecayHalfLife,
  memorySearchMmr,
  memorySearchMmrLambda,
  embeddingEnabled,
  embeddingApiKey,
  embeddingBaseUrl,
  embeddingModel,
  memoryContextMode,
  memoryWorklogEnabled,
  memoryWorklogPrompt,
  memoryAutoInsight,
  memoryInsightPrompt,
  memoryConsolidationEnabled,
  onUpdateMemoryProvider,
}: MemoryTabProps) {
  const { t } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'keyword' | 'vector' | 'hybrid'>('hybrid')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [editContent, setEditContent] = useState<string>('')
  const [isEditing, setIsEditing] = useState(false)

  const queryClient = useQueryClient()
  const { data: filesData, isFetching: isRefetchingFiles } = useMemoryFiles(
    memoryEnabled ? agentId : undefined,
  )
  const { data: fileContentData } = useMemoryFileContent(
    memoryEnabled ? agentId : undefined,
    selectedFile ?? undefined,
  )
  const { data: searchData, isFetching: isSearching } = useSearchMemories(
    memoryEnabled ? agentId : undefined,
    searchQuery,
    { mode: searchMode },
  )
  const { data: statsData } = useMemoryStats(memoryEnabled ? agentId : undefined)

  const updateFile = useUpdateMemoryFile()
  const deleteFile = useDeleteMemoryFile()
  const reindexMemory = useReindexMemory()

  const files = filesData?.data ?? []
  const stats = statsData?.data
  const searchResults = searchData?.data?.results ?? []

  const handleFileSelect = useCallback((filename: string) => {
    setSelectedFile(filename)
    setIsEditing(false)
  }, [])

  const handleSave = useCallback(() => {
    if (!agentId || !selectedFile) return
    updateFile.mutate(
      { agentId, filename: selectedFile, content: editContent },
      {
        onSuccess: () => setIsEditing(false),
      },
    )
  }, [agentId, selectedFile, editContent, updateFile])

  const handleDelete = useCallback(
    (filename: string) => {
      if (!agentId) return
      if (!window.confirm(t('memory.deleteConfirm', { filename }))) return
      deleteFile.mutate(
        { agentId, filename },
        {
          onSuccess: () => {
            if (selectedFile === filename) setSelectedFile(null)
          },
        },
      )
    },
    [agentId, selectedFile, deleteFile, t],
  )

  const fileContent = fileContentData?.data?.content ?? ''

  // Sync editor content when file content loads
  useEffect(() => {
    if (!isEditing && selectedFile) {
      setEditContent(fileContent)
    }
  }, [fileContent, isEditing, selectedFile])

  return (
    <div className="space-y-5">
      {/* 配置区 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{t('memory.title')}</CardTitle>
            <Switch checked={memoryEnabled} onCheckedChange={onToggleMemory} />
          </div>
          <CardDescription>{t('memory.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {memoryEnabled && (
            <div className="divide-y divide-border">
              {/* Active context injection — unified Segmented (warm theme),
                  per-option tooltips preserved via Tooltip-wrapped labels. */}
              <SettingSection
                title={t('memory.contextModeLabel')}
                desc={t('memory.contextModeDesc')}
              >
                <ModePicker
                  value={memoryContextMode === 'full' ? 'memory' : memoryContextMode || 'memory'}
                  onChange={(v) => onUpdateMemoryProvider({ memoryContextMode: v })}
                  options={(['off', 'memory'] as const).map((mode) => ({
                    value: mode,
                    label: (
                      <Tooltip title={t(`memory.contextMode_${mode}_tip`)}>
                        <span>{t(`memory.contextMode_${mode}`)}</span>
                      </Tooltip>
                    ),
                  }))}
                />
              </SettingSection>

              {/* Recall strength — unified Segmented; the weak/medium/strong
                  ordering already conveys intensity, so no per-item hue. */}
              <SettingSection
                title={t('memory.recallLevelLabel')}
                desc={t('memory.recallLevelDesc')}
              >
                <ModePicker
                  value={memoryRecallLevel || 'medium'}
                  onChange={(v) => onUpdateMemoryProvider({ memoryRecallLevel: v })}
                  options={(['weak', 'medium', 'strong'] as const).map((level) => ({
                    value: level,
                    label: (
                      <Tooltip title={t(`memory.recallLevel_${level}_tip`)}>
                        <span>{t(`memory.recallLevel_${level}`)}</span>
                      </Tooltip>
                    ),
                  }))}
                />
              </SettingSection>

              {/* Auto worklog summary */}
              <SettingSection
                title={t('memory.worklogLabel')}
                desc={t('memory.worklogDesc')}
                action={
                  <Switch
                    checked={memoryWorklogEnabled !== false}
                    onCheckedChange={(checked) =>
                      onUpdateMemoryProvider({ memoryWorklogEnabled: checked })
                    }
                  />
                }
              >
                {memoryWorklogEnabled !== false && (
                  <PromptEditor
                    id="worklogPrompt"
                    label={t('memory.worklogPromptLabel')}
                    desc={t('memory.worklogPromptDesc')}
                    value={memoryWorklogPrompt ?? ''}
                    defaultValue={DEFAULT_WORKLOG_PROMPT}
                    onSave={(val) => onUpdateMemoryProvider({ memoryWorklogPrompt: val })}
                  />
                )}
              </SettingSection>

              {/* Auto insight extraction */}
              <SettingSection
                title={t('memory.autoInsightLabel')}
                desc={t('memory.autoInsightDesc')}
                action={
                  <Switch
                    checked={memoryAutoInsight !== false}
                    onCheckedChange={(checked) =>
                      onUpdateMemoryProvider({ memoryAutoInsight: checked })
                    }
                  />
                }
              >
                {memoryAutoInsight !== false && (
                  <PromptEditor
                    id="insightPrompt"
                    label={t('memory.insightPromptLabel')}
                    desc={t('memory.insightPromptDesc')}
                    value={memoryInsightPrompt ?? ''}
                    defaultValue={DEFAULT_INSIGHT_PROMPT}
                    onSave={(val) => onUpdateMemoryProvider({ memoryInsightPrompt: val })}
                  />
                )}
              </SettingSection>

              {/* Auto log consolidation */}
              <SettingSection
                title={t('memory.consolidationLabel')}
                desc={t('memory.consolidationDesc')}
                action={
                  <Switch
                    checked={memoryConsolidationEnabled !== false}
                    onCheckedChange={(checked) =>
                      onUpdateMemoryProvider({ memoryConsolidationEnabled: checked })
                    }
                  />
                }
              />
            </div>
          )}

          {memoryEnabled && stats && (
            <div className="mt-4 flex items-center justify-between info-panel px-3 py-2.5 text-sm text-muted-foreground">
              <span>
                {t('memory.statsInfo', {
                  fileCount: stats.fileCount,
                  totalSize: (stats.totalSize / 1024).toFixed(1),
                  dailyCount: stats.dailyFileCount,
                })}
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={reindexMemory.isPending}
                onClick={() => agentId && reindexMemory.mutate({ agentId })}
                title={t('memory.reindex')}
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${reindexMemory.isPending ? 'animate-spin' : ''}`}
                />
                <span className="ml-1.5">{t('memory.reindex')}</span>
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* 自动记忆模型配置 */}
      {memoryEnabled && (
        <MemoryModelCard
          t={t}
          memoryModel={memoryModel}
          inheritedMemoryModel={inheritedMemoryModel}
          memoryModelOptions={memoryModelOptions}
          onUpdateMemoryProvider={onUpdateMemoryProvider}
        />
      )}

      {/* 向量嵌入配置 */}
      {memoryEnabled && (
        <EmbeddingConfigCard
          t={t}
          embeddingEnabled={embeddingEnabled}
          embeddingApiKey={embeddingApiKey}
          embeddingBaseUrl={embeddingBaseUrl}
          embeddingModel={embeddingModel}
          onUpdateMemoryProvider={onUpdateMemoryProvider}
        />
      )}

      {/* 搜索配置 */}
      {memoryEnabled && (
        <SearchConfigCard
          t={t}
          memorySearchDecay={memorySearchDecay}
          memorySearchDecayHalfLife={memorySearchDecayHalfLife}
          memorySearchMmr={memorySearchMmr}
          memorySearchMmrLambda={memorySearchMmrLambda}
          onUpdateMemoryProvider={onUpdateMemoryProvider}
        />
      )}

      {memoryEnabled && <TopicDirectoryCard agentId={agentId} canWrite={canWrite} />}

      {memoryEnabled && (
        <>
          {/* 搜索栏 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('memory.search')}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <AntInput.Search
                  placeholder={t('memory.searchPlaceholder')}
                  onSearch={(value: string) => setSearchQuery(value)}
                  className="flex-1"
                  allowClear
                />
                <ModePicker
                  value={searchMode}
                  onChange={(v) => setSearchMode(v as 'keyword' | 'vector' | 'hybrid')}
                  options={[
                    { value: 'keyword', label: t('memory.modeKeyword') },
                    { value: 'vector', label: t('memory.modeVector') },
                    { value: 'hybrid', label: t('memory.modeHybrid') },
                  ]}
                />
              </div>

              {searchQuery && searchResults.length > 0 && (
                <div className="mt-4 space-y-2">
                  {searchResults.map((r, i) => (
                    <button
                      type="button"
                      key={`${r.filePath}-${i}`}
                      className="w-full rounded-md border border-border bg-muted/30 px-3 py-2 text-left cursor-pointer hover:bg-surface-hover transition-colors"
                      onClick={() => handleFileSelect(r.filePath)}
                    >
                      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                        <span className="font-mono">{r.filePath}</span>
                        <span>
                          {t('memory.score')}: {r.score.toFixed(3)}
                        </span>
                      </div>
                      <p className="text-sm">{r.snippet}</p>
                    </button>
                  ))}
                </div>
              )}

              {searchQuery && isSearching && (
                <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  {t('memory.searching')}
                </div>
              )}

              {searchQuery && !isSearching && searchResults.length === 0 && (
                <p className="mt-4 text-sm text-muted-foreground">{t('memory.noResults')}</p>
              )}
            </CardContent>
          </Card>

          {/* 文件浏览器 */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{t('memory.files')}</CardTitle>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={isRefetchingFiles}
                  onClick={() => queryClient.invalidateQueries({ queryKey: ['memories', agentId] })}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${isRefetchingFiles ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex gap-4 min-h-[300px]">
                {/* 文件列表 */}
                <div className="w-56 shrink-0 border-r border-border pr-4">
                  {files.length === 0 ? (
                    <div className="rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                      {t('memory.noFiles')}
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {files.map((f) => (
                        <div
                          key={f.name}
                          className={`flex items-center justify-between gap-1 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors ${
                            selectedFile === f.name
                              ? 'bg-surface-selected text-interactive-foreground'
                              : 'hover:bg-surface-hover'
                          }`}
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                            onClick={() => handleFileSelect(f.name)}
                          >
                            <File className="h-3.5 w-3.5 shrink-0" />
                            <span className="truncate">{f.name}</span>
                          </button>
                          <button
                            type="button"
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                            onClick={() => handleDelete(f.name)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 文件内容 */}
                <div className="flex-1 min-w-0">
                  {selectedFile ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm text-muted-foreground">
                          {selectedFile}
                        </span>
                        <div className="flex gap-2">
                          {isEditing ? (
                            <>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setIsEditing(false)
                                  setEditContent(fileContent)
                                }}
                              >
                                {t('common.cancel')}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                onClick={handleSave}
                                disabled={updateFile.isPending}
                              >
                                {t('common.save')}
                              </Button>
                            </>
                          ) : (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => setIsEditing(true)}
                            >
                              {t('memory.edit')}
                            </Button>
                          )}
                        </div>
                      </div>
                      {isEditing ? (
                        <textarea
                          className="w-full h-64 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm resize-y"
                          value={editContent}
                          onChange={(e) => setEditContent(e.target.value)}
                        />
                      ) : (
                        <pre className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm whitespace-pre-wrap overflow-auto max-h-96">
                          {fileContent || t('memory.emptyFile')}
                        </pre>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                      <Search className="h-4 w-4 mr-2" />
                      {t('memory.selectFile')}
                    </div>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
