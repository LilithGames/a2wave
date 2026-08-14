import type { McpServerType } from '@a2wave/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { Select, Tooltip } from 'antd'
import {
  AlertTriangle,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Save,
  Terminal,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ModePicker } from '@/components/ui/mode-picker'
import { Textarea } from '@/components/ui/textarea'
import { useCurrentUser } from '@/hooks/use-auth'
import {
  useCreateMcpServer,
  useMcpServer,
  useMcpServerTools,
  useProbeTools,
  useUpdateMcpServer,
} from '@/hooks/use-mcp-servers'
import { cn } from '@/lib/utils'
import {
  createMcpServerFormSchema,
  introducesStdio,
  isSensitiveEnvKey,
  type McpFormData,
  ProbeResultDisplay,
} from './mcp-form-shared'

interface Props {
  /** undefined = create mode; a value = edit mode */
  serverId?: string
  /** Called after a successful create or update. */
  onSaved: () => void
}

/**
 * Create/edit form for a plain MCP server (stdio | SSE | HTTP). Group servers are
 * handled by McpGroupForm — this form never exposes the group transport option.
 */
export function McpServerForm({ serverId, onSaved }: Props) {
  const { t, i18n: i18nInstance } = useTranslation()
  const language = i18nInstance.language
  const formSchema = useMemo(() => createMcpServerFormSchema(language), [language])
  const isCreateMode = !serverId
  const { data: server } = useMcpServer(serverId ?? '')
  const createServer = useCreateMcpServer()
  const updateServer = useUpdateMcpServer()
  const isSaving = isCreateMode ? createServer.isPending : updateServer.isPending

  const { data: currentUser } = useCurrentUser()
  const isAdmin = currentUser?.role === 'admin'
  const probeTools = useProbeTools()
  // Top-level probe state
  const [topProbeResult, setTopProbeResult] = useState<{
    tools?: { name: string; description?: string }[]
    error?: string
  } | null>(null)
  const [topProbing, setTopProbing] = useState(false)

  // Dynamic key-value editors
  const [newHeaderKey, setNewHeaderKey] = useState('')
  const [newHeaderValue, setNewHeaderValue] = useState('')
  const [newEnvKey, setNewEnvKey] = useState('')
  const [newEnvValue, setNewEnvValue] = useState('')
  const [newArg, setNewArg] = useState('')
  const [revealedEnvKeys, setRevealedEnvKeys] = useState<Set<string>>(new Set())

  const toggleRevealEnv = (key: string) => {
    setRevealedEnvKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { isDirty, errors },
  } = useForm<McpFormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      description: '',
      type: 'stdio',
      command: '',
      args: [],
      cwd: '',
      url: '',
      headers: {},
      env: {},
      groupConfig: { backends: {} },
      isEnabled: false,
      // Default matches the API: a non-stdio server is 'private' (owner-only) by
      // default. stdio is shown/locked to admin-only and forced so by the backend.
      // Only an admin may pick 'all-users' to share.
      usageScope: 'private',
    },
  })

  useEffect(() => {
    if (server) {
      reset({
        name: server.name,
        description: server.description ?? '',
        type: server.type as McpServerType,
        command: server.command ?? '',
        args: server.args ?? [],
        cwd: server.cwd ?? '',
        url: server.url ?? '',
        headers: server.headers ?? {},
        env: server.env ?? {},
        groupConfig: { backends: {} },
        isEnabled: server.isEnabled,
        // Preserve the server's persisted scope verbatim — never silently rewrite
        // it on load. A legacy 'admin-only' non-stdio row stays 'admin-only' (the
        // dropdown offers it as an explicit option below), so an admin who saves
        // without touching the control does NOT accidentally downgrade it.
        usageScope: server.usageScope ?? 'private',
      })
    }
  }, [server, reset])

  const serverType = watch('type')
  const args = watch('args')
  const headers = watch('headers')
  const env = watch('env')

  // Clear probe results when server type changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: serverType is the trigger; effect intentionally resets state on type change
  useEffect(() => {
    setTopProbeResult(null)
  }, [serverType])

  // Live-probing an sse/http/stdio server is owner-or-admin only (the server makes
  // an outbound call with the OWNER's credentials, or spawns the stdio command — a
  // non-owner probing a shared server would be a confused deputy and the API 403s).
  const canProbe = isAdmin || (!!server && server.userId === currentUser?.id)
  const wantsLiveProbe =
    ((serverType === 'sse' || serverType === 'http') && !!server?.url) || serverType === 'stdio'
  const toolsEnabled = !isCreateMode && wantsLiveProbe && canProbe
  const {
    data: tools,
    isLoading: toolsLoading,
    error: toolsError,
    refetch: refetchTools,
    isFetching: toolsFetching,
  } = useMcpServerTools(serverId ?? '', toolsEnabled)

  const handleAddArg = () => {
    const trimmed = newArg.trim()
    if (trimmed) {
      // Auto-split by whitespace so "-y @pkg" becomes ["-y", "@pkg"]
      const tokens = trimmed.split(/\s+/).filter(Boolean)
      setValue('args', [...args, ...tokens], { shouldDirty: true })
      setNewArg('')
    }
  }

  const handleRemoveArg = (index: number) => {
    setValue(
      'args',
      args.filter((_, i) => i !== index),
      { shouldDirty: true },
    )
  }

  const handleAddHeader = () => {
    const key = newHeaderKey.trim()
    const value = newHeaderValue.trim()
    if (key) {
      setValue('headers', { ...headers, [key]: value }, { shouldDirty: true })
      setNewHeaderKey('')
      setNewHeaderValue('')
    }
  }

  const handleRemoveHeader = (key: string) => {
    const next = { ...headers }
    delete next[key]
    setValue('headers', next, { shouldDirty: true })
  }

  const handleAddEnv = () => {
    const key = newEnvKey.trim()
    const value = newEnvValue.trim()
    if (key) {
      setValue('env', { ...env, [key]: value }, { shouldDirty: true })
      setNewEnvKey('')
      setNewEnvValue('')
    }
  }

  const handleRemoveEnv = (key: string) => {
    const next = { ...env }
    delete next[key]
    setValue('env', next, { shouldDirty: true })
  }

  const onSubmit = async (data: McpFormData) => {
    // Auto-include pending env input that hasn't been added via + button
    const finalEnv = newEnvKey.trim()
      ? { ...data.env, [newEnvKey.trim()]: newEnvValue.trim() }
      : data.env

    if (isCreateMode) {
      try {
        await createServer.mutateAsync({
          name: data.name,
          type: data.type,
          description: data.description || undefined,
          command: data.type === 'stdio' ? data.command || undefined : undefined,
          args: data.type === 'stdio' ? data.args : [],
          cwd: data.type === 'stdio' && data.cwd?.trim() ? data.cwd.trim() : undefined,
          url: data.type === 'sse' || data.type === 'http' ? data.url || undefined : undefined,
          headers:
            data.type === 'sse' || data.type === 'http'
              ? Object.keys(data.headers).length > 0
                ? data.headers
                : undefined
              : undefined,
          env: Object.keys(finalEnv).length > 0 ? finalEnv : undefined,
          // Only admins may set the usage scope; the backend forces admin-only for
          // stdio regardless, and ignores this field for non-admins.
          usageScope: isAdmin ? data.usageScope : undefined,
        } as never)
        setNewEnvKey('')
        setNewEnvValue('')
        onSaved()
      } catch (error) {
        console.error('Failed to create MCP server:', error)
      }
      return
    }
    if (!serverId) return
    try {
      await updateServer.mutateAsync({
        id: serverId,
        name: data.name,
        description: data.description || null,
        type: data.type,
        command: data.type === 'stdio' ? data.command || null : null,
        args: data.type === 'stdio' ? data.args : [],
        cwd: data.type === 'stdio' && data.cwd?.trim() ? data.cwd.trim() : null,
        url: data.type === 'sse' || data.type === 'http' ? data.url || null : null,
        headers:
          data.type === 'sse' || data.type === 'http'
            ? Object.keys(data.headers).length > 0
              ? data.headers
              : null
            : null,
        env: Object.keys(finalEnv).length > 0 ? finalEnv : null,
        groupConfig: null,
        usageScope: isAdmin ? data.usageScope : undefined,
      } as never)
      setNewEnvKey('')
      setNewEnvValue('')
      onSaved()
    } catch (error) {
      console.error('Failed to update MCP server:', error)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex max-h-[70vh] flex-col">
      {/* Scroll region — only the body scrolls; the save bar stays pinned. -mr-5
          pr-5 keeps the scrollbar at the modal's edge; min-h keeps a stable height. */}
      <div className="min-h-0 flex-1 overflow-y-auto -mr-5 pr-5">
        <div className="min-h-[24rem] space-y-6">
          {/* Basic Information */}
          <section className="space-y-4">
            <h3 className="text-base font-semibold text-foreground">
              {t('mcpServerDetail.basicInfo')}
            </h3>
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-sm" required>
                    {t('mcpServerDetail.name')}
                  </Label>
                  <Input
                    id="name"
                    {...register('name')}
                    placeholder={t('mcpServerDetail.namePlaceholder')}
                    aria-invalid={!!errors.name}
                  />
                  {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">{t('mcpServerDetail.transportType')}</Label>
                  <ModePicker
                    block
                    value={serverType as 'stdio' | 'sse' | 'http'}
                    onChange={(v) => setValue('type', v, { shouldDirty: true })}
                    options={[
                      { value: 'stdio', label: 'stdio', icon: Terminal },
                      { value: 'sse', label: 'SSE', icon: Globe },
                      { value: 'http', label: 'HTTP', icon: Globe },
                    ]}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description" className="text-sm">
                  {t('mcpServerDetail.description')}
                </Label>
                <Textarea
                  id="description"
                  {...register('description')}
                  placeholder={t('mcpServerDetail.descriptionPlaceholder')}
                  rows={2}
                />
              </div>
              {/* Usage scope — admin-only control (only admins can share). stdio is
              locked to admin-only (host execution); a non-stdio server is private by
              default and an admin may share it to all users. */}
              {isAdmin &&
                (() => {
                  const isStdioType = introducesStdio(serverType, null)
                  const currentScope = watch('usageScope')
                  const options = isStdioType
                    ? [{ value: 'admin-only', label: t('mcpServerDetail.usageScopeAdminOnly') }]
                    : [
                        { value: 'private', label: t('mcpServerDetail.usageScopePrivate') },
                        { value: 'all-users', label: t('mcpServerDetail.usageScopeAllUsers') },
                        ...(currentScope === 'admin-only'
                          ? [
                              {
                                value: 'admin-only',
                                label: t('mcpServerDetail.usageScopeAdminOnly'),
                              },
                            ]
                          : []),
                      ]
                  return (
                    <div className="space-y-1.5">
                      <Label className="text-sm">{t('mcpServerDetail.usageScope')}</Label>
                      <Select
                        className="w-full"
                        value={isStdioType ? 'admin-only' : currentScope}
                        disabled={isStdioType}
                        onChange={(v) =>
                          setValue('usageScope', v as 'private' | 'admin-only' | 'all-users', {
                            shouldDirty: true,
                          })
                        }
                        options={options}
                      />
                      <p className="text-xs text-muted-foreground">
                        {isStdioType
                          ? t('mcpServerDetail.usageScopeStdioHint')
                          : t('mcpServerDetail.usageScopeHint')}
                      </p>
                    </div>
                  )
                })()}
            </div>
          </section>

          {/* stdio Configuration */}
          {serverType === 'stdio' && (
            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-foreground">
                  {t('mcpServerDetail.stdioConfig')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t('mcpServerDetail.stdioConfigDesc')}
                </p>
              </div>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="command" className="text-sm" required>
                    {t('mcpServerDetail.command')}
                  </Label>
                  <Input
                    id="command"
                    {...register('command')}
                    placeholder={t('mcpServerDetail.commandPlaceholder')}
                    className="font-mono text-sm"
                    aria-invalid={!!errors.command}
                  />
                  {errors.command && (
                    <p className="text-xs text-destructive">{errors.command.message}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">{t('mcpServerDetail.arguments')}</Label>
                  {args.length > 0 && (
                    <div className="space-y-1.5">
                      {args.map((arg, index) => (
                        <div key={`${index}-${arg}`} className="flex items-center gap-2">
                          <code className="flex-1 rounded-md border border-border/50 bg-muted/30 px-3 py-1.5 text-sm font-mono truncate">
                            {arg}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleRemoveArg(index)}
                            className="flex size-7 items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            aria-label={t('mcpServerDetail.removeArgAria', { arg })}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={newArg}
                      onChange={(e) => setNewArg(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleAddArg()
                        }
                      }}
                      placeholder={t('mcpServerDetail.argPlaceholder')}
                      className="font-mono text-sm"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleAddArg}
                      disabled={!newArg.trim()}
                      className="shrink-0"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cwd" className="text-sm">
                    {t('mcpServerDetail.workingDirectory')}
                  </Label>
                  <Input
                    id="cwd"
                    {...register('cwd')}
                    placeholder={t('mcpServerDetail.workingDirectoryPlaceholder')}
                    className="font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('mcpServerDetail.workingDirectoryHint')}
                  </p>
                </div>

                {/* Test Connection */}
                <div className="space-y-2 pt-2 border-t border-border/40">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={topProbing || !watch('command')?.trim()}
                      onClick={() => {
                        setTopProbing(true)
                        setTopProbeResult(null)
                        probeTools.mutate(
                          {
                            type: 'stdio',
                            command: watch('command') ?? undefined,
                            args: watch('args') ?? undefined,
                            env: watch('env') ?? undefined,
                          },
                          {
                            onSuccess: (res) => {
                              setTopProbeResult({ tools: res.data.tools })
                              setTopProbing(false)
                            },
                            onError: (err) => {
                              setTopProbeResult({ error: err.message })
                              setTopProbing(false)
                            },
                          },
                        )
                      }}
                    >
                      {topProbing ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <Zap className="h-3 w-3 mr-1" />
                      )}
                      {t('mcpServerDetail.probeTools')}
                    </Button>
                    {topProbeResult?.tools && (
                      <span className="text-xs text-muted-foreground">
                        {t('mcpServerDetail.toolsCount', { count: topProbeResult.tools.length })}
                      </span>
                    )}
                  </div>
                  <ProbeResultDisplay result={topProbeResult} />
                </div>
              </div>
            </section>
          )}

          {/* SSE / HTTP Configuration */}
          {(serverType === 'sse' || serverType === 'http') && (
            <section className="space-y-4">
              <div className="space-y-1">
                <h3 className="text-base font-semibold text-foreground">
                  {serverType === 'http'
                    ? t('mcpServerDetail.httpConfig')
                    : t('mcpServerDetail.sseConfig')}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {serverType === 'http'
                    ? t('mcpServerDetail.httpConfigDesc')
                    : t('mcpServerDetail.sseConfigDesc')}
                </p>
              </div>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="url" className="text-sm" required>
                    {t('mcpServerDetail.serverUrl')}
                  </Label>
                  <Input
                    id="url"
                    {...register('url')}
                    placeholder={t('mcpServerDetail.urlPlaceholder')}
                    className="font-mono text-sm"
                    aria-invalid={!!errors.url}
                  />
                  {errors.url && <p className="text-xs text-destructive">{errors.url.message}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">{t('mcpServerDetail.headers')}</Label>
                  {Object.keys(headers).length > 0 && (
                    <div className="space-y-1.5">
                      {Object.entries(headers).map(([key, value]) => (
                        <div key={key} className="flex items-center gap-2">
                          <code className="rounded-md border border-border/50 bg-muted/30 px-3 py-1.5 text-sm font-mono w-1/3 truncate">
                            {key}
                          </code>
                          <code className="flex-1 rounded-md border border-border/50 bg-muted/30 px-3 py-1.5 text-sm font-mono truncate">
                            {value}
                          </code>
                          <button
                            type="button"
                            onClick={() => handleRemoveHeader(key)}
                            className="flex size-7 items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                            aria-label={t('mcpServerDetail.removeHeaderAria', { name: key })}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={newHeaderKey}
                      onChange={(e) => setNewHeaderKey(e.target.value)}
                      placeholder={t('mcpServerDetail.headerNamePlaceholder')}
                      className="font-mono text-sm w-1/3"
                    />
                    <Input
                      value={newHeaderValue}
                      onChange={(e) => setNewHeaderValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleAddHeader()
                        }
                      }}
                      placeholder={t('mcpServerDetail.headerValuePlaceholder')}
                      className="font-mono text-sm flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleAddHeader}
                      disabled={!newHeaderKey.trim()}
                      className="shrink-0"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Test Connection */}
                <div className="space-y-2 pt-2 border-t border-border/40">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={topProbing || !watch('url')?.trim()}
                      onClick={() => {
                        setTopProbing(true)
                        setTopProbeResult(null)
                        probeTools.mutate(
                          {
                            type: serverType as 'sse' | 'http',
                            url: watch('url') ?? undefined,
                            headers: watch('headers') ?? undefined,
                          },
                          {
                            onSuccess: (res) => {
                              setTopProbeResult({ tools: res.data.tools })
                              setTopProbing(false)
                            },
                            onError: (err) => {
                              setTopProbeResult({ error: err.message })
                              setTopProbing(false)
                            },
                          },
                        )
                      }}
                    >
                      {topProbing ? (
                        <Loader2 className="h-3 w-3 animate-spin mr-1" />
                      ) : (
                        <Zap className="h-3 w-3 mr-1" />
                      )}
                      {t('mcpServerDetail.probeTools')}
                    </Button>
                    {topProbeResult?.tools && (
                      <span className="text-xs text-muted-foreground">
                        {t('mcpServerDetail.toolsCount', { count: topProbeResult.tools.length })}
                      </span>
                    )}
                  </div>
                  <ProbeResultDisplay result={topProbeResult} />
                </div>
              </div>
            </section>
          )}

          {/* Available Tools */}
          {toolsEnabled && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-foreground">
                    {t('mcpServerDetail.tools')}
                  </h3>
                  <p className="text-sm text-muted-foreground">{t('mcpServerDetail.toolsDesc')}</p>
                </div>
                <div className="flex items-center gap-2">
                  {tools && tools.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t('mcpServerDetail.toolsCount', { count: tools.length })}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() => refetchTools()}
                    disabled={toolsFetching}
                    aria-label={t('mcpServerDetail.toolsRefresh')}
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', toolsFetching && 'animate-spin')} />
                  </Button>
                </div>
              </div>
              <div>
                {(toolsLoading || toolsFetching) && !tools && (
                  <div className="flex items-center gap-2 info-panel px-3 py-2.5 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    {t('mcpServerDetail.toolsLoading')}
                  </div>
                )}
                {toolsError && !toolsFetching && (
                  <div className="flex items-center gap-2 info-panel px-3 py-2.5 text-sm text-destructive">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>
                      {t('mcpServerDetail.toolsError')}
                      {toolsError.message && !toolsError.message.startsWith('HTTP_')
                        ? `: ${toolsError.message}`
                        : ''}
                    </span>
                  </div>
                )}
                {tools && tools.length === 0 && (
                  <p className="rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    {t('mcpServerDetail.toolsEmpty')}
                  </p>
                )}
                {tools && tools.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {tools.map((tool) => (
                      <Tooltip key={tool.name} title={tool.description} placement="top">
                        <span className="inline-flex items-center rounded-md border border-border bg-muted/30 px-2 py-0.5 font-mono text-xs cursor-default hover:bg-surface-hover transition-colors">
                          {tool.name}
                        </span>
                      </Tooltip>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Environment Variables */}
          <section className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-foreground">
                {t('mcpServerDetail.envVars')}
              </h3>
              <p className="text-sm text-muted-foreground">{t('mcpServerDetail.envVarsDesc')}</p>
            </div>
            <div className="space-y-3">
              {Object.keys(env).length > 0 && (
                <div className="space-y-1.5">
                  {Object.entries(env).map(([key, value]) => {
                    const sensitive = isSensitiveEnvKey(key)
                    const revealed = revealedEnvKeys.has(key)
                    const displayValue = sensitive && !revealed ? '••••••••' : value
                    return (
                      <div key={key} className="flex items-center gap-2">
                        <Tooltip title={key} placement="top">
                          <code className="rounded-md border border-border/50 bg-muted/30 px-3 py-1.5 text-sm font-mono w-1/3 truncate">
                            {key}
                          </code>
                        </Tooltip>
                        <Tooltip title={sensitive && !revealed ? undefined : value} placement="top">
                          <code className="flex-1 rounded-md border border-border/50 bg-muted/30 px-3 py-1.5 text-sm font-mono truncate">
                            {displayValue}
                          </code>
                        </Tooltip>
                        {sensitive && (
                          <button
                            type="button"
                            onClick={() => toggleRevealEnv(key)}
                            className="flex size-7 items-center justify-center rounded-md hover:bg-surface-hover text-muted-foreground hover:text-foreground transition-colors"
                            aria-label={
                              revealed
                                ? t('mcpServerDetail.hideEnvAria', { name: key })
                                : t('mcpServerDetail.revealEnvAria', { name: key })
                            }
                          >
                            {revealed ? (
                              <EyeOff className="h-3.5 w-3.5" />
                            ) : (
                              <Eye className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveEnv(key)}
                          className="flex size-7 items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                          aria-label={t('mcpServerDetail.removeEnvAria', { name: key })}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              {Object.keys(env).length === 0 && (
                <p className="text-sm text-muted-foreground/60 italic">
                  {t('mcpServerDetail.noEnvVars')}
                </p>
              )}
              <div className="flex gap-2">
                <Input
                  value={newEnvKey}
                  onChange={(e) => setNewEnvKey(e.target.value)}
                  placeholder={t('mcpServerDetail.varNamePlaceholder')}
                  className="font-mono text-sm w-1/3"
                />
                <Input
                  value={newEnvValue}
                  onChange={(e) => setNewEnvValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddEnv()
                    }
                  }}
                  placeholder={t('mcpServerDetail.varValuePlaceholder')}
                  className="font-mono text-sm flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleAddEnv}
                  disabled={!newEnvKey.trim()}
                  className="shrink-0"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Pinned save bar */}
      <div className="mt-3 flex shrink-0 items-center justify-end border-t border-border/60 pt-3">
        <Button type="submit" disabled={isCreateMode ? isSaving : !isDirty || isSaving}>
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {isCreateMode ? t('mcpServerDetail.creating') : t('mcpServerDetail.saving')}
            </>
          ) : (
            <>
              <Save className="h-4 w-4" aria-hidden="true" />
              {isCreateMode ? t('mcpServerDetail.createMcp') : t('mcpServerDetail.saveChanges')}
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
