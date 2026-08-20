import { useQueryClient } from '@tanstack/react-query'
import { Dropdown, Tabs, Tooltip } from 'antd'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  Bot,
  Brain,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Copy,
  Download,
  FileBox,
  Globe,
  GlobeLock,
  History,
  Info,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Play,
  RefreshCw,
  Rocket,
  Save,
  Settings2,
  Share2,
  Stethoscope,
  StopCircle,
  Trash2,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmojiPicker } from '@/components/ui/emoji-picker'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { UnsavedChangesDialog } from '@/components/unsaved-changes-dialog'
import {
  CHAT_CONNECTIONS_QUERY_KEY,
  FEISHU_CONNECTIONS_QUERY_KEY,
  useUpdateAgent,
} from '@/hooks/use-agents'
import {
  type AgentDiagnoseClipboardPayload,
  formatAgentDiagnoseClipboardText,
} from '@/lib/agent-diagnose-clipboard'
import { message, modal } from '@/lib/antd-static'
import { api } from '@/lib/api'
import { formatApiError } from '@/lib/api-error'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { ArtifactsTab } from './artifacts-tab'
import { ConfigTab } from './config-tab'
import { CopyButton } from './copy-button'
import { EvaluationTab } from './evaluation'
import { MembersDialog } from './members-dialog'
import { MemoryTab } from './memory-tab'
import { OverviewTab } from './overview-tab'
import { PublishTab } from './publish-tab'
import { RunsTab } from './runs-tab'
import { TestDrawer } from './test-drawer'
import { useAgentForm } from './use-agent-form'

/** Minimum time a manual-refresh spinner stays visible (diagnose + runs refresh),
 * so a fast response doesn't flash for a single frame and read as a glitch. */
const MIN_SPINNER_MS = 600

export function AgentDetailPage() {
  const { t } = useTranslation()
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const isCreateMode = !id && location.pathname === '/agents/new'
  const [testDrawerOpen, setTestDrawerOpen] = useState(false)
  const [diagnoseOpen, setDiagnoseOpen] = useState(false)
  const [diagnoseLoading, setDiagnoseLoading] = useState(false)
  const [diagnoseResult, setDiagnoseResult] = useState<AgentDiagnoseClipboardPayload | null>(null)
  const [diagnoseCopied, setDiagnoseCopied] = useState(false)
  const [diagnoseError, setDiagnoseError] = useState<string | null>(null)
  const [membersDialogOpen, setMembersDialogOpen] = useState(false)
  const queryClient = useQueryClient()

  const {
    agent,
    permission,
    skillBindingScope,
    skillBindingOwnerId,
    isLoading,
    form,
    blocker,
    providersList,
    providerChainEntries,
    setProviderChainEntries,
    providerLocked,
    skillsList,
    skillGroupsList,
    mcpServersList,
    scmSourcesList,
    kbDocumentsList,
    showApiKey,
    setShowApiKey,
    selectedSkills,
    setSelectedSkills,
    selectedSkillGroupIds,
    setSelectedSkillGroupIds,
    selectedMcpServerIds,
    setSelectedMcpServerIds,
    selectedKbDocumentIds,
    setSelectedKbDocumentIds,
    workspaceType,
    setWorkspaceType,
    scmSubType,
    setScmSubType,
    selectedScmSourceId,
    setSelectedScmSourceId,
    envEntries,
    setEnvEntries,
    visibleEnvIds,
    setVisibleEnvIds,
    setRouteEnabled,
    localAgentIds,
    setLocalAgentIds,
    showLocalChildOutput,
    setShowLocalChildOutput,
    showRemoteChildOutput,
    setShowRemoteChildOutput,
    remoteEntries,
    setRemoteEntries,
    resolvedWorkDir,
    hasSelectionChanges,
    discardChanges,
    onSubmit,
    handleDelete,
    handleClone,
    handlePublishConfirm,
    handleStop,
    handleResume,
    isSaving,
    isDeleting,
    publishAgent,
    stopAgent,
    resumeAgent,
    cloneAgent,
  } = useAgentForm(id, isCreateMode, location.state?.template)

  // Permission-driven UI gates. Until the agent is loaded, we treat the user as
  // read-only (canWrite=false) so write actions stay disabled. Once permission
  // resolves, owner/editor unlocks writes; only owner can manage members or
  // delete the agent. In create mode there is no permission yet, so we leave
  // create-mode controls untouched.
  const canWrite = permission === 'owner' || permission === 'editor'
  const isOwner = permission === 'owner'

  // Monotonic token so an in-flight diagnose from a previous open can't clobber
  // a newer run's result (the MIN_SPINNER_MS floor widens that race window).
  const diagnoseSeqRef = useRef(0)
  const runDiagnose = useCallback(async () => {
    if (!id) return
    const seq = ++diagnoseSeqRef.current
    setDiagnoseLoading(true)
    setDiagnoseError(null)
    // Diagnose usually returns within ~100ms, which would make the spinner flash
    // for a single frame and read as a glitch. Hold the loading state for a
    // minimum beat so the retry registers as deliberate feedback.
    const settled = new Promise((resolve) => setTimeout(resolve, MIN_SPINNER_MS))
    try {
      const res = await api.get<AgentDiagnoseClipboardPayload>(`/agents/${id}/diagnose`)
      await settled
      if (seq !== diagnoseSeqRef.current) return
      setDiagnoseResult(res.data)
      // Diagnose reports on all three native chat channels, so refresh each
      // registry — otherwise the publish cards contradict the report just read.
      await queryClient.invalidateQueries({ queryKey: FEISHU_CONNECTIONS_QUERY_KEY })
      await queryClient.invalidateQueries({ queryKey: CHAT_CONNECTIONS_QUERY_KEY })
    } catch {
      await settled
      if (seq !== diagnoseSeqRef.current) return
      setDiagnoseResult(null)
      setDiagnoseError('DIAGNOSE_FAILED')
    } finally {
      if (seq === diagnoseSeqRef.current) setDiagnoseLoading(false)
    }
  }, [id, queryClient])

  const openDiagnose = useCallback(() => {
    setDiagnoseOpen(true)
    setDiagnoseResult(null)
    setDiagnoseError(null)
    setDiagnoseCopied(false)
    void runDiagnose()
  }, [runDiagnose])

  const handleCopyDiagnoseReport = useCallback(async () => {
    if (!diagnoseResult) return
    const text = formatAgentDiagnoseClipboardText(diagnoseResult, {
      title: t('agentDetail.diagnoseTitle'),
      checkedAtLabel: t('agentDetail.diagnoseReportCheckedAt'),
      scopeLabel: t('agentDetail.diagnoseReportScope'),
      summaryOk: t('agentDetail.diagnoseSummaryOk'),
      summaryBad: t('agentDetail.diagnoseSummaryBad'),
      severityError: t('agentDetail.diagnoseSeverityError'),
      severityWarn: t('agentDetail.diagnoseSeverityWarn'),
      severityInfo: t('agentDetail.diagnoseSeverityInfo'),
    })
    if (!(await copyText(text))) return
    setDiagnoseCopied(true)
    window.setTimeout(() => setDiagnoseCopied(false), 2000)
  }, [diagnoseResult, t])

  const closeDiagnoseModal = useCallback(() => {
    setDiagnoseOpen(false)
    setDiagnoseCopied(false)
  }, [])

  const runsRefetchRef = useRef<(() => void) | undefined>(undefined)
  const [runsIsFetching, setRunsIsFetching] = useState(false)
  const [runsSpinning, setRunsSpinning] = useState(false)
  const handleRunsFetchingChange = useCallback((v: boolean) => setRunsIsFetching(v), [])
  const handleRunsRefresh = useCallback(() => {
    runsRefetchRef.current?.()
    setRunsSpinning(true)
    setTimeout(() => setRunsSpinning(false), MIN_SPINNER_MS)
  }, [])

  const memoryUpdateAgent = useUpdateAgent()
  const agentCfg = (agent?.config as Record<string, unknown>) ?? {}
  const memoryEnabled = !!agentCfg.memoryEnabled
  const inheritedMemoryModel = typeof agentCfg.model === 'string' ? agentCfg.model : ''
  const memoryModel =
    typeof agentCfg.memoryModel === 'string'
      ? agentCfg.memoryModel
      : typeof agentCfg.memoryProviderModel === 'string'
        ? agentCfg.memoryProviderModel
        : undefined
  const memoryModelOptions = useMemo(() => {
    // Providers no longer store a model catalog (models are probed per
    // credential on the config tab), so the candidates here are the models this
    // Agent has actually selected on its enabled chain entries — which are also
    // the only ones known to work with the credentials it runs under.
    const models = new Set<string>()

    const rawChain = agentCfg.providerChain
    if (Array.isArray(rawChain)) {
      for (const item of rawChain) {
        if (!item || typeof item !== 'object') continue
        const entry = item as Record<string, unknown>
        if (entry.enabled === false) continue
        if (typeof entry.model === 'string' && entry.model.trim()) models.add(entry.model)
      }
    } else if (typeof agentCfg.model === 'string' && agentCfg.model.trim()) {
      models.add(agentCfg.model)
    }

    if (inheritedMemoryModel) models.add(inheritedMemoryModel)
    if (memoryModel) models.add(memoryModel)
    return Array.from(models)
  }, [agentCfg.providerChain, agentCfg.model, inheritedMemoryModel, memoryModel])

  const handleToggleMemory = useCallback(
    (enabled: boolean) => {
      if (!id) return
      memoryUpdateAgent.mutate(
        {
          id,
          config: { ...agentCfg, memoryEnabled: enabled },
        },
        {
          onError: (error) => message.error(formatApiError(error, t)),
        },
      )
    },
    [id, agentCfg, memoryUpdateAgent, t],
  )

  const handleUpdateMemoryProvider = useCallback(
    (fields: Record<string, unknown>) => {
      if (!id) return
      const { memoryProviderApiKey: mpk, embeddingApiKey: eak, ...configFields } = fields
      const patch: Record<string, unknown> = {
        id,
        config: { ...agentCfg, ...configFields },
      }
      if (mpk !== undefined) patch.memoryProviderApiKey = mpk
      if (eak !== undefined) patch.embeddingApiKey = eak
      memoryUpdateAgent.mutate(patch as Parameters<typeof memoryUpdateAgent.mutate>[0], {
        onError: (error) => message.error(formatApiError(error, t)),
      })
    },
    [id, agentCfg, memoryUpdateAgent, t],
  )

  const VALID_TABS = [
    'config',
    'evaluation',
    'publish',
    'artifacts',
    'runs',
    'memory',
    'overview',
  ] as const
  const tabParam = searchParams.get('tab')
  const activeTab =
    tabParam && VALID_TABS.includes(tabParam as (typeof VALID_TABS)[number]) ? tabParam : 'config'

  const handleTabChange = (key: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', key)
    setSearchParams(next, { replace: true })
  }

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { isDirty, errors },
  } = form
  const icon = watch('icon')

  if (isLoading && !isCreateMode) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <Skeleton className="h-6 w-48" />
        </div>
        <div className="rounded-[10px] border border-border bg-card p-6">
          <div className="flex items-center gap-4">
            <Skeleton className="size-14 rounded-2xl" />
            <div className="space-y-2 flex-1">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-64" />
            </div>
          </div>
        </div>
        <div className="rounded-[10px] border border-border bg-card p-6 space-y-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-32 w-full" />
        </div>
      </div>
    )
  }

  if (!isCreateMode && (!id || !agent)) {
    return (
      <div>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-muted mb-4">
            <Bot className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
          </div>
          <h2
            className="text-lg font-semibold mb-2 text-foreground"
            style={{ textWrap: 'balance' }}
          >
            {!id ? t('agentDetail.invalidId') : t('agentDetail.notFound')}
          </h2>
          <p className="text-sm text-muted-foreground mb-5">
            {!id ? t('agentDetail.invalidIdDesc') : t('agentDetail.notFoundDesc')}
          </p>
          <Link to="/agents">
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t('agentDetail.backToAgents')}
            </Button>
          </Link>
        </div>
      </div>
    )
  }

  const tabItems = [
    {
      key: 'config',
      label: (
        <span className="inline-flex items-center gap-1.5">
          <Settings2 className="h-4 w-4" />
          {t('agentDetail.tabConfig')}
        </span>
      ),
      children: (
        <ConfigTab
          form={form}
          agentId={id}
          agent={agent}
          skillBindingScope={skillBindingScope}
          skillBindingOwnerId={skillBindingOwnerId}
          providersList={providersList}
          providerChainEntries={providerChainEntries}
          setProviderChainEntries={setProviderChainEntries}
          providerLocked={providerLocked}
          skillsList={skillsList}
          skillGroupsList={skillGroupsList}
          mcpServersList={mcpServersList}
          scmSourcesList={scmSourcesList}
          selectedSkills={selectedSkills}
          setSelectedSkills={setSelectedSkills}
          selectedSkillGroupIds={selectedSkillGroupIds}
          setSelectedSkillGroupIds={setSelectedSkillGroupIds}
          selectedMcpServerIds={selectedMcpServerIds}
          setSelectedMcpServerIds={setSelectedMcpServerIds}
          kbDocumentsList={kbDocumentsList}
          selectedKbDocumentIds={selectedKbDocumentIds}
          setSelectedKbDocumentIds={setSelectedKbDocumentIds}
          workspaceType={workspaceType}
          setWorkspaceType={setWorkspaceType}
          scmSubType={scmSubType}
          setScmSubType={setScmSubType}
          selectedScmSourceId={selectedScmSourceId}
          setSelectedScmSourceId={setSelectedScmSourceId}
          envEntries={envEntries}
          setEnvEntries={setEnvEntries}
          visibleEnvIds={visibleEnvIds}
          setVisibleEnvIds={setVisibleEnvIds}
          setRouteEnabled={setRouteEnabled}
          localAgentIds={localAgentIds}
          setLocalAgentIds={setLocalAgentIds}
          showLocalChildOutput={showLocalChildOutput}
          setShowLocalChildOutput={setShowLocalChildOutput}
          showRemoteChildOutput={showRemoteChildOutput}
          setShowRemoteChildOutput={setShowRemoteChildOutput}
          remoteEntries={remoteEntries}
          setRemoteEntries={setRemoteEntries}
          resolvedWorkDir={resolvedWorkDir}
          showApiKey={showApiKey}
          setShowApiKey={setShowApiKey}
        />
      ),
    },
    ...(!isCreateMode
      ? [
          {
            key: 'publish',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Rocket className="h-4 w-4" />
                {t('agentDetail.tabPublish')}
              </span>
            ),
            children: (
              <PublishTab
                agentId={id}
                agent={agent}
                canWrite={canWrite}
                onPublishConfirm={handlePublishConfirm}
                isPublishing={publishAgent.isPending}
                onStop={handleStop}
                onResume={handleResume}
                isStopPending={stopAgent.isPending}
                isResumePending={resumeAgent.isPending}
              />
            ),
          },
          {
            key: 'evaluation',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <ClipboardCheck className="h-4 w-4" />
                {t('agentDetail.tabEvaluation')}
              </span>
            ),
            children: <EvaluationTab agentId={id as string} canWrite={canWrite} />,
          },
          {
            key: 'artifacts',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <FileBox className="h-4 w-4" />
                {t('agentDetail.tabArtifacts')}
              </span>
            ),
            children: <ArtifactsTab agentId={id} artifactPolicy={agent?.artifactPolicy ?? null} />,
          },
          {
            key: 'runs',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <History className="h-4 w-4" />
                {t('agentDetail.tabRuns')}
              </span>
            ),
            children: (
              <RunsTab
                agentId={id}
                refetchRef={runsRefetchRef}
                onFetchingChange={handleRunsFetchingChange}
              />
            ),
          },
          {
            key: 'memory',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Brain className="h-4 w-4" />
                {t('agentDetail.tabMemory')}
              </span>
            ),
            children: (
              <MemoryTab
                agentId={id}
                canWrite={canWrite}
                memoryEnabled={memoryEnabled}
                onToggleMemory={handleToggleMemory}
                onUpdateMemoryProvider={handleUpdateMemoryProvider}
                memoryRecallLevel={agentCfg.memoryRecallLevel as string | undefined}
                memoryModel={memoryModel}
                inheritedMemoryModel={inheritedMemoryModel}
                memoryModelOptions={memoryModelOptions}
                memorySearchDecay={agentCfg.memorySearchDecay as boolean | undefined}
                memorySearchDecayHalfLife={agentCfg.memorySearchDecayHalfLife as number | undefined}
                memorySearchMmr={agentCfg.memorySearchMmr as boolean | undefined}
                memorySearchMmrLambda={agentCfg.memorySearchMmrLambda as number | undefined}
                embeddingEnabled={agentCfg.embeddingEnabled as boolean | undefined}
                embeddingApiKey={agent?.embeddingApiKey ?? undefined}
                embeddingBaseUrl={agentCfg.embeddingBaseUrl as string | undefined}
                embeddingModel={agentCfg.embeddingModel as string | undefined}
                memoryContextMode={agentCfg.memoryContextMode as string | undefined}
                memoryWorklogEnabled={agentCfg.memoryWorklogEnabled as boolean | undefined}
                memoryWorklogPrompt={agentCfg.memoryWorklogPrompt as string | null | undefined}
                memoryAutoInsight={agentCfg.memoryAutoInsight as boolean | undefined}
                memoryInsightPrompt={agentCfg.memoryInsightPrompt as string | null | undefined}
                memoryConsolidationEnabled={
                  agentCfg.memoryConsolidationEnabled as boolean | undefined
                }
              />
            ),
          },
          {
            key: 'overview',
            label: (
              <span className="inline-flex items-center gap-1.5">
                <BarChart3 className="h-4 w-4" />
                {t('agentDetail.tabOverview')}
              </span>
            ),
            children: <OverviewTab agentId={id} />,
          },
        ]
      : []),
  ]

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-page="agent-detail">
      <div className="flex items-center gap-2 mb-6">
        <Link
          to="/agents"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md px-1 py-0.5"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {t('nav.agents')}
        </Link>
        <span className="text-muted-foreground/30">/</span>
        <span className="text-sm font-medium text-foreground truncate">
          {isCreateMode ? t('agents.newAgent') : agent?.name}
        </span>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="flex-1 flex flex-col min-h-0 space-y-5">
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-4 min-w-0 flex-1">
                  <EmojiPicker
                    value={icon}
                    onChange={(emoji) => setValue('icon', emoji, { shouldDirty: true })}
                    className="shrink-0"
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <Input
                      {...register('name')}
                      className={cn(
                        'text-lg font-semibold h-auto border-none bg-transparent p-0 focus-visible:ring-0 shadow-none placeholder:text-muted-foreground/40',
                        errors.name && 'text-destructive placeholder:text-destructive/40',
                      )}
                      placeholder={t('agentDetail.namePlaceholder')}
                      aria-label={t('agentDetail.namePlaceholder')}
                      aria-required="true"
                    />
                    {errors.name && (
                      <p className="text-xs text-destructive mt-0.5">{errors.name.message}</p>
                    )}
                    {!isCreateMode && agent && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <code className="font-mono bg-warm-50 border border-border/60 px-1.5 py-0.5 rounded text-xs">
                          {agent.id}
                        </code>
                        <CopyButton text={agent.id} label={t('agent.copyId')} />
                      </div>
                    )}
                  </div>
                </div>

                {!isCreateMode && (
                  <div className="flex items-center gap-2 shrink-0">
                    <Tooltip
                      title={
                        isDirty || hasSelectionChanges
                          ? t('agentDetail.testDirtyHint')
                          : t('agentDetail.testCleanHint')
                      }
                      placement="bottom"
                    >
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setTestDrawerOpen(true)}
                        className="gap-1.5"
                      >
                        <MessageSquare className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('agentDetail.tabTest')}
                      </Button>
                    </Tooltip>
                    <Badge
                      variant={
                        agent?.publishStatus === 'published'
                          ? 'success'
                          : agent?.publishStatus === 'stopped'
                            ? 'destructive'
                            : 'secondary'
                      }
                      className="gap-1"
                    >
                      {agent?.publishStatus === 'published' ? (
                        <Globe className="h-3 w-3" aria-hidden="true" />
                      ) : agent?.publishStatus === 'stopped' ? (
                        <StopCircle className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <GlobeLock className="h-3 w-3" aria-hidden="true" />
                      )}
                      {agent?.publishStatus === 'published'
                        ? t('agent.running')
                        : agent?.publishStatus === 'stopped'
                          ? t('agentDetail.stopped')
                          : t('agent.draft')}
                    </Badge>
                    <Dropdown
                      menu={{
                        items: (() => {
                          const diagnoseItem = {
                            key: 'diagnose',
                            label: (
                              <span data-testid="agent-diagnose-menu-item">
                                {t('agentDetail.diagnose')}
                              </span>
                            ),
                            icon: <Stethoscope className="h-4 w-4" />,
                            disabled: diagnoseLoading,
                            onClick: openDiagnose,
                          }
                          const membersItem = isOwner
                            ? {
                                key: 'members',
                                label: (
                                  <span data-testid="agent-members-menu-item">
                                    {t('agentDetail.members.menuItem')}
                                  </span>
                                ),
                                icon: <Users className="h-4 w-4" />,
                                onClick: () => setMembersDialogOpen(true),
                              }
                            : null
                          const stopResumeItems = [
                            ...(agent?.publishStatus === 'published'
                              ? [
                                  {
                                    key: 'stop',
                                    label: t('agentDetail.stop'),
                                    icon: <StopCircle className="h-4 w-4" />,
                                    disabled: stopAgent.isPending || !canWrite,
                                    onClick: handleStop,
                                  },
                                ]
                              : []),
                            ...(agent?.publishStatus === 'stopped'
                              ? [
                                  {
                                    key: 'resume',
                                    label: t('agentDetail.resume'),
                                    icon: <Play className="h-4 w-4" />,
                                    disabled: resumeAgent.isPending || !canWrite,
                                    onClick: handleResume,
                                  },
                                ]
                              : []),
                          ]
                          const cloneItem = {
                            key: 'clone',
                            label: t('agentDetail.clone'),
                            icon: <Copy className="h-4 w-4" />,
                            disabled: cloneAgent.isPending || !canWrite,
                            onClick: handleClone,
                          }
                          const exportItem = {
                            key: 'export',
                            label: t('agentDetail.export'),
                            icon: <Download className="h-4 w-4" />,
                            onClick: async () => {
                              if (!id) return
                              try {
                                const res = await fetch(`/api/agents/${id}/export`, {
                                  credentials: 'include',
                                })
                                if (!res.ok) throw new Error('Export failed')
                                const blob = await res.blob()
                                const disposition = res.headers.get('content-disposition') ?? ''
                                const match = disposition.match(/filename="?([^"]+)"?/)
                                const filename = match
                                  ? decodeURIComponent(match[1])
                                  : `${agent?.name ?? 'agent'}-export.zip`
                                const url = URL.createObjectURL(blob)
                                const a = document.createElement('a')
                                a.href = url
                                a.download = filename
                                document.body.appendChild(a)
                                a.click()
                                URL.revokeObjectURL(url)
                                a.remove()
                              } catch {
                                modal.error({ title: t('agentDetail.exportFailed') })
                              }
                            },
                          }
                          const shareItem = {
                            key: 'share',
                            label: t('agentDetail.shareLink'),
                            icon: <Share2 className="h-4 w-4" />,
                            disabled: !canWrite,
                            onClick: async () => {
                              if (!id) return
                              try {
                                const res = await api.post<{ shareUrl: string; expiresIn: string }>(
                                  `/agents/${id}/share`,
                                  {},
                                )
                                await copyText(res.data.shareUrl)
                                modal.success({
                                  title: t('agentDetail.shareLinkCopied'),
                                  content: t('agentDetail.shareLinkExpiry', {
                                    expiry: res.data.expiresIn,
                                  }),
                                })
                              } catch {
                                modal.error({ title: t('agentDetail.shareLinkFailed') })
                              }
                            },
                          }
                          const deleteItem = {
                            key: 'delete',
                            label: t('agentDetail.deleteAgent'),
                            icon: <Trash2 className="h-4 w-4" />,
                            danger: true,
                            disabled: isDeleting || !isOwner,
                            onClick: handleDelete,
                          }
                          const secondaryItems = [
                            ...stopResumeItems,
                            cloneItem,
                            exportItem,
                            shareItem,
                          ]
                          return [
                            diagnoseItem,
                            { type: 'divider' as const },
                            ...(membersItem ? [membersItem, { type: 'divider' as const }] : []),
                            ...secondaryItems,
                            { type: 'divider' as const },
                            deleteItem,
                          ]
                        })(),
                      }}
                      trigger={['click']}
                      placement="bottomRight"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8"
                        aria-label={t('agentDetail.moreActions')}
                        data-testid="agent-detail-more-actions"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </Dropdown>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <Tabs
          activeKey={activeTab}
          onChange={handleTabChange}
          items={tabItems}
          className="agent-detail-tabs"
          tabBarExtraContent={
            activeTab === 'runs'
              ? {
                  right: (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 text-muted-foreground hover:text-foreground"
                      disabled={runsSpinning}
                      onClick={handleRunsRefresh}
                      aria-label={t('common.refresh')}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${runsSpinning ? 'animate-spin' : ''}`} />
                    </Button>
                  ),
                }
              : undefined
          }
        />

        {activeTab === 'config' && (
          <div
            className="sticky bottom-0 z-10 -mx-10 px-10 py-4 bg-gradient-to-t from-background via-background to-transparent mt-auto"
            data-sticky-bar
          >
            <div className="w-full flex items-center justify-end">
              <Tooltip
                title={
                  !isCreateMode && !canWrite ? t('agentDetail.members.readOnlyHint') : undefined
                }
                placement="top"
              >
                <Button
                  type="submit"
                  data-tour="agent-submit"
                  data-testid="agent-detail-save"
                  disabled={
                    isCreateMode
                      ? isSaving
                      : (!isDirty && !hasSelectionChanges) || isSaving || !canWrite
                  }
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      {isCreateMode ? t('agentDetail.creating') : t('agentDetail.saving')}
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4" aria-hidden="true" />
                      {isCreateMode ? t('agentDetail.createAgent') : t('agentDetail.saveChanges')}
                    </>
                  )}
                </Button>
              </Tooltip>
            </div>
          </div>
        )}
      </form>

      {!isCreateMode && (
        <TestDrawer
          open={testDrawerOpen}
          onClose={() => setTestDrawerOpen(false)}
          agentId={id}
          agentStatus={agent?.status}
          agentIcon={icon}
        />
      )}

      {!isCreateMode && id && (
        <MembersDialog
          open={membersDialogOpen}
          onClose={() => setMembersDialogOpen(false)}
          agentId={id}
        />
      )}

      <UnsavedChangesDialog blocker={blocker} onDiscard={discardChanges} />

      <Dialog
        open={diagnoseOpen}
        onOpenChange={(next) => {
          if (!next) closeDiagnoseModal()
        }}
        width={720}
      >
        <DialogContent>
          <div data-testid="agent-diagnose-modal">
            <DialogHeader>
              <DialogTitle className="pr-8" data-testid="agent-diagnose-title">
                {t('agentDetail.diagnoseTitle')}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {t('agentDetail.diagnoseScopeHint')}
              </DialogDescription>
            </DialogHeader>

            <div className="mt-4 space-y-3">
              {/* Only the very first diagnose shows a spinner here; re-runs keep the
                  previous result mounted so the modal does not collapse and flash. */}
              {diagnoseLoading && !diagnoseResult && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-hidden="true" />
                  {t('agentDetail.diagnoseLoading')}
                </div>
              )}
              {diagnoseError && (
                <div className="info-panel px-3 py-2.5 text-sm text-destructive flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                  {t('agentDetail.diagnoseError')}
                </div>
              )}
              {diagnoseResult && (
                <>
                  <output
                    className={cn(
                      'rounded-lg px-3 py-2.5 text-sm flex items-start justify-between gap-2',
                      diagnoseResult.ok
                        ? 'bg-success-subtle text-success'
                        : 'bg-destructive/10 text-destructive',
                    )}
                  >
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      {diagnoseResult.ok ? (
                        <CheckCircle2
                          className="mt-0.5 h-4 w-4 shrink-0 text-success"
                          aria-hidden="true"
                        />
                      ) : (
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                      )}
                      <span className="min-w-0">
                        {diagnoseResult.ok
                          ? t('agentDetail.diagnoseSummaryOk')
                          : t('agentDetail.diagnoseSummaryBad')}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-1.5"
                      onClick={() => void handleCopyDiagnoseReport()}
                      aria-label={t('agentDetail.diagnoseCopy')}
                      data-testid="agent-diagnose-copy"
                    >
                      {diagnoseCopied ? (
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {diagnoseCopied
                        ? t('agentDetail.diagnoseCopied')
                        : t('agentDetail.diagnoseCopy')}
                    </Button>
                  </output>
                  <ul
                    className="space-y-2 max-h-[min(50vh,360px)] overflow-y-auto pr-1"
                    aria-label={t('agentDetail.diagnoseTitle')}
                  >
                    {diagnoseResult.checks.map((c) => (
                      <li
                        key={c.id}
                        className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm flex gap-2.5"
                      >
                        {c.severity === 'error' ? (
                          <AlertCircle
                            className="h-4 w-4 text-destructive shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                        ) : c.severity === 'warn' ? (
                          <AlertTriangle
                            className="mt-0.5 h-4 w-4 shrink-0 text-warning"
                            aria-hidden="true"
                          />
                        ) : (
                          <Info
                            className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                            {c.severity === 'error'
                              ? t('agentDetail.diagnoseSeverityError')
                              : c.severity === 'warn'
                                ? t('agentDetail.diagnoseSeverityWarn')
                                : t('agentDetail.diagnoseSeverityInfo')}
                          </span>
                          <p className="text-foreground mt-0.5 text-pretty">{c.message}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDiagnoseModal}>
                {t('agentDetail.diagnoseClose')}
              </Button>
              <Button
                type="button"
                disabled={diagnoseLoading}
                onClick={() => void runDiagnose()}
                aria-busy={diagnoseLoading}
              >
                {diagnoseLoading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('agentDetail.diagnoseRetry')}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
