import {
  useAgent,
  useCloneAgent,
  useCreateAgent,
  useDeleteAgent,
  usePublishAgent,
  useResumeAgent,
  useStopAgent,
  useUpdateAgent,
} from '@/hooks/use-agents'
import type { PublishConfig } from '@/hooks/use-agents'
import { useCurrentUser } from '@/hooks/use-auth'
import { useFormDraft } from '@/hooks/use-form-draft'
import { useKbDocuments } from '@/hooks/use-kb-documents'
import { useMcpServers } from '@/hooks/use-mcp-servers'
import { useProviders } from '@/hooks/use-providers'
import { useScmSources } from '@/hooks/use-scm-sources'
import { useSettings } from '@/hooks/use-settings'
import { useSkillGroups } from '@/hooks/use-skill-groups'
import { useSkills } from '@/hooks/use-skills'
import { useUnsavedChanges } from '@/hooks/use-unsaved-changes'
import type { AgentTemplate } from '@/lib/agent-template-catalog'
import { message, modal } from '@/lib/antd-static'
import { formatApiError } from '@/lib/api-error'
import { confirm } from '@/lib/confirm'
import { idSuffix } from '@/lib/id-suffix'
import { safeSetItem } from '@/lib/safe-storage'
import { uniqueId } from '@/lib/utils'
import type {
  A2ARouteTarget,
  AgentPermission,
  ArtifactPolicy,
  CreateAgentInput,
  UpdateAgentInput,
} from '@a2wave/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { confirmDeleteAgent } from './confirm-delete-agent'
import { buildProviderChainSubmission, validateProviderChainSubmission } from './provider-chain'
import type { EnvEntry, FormData, ProviderChainEntry, RemoteEntry } from './types'
import { agentFormSchema } from './validation'

const SENSITIVE_PATTERNS = /PASSWORD|TOKEN|SECRET|KEY|PASSWD|CREDENTIAL/i

function resolvePersistedAuthMode(
  value: unknown,
  providerDefault: FormData['authMode'] | undefined,
): FormData['authMode'] {
  if (value === 'apiKey' || value === 'oauth' || value === 'localSession') return value
  return providerDefault ?? 'apiKey'
}

export function useAgentForm(
  id: string | undefined,
  isCreateMode: boolean,
  templateData?: AgentTemplate,
) {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const { data: agentSelection, isLoading } = useAgent(id ?? '')
  const agent = agentSelection?.data
  const permission: AgentPermission | undefined = agentSelection?.permission
  const { data: currentUser } = useCurrentUser()
  const skillBindingScope =
    agentSelection?.skillBindingScope ??
    (isCreateMode && currentUser?.role === 'admin' ? 'all-visible' : 'owner-or-shared')
  const persistedAgentOwnerId = (agent as (typeof agent & { userId?: string | null }) | undefined)
    ?.userId
  const skillBindingOwnerId = isCreateMode ? currentUser?.id : persistedAgentOwnerId
  const { data: providersList, isError: providersError } = useProviders()
  const { data: skillsResult } = useSkills({ pageSize: 500 })
  const { data: skillGroupsResult } = useSkillGroups({ pageSize: 500 })
  const { data: mcpServersResult } = useMcpServers({ pageSize: 100 })
  const { data: scmSourcesResult } = useScmSources()
  const { data: kbDocumentsResult } = useKbDocuments()
  const skillsList = skillsResult?.data
  const skillGroupsList = skillGroupsResult?.data
  const mcpServersList = mcpServersResult?.data
  const scmSourcesList = scmSourcesResult?.data
  const kbDocumentsList = kbDocumentsResult?.data
  const { data: settingsMap } = useSettings()

  const createAgent = useCreateAgent()
  const updateAgent = useUpdateAgent()
  const deleteAgent = useDeleteAgent()
  const cloneAgent = useCloneAgent()
  const publishAgent = usePublishAgent()
  const stopAgent = useStopAgent()
  const resumeAgent = useResumeAgent()

  const [showApiKey, setShowApiKey] = useState(false)
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [selectedSkillGroupIds, setSelectedSkillGroupIds] = useState<string[]>([])
  const [selectedMcpServerIds, setSelectedMcpServerIds] = useState<string[]>([])
  const [selectedKbDocumentIds, setSelectedKbDocumentIds] = useState<string[]>([])
  const [workspaceType, setWorkspaceType] = useState<'scm' | 'temp'>('temp')
  const [scmSubType, setScmSubType] = useState<'p4' | 'git'>('p4')
  const [selectedScmSourceId, setSelectedScmSourceId] = useState<string | null>(null)
  const [envEntries, setEnvEntries] = useState<EnvEntry[]>([])
  const [visibleEnvIds, setVisibleEnvIds] = useState<Set<string>>(new Set())
  const [routeEnabled, setRouteEnabled] = useState(false)
  const [localAgentIds, setLocalAgentIds] = useState<string[]>([])
  const [showLocalChildOutput, setShowLocalChildOutput] = useState(true)
  const [showRemoteChildOutput, setShowRemoteChildOutput] = useState(true)
  const [remoteEntries, setRemoteEntries] = useState<RemoteEntry[]>([])
  const [providerChainEntries, setProviderChainEntries] = useState<ProviderChainEntry[]>([
    {
      id: uniqueId(),
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
  ])
  const [saveVersion, setSaveVersion] = useState(0)

  const initializedAgentIdRef = useRef<string | null>(null)
  const initialSkillsRef = useRef<string[]>([])
  const initialSkillGroupIdsRef = useRef<string[]>([])
  const initialMcpServerIdsRef = useRef<string[]>([])
  const initialKbDocumentIdsRef = useRef<string[]>([])
  const initialWorkspaceTypeRef = useRef<'scm' | 'temp'>('temp')
  const initialScmSourceIdRef = useRef<string | null>(null)
  const initialEnvRef = useRef<Array<{ key: string; value: string; sensitive: boolean }>>([])
  const initialRouteEnabledRef = useRef(false)
  const initialLocalAgentIdsRef = useRef<string[]>([])
  const initialShowLocalChildOutputRef = useRef(true)
  const initialShowRemoteChildOutputRef = useRef(true)
  const initialRemoteEntriesRef = useRef<RemoteEntry[]>([])
  const initialProviderChainRef = useRef<ProviderChainEntry[]>([])

  const form = useForm<FormData>({
    resolver: zodResolver(agentFormSchema),
    defaultValues: {
      name: '',
      description: '',
      systemPrompt: '',
      icon: '🤖',
      providerApiKey: '',
      providerBaseUrl: '',
      providerOauthToken: '',
      authMode: 'apiKey',
      providerId: null,
      model: '',
      readOnly: false,
      force: true,
      cleanResult: false,
      maxConcurrency: 1,
      timeoutMinutes: 10,
      maxRetries: 2,
      totalTimeoutMinutes: null,
    },
  })

  const watchedName = form.watch('name')
  const workspacePath = settingsMap?.general?.workspacePath ?? '/tmp/a2wave-sandbox'

  const resolvedWorkDir = useMemo(() => {
    if (workspaceType === 'scm' && selectedScmSourceId) {
      const source = scmSourcesList?.find((s) => s.id === selectedScmSourceId)
      if (source) return { path: source.localPath, scmType: source.type as 'p4' | 'git' | null }
    }
    const suffix = idSuffix(id)
    const slug = (watchedName || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    const dirName = slug ? `${slug}-${suffix}` : suffix
    return { path: `${workspacePath}/${dirName}`, scmType: null }
  }, [workspaceType, selectedScmSourceId, scmSourcesList, id, watchedName, workspacePath])

  // biome-ignore lint/correctness/useExhaustiveDependencies: saveVersion is the explicit recompute trigger after a save settles
  const hasSelectionChanges = useMemo(() => {
    const sameItems = (a: string[], b: string[]) =>
      a.length === b.length && a.every((item) => b.includes(item))
    const sameEnv = (
      a: Array<{ key: string; value: string; sensitive: boolean }>,
      b: Array<{ key: string; value: string; sensitive: boolean }>,
    ) => {
      if (a.length !== b.length) return false
      const toMap = (arr: typeof a) =>
        new Map(arr.map((e) => [e.key, { value: e.value, sensitive: e.sensitive }]))
      const ma = toMap(a)
      const mb = toMap(b)
      for (const [k, v] of ma) {
        const o = mb.get(k)
        if (!o || o.value !== v.value || o.sensitive !== v.sensitive) return false
      }
      return true
    }
    const sameRemoteEntries = (a: RemoteEntry[], b: RemoteEntry[]) => {
      if (a.length !== b.length) return false
      return a.every(
        (entry, i) =>
          entry.name === b[i].name &&
          entry.url === b[i].url &&
          (entry.connectionMode ?? 'direct') === (b[i].connectionMode ?? 'direct') &&
          (entry.protocolVersion ?? '0.3') === (b[i].protocolVersion ?? '0.3') &&
          Boolean(entry.callerProvenance) === Boolean(b[i].callerProvenance) &&
          entry.description === b[i].description &&
          entry.apiKey === b[i].apiKey,
      )
    }
    const sameProviderChain = (a: ProviderChainEntry[], b: ProviderChainEntry[]) => {
      if (a.length !== b.length) return false
      return a.every((entry, i) => {
        const other = b[i]
        return (
          entry.providerId === other.providerId &&
          entry.model === other.model &&
          entry.reasoningEffort === other.reasoningEffort &&
          Boolean(entry.fastMode) === Boolean(other.fastMode) &&
          entry.authMode === other.authMode &&
          entry.providerApiKey === other.providerApiKey &&
          entry.providerBaseUrl === other.providerBaseUrl &&
          entry.providerOauthToken === other.providerOauthToken &&
          entry.enabled === other.enabled
        )
      })
    }
    return (
      !sameItems(initialSkillsRef.current, selectedSkills) ||
      !sameItems(initialSkillGroupIdsRef.current, selectedSkillGroupIds) ||
      !sameItems(initialMcpServerIdsRef.current, selectedMcpServerIds) ||
      !sameItems(initialKbDocumentIdsRef.current, selectedKbDocumentIds) ||
      workspaceType !== initialWorkspaceTypeRef.current ||
      selectedScmSourceId !== initialScmSourceIdRef.current ||
      !sameEnv(
        initialEnvRef.current,
        envEntries.map((e) => ({ key: e.key, value: e.value, sensitive: e.sensitive })),
      ) ||
      routeEnabled !== initialRouteEnabledRef.current ||
      !sameItems(initialLocalAgentIdsRef.current, localAgentIds) ||
      showLocalChildOutput !== initialShowLocalChildOutputRef.current ||
      showRemoteChildOutput !== initialShowRemoteChildOutputRef.current ||
      !sameRemoteEntries(initialRemoteEntriesRef.current, remoteEntries) ||
      !sameProviderChain(initialProviderChainRef.current, providerChainEntries)
    )
    // saveVersion forces recompute after save so the memo doesn't return a stale true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    selectedMcpServerIds,
    selectedSkills,
    selectedSkillGroupIds,
    selectedKbDocumentIds,
    workspaceType,
    selectedScmSourceId,
    envEntries,
    routeEnabled,
    localAgentIds,
    showLocalChildOutput,
    showRemoteChildOutput,
    remoteEntries,
    providerChainEntries,
    saveVersion,
  ])

  const blocker = useUnsavedChanges(
    !isCreateMode && (form.formState.isDirty || hasSelectionChanges),
  )

  const templateAppliedRef = useRef(false)
  // 新手模板：锁定 Provider（创建态不可切换）。templateData 在应用后会被清出
  // location.state，故用独立 state 持有，避免 UI 状态丢失。
  const [providerLocked, setProviderLocked] = useState(false)
  // 新手模板：创建成功后跳发布页（templateData 提交时已失效，用 ref 记住）。
  const gotoPublishAfterCreateRef = useRef(false)
  // 模板预填的产物策略（如网页应用模板默认开启自动分享）；提交时随 createData 一并落库。
  const templateArtifactPolicyRef = useRef<ArtifactPolicy | null>(null)

  const draftKey = id ? `agent-edit-${id}` : 'agent-create'
  // 凭证不落本地：表单层的 apiKey / oauthToken 排除出草稿。
  const { clearDraft: clearFormDraft } = useFormDraft(draftKey, form, {
    omit: ['providerApiKey', 'providerOauthToken'],
  })

  const extraDraftKeyRef = useRef(`draft-extra:${draftKey}`)
  extraDraftKeyRef.current = `draft-extra:${draftKey}`

  const extraStateRef = useRef({
    selectedSkills,
    selectedSkillGroupIds,
    selectedMcpServerIds,
    selectedKbDocumentIds,
    workspaceType,
    scmSubType,
    selectedScmSourceId,
    envEntries,
    providerChainEntries,
  })
  extraStateRef.current = {
    selectedSkills,
    selectedSkillGroupIds,
    selectedMcpServerIds,
    selectedKbDocumentIds,
    workspaceType,
    scmSubType,
    selectedScmSourceId,
    envEntries,
    providerChainEntries,
  }

  const extraRestoredRef = useRef(false)
  // clearDraft 后置位：阻止额外草稿的 cleanup/beforeunload save 复写回 localStorage。
  const extraDisabledRef = useRef(false)
  useEffect(() => {
    if (!isCreateMode || extraRestoredRef.current) return
    extraRestoredRef.current = true
    const saved = localStorage.getItem(extraDraftKeyRef.current)
    if (!saved) return
    try {
      const data = JSON.parse(saved)
      if (Array.isArray(data.selectedSkills)) setSelectedSkills(data.selectedSkills)
      if (Array.isArray(data.selectedSkillGroupIds))
        setSelectedSkillGroupIds(data.selectedSkillGroupIds)
      if (Array.isArray(data.selectedMcpServerIds))
        setSelectedMcpServerIds(data.selectedMcpServerIds)
      if (Array.isArray(data.selectedKbDocumentIds))
        setSelectedKbDocumentIds(data.selectedKbDocumentIds)
      if (data.workspaceType === 'scm' || data.workspaceType === 'temp')
        setWorkspaceType(data.workspaceType)
      if (data.scmSubType === 'p4' || data.scmSubType === 'git') setScmSubType(data.scmSubType)
      if (data.selectedScmSourceId !== undefined) setSelectedScmSourceId(data.selectedScmSourceId)
      if (Array.isArray(data.envEntries)) setEnvEntries(data.envEntries)
      if (Array.isArray(data.providerChainEntries))
        setProviderChainEntries(data.providerChainEntries)
    } catch {
      localStorage.removeItem(extraDraftKeyRef.current)
    }
  }, [isCreateMode])

  useEffect(() => {
    if (!isCreateMode) return
    // 额外状态（Provider 链/技能/MCP 等）不在 react-hook-form 内，需单独持久化。
    // 刷新/关闭不会触发 React cleanup，故同时挂 beforeunload 兜底，避免刷新后用户输入全丢。
    // 凭证不落本地：剔除 Provider 链里的 apiKey/oauthToken 与敏感环境变量值。
    const save = () => {
      // clearDraft 后不再写回：创建成功 clearDraft()→navigate() 卸载会触发此 cleanup save，
      // 若不门控会把刚清掉的额外草稿（Provider 链/技能/baseUrl 等）复写回来，污染下次创建。
      if (extraDisabledRef.current) return
      const s = extraStateRef.current
      const sanitized = {
        ...s,
        providerChainEntries: s.providerChainEntries.map((e) => ({
          ...e,
          providerApiKey: '',
          providerOauthToken: '',
        })),
        envEntries: s.envEntries.map((e) => (e.sensitive ? { ...e, value: '' } : e)),
      }
      safeSetItem(extraDraftKeyRef.current, JSON.stringify(sanitized))
    }
    window.addEventListener('beforeunload', save)
    return () => {
      window.removeEventListener('beforeunload', save)
      save()
    }
  }, [isCreateMode])

  const clearDraft = useCallback(() => {
    extraDisabledRef.current = true
    clearFormDraft()
    localStorage.removeItem(extraDraftKeyRef.current)
  }, [clearFormDraft])

  useEffect(() => {
    if (!isCreateMode || !templateData || templateAppliedRef.current) return
    // Wait for Providers before applying a template that binds a stable kind.
    // If the query fails, apply the remaining template fields without blocking creation.
    if (templateData.providerKind && !providersList && !providersError) return
    // 含预选技能的模板需等技能列表加载完成，否则按 name 匹配不到 id 会漏选。
    if ((templateData.skillNames?.length || templateData.builtinSkillNames?.length) && !skillsList)
      return
    templateAppliedRef.current = true

    form.reset(
      {
        name: templateData.name,
        description: templateData.description,
        systemPrompt: templateData.systemPrompt,
        icon: templateData.icon,
        providerApiKey: '',
        providerBaseUrl: '',
        providerOauthToken: '',
        authMode: 'apiKey',
        providerId: null,
        model: '',
        readOnly: templateData.readOnly,
        force: true,
        cleanResult: false,
        maxConcurrency: 1,
        timeoutMinutes: 10,
        maxRetries: 2,
        totalTimeoutMinutes: null,
      },
      { keepDefaultValues: false },
    )

    if (templateData.baseUrl) {
      form.setValue('providerBaseUrl', templateData.baseUrl, { shouldDirty: true })
    }
    if (templateData.model) {
      form.setValue('model', templateData.model, { shouldDirty: true })
    }

    setWorkspaceType(templateData.workspaceType ?? 'temp')
    setScmSubType(templateData.scmSubType ?? 'p4')
    setSelectedScmSourceId(null)

    if (templateData.providerKind && providersList) {
      const matched = providersList.find((p) => p.kind === templateData.providerKind)
      if (matched) {
        form.setValue('providerId', matched.id, { shouldDirty: true })
        setProviderChainEntries((prev) => [
          {
            ...(prev[0] ?? {
              id: uniqueId(),
              model: '',
              authMode: 'apiKey' as const,
              authHeaderStyle: 'x-api-key' as const,
              providerApiKey: '',
              providerBaseUrl: '',
              providerOauthToken: '',
              enabled: true,
              expanded: true,
            }),
            providerId: matched.id,
            authMode: matched.capabilities?.defaultAuthMode ?? 'apiKey',
            model: templateData.model ?? prev[0]?.model ?? '',
            providerBaseUrl: templateData.baseUrl ?? prev[0]?.providerBaseUrl ?? '',
          },
        ])
      }
    }

    // Resolve regular names using the visible list order, while platform templates
    // explicitly bind only trusted system-owned built-ins.
    if ((templateData.skillNames?.length || templateData.builtinSkillNames?.length) && skillsList) {
      const regularIds = (templateData.skillNames ?? [])
        .map((name) => skillsList.find((skill) => skill.name === name)?.id)
        .filter((id): id is string => !!id)
      const builtinIds = (templateData.builtinSkillNames ?? [])
        .map(
          (name) =>
            skillsList.find(
              (skill) =>
                skill.name === name && skill.userId == null && skill.visibility === 'all-users',
            )?.id,
        )
        .filter((id): id is string => !!id)
      const ids = [...new Set([...regularIds, ...builtinIds])]
      if (ids.length > 0) setSelectedSkills(ids)
    }

    templateArtifactPolicyRef.current = templateData.artifactPolicy ?? null

    setProviderLocked(!!templateData.lockProvider)
    gotoPublishAfterCreateRef.current = !!templateData.gotoPublishAfterCreate

    // Clear template from location state to prevent re-application on remount
    navigate(window.location.pathname, { replace: true, state: {} })
  }, [isCreateMode, templateData, providersList, providersError, skillsList, form, navigate])

  const discardChanges = () => {
    form.reset()
    setSelectedSkills(initialSkillsRef.current)
    setSelectedSkillGroupIds(initialSkillGroupIdsRef.current)
    setSelectedMcpServerIds(initialMcpServerIdsRef.current)
    setSelectedKbDocumentIds(initialKbDocumentIdsRef.current)
    setWorkspaceType(initialWorkspaceTypeRef.current)
    setSelectedScmSourceId(initialScmSourceIdRef.current)
    setEnvEntries(
      initialEnvRef.current.map((e) => ({
        id: uniqueId(),
        key: e.key,
        value: e.value,
        sensitive: e.sensitive,
      })),
    )
    setRouteEnabled(initialRouteEnabledRef.current)
    setLocalAgentIds(initialLocalAgentIdsRef.current)
    setShowLocalChildOutput(initialShowLocalChildOutputRef.current)
    setShowRemoteChildOutput(initialShowRemoteChildOutputRef.current)
    setRemoteEntries(initialRemoteEntriesRef.current)
    setProviderChainEntries(initialProviderChainRef.current)
  }

  // Initialize form from agent data
  useEffect(() => {
    if (!agent || initializedAgentIdRef.current === agent.id) return
    // Missing authMode inherits the Provider manifest default. Wait for the
    // Provider query so a valid local-session binding is never materialized as
    // apiKey merely because the two edit-page queries completed out of order.
    if (!providersList && !providersError) return

    const config = agent.config as Record<string, unknown> | null | undefined
    const modelFromConfig = config?.model
    const providersById = new Map((providersList ?? []).map((provider) => [provider.id, provider]))
    const legacyProviderId =
      ((agent as Record<string, unknown>).providerId as string | null | undefined) ?? null
    const legacyAuthMode = resolvePersistedAuthMode(
      (agent as Record<string, unknown>).authMode,
      legacyProviderId
        ? providersById.get(legacyProviderId)?.capabilities?.defaultAuthMode
        : undefined,
    )
    const nextProviderChain: ProviderChainEntry[] = (() => {
      const raw = config?.providerChain
      if (Array.isArray(raw) && raw.length > 0) {
        return raw.map((item: Record<string, unknown>) => {
          const providerId =
            typeof item.providerId === 'string' && item.providerId ? item.providerId : null
          return {
            id: typeof item.id === 'string' ? item.id : uniqueId(),
            providerId,
            model: typeof item.model === 'string' ? item.model : '',
            ...(typeof item.reasoningEffort === 'string' && item.reasoningEffort
              ? { reasoningEffort: item.reasoningEffort }
              : {}),
            ...(item.fastMode === true ? { fastMode: true } : {}),
            authMode: resolvePersistedAuthMode(
              item.authMode,
              providerId ? providersById.get(providerId)?.capabilities?.defaultAuthMode : undefined,
            ),
            authHeaderStyle: item.authHeaderStyle === 'bearer' ? 'bearer' : 'x-api-key',
            providerApiKey: typeof item.providerApiKey === 'string' ? item.providerApiKey : '',
            providerBaseUrl: typeof item.providerBaseUrl === 'string' ? item.providerBaseUrl : '',
            providerOauthToken:
              typeof item.providerOauthToken === 'string' ? item.providerOauthToken : '',
            enabled: item.enabled !== false,
            expanded: false,
          }
        })
      }
      return [
        {
          id: uniqueId(),
          providerId: legacyProviderId,
          model: typeof modelFromConfig === 'string' ? modelFromConfig : '',
          authMode: legacyAuthMode,
          authHeaderStyle: 'x-api-key',
          providerApiKey: ((agent as Record<string, unknown>).providerApiKey as string) || '',
          providerBaseUrl: ((agent as Record<string, unknown>).providerBaseUrl as string) || '',
          providerOauthToken:
            ((agent as Record<string, unknown>).providerOauthToken as string) || '',
          enabled: true,
          expanded: true,
        },
      ]
    })()
    form.reset({
      name: agent.name,
      description: agent.description || '',
      systemPrompt: agent.systemPrompt || '',
      icon: agent.icon || '🤖',
      providerApiKey: ((agent as Record<string, unknown>).providerApiKey as string) || '',
      providerBaseUrl: ((agent as Record<string, unknown>).providerBaseUrl as string) || '',
      providerOauthToken: ((agent as Record<string, unknown>).providerOauthToken as string) || '',
      authMode: legacyAuthMode,
      providerId: legacyProviderId,
      model: typeof modelFromConfig === 'string' ? modelFromConfig : '',
      readOnly: config?.readOnly !== undefined ? Boolean(config.readOnly) : false,
      force: config?.force !== undefined ? Boolean(config.force) : true,
      cleanResult: config?.cleanResult !== undefined ? Boolean(config.cleanResult) : false,
      maxConcurrency: ((agent as Record<string, unknown>).maxConcurrency as number) ?? 1,
      timeoutMinutes: typeof config?.timeoutMinutes === 'number' ? config.timeoutMinutes : 10,
      maxRetries: typeof config?.maxRetries === 'number' ? config.maxRetries : 2,
      totalTimeoutMinutes:
        typeof config?.totalTimeoutMinutes === 'number' ? config.totalTimeoutMinutes : null,
    })
    const nextSkills = agent.skills || []
    const nextSkillGroupIds = ((agent as Record<string, unknown>).skillGroupIds as string[]) ?? []
    const nextMcpServerIds = ((agent as Record<string, unknown>).mcpServerIds as string[]) ?? []
    const nextKbDocumentIds = ((agent as Record<string, unknown>).kbDocumentIds as string[]) ?? []
    const nextWorkspaceType =
      ((agent as Record<string, unknown>).workspaceType as 'scm' | 'temp') ?? 'temp'
    const nextScmSourceId =
      ((agent as Record<string, unknown>).scmSourceId as string | null) ?? null
    const agentEnv = (agent as Record<string, unknown>).env as
      | Record<string, { value: string; sensitive: boolean }>
      | null
      | undefined
    const nextEnvEntries = agentEnv
      ? Object.entries(agentEnv).map(([key, entry]) => ({
          id: uniqueId(),
          key,
          value: entry?.value ?? '',
          sensitive: entry?.sensitive ?? SENSITIVE_PATTERNS.test(key),
        }))
      : []
    const nextScmSubType: 'p4' | 'git' = (() => {
      if (nextWorkspaceType === 'scm' && nextScmSourceId && scmSourcesList) {
        const src = scmSourcesList.find((s) => s.id === nextScmSourceId)
        if (src) return src.type as 'p4' | 'git'
      }
      return 'p4'
    })()

    // Route targets initialization
    const routeTargets = (agent as Record<string, unknown>).a2aRouteTargets as
      | A2ARouteTarget[]
      | null
      | undefined
    const nextRouteEnabled = !!(
      routeTargets &&
      Array.isArray(routeTargets) &&
      routeTargets.length > 0
    )
    const nextLocalAgentIds = nextRouteEnabled
      ? routeTargets
          .filter((t): t is A2ARouteTarget & { type: 'local' } => t.type === 'local')
          .map((t) => t.agentId)
      : []
    let remoteCounter = 0
    const nextRemoteEntries: RemoteEntry[] = nextRouteEnabled
      ? routeTargets
          .filter((t): t is A2ARouteTarget & { type: 'remote' } => t.type === 'remote')
          .map((t) => ({
            id: `re_init_${++remoteCounter}`,
            name: t.name,
            url: t.url,
            // Rows created before Agent Card discovery had only an endpoint
            // URL, so preserve their direct A2A 0.3 behavior on first edit.
            connectionMode: t.connectionMode ?? 'direct',
            protocolVersion: t.protocolVersion ?? '0.3',
            callerProvenance: t.callerProvenance ?? false,
            description: t.description || '',
            apiKey: t.apiKey || '',
            showApiKey: false,
          }))
      : []

    setSelectedSkills(nextSkills)
    setSelectedSkillGroupIds(nextSkillGroupIds)
    setSelectedMcpServerIds(nextMcpServerIds)
    setSelectedKbDocumentIds(nextKbDocumentIds)
    setWorkspaceType(nextWorkspaceType)
    setScmSubType(nextScmSubType)
    setSelectedScmSourceId(nextScmSourceId)
    setEnvEntries(nextEnvEntries)
    setRouteEnabled(nextRouteEnabled)
    setLocalAgentIds(nextLocalAgentIds)
    const nextShowLocal = agent.showLocalChildOutput ?? true
    const nextShowRemote = agent.showRemoteChildOutput ?? true
    setShowLocalChildOutput(nextShowLocal)
    setShowRemoteChildOutput(nextShowRemote)
    setRemoteEntries(nextRemoteEntries)
    setProviderChainEntries(nextProviderChain)
    initialSkillsRef.current = nextSkills
    initialSkillGroupIdsRef.current = nextSkillGroupIds
    initialMcpServerIdsRef.current = nextMcpServerIds
    initialKbDocumentIdsRef.current = nextKbDocumentIds
    initialWorkspaceTypeRef.current = nextWorkspaceType
    initialScmSourceIdRef.current = nextScmSourceId
    initialEnvRef.current = nextEnvEntries.map((e) => ({
      key: e.key,
      value: e.value,
      sensitive: e.sensitive,
    }))
    initialRouteEnabledRef.current = nextRouteEnabled
    initialLocalAgentIdsRef.current = nextLocalAgentIds
    initialShowLocalChildOutputRef.current = nextShowLocal
    initialShowRemoteChildOutputRef.current = nextShowRemote
    initialRemoteEntriesRef.current = nextRemoteEntries
    initialProviderChainRef.current = nextProviderChain
    initializedAgentIdRef.current = agent.id
  }, [agent, form, providersError, providersList, scmSourcesList])

  useEffect(() => {
    if (workspaceType === 'scm' && selectedScmSourceId && scmSourcesList) {
      const src = scmSourcesList.find((s) => s.id === selectedScmSourceId)
      if (src) setScmSubType(src.type as 'p4' | 'git')
    }
  }, [workspaceType, selectedScmSourceId, scmSourcesList])

  const onSubmit = async (data: FormData) => {
    if (workspaceType === 'scm' && !selectedScmSourceId) {
      message.error(
        t('agentDetail.scmSourceRequired', {
          type: scmSubType === 'git' ? t('agentDetail.gitSource') : t('agentDetail.p4Source'),
        }),
      )
      return
    }

    const envRecord =
      envEntries.length > 0
        ? Object.fromEntries(
            envEntries
              .filter((e) => e.key.trim())
              .map((e) => [e.key.trim(), { value: e.value, sensitive: e.sensitive }]),
          )
        : {}

    const providerSubmission = buildProviderChainSubmission(providerChainEntries, data)
    const providerValidationIssue = validateProviderChainSubmission(providerSubmission)
    if (providerValidationIssue?.code === 'oauthTokenRequired') {
      modal.error({
        title: t('agentDetail.providerChainInvalidTitle'),
        content: t('agentDetail.providerChainOauthRequired', {
          index: providerValidationIssue.index + 1,
        }),
      })
      return
    }
    const baseAgentConfig = { ...((agent?.config as Record<string, unknown>) || {}) }

    if (isCreateMode) {
      const createData: CreateAgentInput = {
        name: data.name,
        type: 'cursor',
        description: data.description || undefined,
        systemPrompt: data.systemPrompt || undefined,
        icon: data.icon,
        skills: selectedSkills.length > 0 ? selectedSkills : undefined,
        artifactPolicy: templateArtifactPolicyRef.current ?? undefined,
        skillGroupIds: selectedSkillGroupIds.length > 0 ? selectedSkillGroupIds : undefined,
        mcpServerIds: selectedMcpServerIds.length > 0 ? selectedMcpServerIds : undefined,
        kbDocumentIds: selectedKbDocumentIds.length > 0 ? selectedKbDocumentIds : undefined,
        workspaceType,
        scmSourceId: workspaceType === 'scm' ? (selectedScmSourceId ?? undefined) : undefined,
        env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
        maxConcurrency: data.maxConcurrency,
        providerApiKey: providerSubmission.providerApiKey || undefined,
        providerBaseUrl: providerSubmission.providerBaseUrl || undefined,
        providerOauthToken: providerSubmission.providerOauthToken || undefined,
        authMode: providerSubmission.authMode,
        providerId: providerSubmission.providerId || undefined,
        config: {
          ...(providerSubmission.model ? { model: providerSubmission.model } : {}),
          ...(providerSubmission.providerChain.length > 0
            ? { providerChain: providerSubmission.providerChain }
            : {}),
          readOnly: data.readOnly,
          force: data.force,
          cleanResult: data.cleanResult,
          timeoutMinutes: data.timeoutMinutes,
          maxRetries: data.maxRetries,
          totalTimeoutMinutes: data.totalTimeoutMinutes ?? undefined,
        },
      }
      try {
        const result = await createAgent.mutateAsync(createData)
        clearDraft()
        // 新手模板、或引导进行中（含创建页刷新丢了模板标记的情况）→ 创建后落到发布页飞书子页。
        // 引导是否显示由根部 OnboardingTour 按 (进行中 + 路由) 推导，这里只负责导航到正确页面。
        const onboardingRunning = (() => {
          try {
            return localStorage.getItem('a2wave:onboarding:active') === '1'
          } catch {
            return false
          }
        })()
        // 两种「创建后去发布页」的语境要区别对待，因为 publishTab 如今表示
        // 「哪个渠道的配置弹窗是打开的」（见 publish/channel-config-modal.tsx）：
        //   - 新手引导进行中：必须带 publishTab=feishu。引导的整条飞书分支都门控在这个
        //     参数上（onboarding-tour.tsx 的 deriveStepId），且 choose-method 等步骤的目标
        //     元素就在弹窗内部；不带参数会让引导在最需要手把手的一步直接失去聚光灯。
        //   - 仅来自模板（gotoPublishAfterCreate）：只要把飞书渠道置顶，不该替用户弹窗。
        //     此前两者共用一个跳转，于是模板路径也被迫弹窗——那正是本次要修的 bug。
        const agentPath = `/agents/${result.data.id}`
        const target = onboardingRunning
          ? `${agentPath}?tab=publish&publishTab=feishu&onboarding=1`
          : gotoPublishAfterCreateRef.current
            ? `${agentPath}?tab=publish&onboarding=1`
            : agentPath
        navigate(target, { replace: true })
      } catch (error) {
        console.error('Failed to create agent:', error)
        // Match the update path: the server message often carries the only actionable
        // detail (which env variable was rejected, which Provider is incompatible),
        // and a generic toast throws it away. formatApiError falls back to generic
        // copy when there is no message worth showing.
        message.error(formatApiError(error, t))
      }
      return
    }

    if (!id) return

    // Build a2aRouteTargets from route state
    const a2aRouteTargets: A2ARouteTarget[] | null = (() => {
      if (!routeEnabled) return null
      const targets: A2ARouteTarget[] = [
        ...localAgentIds.map((aid) => ({
          type: 'local' as const,
          agentId: aid,
        })),
        ...remoteEntries
          .filter((e) => e.name.trim() && e.url.trim())
          .map((e) => {
            const connectionMode = e.connectionMode ?? 'direct'
            const protocolVersion =
              connectionMode === 'direct' ? (e.protocolVersion ?? '0.3') : undefined
            return {
              type: 'remote' as const,
              name: e.name.trim(),
              url: e.url.trim(),
              connectionMode,
              protocolVersion,
              ...(protocolVersion === '1.0' && e.callerProvenance
                ? { callerProvenance: true }
                : {}),
              description: e.description.trim() || undefined,
              apiKey: e.apiKey.trim() || undefined,
            }
          }),
      ]
      return targets.length > 0 ? targets : null
    })()

    const updateData: UpdateAgentInput = {
      name: data.name,
      description: data.description || null,
      systemPrompt: data.systemPrompt || null,
      icon: data.icon,
      skills: selectedSkills,
      skillGroupIds: selectedSkillGroupIds,
      mcpServerIds: selectedMcpServerIds,
      kbDocumentIds: selectedKbDocumentIds,
      workspaceType,
      scmSourceId: workspaceType === 'scm' ? selectedScmSourceId : null,
      env: Object.keys(envRecord).length > 0 ? envRecord : null,
      maxConcurrency: data.maxConcurrency,
      providerApiKey: providerSubmission.providerApiKey,
      providerBaseUrl: providerSubmission.providerBaseUrl,
      providerOauthToken: providerSubmission.providerOauthToken,
      authMode: providerSubmission.authMode,
      providerId: providerSubmission.providerId,
      a2aRouteTargets,
      showLocalChildOutput,
      showRemoteChildOutput,
      config: {
        ...baseAgentConfig,
        model: providerSubmission.model,
        providerChain: providerSubmission.providerChain,
        readOnly: data.readOnly,
        force: data.force,
        cleanResult: data.cleanResult,
        timeoutMinutes: data.timeoutMinutes,
        maxRetries: data.maxRetries,
        totalTimeoutMinutes: data.totalTimeoutMinutes ?? undefined,
      },
    }
    try {
      await updateAgent.mutateAsync({ id, ...updateData })
      message.success(t('agentDetail.saveSuccess'))
      clearDraft()
      // Reset dirty state after successful save
      form.reset(data)
      initialSkillsRef.current = selectedSkills
      initialSkillGroupIdsRef.current = selectedSkillGroupIds
      initialMcpServerIdsRef.current = selectedMcpServerIds
      initialKbDocumentIdsRef.current = selectedKbDocumentIds
      initialWorkspaceTypeRef.current = workspaceType
      initialScmSourceIdRef.current = workspaceType === 'scm' ? selectedScmSourceId : null
      initialEnvRef.current = envEntries
        .filter((e) => e.key.trim())
        .map((e) => ({ key: e.key.trim(), value: e.value, sensitive: e.sensitive }))
      initialRouteEnabledRef.current = routeEnabled
      initialLocalAgentIdsRef.current = localAgentIds
      initialShowLocalChildOutputRef.current = showLocalChildOutput
      initialShowRemoteChildOutputRef.current = showRemoteChildOutput
      initialRemoteEntriesRef.current = remoteEntries
      initialProviderChainRef.current = providerChainEntries
      // Bump version to force hasSelectionChanges memo to recompute with updated refs
      setSaveVersion((v) => v + 1)
    } catch (error) {
      console.error('Failed to update agent:', error)
      message.error(formatApiError(error, t))
    }
  }

  const handleDelete = () => {
    if (!id || !agent) return
    // A running (published) agent must be stopped before it can be deleted.
    if (agent.publishStatus === 'published') {
      modal.warning({
        title: t('agentDetail.deleteRunningTitle'),
        content: t('agentDetail.deleteRunningContent'),
        okText: t('common.confirm'),
      })
      return
    }
    confirmDeleteAgent({
      agentName: agent.name,
      t,
      onConfirm: async () => {
        try {
          await deleteAgent.mutateAsync(id)
          navigate('/agents')
        } catch (error) {
          console.error('Failed to delete agent:', error)
          message.error(t('agentDetail.deleteFail'))
        }
      },
    })
  }

  const handleClone = () => {
    if (!id) return
    confirm({
      title: t('agentDetail.cloneConfirmTitle'),
      content: t('agentDetail.cloneConfirmContent'),
      okText: t('agentDetail.cloneConfirmOk'),
      onOk: async () => {
        try {
          const res = await cloneAgent.mutateAsync(id)
          navigate(`/agents/${res.data.id}`, { state: { tab: 'config' } })
        } catch (error) {
          console.error('Failed to clone agent:', error)
          message.error(t('agentDetail.cloneFail'))
        }
      },
    })
  }

  const handlePublishConfirm = async (config: PublishConfig) => {
    if (!id) return
    try {
      const res = await publishAgent.mutateAsync({ id, config })
      message.success(t('agentPublish.publishSuccess'))
      return res?.data?.endpointApiKey ? { endpointApiKey: res.data.endpointApiKey } : undefined
    } catch (err) {
      message.error(formatApiError(err, t))
      throw err
    }
  }

  const handleStop = () => {
    if (!id || !agent) return
    confirm({
      title: t('agentDetail.stopConfirmTitle'),
      content: t('agentDetail.stopConfirmContent'),
      okText: t('agentDetail.stopOk'),
      danger: true,
      cancelText: t('agentDetail.deleteCancel'),
      onOk: async () => {
        try {
          await stopAgent.mutateAsync(id)
          message.success(t('agentDetail.stopSuccess'))
        } catch (error) {
          console.error('Failed to stop agent:', error)
          message.error(t('agentDetail.stopFail'))
        }
      },
    })
  }

  const handleResume = async () => {
    if (!id) return
    try {
      await resumeAgent.mutateAsync(id)
      message.success(t('agentDetail.resumeSuccess'))
    } catch (error) {
      console.error('Failed to resume agent:', error)
      message.error(formatApiError(error, t))
    }
  }

  return {
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
    routeEnabled,
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
    isSaving: isCreateMode ? createAgent.isPending : updateAgent.isPending,
    isDeleting: deleteAgent.isPending,
    publishAgent,
    stopAgent,
    resumeAgent,
    cloneAgent,
  }
}
