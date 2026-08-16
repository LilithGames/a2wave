import type { Agent, ProviderDto, ScmSource } from '@a2wave/shared'
import { ADMIN_MCP_NAMES, INTERNAL_MCP_NAMES, PROVIDER_CHAIN_MAX } from '@a2wave/shared'
import { InputNumber, Radio, Select, Tag, Tooltip } from 'antd'
import {
  AlertTriangle,
  Blocks,
  BookOpen,
  Cable,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  GripVertical,
  Info,
  Key,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { PromptEditor } from '@/components/prompt-editor'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAllAgents } from '@/hooks/use-agents'
import { useCurrentUser } from '@/hooks/use-auth'
import { useProbeModels } from '@/hooks/use-providers'
import { resolveCollectionIcon } from '@/lib/collection-icons'
import { selectFilterOption } from '@/lib/select-filter'
import { findUndefinedVariables } from '@/lib/template-utils'
import { EnvSection } from './env-section'
import { McpServerTools, mcpServerHasToolPreview } from './mcp-server-tools'
import {
  buildProbeModelsRequest,
  credentialFieldIsRequired,
  hasConfiguredMcpBackedCapabilities,
  hasConfiguredRouteTargets,
  modelProbePolicy,
  normalizeAuthMode,
  providersWithoutMcpDelivery,
  reasoningEffortAfterModelChange,
  reasoningEffortSelectState,
  resolveModelProbeErrorTranslation,
  visibleCredentialFieldsFor,
} from './provider-capabilities'
import { applyProviderEntryPatch } from './provider-chain'
import { RouteSection } from './route-section'
import type { AgentFormMethods, EnvEntry, ProviderChainEntry, RemoteEntry } from './types'
import { WorkspaceSection } from './workspace-section'

let remoteEntryCounter = 0
function nextRemoteEntryId() {
  return `re_${++remoteEntryCounter}`
}

let providerEntryCounter = 0
function nextProviderEntryId() {
  return `pc_${Date.now()}_${++providerEntryCounter}`
}

export type SkillBindingScope = 'all-visible' | 'owner-or-shared'

export interface SkillPickerSkill {
  id: string
  name: string
  description?: string | null
  groupId?: string | null
  userId?: string | null
  visibility?: 'private' | 'all-users'
}

export interface SkillPickerGroup {
  id: string
  name: string
  description?: string | null
  icon?: string
  userId?: string | null
  ownerCanBindAllSkills?: boolean
}

export interface SkillBindingPickerState {
  skills: SkillPickerSkill[]
  groups: SkillPickerGroup[]
  unavailableExistingSkillIds: string[]
  unavailableExistingGroupIds: string[]
}

/**
 * Limit newly attachable resources to the target Agent owner's runtime scope.
 * Existing references stay in the picker even when they are not newly
 * assignable, so unrelated saves preserve them while an explicit removal is
 * still submitted, matching the API's diff-only PATCH contract.
 */
export function buildSkillBindingPickerState({
  skills,
  groups,
  existingSkillIds,
  existingGroupIds,
  agentOwnerId,
  scope,
}: {
  skills: SkillPickerSkill[]
  groups: SkillPickerGroup[]
  existingSkillIds: string[]
  existingGroupIds: string[]
  agentOwnerId: string | null | undefined
  scope: SkillBindingScope
}): SkillBindingPickerState {
  const canAddSkill = (skill: SkillPickerSkill) =>
    scope === 'all-visible' ||
    skill.visibility === 'all-users' ||
    (agentOwnerId != null && skill.userId === agentOwnerId)

  const canAddGroup = (group: SkillPickerGroup) => {
    if (scope === 'all-visible') return true
    if (agentOwnerId == null || group.userId !== agentOwnerId) return false
    if (group.ownerCanBindAllSkills === false) return false
    return skills
      .filter((skill) => skill.groupId === group.id)
      .every((skill) => skill.visibility === 'all-users' || skill.userId === agentOwnerId)
  }

  const assignableSkillIds = new Set(skills.filter(canAddSkill).map((skill) => skill.id))
  const assignableGroupIds = new Set(groups.filter(canAddGroup).map((group) => group.id))
  const existingSkillIdSet = new Set(existingSkillIds)
  const existingGroupIdSet = new Set(existingGroupIds)

  return {
    skills: skills.filter(
      (skill) => assignableSkillIds.has(skill.id) || existingSkillIdSet.has(skill.id),
    ),
    groups: groups.filter(
      (group) => assignableGroupIds.has(group.id) || existingGroupIdSet.has(group.id),
    ),
    unavailableExistingSkillIds: existingSkillIds.filter((id) => !assignableSkillIds.has(id)),
    unavailableExistingGroupIds: existingGroupIds.filter((id) => !assignableGroupIds.has(id)),
  }
}

interface ConfigTabProps {
  form: AgentFormMethods
  agentId: string | undefined
  agent: Agent | undefined
  skillBindingScope: SkillBindingScope
  skillBindingOwnerId: string | null | undefined
  providersList: ProviderDto[] | undefined
  providerChainEntries: ProviderChainEntry[]
  setProviderChainEntries: React.Dispatch<React.SetStateAction<ProviderChainEntry[]>>
  /** Locks the first Provider for guided templates. */
  providerLocked?: boolean
  skillsList: SkillPickerSkill[] | undefined
  skillGroupsList: SkillPickerGroup[] | undefined
  mcpServersList:
    | Array<{
        id: string
        name: string
        description?: string | null
        type: string
        isEnabled: boolean
      }>
    | undefined
  scmSourcesList: ScmSource[] | undefined
  selectedSkills: string[]
  setSelectedSkills: (v: string[]) => void
  selectedSkillGroupIds: string[]
  setSelectedSkillGroupIds: (v: string[]) => void
  selectedMcpServerIds: string[]
  setSelectedMcpServerIds: (v: string[]) => void
  kbDocumentsList: Array<{ id: string; name: string; description?: string | null }> | undefined
  selectedKbDocumentIds: string[]
  setSelectedKbDocumentIds: (v: string[]) => void
  workspaceType: 'scm' | 'temp'
  setWorkspaceType: (v: 'scm' | 'temp') => void
  scmSubType: 'p4' | 'git'
  setScmSubType: (v: 'p4' | 'git') => void
  selectedScmSourceId: string | null
  setSelectedScmSourceId: (v: string | null) => void
  envEntries: EnvEntry[]
  setEnvEntries: React.Dispatch<React.SetStateAction<EnvEntry[]>>
  visibleEnvIds: Set<string>
  setVisibleEnvIds: React.Dispatch<React.SetStateAction<Set<string>>>
  setRouteEnabled: (v: boolean) => void
  localAgentIds: string[]
  setLocalAgentIds: (v: string[]) => void
  showLocalChildOutput: boolean
  setShowLocalChildOutput: (v: boolean) => void
  showRemoteChildOutput: boolean
  setShowRemoteChildOutput: (v: boolean) => void
  remoteEntries: RemoteEntry[]
  setRemoteEntries: React.Dispatch<React.SetStateAction<RemoteEntry[]>>
  resolvedWorkDir: { path: string; scmType: 'p4' | 'git' | null }
  showApiKey: boolean
  setShowApiKey: (v: boolean) => void
}

export function ConfigTab({
  form,
  agentId,
  agent,
  skillBindingScope,
  skillBindingOwnerId,
  providersList,
  providerChainEntries,
  setProviderChainEntries,
  providerLocked = false,
  skillsList,
  skillGroupsList,
  mcpServersList,
  scmSourcesList,
  selectedSkills,
  setSelectedSkills,
  selectedSkillGroupIds,
  setSelectedSkillGroupIds,
  selectedMcpServerIds,
  setSelectedMcpServerIds,
  kbDocumentsList,
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
  showApiKey,
  setShowApiKey,
}: ConfigTabProps) {
  const { t } = useTranslation()
  const { register, watch, setValue } = form

  const watchedProviderId = providerChainEntries[0]?.providerId ?? watch('providerId')
  const [showOauthToken, setShowOauthToken] = useState(false)
  const [draggingProviderId, setDraggingProviderId] = useState<string | null>(null)
  const [providerDragOffsetY, setProviderDragOffsetY] = useState(0)
  const [providerDragTransforms, setProviderDragTransforms] = useState<Record<string, number>>({})
  const providerListRef = useRef<HTMLDivElement | null>(null)
  const providerItemRefs = useRef(new Map<string, HTMLDivElement>())
  const providerChainEntriesRef = useRef(providerChainEntries)
  const providerDragFrameRef = useRef<number | null>(null)
  const providerPendingOffsetYRef = useRef(0)
  const providerDragRef = useRef<{
    id: string
    startIndex: number
    currentIndex: number
    startTop: number
    activeHeight: number
    gap: number
    pointerOffsetY: number
    lastClientY: number
    rects: Array<{ id: string; index: number; top: number; height: number }>
  } | null>(null)
  const watchedReadOnly = watch('readOnly')
  const watchedForce = watch('force')
  const watchedCleanResult = watch('cleanResult')
  const watchedMaxConcurrency = watch('maxConcurrency')
  const watchedTimeoutMinutes = watch('timeoutMinutes')
  const watchedMaxRetries = watch('maxRetries')
  const watchedTotalTimeoutMinutes = watch('totalTimeoutMinutes')
  const watchedSystemPrompt = watch('systemPrompt') ?? ''

  providerChainEntriesRef.current = providerChainEntries

  const envKeysForEditor = useMemo(
    () => envEntries.filter((e) => e.key.trim()).map((e) => e.key.trim()),
    [envEntries],
  )

  const undefinedVars = useMemo(
    () => findUndefinedVariables(watchedSystemPrompt, envKeysForEditor),
    [watchedSystemPrompt, envKeysForEditor],
  )

  // Route: fetch published A2A agents for local selection. This cannot be gated
  // on "routing is enabled" any more — enablement is now derived from having
  // targets, so gating on it would leave the picker empty for exactly the agent
  // that has none yet, i.e. the one trying to add its first target.
  const { data: agentsResult } = useAllAgents()
  const publishedA2aAgents = useMemo(
    () =>
      (agentsResult?.data ?? []).filter(
        (a) =>
          a.id !== agentId &&
          a.publishStatus === 'published' &&
          (a.publishChannels as string[] | undefined)?.includes('a2a'),
      ),
    [agentsResult, agentId],
  )

  const { data: currentUser } = useCurrentUser()
  const isAdmin = currentUser?.role === 'admin'

  const filteredMcpServersList = useMemo(
    () =>
      mcpServersList?.filter((s) => {
        if (INTERNAL_MCP_NAMES.has(s.name)) return false
        if (ADMIN_MCP_NAMES.has(s.name) && !isAdmin) return false
        return true
      }),
    [mcpServersList, isAdmin],
  )

  // Selected servers that `McpServerTools` actually renders. stdio servers
  // expose no tool list, so they must not count toward showing the container.
  const serversWithTools = useMemo(
    () =>
      selectedMcpServerIds.flatMap((id) => {
        const server = filteredMcpServersList?.find((s) => s.id === id)
        if (!server) return []
        return mcpServerHasToolPreview(server.type) ? [server] : []
      }),
    [selectedMcpServerIds, filteredMcpServersList],
  )

  // `routeEnabled` is no longer a user-toggled flag: routing is enabled exactly
  // when targets are configured. Derive it from the same helper `RouteSection`
  // uses, so the Provider/MCP compatibility warning keeps firing for
  // route-backed capabilities and cannot disagree with the routing card.
  const routeEnabled = hasConfiguredRouteTargets({ localAgentIds, remoteEntries })
  const hasMcpBackedCapabilities = useMemo(
    () =>
      hasConfiguredMcpBackedCapabilities({
        mcpServerIds: selectedMcpServerIds,
        routeEnabled,
        localAgentIds,
        remoteEntries,
      }),
    [selectedMcpServerIds, routeEnabled, localAgentIds, remoteEntries],
  )
  const mcpUnsupportedProviderNames = useMemo(
    () =>
      providersWithoutMcpDelivery(providerChainEntries, providersList, hasMcpBackedCapabilities),
    [providerChainEntries, providersList, hasMcpBackedCapabilities],
  )

  const addRemoteEntry = useCallback(() => {
    setRemoteEntries((prev) => [
      ...prev,
      {
        id: nextRemoteEntryId(),
        name: '',
        url: '',
        connectionMode: 'agent_card',
        protocolVersion: '1.0',
        callerProvenance: false,
        description: '',
        apiKey: '',
        showApiKey: false,
      },
    ])
  }, [setRemoteEntries])

  const updateRemoteEntry = useCallback(
    (id: string, field: keyof RemoteEntry, value: string | boolean) => {
      setRemoteEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)))
    },
    [setRemoteEntries],
  )

  const removeRemoteEntry = useCallback(
    (id: string) => {
      setRemoteEntries((prev) => prev.filter((e) => e.id !== id))
    },
    [setRemoteEntries],
  )

  const addProviderEntry = useCallback(() => {
    setProviderChainEntries((prev) => {
      // The button is disabled at the cap; this guards the state update itself so
      // the chain can never exceed what the server-side schema accepts.
      if (prev.length >= PROVIDER_CHAIN_MAX) return prev
      return [
        ...prev,
        {
          id: nextProviderEntryId(),
          providerId: null,
          model: '',
          authMode: 'apiKey',
          authHeaderStyle: 'x-api-key',
          providerApiKey: '',
          providerBaseUrl: '',
          providerOauthToken: '',
          enabled: true,
          expanded: true,
        },
      ]
    })
  }, [setProviderChainEntries])

  const updateProviderEntry = useCallback(
    (id: string, patch: Partial<ProviderChainEntry>) => {
      setProviderChainEntries((prev) =>
        prev.map((entry) => (entry.id === id ? applyProviderEntryPatch(entry, patch) : entry)),
      )
    },
    [setProviderChainEntries],
  )

  const probeMutation = useProbeModels()

  /** Probes models for one chain entry and keeps failures local to that entry. */
  const probeModelsForEntry = useCallback(
    async (entry: ProviderChainEntry, provider: ProviderDto | undefined) => {
      if (!provider) return

      const { request, missingFields, maskedFields, unsupportedAuthMode } = buildProbeModelsRequest(
        provider,
        entry,
      )
      if (!request) {
        if (unsupportedAuthMode) {
          updateProviderEntry(entry.id, {
            probeError: t('agentDetail.probeUnsupportedAuthMode', {
              provider: provider.name,
            }),
          })
        } else if (maskedFields?.length) {
          updateProviderEntry(entry.id, { probeError: t('agentDetail.probeMaskedCredentials') })
        } else if (missingFields.includes('baseUrl')) {
          updateProviderEntry(entry.id, { probeError: t('agentDetail.probeMissingBaseOrKey') })
        } else if (missingFields.includes('oauthToken')) {
          updateProviderEntry(entry.id, { probeError: t('agentDetail.probeMissingOauthToken') })
        } else if (missingFields.includes('apiKey')) {
          updateProviderEntry(entry.id, { probeError: t('agentDetail.probeMissingApiKey') })
        }
        return
      }

      updateProviderEntry(entry.id, {
        probing: true,
        probeError: undefined,
        probeErrorCode: undefined,
      })
      try {
        const result = await probeMutation.mutateAsync(request)
        if (result.error) {
          updateProviderEntry(entry.id, {
            probing: false,
            probeError: result.error,
            probeErrorCode: result.code,
            dynamicModels: undefined,
            modelCapabilities: undefined,
            fastModeAvailability: undefined,
          })
        } else {
          updateProviderEntry(entry.id, {
            probing: false,
            probeError: undefined,
            probeErrorCode: undefined,
            dynamicModels: result.models,
            modelCapabilities: result.modelCapabilities,
            fastModeAvailability: result.fastMode,
          })
        }
      } catch (e) {
        updateProviderEntry(entry.id, {
          probing: false,
          probeError: e instanceof Error ? e.message : String(e),
          probeErrorCode: undefined,
          dynamicModels: undefined,
          modelCapabilities: undefined,
          fastModeAvailability: undefined,
        })
      }
    },
    [probeMutation, t, updateProviderEntry],
  )

  /** Automatically probes entries whose manifest opts into mount-time discovery. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: probeModelsForEntry is captured but invocation gated by entry state checks above
  useEffect(() => {
    for (const entry of providerChainEntries) {
      const provider = providersList?.find((p) => p.id === entry.providerId)
      if (!provider) continue
      const policy = modelProbePolicy(provider.capabilities, entry.authMode)
      if (policy !== 'autoOnMount') continue
      if (entry.dynamicModels !== undefined) continue
      if (entry.probing) continue
      if (entry.probeError) continue // 失败过就不再自动重试，等用户手动改字段触发 reset
      void probeModelsForEntry(entry, provider)
    }
  }, [providerChainEntries, providersList])

  const removeProviderEntry = useCallback(
    (id: string) => {
      setProviderChainEntries((prev) => {
        const next = prev.filter((entry) => entry.id !== id)
        return next.length > 0 ? next : prev
      })
    },
    [setProviderChainEntries],
  )

  const setProviderDragOffsetOnFrame = useCallback((offsetY: number) => {
    providerPendingOffsetYRef.current = offsetY
    if (providerDragFrameRef.current !== null) return

    providerDragFrameRef.current = window.requestAnimationFrame(() => {
      providerDragFrameRef.current = null
      setProviderDragOffsetY(providerPendingOffsetYRef.current)
    })
  }, [])

  const commitProviderMove = useCallback(
    (fromId: string, toIndex: number) => {
      setProviderChainEntries((prev) => {
        const from = prev.findIndex((entry) => entry.id === fromId)
        if (from < 0 || toIndex < 0 || toIndex >= prev.length || from === toIndex) return prev
        const next = [...prev]
        const [item] = next.splice(from, 1)
        next.splice(toIndex, 0, item)
        return next
      })
    },
    [setProviderChainEntries],
  )

  const syncProviderDragOffset = useCallback(
    (clientY: number) => {
      const drag = providerDragRef.current
      const listNode = providerListRef.current
      if (!drag || !listNode) return null

      const listRect = listNode.getBoundingClientRect()
      const minTop = listRect.top
      const maxTop = Math.max(listRect.top, listRect.bottom - drag.activeHeight)
      const desiredTop = Math.min(Math.max(clientY - drag.pointerOffsetY, minTop), maxTop)
      const nextOffsetY = desiredTop - drag.startTop

      setProviderDragOffsetOnFrame(nextOffsetY)
      return { activeCenterY: desiredTop + drag.activeHeight / 2 }
    },
    [setProviderDragOffsetOnFrame],
  )

  const handleProviderPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = providerDragRef.current
      const listNode = providerListRef.current
      if (!drag || !listNode) return

      event.preventDefault()
      const listRect = listNode.getBoundingClientRect()
      if (event.clientY < listRect.top || event.clientY > listRect.bottom) return
      drag.lastClientY = event.clientY
      if (!syncProviderDragOffset(event.clientY)) return

      let nextIndex = drag.startIndex
      for (const rect of drag.rects) {
        if (rect.id === drag.id) continue
        const midpointY = rect.top + rect.height / 2
        if (rect.index > drag.startIndex && event.clientY > midpointY) {
          nextIndex = rect.index
        }
        if (rect.index < drag.startIndex && event.clientY < midpointY) {
          nextIndex = Math.min(nextIndex, rect.index)
        }
      }
      if (nextIndex === drag.currentIndex) return

      drag.currentIndex = nextIndex
      const transforms: Record<string, number> = {}
      const shift = drag.activeHeight + drag.gap
      for (const rect of drag.rects) {
        if (rect.id === drag.id) continue
        if (
          drag.startIndex < nextIndex &&
          rect.index > drag.startIndex &&
          rect.index <= nextIndex
        ) {
          transforms[rect.id] = -shift
        } else if (
          drag.startIndex > nextIndex &&
          rect.index >= nextIndex &&
          rect.index < drag.startIndex
        ) {
          transforms[rect.id] = shift
        }
      }
      setProviderDragTransforms(transforms)
    },
    [syncProviderDragOffset],
  )

  const finishProviderPointerDrag = useCallback(() => {
    if (providerDragFrameRef.current !== null) {
      window.cancelAnimationFrame(providerDragFrameRef.current)
      providerDragFrameRef.current = null
    }
    const drag = providerDragRef.current
    providerDragRef.current = null
    setDraggingProviderId(null)
    setProviderDragOffsetY(0)
    setProviderDragTransforms({})
    if (drag) commitProviderMove(drag.id, drag.currentIndex)
    document.removeEventListener('pointermove', handleProviderPointerMove)
    document.removeEventListener('pointerup', finishProviderPointerDrag)
    document.removeEventListener('pointercancel', finishProviderPointerDrag)
  }, [commitProviderMove, handleProviderPointerMove])

  const startProviderPointerDrag = useCallback(
    (entryId: string, event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return
      const activeNode = providerItemRefs.current.get(entryId)
      if (!activeNode) return

      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      const activeRect = activeNode.getBoundingClientRect()
      const entries = providerChainEntriesRef.current
      const startIndex = entries.findIndex((entry) => entry.id === entryId)
      if (startIndex < 0) return
      const rects = entries.flatMap((entry, index) => {
        const node = providerItemRefs.current.get(entry.id)
        if (!node) return []
        const rect = node.getBoundingClientRect()
        return [{ id: entry.id, index, top: rect.top, height: rect.height }]
      })
      const nextRect = rects[startIndex + 1]
      const previousRect = rects[startIndex - 1]
      const gap = nextRect
        ? Math.max(0, nextRect.top - (activeRect.top + activeRect.height))
        : previousRect
          ? Math.max(0, activeRect.top - (previousRect.top + previousRect.height))
          : 12
      providerDragRef.current = {
        id: entryId,
        startIndex,
        currentIndex: startIndex,
        startTop: activeRect.top,
        activeHeight: activeRect.height,
        gap,
        pointerOffsetY: event.clientY - activeRect.top,
        lastClientY: event.clientY,
        rects,
      }
      setDraggingProviderId(entryId)
      setProviderDragOffsetY(0)
      setProviderDragTransforms({})
      document.addEventListener('pointermove', handleProviderPointerMove, { passive: false })
      document.addEventListener('pointerup', finishProviderPointerDrag)
      document.addEventListener('pointercancel', finishProviderPointerDrag)
    },
    [finishProviderPointerDrag, handleProviderPointerMove],
  )

  useEffect(
    () => () => {
      document.removeEventListener('pointermove', handleProviderPointerMove)
      document.removeEventListener('pointerup', finishProviderPointerDrag)
      document.removeEventListener('pointercancel', finishProviderPointerDrag)
    },
    [finishProviderPointerDrag, handleProviderPointerMove],
  )

  const selectedProvider = useMemo(
    () => providersList?.find((p) => p.id === watchedProviderId) ?? null,
    [providersList, watchedProviderId],
  )
  const executionOptions = selectedProvider?.capabilities.executionOptions ?? []
  const supportsAdvancedOptions = executionOptions.length > 0
  const showReadOnlyOption = executionOptions.includes('readOnly')
  const showForceOption = executionOptions.includes('force')
  const showCleanResultOption = executionOptions.includes('cleanResult')

  return (
    <div className="space-y-5">
      {/* Description */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <Label htmlFor="description" className="text-sm font-medium text-foreground">
            {t('agentDetail.description')}
          </Label>
          <Textarea
            id="description"
            {...register('description')}
            placeholder={t('agentDetail.descriptionPlaceholder')}
            rows={2}
            className="resize-none"
          />
        </CardContent>
      </Card>

      {/* Provider */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Blocks className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <Label className="text-sm font-medium text-foreground">
                {t('agentDetail.provider')}
              </Label>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={providerChainEntries.length >= PROVIDER_CHAIN_MAX}
              title={
                providerChainEntries.length >= PROVIDER_CHAIN_MAX
                  ? t('agentDetail.providerChainMaxReached', { max: PROVIDER_CHAIN_MAX })
                  : undefined
              }
              onClick={addProviderEntry}
              data-testid="provider-chain-add"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              {t('common.add')}
            </Button>
          </div>

          {mcpUnsupportedProviderNames.length > 0 && (
            <div
              role="alert"
              data-testid="provider-mcp-unsupported"
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2.5 text-sm"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <div>
                <p className="font-medium text-warning">
                  {t('agentDetail.providerMcpUnsupportedTitle')}
                </p>
                <p className="mt-0.5 text-xs text-warning">
                  {t('agentDetail.providerMcpUnsupportedDescription', {
                    providers: mcpUnsupportedProviderNames.join(', '),
                  })}
                </p>
              </div>
            </div>
          )}

          <div
            ref={providerListRef}
            className="space-y-3 select-none [&_*]:[-webkit-user-drag:none]"
            onDragStartCapture={(event) => event.preventDefault()}
            data-testid="provider-chain-list"
          >
            {providerChainEntries.map((entry, index) => {
              const provider = providersList?.find((p) => p.id === entry.providerId) ?? null
              const capabilities = provider?.capabilities
              const credentialFields = visibleCredentialFieldsFor(capabilities, entry.authMode)
              const authModes = capabilities?.authModes ?? ['apiKey', 'oauth', 'localSession']
              const visibleAuthModes = authModes.includes(entry.authMode)
                ? authModes
                : [entry.authMode, ...authModes]
              const loginCommand = capabilities?.localSessionLoginCommand ?? ''
              const probeErrorTranslation =
                provider && entry.probeError
                  ? resolveModelProbeErrorTranslation({
                      providerName: provider.name,
                      capabilities,
                      authMode: entry.authMode,
                      code: entry.probeErrorCode,
                      error: entry.probeError,
                    })
                  : null
              const isTraeProvider = provider?.kind === 'trae'
              const usesProxyBaseUrlPlaceholder =
                provider?.kind === 'codex' || provider?.kind === 'pi'
              const isApiKeyRequired = credentialFieldIsRequired(
                capabilities,
                entry.authMode,
                'apiKey',
              )
              const isBaseUrlRequired = credentialFieldIsRequired(
                capabilities,
                entry.authMode,
                'baseUrl',
              )
              const isOauthTokenRequired = credentialFieldIsRequired(
                capabilities,
                entry.authMode,
                'oauthToken',
              )
              const probePolicy = modelProbePolicy(capabilities, entry.authMode)
              // The model list comes solely from probing the CLI with these
              // credentials. There is no stored catalog to fall back to: a
              // hand-maintained list drifts from what the account can actually
              // run, and picking a model the credential cannot use fails at
              // spawn time rather than here.
              const availableModels = entry.dynamicModels ?? []
              // 已有 entry.model 但不在 options 里时，临时插入（保证 Antd Select 能显示）
              const modelSelectOptions: { value: string; label: string }[] = (() => {
                const base = availableModels.map((m) => ({ value: m, label: m }))
                if (entry.model && !availableModels.includes(entry.model)) {
                  base.unshift({ value: entry.model, label: entry.model })
                }
                return base
              })()
              // The level set follows the MODEL, not the Provider, so it is read
              // from this entry's probe result for whichever model is selected.
              const effortState = reasoningEffortSelectState(
                capabilities,
                entry.modelCapabilities,
                entry.model,
              )
              const showFastModeOption = Boolean(capabilities?.fastMode)
              // Blocked only on a definite "no" from the vendor for these
              // credentials. Absent availability means the question was never
              // answered, and that is not evidence.
              const fastModeBlocked = entry.fastModeAvailability?.available === false
              const needProbeManual = probePolicy === 'manualButton'
              const needProbeAuto = probePolicy === 'autoOnMount'
              // The auto-probe effect deliberately does not retry after a failure,
              // so an autoOnMount Provider whose first probe failed (an
              // uninstalled CLI is the default state) would otherwise be stuck:
              // no refresh button, and for credential-less kinds like Kimi /
              // OpenCode / Pi no field to edit that would re-arm it. Offering the
              // button on failure is the only recovery path left now that the
              // static fallback list is gone.
              // `entry.probing` is part of the condition on purpose: probing
              // clears probeError first, so keying only off probeError would
              // unmount the button — spinner and all — for the whole request,
              // making a deliberate retry look like the control vanished.
              const showProbeButton =
                needProbeManual || Boolean(entry.probeError) || Boolean(entry.probing)
              // A failed probe must not hard-block configuration: with the static
              // fallback gone there is no other way to name a model, so the
              // Select stays open (free entry, see `mode` below) once an error
              // has been reported rather than leaving the operator stuck.
              const modelSelectDisabled =
                (needProbeManual || needProbeAuto) &&
                !entry.dynamicModels &&
                !entry.probing &&
                !entry.probeError
              const authModeLabel =
                entry.authMode === 'localSession'
                  ? t('agentDetail.authModeLocalSession')
                  : entry.authMode === 'oauth'
                    ? t('agentDetail.authModeOauth')
                    : t('agentDetail.authModeApiKey')
              const baseUrlHost = (() => {
                if (!entry.providerBaseUrl) return ''
                try {
                  return new URL(entry.providerBaseUrl).host
                } catch {
                  return entry.providerBaseUrl.replace(/^https?:\/\//, '').split('/')[0] ?? ''
                }
              })()
              const isDragging = draggingProviderId === entry.id
              const style: React.CSSProperties | undefined = isDragging
                ? {
                    position: 'relative',
                    zIndex: 30,
                    backgroundColor: 'var(--color-card)',
                    transform: `translate3d(0, ${providerDragOffsetY}px, 0)`,
                    transition: 'none',
                  }
                : providerDragTransforms[entry.id] !== undefined
                  ? {
                      position: 'relative',
                      zIndex: 0,
                      transform: `translate3d(0, ${providerDragTransforms[entry.id]}px, 0)`,
                      transition: 'transform 180ms cubic-bezier(0.2, 0, 0, 1)',
                    }
                  : undefined
              return (
                <div
                  key={entry.id}
                  ref={(node) => {
                    if (node) {
                      providerItemRefs.current.set(entry.id, node)
                    } else {
                      providerItemRefs.current.delete(entry.id)
                    }
                  }}
                  style={style}
                  data-testid={`provider-chain-item-${index}`}
                  className={`rounded-md border bg-background transition-[background-color,border-color,box-shadow] duration-150 will-change-transform hover:border-primary/45 hover:bg-surface-hover ${
                    isDragging
                      ? 'relative z-10 border-primary/50 bg-card shadow-lg'
                      : 'border-border/60'
                  }`}
                >
                  {/* biome-ignore lint/a11y/useSemanticElements: the row contains nested interactive controls, so a native button would be invalid HTML. */}
                  <div
                    role="button"
                    tabIndex={0}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    onClick={(event) => {
                      const target = event.target as HTMLElement
                      if (target.closest('[data-provider-action]')) return
                      updateProviderEntry(entry.id, { expanded: !entry.expanded })
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        updateProviderEntry(entry.id, { expanded: !entry.expanded })
                      }
                    }}
                    aria-expanded={entry.expanded}
                    data-testid={`provider-chain-header-${index}`}
                  >
                    <button
                      type="button"
                      draggable={false}
                      onPointerDown={(event) => startProviderPointerDrag(entry.id, event)}
                      onClick={(event) => event.stopPropagation()}
                      className={`touch-none select-none text-muted-foreground hover:text-foreground ${
                        isDragging ? 'cursor-grabbing' : 'cursor-grab'
                      }`}
                      data-provider-action
                      data-testid={`provider-chain-drag-${index}`}
                      aria-label={t('agentDetail.dragProvider', { defaultValue: 'Drag provider' })}
                    >
                      <GripVertical className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="text-xs font-medium text-muted-foreground">
                        #{index + 1}
                      </span>
                      <span className="truncate text-sm font-medium text-foreground">
                        {provider?.name ?? t('agentDetail.providerPlaceholder')}
                      </span>
                      <Tag className="m-0 shrink-0 text-2xs">{authModeLabel}</Tag>
                      {baseUrlHost && (
                        <Tag className="m-0 max-w-[160px] truncate font-mono text-2xs">
                          {baseUrlHost}
                        </Tag>
                      )}
                      {entry.model && (
                        <span className="max-w-[180px] truncate font-mono text-xs text-muted-foreground">
                          {entry.model}
                        </span>
                      )}
                    </div>
                    <span role="presentation" data-provider-action>
                      <Switch
                        checked={entry.enabled}
                        onCheckedChange={(checked) =>
                          updateProviderEntry(entry.id, { enabled: checked })
                        }
                        aria-label={t('common.enabled')}
                      />
                    </span>
                    <span role="presentation" data-provider-action>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={providerChainEntries.length <= 1}
                        onClick={(event) => {
                          event.stopPropagation()
                          removeProviderEntry(entry.id)
                        }}
                        aria-label={t('common.delete')}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </span>
                  </div>

                  {entry.expanded && (
                    <div className="space-y-4 border-t border-border/60 px-3 py-3">
                      <Select
                        showSearch
                        allowClear={!(providerLocked && index === 0)}
                        disabled={providerLocked && index === 0}
                        placeholder={t('agentDetail.providerPlaceholder')}
                        value={entry.providerId || undefined}
                        data-testid={`provider-chain-provider-select-${index}`}
                        onChange={(val) => {
                          const providerChanged = (val ?? null) !== entry.providerId
                          const nextProvider = providersList?.find((p) => p.id === val)
                          updateProviderEntry(entry.id, {
                            providerId: val ?? null,
                            authMode: normalizeAuthMode(nextProvider?.capabilities, entry.authMode),
                            // Only on an actual Provider change: switching
                            // invalidates the probed list, and the previous model
                            // can no longer be validated against it. Re-selecting
                            // the same Provider must not wipe a valid selection.
                            ...(providerChanged
                              ? {
                                  authHeaderStyle: 'x-api-key',
                                  model: '',
                                  providerApiKey: '',
                                  providerBaseUrl: '',
                                  providerOauthToken: '',
                                }
                              : {}),
                          })
                          if (index === 0) {
                            setValue('providerId', val ?? null, { shouldDirty: true })
                          }
                        }}
                        filterOption={selectFilterOption}
                        options={providersList?.map((p) => ({ value: p.id, label: p.name }))}
                        optionRender={(option) => <span className="truncate">{option.label}</span>}
                        className="w-full [&_.ant-select-selector]:!min-h-9"
                        popupMatchSelectWidth
                        // 同模型框：provider 卡片的 will-change-transform 会困住浮层，挂到 body escape。
                        getPopupContainer={() => document.body}
                      />

                      {providerLocked && index === 0 && (
                        <div className="text-xs text-muted-foreground">
                          {t('agentDetail.providerLockedHint')}
                        </div>
                      )}

                      {provider?.checkScript && (
                        <div className="rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                          {t('agentDetail.check')}:{' '}
                          <code className="font-mono text-xs">{provider.checkScript}</code>
                        </div>
                      )}

                      <div className="space-y-2 pt-1">
                        <Label className="text-sm font-medium text-foreground flex items-center gap-1.5">
                          <Key className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                          {t('agentDetail.authMode')}
                        </Label>
                        <Radio.Group
                          value={entry.authMode}
                          data-testid={`provider-chain-auth-mode-${index}`}
                          onChange={(event) => {
                            const authMode = event.target.value as ProviderChainEntry['authMode']
                            updateProviderEntry(entry.id, {
                              authMode,
                              ...(authMode === 'localSession'
                                ? {
                                    providerApiKey: '',
                                    providerBaseUrl: '',
                                    providerOauthToken: '',
                                  }
                                : authMode === 'oauth'
                                  ? {
                                      providerApiKey: '',
                                      providerBaseUrl: '',
                                    }
                                  : {
                                      providerOauthToken: '',
                                    }),
                            })
                          }}
                          className="flex flex-row flex-wrap items-center gap-x-5 gap-y-2"
                        >
                          {visibleAuthModes.map((authMode) => (
                            <Radio key={authMode} value={authMode}>
                              {authMode === 'apiKey'
                                ? t('agentDetail.authModeApiKey')
                                : authMode === 'oauth'
                                  ? t('agentDetail.authModeOauth')
                                  : t('agentDetail.authModeLocalSession')}
                            </Radio>
                          ))}
                        </Radio.Group>
                      </div>

                      {entry.authMode === 'localSession' ? (
                        <p className="rounded-md border border-border/60 bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                          {t('agentDetail.authModeLocalSessionHint', { command: loginCommand })}
                        </p>
                      ) : credentialFields.includes('oauthToken') ? (
                        <div className="space-y-2">
                          <Label
                            className="text-sm font-medium text-foreground"
                            required={isOauthTokenRequired}
                          >
                            {t('agentDetail.oauthTokenLabel')}
                          </Label>
                          <div className="relative">
                            <Input
                              // 隐藏且已配置时显示 8 个圆点遮罩（点眼睛查看明文）；新输入则照常编辑。
                              value={
                                !showOauthToken && entry.providerOauthToken
                                  ? '••••••••'
                                  : entry.providerOauthToken
                              }
                              data-testid={`provider-chain-oauth-token-${index}`}
                              onChange={(event) =>
                                updateProviderEntry(entry.id, {
                                  providerOauthToken: event.target.value,
                                })
                              }
                              type={showOauthToken ? 'text' : 'password'}
                              readOnly={!showOauthToken && !!entry.providerOauthToken}
                              placeholder={t('agentDetail.oauthTokenPlaceholder')}
                              className="pr-10 font-mono text-sm"
                              autoComplete="new-password"
                              spellCheck={false}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="absolute right-0 top-0 h-full w-10 text-muted-foreground hover:text-foreground"
                              onClick={() => setShowOauthToken(!showOauthToken)}
                              aria-label={
                                showOauthToken
                                  ? t('agentDetail.hideOauthToken')
                                  : t('agentDetail.showOauthToken')
                              }
                            >
                              {showOauthToken ? (
                                <EyeOff className="h-4 w-4" />
                              ) : (
                                <Eye className="h-4 w-4" />
                              )}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="grid gap-3 md:grid-cols-2">
                          {provider?.kind === 'claude-code' && entry.authMode === 'apiKey' && (
                            <div className="space-y-2 md:col-span-2">
                              <Label className="text-sm font-medium text-foreground">
                                {t('agentDetail.authHeaderStyle')}
                              </Label>
                              <Select
                                value={entry.authHeaderStyle ?? 'x-api-key'}
                                data-testid={`provider-chain-auth-header-style-${index}`}
                                onChange={(value) =>
                                  updateProviderEntry(entry.id, { authHeaderStyle: value })
                                }
                                options={[
                                  {
                                    value: 'x-api-key',
                                    label: t('agentDetail.authHeaderStyleXApiKey'),
                                  },
                                  {
                                    value: 'bearer',
                                    label: t('agentDetail.authHeaderStyleBearer'),
                                  },
                                ]}
                                className="w-full"
                                getPopupContainer={() => document.body}
                              />
                              <p className="text-xs text-muted-foreground">
                                {t('agentDetail.authHeaderStyleHint')}
                              </p>
                            </div>
                          )}
                          {credentialFields.includes('apiKey') && (
                            <div className="space-y-2">
                              <Label
                                className="text-sm font-medium text-foreground"
                                required={isApiKeyRequired}
                              >
                                {capabilities?.apiKeyEnvVar === 'CURSOR_API_KEY'
                                  ? t('agentDetail.cursorApiKey')
                                  : t('agentDetail.apiKey')}
                              </Label>
                              <div className="relative">
                                <Input
                                  value={entry.providerApiKey}
                                  data-testid={`provider-chain-api-key-${index}`}
                                  onChange={(event) =>
                                    updateProviderEntry(entry.id, {
                                      providerApiKey: event.target.value,
                                    })
                                  }
                                  type={showApiKey ? 'text' : 'password'}
                                  placeholder={
                                    capabilities?.apiKeyEnvVar === 'CURSOR_API_KEY'
                                      ? t('agentDetail.cursorApiKeyPlaceholder')
                                      : t('agentDetail.apiKeyPlaceholder')
                                  }
                                  className="pr-10 font-mono text-sm"
                                  autoComplete="new-password"
                                  spellCheck={false}
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="absolute right-0 top-0 h-full w-10 text-muted-foreground hover:text-foreground"
                                  onClick={() => setShowApiKey(!showApiKey)}
                                  aria-label={
                                    showApiKey
                                      ? t('agentDetail.hideApiKey')
                                      : t('agentDetail.showApiKey')
                                  }
                                >
                                  {showApiKey ? (
                                    <EyeOff className="h-4 w-4" />
                                  ) : (
                                    <Eye className="h-4 w-4" />
                                  )}
                                </Button>
                              </div>
                            </div>
                          )}
                          {credentialFields.includes('baseUrl') && (
                            <div className="space-y-2">
                              <Label
                                className="text-sm font-medium text-foreground"
                                required={isBaseUrlRequired}
                              >
                                {isTraeProvider
                                  ? t('agentDetail.traeHostLabel')
                                  : t('agentDetail.baseUrl')}
                              </Label>
                              <Input
                                value={entry.providerBaseUrl}
                                data-testid={`provider-chain-base-url-${index}`}
                                onChange={(event) =>
                                  updateProviderEntry(entry.id, {
                                    providerBaseUrl: event.target.value,
                                  })
                                }
                                placeholder={
                                  isTraeProvider
                                    ? t('agentDetail.traeHostPlaceholder')
                                    : usesProxyBaseUrlPlaceholder
                                      ? t('agentDetail.proxyBaseUrlPlaceholder')
                                      : t('agentDetail.baseUrlPlaceholder')
                                }
                                className="font-mono text-sm"
                                autoComplete="off"
                                spellCheck={false}
                              />
                            </div>
                          )}
                        </div>
                      )}

                      {/* Model 块挪到凭证之后：先填凭证 → 再拉模型 → 选 model 的自然动线 */}
                      {provider && (
                        <div className="space-y-2 pt-1">
                          <div className="flex items-center justify-between gap-2">
                            <Label className="text-sm font-medium text-foreground">
                              {t('agentDetail.model')}
                            </Label>
                            {showProbeButton && (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={entry.probing}
                                onClick={() => probeModelsForEntry(entry, provider ?? undefined)}
                                data-testid={`provider-chain-probe-models-${index}`}
                                data-provider-action
                              >
                                <RefreshCw
                                  className={`h-3.5 w-3.5 ${entry.probing ? 'animate-spin' : ''}`}
                                  aria-hidden="true"
                                />
                                {entry.probing
                                  ? t('agentDetail.probeModelsLoading')
                                  : entry.dynamicModels
                                    ? t('agentDetail.probeModelsRefresh')
                                    : t('agentDetail.probeModelsButton')}
                              </Button>
                            )}
                          </div>
                          {/* 动态拉取成功 */}
                          {entry.dynamicModels && !entry.probeError && (
                            <div className="flex items-center gap-1.5 text-xs text-success">
                              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>
                                {t('agentDetail.probeModelsSuccess', {
                                  count: entry.dynamicModels.length,
                                })}
                              </span>
                            </div>
                          )}
                          {/* Probe 失败：按 error code 给容器登录态友好提示，未知码退回原始 error */}
                          {probeErrorTranslation && (
                            <div className="flex items-start gap-1.5 text-xs text-destructive">
                              <AlertTriangle
                                className="h-3.5 w-3.5 mt-0.5 shrink-0"
                                aria-hidden="true"
                              />
                              <span className="break-all">
                                {t(probeErrorTranslation.key, probeErrorTranslation.values)}
                              </span>
                            </div>
                          )}
                          {/* `mode="tags"` once a probe has failed: with the
                              static fallback list gone, an environment where the
                              probe can never succeed would otherwise leave the
                              operator unable to name a model at all. Single-value
                              is enforced in the handler (taking the last entry),
                              not with maxCount, which locks the field at the
                              limit. */}
                          <Select
                            showSearch
                            mode={entry.probeError ? 'tags' : undefined}
                            placeholder={
                              modelSelectDisabled
                                ? t('agentDetail.modelPlaceholderProbeFirst')
                                : t('agentDetail.modelPlaceholder')
                            }
                            disabled={modelSelectDisabled}
                            value={
                              entry.probeError
                                ? entry.model
                                  ? [entry.model]
                                  : undefined
                                : entry.model || undefined
                            }
                            data-testid={`provider-chain-model-select-${index}`}
                            onChange={(val) => {
                              const next = Array.isArray(val) ? (val[val.length - 1] ?? '') : val
                              // The options follow the model on their own; the
                              // selected level has to be re-checked against the
                              // new model, or a level it rejects stays selected
                              // and gets saved.
                              updateProviderEntry(entry.id, {
                                model: next,
                                reasoningEffort: reasoningEffortAfterModelChange(
                                  capabilities,
                                  entry.modelCapabilities,
                                  next,
                                  entry.reasoningEffort,
                                ),
                              })
                              if (index === 0) setValue('model', next, { shouldDirty: true })
                            }}
                            filterOption={selectFilterOption}
                            options={modelSelectOptions}
                            className="w-full [&_.ant-select-selector]:!min-h-9"
                            popupMatchSelectWidth
                            // 渲染到 body：provider 卡片容器带 will-change-transform 会建立 stacking
                            // context，把浮层困在卡片局部，导致下一张卡片的开关盖住下拉框。挂到 body
                            // 让浮层走 Antd 全局 z-index，escape 局部层叠上下文。
                            getPopupContainer={() => document.body}
                          />
                          {/* Reasoning effort sits beside the model it belongs
                              to: the legal levels come from the model, so a
                              chain that mixes Providers cannot share one value.
                              Four states, because an empty dropdown means two
                              very different things — see
                              `reasoningEffortSelectState`. */}
                          {effortState.kind !== 'unsupported' && (
                            <div className="space-y-1.5 pt-1">
                              <Label className="text-sm font-medium text-foreground">
                                {t('agentDetail.reasoningEffort')}
                              </Label>
                              <Select
                                allowClear
                                disabled={effortState.kind !== 'options'}
                                placeholder={
                                  effortState.kind === 'none'
                                    ? t('agentDetail.reasoningEffortNone')
                                    : effortState.kind === 'unknown'
                                      ? t('agentDetail.reasoningEffortUnknown')
                                      : t('agentDetail.reasoningEffortPlaceholder')
                                }
                                value={entry.reasoningEffort || undefined}
                                data-testid={`provider-chain-reasoning-effort-${index}`}
                                onChange={(val) =>
                                  updateProviderEntry(entry.id, {
                                    reasoningEffort: (val as string | undefined) || undefined,
                                  })
                                }
                                options={
                                  effortState.kind === 'options'
                                    ? effortState.options.map((option) => ({
                                        value: option.value,
                                        label:
                                          option.value === effortState.defaultValue
                                            ? t('agentDetail.reasoningEffortDefaultOption', {
                                                level: option.value,
                                              })
                                            : option.value,
                                        title: option.description,
                                      }))
                                    : []
                                }
                                className="w-full [&_.ant-select-selector]:!min-h-9"
                                popupMatchSelectWidth
                                getPopupContainer={() => document.body}
                              />
                              <p className="text-xs text-muted-foreground">
                                {effortState.kind === 'none'
                                  ? t('agentDetail.reasoningEffortNoneDesc')
                                  : effortState.kind === 'unknown'
                                    ? t('agentDetail.reasoningEffortUnknownDesc')
                                    : t('agentDetail.reasoningEffortDesc')}
                              </p>
                            </div>
                          )}
                          {/* Fast mode is a plain switch — nothing to discover.
                              Whether a run really gets the faster path depends
                              on the model, the plan and the endpoint, and the
                              run reports that itself. */}
                          {showFastModeOption && (
                            <div className="flex items-center gap-3 pt-1">
                              <Switch
                                checked={Boolean(entry.fastMode)}
                                disabled={fastModeBlocked}
                                onCheckedChange={(checked) =>
                                  updateProviderEntry(entry.id, { fastMode: checked })
                                }
                                aria-label={t('agentDetail.fastMode')}
                                data-testid={`provider-chain-fast-mode-${index}`}
                              />
                              <div className="space-y-0.5">
                                <Label className="text-sm font-medium text-foreground">
                                  {t('agentDetail.fastMode')}
                                </Label>
                                <p className="text-xs text-muted-foreground">
                                  {/* Only ever states a refusal the vendor actually
                                      issued for these credentials. When the probe
                                      said nothing the switch stays usable — a
                                      failed probe must not lock out a working
                                      feature. */}
                                  {fastModeBlocked
                                    ? t(
                                        `agentDetail.fastModeBlocked.${entry.fastModeAvailability?.reason ?? 'unknown'}`,
                                        {
                                          defaultValue: t('agentDetail.fastModeBlocked.unknown'),
                                        },
                                      )
                                    : t('agentDetail.fastModeDesc')}
                                </p>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Advanced options declared by the selected Provider capability manifest. */}
          {supportsAdvancedOptions && (
            <div className="space-y-3 rounded-lg border border-border/60 p-4">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {t('agentDetail.advancedOptions')}
              </p>

              {showReadOnlyOption && (
                <div className="flex items-center gap-3">
                  <Switch
                    checked={watchedReadOnly}
                    onCheckedChange={(checked) =>
                      setValue('readOnly', checked, { shouldDirty: true })
                    }
                    aria-label={t('agentDetail.askMode')}
                  />
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium text-foreground">
                      {t('agentDetail.askMode')}
                    </Label>
                    <p className="text-xs text-muted-foreground">{t('agentDetail.askModeDesc')}</p>
                  </div>
                </div>
              )}

              {showForceOption && (
                <div className="flex items-center gap-3">
                  <Switch
                    checked={watchedForce}
                    onCheckedChange={(checked) => setValue('force', checked, { shouldDirty: true })}
                    aria-label={t('agentDetail.forceMode')}
                  />
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium text-foreground">
                      {t('agentDetail.forceMode')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('agentDetail.forceModeDesc')}
                    </p>
                  </div>
                </div>
              )}

              {showCleanResultOption && (
                <div className="flex items-center gap-3">
                  <Switch
                    checked={watchedCleanResult}
                    onCheckedChange={(checked) =>
                      setValue('cleanResult', checked, { shouldDirty: true })
                    }
                    aria-label={t('agentDetail.cleanResult')}
                  />
                  <div className="space-y-0.5">
                    <Label className="text-sm font-medium text-foreground">
                      {t('agentDetail.cleanResult')}
                    </Label>
                    <p className="text-xs text-muted-foreground">
                      {t('agentDetail.cleanResultDesc')}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-3 text-xs">
            <Link
              to="/providers"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-interactive-foreground underline-offset-4 transition-colors hover:underline"
            >
              {t('agentDetail.manageProviders')}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
        </CardContent>
      </Card>

      {/* System Prompt */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Label htmlFor="systemPrompt" className="text-sm font-medium text-foreground">
              {t('agentDetail.systemPrompt')}
            </Label>
          </div>
          <PromptEditor
            value={watchedSystemPrompt}
            onChange={(val) => setValue('systemPrompt', val, { shouldDirty: true })}
            placeholder={t('agentDetail.systemPromptPlaceholder')}
            envKeys={envKeysForEditor}
          />
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t('agentDetail.templateVarsAvailable')}:</span>
            <code className="rounded bg-primary-subtle px-1.5 py-0.5 font-mono text-interactive-foreground">
              {'{{message}}'}
            </code>
            <code className="rounded bg-primary-subtle px-1.5 py-0.5 font-mono text-interactive-foreground">
              {'{{context}}'}
            </code>
            <code className="rounded bg-primary-subtle px-1.5 py-0.5 font-mono text-interactive-foreground">
              {'{{model}}'}
            </code>
            <code className="rounded bg-primary-subtle px-1.5 py-0.5 font-mono text-interactive-foreground">
              {'{{agent_provider}}'}
            </code>
            {envKeysForEditor.map((k) => (
              <code
                key={k}
                className="rounded bg-primary-subtle px-1.5 py-0.5 font-mono text-interactive-foreground"
              >{`{{${k}}}`}</code>
            ))}
          </div>
          {undefinedVars.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2.5 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <div>
                <p className="font-medium text-warning">
                  {t('agentDetail.templateVarsUndefined')}:{' '}
                  {undefinedVars.map((v) => (
                    <code
                      key={v}
                      className="mx-0.5 rounded bg-warning/10 px-1 py-0.5 font-mono text-xs text-warning"
                    >{`{{${v}}}`}</code>
                  ))}
                </p>
                <p className="mt-0.5 text-xs text-warning">
                  {t('agentDetail.templateVarsUndefinedHint')}
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Capability, workspace, routing & env pickers.
          No `items-start`: the default `stretch` is what makes every card in a
          row share the tallest card's height. Each card must therefore stretch
          internally too (`h-full` + a flex column), or it would render as a
          short card floating in a tall grid cell. */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
        {/* Skills & Skill Collections — merged picker */}
        <Card className="flex h-full flex-col">
          <CardContent className="flex flex-1 flex-col space-y-3 p-5">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Label className="text-sm font-medium text-foreground">
                  {t('agentDetail.skills')}
                </Label>
                {selectedSkillGroupIds.length + selectedSkills.length > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {selectedSkillGroupIds.length + selectedSkills.length}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('agentDetail.skillsDesc')}</p>
            </div>

            {(() => {
              const existingSkillIds = agent?.skills ?? []
              const existingGroupIds = agent?.skillGroupIds ?? []
              const pickerState = buildSkillBindingPickerState({
                skills: skillsList ?? [],
                groups: skillGroupsList ?? [],
                existingSkillIds,
                existingGroupIds,
                agentOwnerId: skillBindingOwnerId,
                scope: skillBindingScope,
              })
              // 前缀分拣：skg_ → 分组；skl_ → 单独 Skill
              const mergedValue = [...selectedSkillGroupIds, ...selectedSkills]

              const handleChange = (vals: string[]) => {
                const nextGroups = vals.filter((v) => v.startsWith('skg_'))
                const nextSkills = vals.filter((v) => v.startsWith('skl_'))
                if (
                  nextGroups.length !== selectedSkillGroupIds.length ||
                  nextGroups.some((v, i) => selectedSkillGroupIds[i] !== v)
                ) {
                  setSelectedSkillGroupIds(nextGroups)
                }
                if (
                  nextSkills.length !== selectedSkills.length ||
                  nextSkills.some((v, i) => selectedSkills[i] !== v)
                ) {
                  setSelectedSkills(nextSkills)
                }
              }

              const selectedGroupSet = new Set(selectedSkillGroupIds)

              // 统计每个分组的成员数量（来自 skillsList）
              const groupMemberCount = new Map<string, number>()
              for (const skill of skillsList ?? []) {
                const gid = (skill as { groupId?: string | null }).groupId ?? null
                if (gid) groupMemberCount.set(gid, (groupMemberCount.get(gid) ?? 0) + 1)
              }

              const groupOptions = pickerState.groups.map((g) => ({
                value: g.id,
                label: g.name,
                description: g.description,
                iconName: g.icon,
                memberCount: groupMemberCount.get(g.id) ?? 0,
                kind: 'group' as const,
              }))
              const knownGroupIds = new Set(pickerState.groups.map((group) => group.id))
              for (const id of pickerState.unavailableExistingGroupIds) {
                if (knownGroupIds.has(id)) continue
                groupOptions.push({
                  value: id,
                  label: id,
                  description: undefined,
                  iconName: undefined,
                  memberCount: 0,
                  kind: 'group',
                })
              }

              const skillOptions = pickerState.skills.map((skill) => {
                const skillGroupId = (skill as { groupId?: string | null }).groupId ?? null
                const owningGroup =
                  skillGroupId && selectedGroupSet.has(skillGroupId)
                    ? pickerState.groups.find((g) => g.id === skillGroupId)
                    : undefined
                return {
                  value: skill.id,
                  label: skill.name,
                  description: skill.description,
                  disabled: !!owningGroup,
                  owningGroupName: owningGroup?.name,
                  kind: 'skill' as const,
                }
              })
              const knownSkillIds = new Set(pickerState.skills.map((skill) => skill.id))
              for (const id of pickerState.unavailableExistingSkillIds) {
                if (knownSkillIds.has(id)) continue
                skillOptions.push({
                  value: id,
                  label: id,
                  description: undefined,
                  disabled: false,
                  owningGroupName: undefined,
                  kind: 'skill',
                })
              }

              const groupedOptions: Array<{ label: React.ReactNode; options: unknown[] }> = []
              if (groupOptions.length > 0) {
                groupedOptions.push({
                  label: (
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('agentDetail.skillGroups')}
                    </span>
                  ),
                  options: groupOptions,
                })
              }
              if (skillOptions.length > 0) {
                groupedOptions.push({
                  label: (
                    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t('agentDetail.individualSkills')}
                    </span>
                  ),
                  options: skillOptions,
                })
              }

              return (
                <Select
                  mode="multiple"
                  showSearch
                  placeholder={t('agentDetail.skillsMergedPlaceholder')}
                  value={mergedValue}
                  onChange={handleChange}
                  filterOption={selectFilterOption}
                  options={groupedOptions}
                  optionRender={(option) => {
                    const data = option.data as {
                      description?: string
                      kind?: 'group' | 'skill'
                      iconName?: string
                      memberCount?: number
                      owningGroupName?: string
                    }
                    if (data.kind === 'group') {
                      const IconComp = resolveCollectionIcon(data.iconName)
                      return (
                        <div className="flex items-center gap-2 min-w-0 py-0.5">
                          <IconComp
                            className="h-4 w-4 text-muted-foreground shrink-0"
                            aria-hidden
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate text-sm">{option.label}</span>
                              <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                                {t('skills.groups.memberCount', { count: data.memberCount ?? 0 })}
                              </span>
                            </div>
                            {data.description && (
                              <span className="text-xs text-muted-foreground truncate block">
                                {data.description}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    }
                    const inner = (
                      <div className="flex items-center gap-2 min-w-0 py-0.5">
                        <Zap className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden />
                        <div className="flex-1 min-w-0">
                          <span className="truncate text-sm block">{option.label}</span>
                          {data.description && (
                            <span className="text-xs text-muted-foreground truncate block">
                              {data.description}
                            </span>
                          )}
                          {data.owningGroupName && (
                            <span className="block truncate text-xs text-warning">
                              {t('agentDetail.skillIncludedInGroup', {
                                name: data.owningGroupName,
                              })}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                    return data.owningGroupName ? (
                      <Tooltip
                        title={t('agentDetail.skillIncludedInGroup', {
                          name: data.owningGroupName,
                        })}
                        placement="right"
                      >
                        {inner}
                      </Tooltip>
                    ) : (
                      inner
                    )
                  }}
                  tagRender={(props) => {
                    const { value, label, closable, onClose } = props
                    const isGroup = typeof value === 'string' && value.startsWith('skg_')
                    const g = isGroup ? skillGroupsList?.find((x) => x.id === value) : undefined
                    const IconComp = isGroup ? resolveCollectionIcon(g?.icon) : Zap
                    return (
                      <Tag
                        closable={closable}
                        onClose={onClose}
                        className="!m-0 !mr-1 !my-0.5 flex items-center gap-1"
                      >
                        <IconComp className="h-3 w-3 text-muted-foreground" aria-hidden />
                        <span className="text-xs">{label}</span>
                      </Tag>
                    )
                  }}
                  popupRender={(menu) => (
                    <>
                      {menu}
                      <div className="border-t border-border px-3 py-2">
                        <Link
                          to="/skills"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-interactive-foreground underline-offset-4 transition-colors hover:underline"
                        >
                          {t('agentDetail.manageSkills')}
                          <ExternalLink className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      </div>
                    </>
                  )}
                  className="select-wrap-tags w-full"
                  popupMatchSelectWidth
                  getPopupContainer={() => document.body}
                />
              )
            })()}

            {(() => {
              // 展开：每个已选分组 → 该分组下的所有 Skill
              const selectedGroups = (selectedSkillGroupIds ?? [])
                .map((gid) => skillGroupsList?.find((g) => g.id === gid))
                .filter((g): g is NonNullable<typeof g> => !!g)
              const expanded = selectedGroups.flatMap((g) =>
                (skillsList ?? [])
                  .filter((s) => ((s as { groupId?: string | null }).groupId ?? null) === g.id)
                  .map((skill) => ({ group: g, skill })),
              )
              if (expanded.length === 0) return null
              return (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <span className="text-xs text-muted-foreground pr-1 self-center">
                    {t('agentDetail.skillGroupsExpanded')}
                  </span>
                  {expanded.map(({ skill, group }) => (
                    <Tag key={`${group.id}-${skill.id}`} className="!m-0" color="default">
                      <span className="text-xs">
                        {skill.name}
                        <span className="text-muted-foreground"> · {group.name}</span>
                      </span>
                    </Tag>
                  ))}
                </div>
              )
            })()}
          </CardContent>
        </Card>

        {/* MCP Servers */}
        <Card className="flex h-full flex-col">
          <CardContent className="flex flex-1 flex-col space-y-3 p-5">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Cable className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Label className="text-sm font-medium text-foreground">MCP</Label>
                {selectedMcpServerIds.length > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {selectedMcpServerIds.length}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('agentDetail.mcpServersDesc')}</p>
            </div>

            <Select
              mode="multiple"
              showSearch
              placeholder={t('agentDetail.mcpServersPlaceholder')}
              value={selectedMcpServerIds}
              onChange={(vals) => setSelectedMcpServerIds(vals)}
              filterOption={selectFilterOption}
              options={filteredMcpServersList
                ?.filter((s) => s.isEnabled)
                .map((server) => ({
                  value: server.id,
                  label: server.name,
                  description: server.description,
                  type: server.type,
                }))}
              optionRender={(option) => {
                const data = option.data as { description?: string; type?: string }
                return (
                  <div className="flex items-center gap-2 py-0.5">
                    <div className="flex flex-col min-w-0 overflow-hidden flex-1">
                      <span className="truncate text-sm">{option.label}</span>
                      {data.description && (
                        <span className="text-xs text-muted-foreground truncate block">
                          {data.description}
                        </span>
                      )}
                    </div>
                    {data.type && <Tag className="text-2xs shrink-0 m-0">{data.type}</Tag>}
                  </div>
                )
              }}
              popupRender={(menu) => (
                <>
                  {menu}
                  <div className="border-t border-border px-3 py-2">
                    <Link
                      to="/mcp-servers"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-interactive-foreground underline-offset-4 transition-colors hover:underline"
                    >
                      {t('agentDetail.manageMcpServers')}
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </div>
                </>
              )}
              className="select-wrap-tags w-full"
              popupMatchSelectWidth
              getPopupContainer={() => document.body}
            />

            {/* Gate on servers that actually render something: McpServerTools
                returns null for stdio, so keying off `selectedMcpServerIds`
                alone drew a bordered container with no content — a stray rule
                under the picker. */}
            {serversWithTools.length > 0 && (
              <div className="space-y-3 border-t border-border pt-3">
                {serversWithTools.map((server) => (
                  <McpServerTools key={server.id} server={server} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Knowledge Base */}
        <Card className="flex h-full flex-col">
          <CardContent className="flex flex-1 flex-col space-y-3 p-5">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <BookOpen className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Label className="text-sm font-medium text-foreground">
                  {t('agentDetail.kbDocuments')}
                </Label>
                {selectedKbDocumentIds.length > 0 && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {selectedKbDocumentIds.length}
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('agentDetail.kbDocumentsDesc')}</p>
            </div>

            <Select
              mode="multiple"
              showSearch
              placeholder={t('agentDetail.kbDocumentsPlaceholder')}
              value={selectedKbDocumentIds}
              onChange={(vals) => setSelectedKbDocumentIds(vals)}
              filterOption={selectFilterOption}
              options={kbDocumentsList?.map((doc) => ({
                value: doc.id,
                label: doc.name,
                description: doc.description,
              }))}
              optionRender={(option) => (
                <div className="flex flex-col min-w-0 overflow-hidden py-0.5">
                  <span className="truncate text-sm">{option.label}</span>
                  {(option.data as { description?: string }).description && (
                    <span className="text-xs text-muted-foreground truncate block">
                      {(option.data as { description?: string }).description}
                    </span>
                  )}
                </div>
              )}
              popupRender={(menu) => (
                <>
                  {menu}
                  <div className="border-t border-border px-3 py-2">
                    <Link
                      to="/kb-documents"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-interactive-foreground underline-offset-4 transition-colors hover:underline"
                    >
                      {t('agentDetail.manageKbDocuments')}
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </div>
                </>
              )}
              className="select-wrap-tags w-full"
              popupMatchSelectWidth
              getPopupContainer={() => document.body}
            />
          </CardContent>
        </Card>

        <WorkspaceSection
          workspaceType={workspaceType}
          setWorkspaceType={setWorkspaceType}
          scmSubType={scmSubType}
          setScmSubType={setScmSubType}
          selectedScmSourceId={selectedScmSourceId}
          setSelectedScmSourceId={setSelectedScmSourceId}
          scmSourcesList={scmSourcesList}
          resolvedWorkDir={resolvedWorkDir}
        />

        <RouteSection
          setRouteEnabled={setRouteEnabled}
          localAgentIds={localAgentIds}
          setLocalAgentIds={setLocalAgentIds}
          showLocalChildOutput={showLocalChildOutput}
          setShowLocalChildOutput={setShowLocalChildOutput}
          showRemoteChildOutput={showRemoteChildOutput}
          setShowRemoteChildOutput={setShowRemoteChildOutput}
          remoteEntries={remoteEntries}
          addRemoteEntry={addRemoteEntry}
          updateRemoteEntry={updateRemoteEntry}
          removeRemoteEntry={removeRemoteEntry}
          publishedA2aAgents={publishedA2aAgents}
        />

        <EnvSection
          envEntries={envEntries}
          setEnvEntries={setEnvEntries}
          visibleEnvIds={visibleEnvIds}
          setVisibleEnvIds={setVisibleEnvIds}
        />
      </div>

      {/* Other Settings */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Settings className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Label className="text-sm font-medium text-foreground">
              {t('agentDetail.otherSettings')}
            </Label>
          </div>

          <div className="grid grid-cols-[minmax(0,max-content)_auto] gap-x-3 gap-y-4 items-center">
            <div className="space-y-0.5 min-w-0">
              <Label className="text-sm font-medium text-foreground">
                {t('agentDetail.maxConcurrency')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('agentDetail.maxConcurrencyHint')}</p>
            </div>
            <InputNumber
              min={1}
              max={5}
              value={watchedMaxConcurrency}
              onChange={(val) => setValue('maxConcurrency', val ?? 1, { shouldDirty: true })}
              className="w-20 shrink-0"
            />
            <div className="space-y-0.5 min-w-0">
              <Label className="text-sm font-medium text-foreground">
                {t('agentDetail.timeoutMinutes')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('agentDetail.timeoutMinutesHint')}</p>
            </div>
            <InputNumber
              data-testid="agent-timeout-minutes"
              min={5}
              max={120}
              value={watchedTimeoutMinutes}
              onChange={(val) => setValue('timeoutMinutes', val ?? 10, { shouldDirty: true })}
              className="w-20 shrink-0"
            />
            <div className="space-y-0.5 min-w-0">
              <Label className="text-sm font-medium text-foreground">
                {t('agentDetail.maxRetries')}
              </Label>
              <p className="text-xs text-muted-foreground">{t('agentDetail.maxRetriesHint')}</p>
            </div>
            <InputNumber
              data-testid="agent-max-retries"
              min={0}
              max={5}
              value={watchedMaxRetries}
              onChange={(val) => setValue('maxRetries', val ?? 2, { shouldDirty: true })}
              className="w-20 shrink-0"
            />
            <div className="space-y-0.5 min-w-0">
              <Label className="text-sm font-medium text-foreground">
                {t('agentDetail.totalTimeoutMinutes')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('agentDetail.totalTimeoutMinutesHint')}
              </p>
            </div>
            <InputNumber
              data-testid="agent-total-timeout-minutes"
              min={5}
              max={600}
              value={watchedTotalTimeoutMinutes}
              placeholder={t('agentDetail.totalTimeoutMinutesUnlimited')}
              onChange={(val) =>
                setValue('totalTimeoutMinutes', val ?? null, { shouldDirty: true })
              }
              className="w-20 shrink-0"
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
