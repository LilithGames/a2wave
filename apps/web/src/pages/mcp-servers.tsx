import type { GroupConfig, McpServer } from '@a2wave/shared'
import { ADMIN_MCP_NAMES, INTERNAL_MCP_NAMES } from '@a2wave/shared'
import { Dropdown } from 'antd'
import {
  Cable,
  Copy,
  Globe,
  Layers,
  MoreHorizontal,
  Plus,
  Shield,
  Terminal,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { McpGroupFormModal } from '@/components/mcp/mcp-group-form-modal'
import { McpServerFormModal } from '@/components/mcp/mcp-server-form-modal'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ModePicker } from '@/components/ui/mode-picker'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentUser } from '@/hooks/use-auth'
import { useCloneMcpServer, useDeleteMcpServer, useMcpServers } from '@/hooks/use-mcp-servers'
import { useUrlParam, useUrlRecord } from '@/hooks/use-url-state'
import { confirm } from '@/lib/confirm'

export function McpServersPage() {
  const { t } = useTranslation()
  const { data: serversResult, isLoading } = useMcpServers()
  const { data: user } = useCurrentUser()
  const isAdmin = user?.role === 'admin'
  const cloneServer = useCloneMcpServer()
  const deleteServer = useDeleteMcpServer()

  // Modal state lives in the URL so an editor is linkable and survives a reload.
  // A group and a plain server never share a modal, so they keep separate params.
  const serverModal = useUrlRecord('server')
  const groupModal = useUrlRecord('group')

  // Type filter (All / stdio / sse / http / group). `allowed` guards against a
  // hand-edited URL putting the page into a state that renders nothing.
  const [typeFilter, setTypeFilter] = useUrlParam('type', {
    defaultValue: 'all',
    allowed: ['all', 'stdio', 'sse', 'http', 'group'],
  })

  // Visible servers before the type filter — used both to decide whether to show
  // the filter at all and as the base for the filtered grid.
  const visibleServers = serversResult?.data
    ?.filter((s) => {
      if (INTERNAL_MCP_NAMES.has(s.name)) return false
      if (ADMIN_MCP_NAMES.has(s.name) && !isAdmin) return false
      return true
    })
    .sort((a, b) => {
      const aBuiltin = ADMIN_MCP_NAMES.has(a.name) ? 0 : 1
      const bBuiltin = ADMIN_MCP_NAMES.has(b.name) ? 0 : 1
      return aBuiltin - bBuiltin
    })

  const servers =
    typeFilter === 'all' ? visibleServers : visibleServers?.filter((s) => s.type === typeFilter)

  const typeFilterOptions = [
    { value: 'all', label: t('mcpServers.filterAll') },
    { value: 'stdio', label: 'stdio' },
    { value: 'sse', label: 'SSE' },
    { value: 'http', label: 'HTTP' },
    { value: 'group', label: 'Group' },
  ]

  const openForEdit = (server: McpServer) => {
    if (server.type === 'group') {
      groupModal.openEdit(server.id)
    } else {
      serverModal.openEdit(server.id)
    }
  }

  const handleClone = (server: McpServer) => {
    confirm({
      title: t('mcpServerDetail.cloneConfirmTitle'),
      content: t('mcpServerDetail.cloneConfirmContent'),
      okText: t('mcpServerDetail.cloneConfirmOk'),
      onOk: async () => {
        try {
          await cloneServer.mutateAsync(server.id)
        } catch (error) {
          console.error('Failed to clone MCP server:', error)
        }
      },
    })
  }

  const handleDelete = (server: McpServer) => {
    confirm({
      title: t('mcpServerDetail.deleteTitle'),
      content: t('mcpServerDetail.deleteDesc'),
      okText: t('mcpServerDetail.delete'),
      danger: true,
      onOk: async () => {
        try {
          await deleteServer.mutateAsync(server.id)
        } catch (error) {
          console.error('Failed to delete MCP server:', error)
        }
      },
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2
            className="text-2xl font-semibold tracking-tight text-foreground"
            style={{ textWrap: 'balance' }}
          >
            {t('mcpServers.title')}
          </h2>
          <p className="text-sm text-muted-foreground mt-1.5">{t('mcpServers.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => groupModal.openCreate()}>
            <Layers className="h-4 w-4" aria-hidden="true" />
            {t('mcpServers.addGroup')}
          </Button>
          <Button onClick={() => serverModal.openCreate()}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('mcpServers.addMcp')}
          </Button>
        </div>
      </div>

      {!isLoading && (visibleServers?.length ?? 0) > 0 && (
        <ModePicker
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as string)}
          options={typeFilterOptions}
        />
      )}

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-live="polite">
          <span className="sr-only">{t('common.loading')}</span>
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder, fixed count
            <Card key={i}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <Skeleton className="size-10 rounded-xl" />
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-24" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-full mb-2" />
                <Skeleton className="h-3 w-2/3" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : servers?.length === 0 ? (
        (visibleServers?.length ?? 0) > 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 px-8">
              <p className="text-sm text-muted-foreground text-center">
                {t('mcpServers.filterEmpty')}
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-20 px-8">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-brand-gradient-subtle text-interactive-foreground mb-5">
                <Cable className="h-7 w-7" aria-hidden="true" />
              </div>
              <h3 className="font-semibold text-base mb-1 text-foreground">
                {t('mcpServers.emptyTitle')}
              </h3>
              <p
                className="text-sm text-muted-foreground text-center max-w-xs"
                style={{ textWrap: 'pretty' }}
              >
                {t('mcpServers.emptyDesc')}
              </p>
            </CardContent>
          </Card>
        )
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {servers?.map((server) => {
            const isBuiltIn = ADMIN_MCP_NAMES.has(server.name)
            return (
              <Card
                key={server.id}
                // biome-ignore lint/a11y/useSemanticElements: the card body holds a nested action
                // <button> and an <h3> title, neither of which is valid inside a <button>.
                role="button"
                tabIndex={0}
                onClick={() => openForEdit(server)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    openForEdit(server)
                  }
                }}
                className="h-full cursor-pointer hover:border-primary/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardHeader className="pb-3">
                  <div className="relative flex items-start gap-3 min-w-0">
                    <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground shrink-0">
                      {server.type === 'group' ? (
                        <Layers className="h-5 w-5" aria-hidden="true" />
                      ) : server.type === 'sse' || server.type === 'http' ? (
                        <Globe className="h-5 w-5" aria-hidden="true" />
                      ) : (
                        <Terminal className="h-5 w-5" aria-hidden="true" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1 pr-20">
                      <CardTitle className="text-base truncate font-semibold">
                        {server.name}
                      </CardTitle>
                      <CardDescription className="text-xs mt-0.5">
                        {server.type === 'group'
                          ? 'Group'
                          : server.type === 'http'
                            ? 'Streamable HTTP'
                            : server.type === 'sse'
                              ? 'HTTP/SSE'
                              : 'stdio'}
                      </CardDescription>
                    </div>
                    <div className="absolute right-0 top-0 flex items-start gap-1.5">
                      <div className="flex flex-col items-end gap-1.5">
                        <Badge variant={server.isEnabled ? 'success' : 'outline'}>
                          {server.isEnabled ? t('mcpServers.enabled') : t('mcpServers.disabled')}
                        </Badge>
                        {isBuiltIn && (
                          <Badge className="gap-1 border-primary/20 bg-primary/10 text-interactive-foreground font-semibold">
                            <Shield className="h-3 w-3" aria-hidden="true" />
                            {t('mcpServers.builtIn')}
                          </Badge>
                        )}
                      </div>
                      {!isBuiltIn && (
                        <Dropdown
                          menu={{
                            items: [
                              {
                                key: 'clone',
                                label: t('mcpServerDetail.clone'),
                                icon: <Copy className="h-4 w-4" />,
                                disabled: cloneServer.isPending,
                                onClick: ({ domEvent }) => {
                                  domEvent.stopPropagation()
                                  handleClone(server)
                                },
                              },
                              {
                                key: 'delete',
                                label: t('mcpServerDetail.delete'),
                                icon: <Trash2 className="h-4 w-4" />,
                                danger: true,
                                onClick: ({ domEvent }) => {
                                  domEvent.stopPropagation()
                                  handleDelete(server)
                                },
                              },
                            ],
                          }}
                          trigger={['click']}
                          placement="bottomRight"
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-7 -mr-1 -mt-1"
                            aria-label={t('agentDetail.moreActions')}
                            onClick={(e) => e.stopPropagation()}
                            // Keep keyboard activation from bubbling to the card's
                            // onKeyDown (which would also open the edit modal).
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </Dropdown>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <p
                    className="text-sm text-muted-foreground line-clamp-2 leading-relaxed"
                    style={{ textWrap: 'pretty' }}
                  >
                    {server.description || t('common.noDescription')}
                  </p>
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <code className="text-xs text-muted-foreground/60 font-mono truncate block">
                      {server.type === 'group'
                        ? (() => {
                            const gc = (server as Record<string, unknown>)
                              .groupConfig as GroupConfig | null
                            if (!gc) return '—'
                            const keys = Object.keys(gc.backends)
                            const totalBackends = Object.values(gc.backends).reduce(
                              (sum, arr) => sum + arr.length,
                              0,
                            )
                            return `${keys.join(', ')} — ${t('mcpServers.backendCount', { count: totalBackends })}`
                          })()
                        : server.type === 'sse' || server.type === 'http'
                          ? server.url || '—'
                          : server.command
                            ? `${server.command} ${(server.args ?? []).join(' ')}`.trim()
                            : '—'}
                    </code>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <McpServerFormModal
        open={serverModal.open}
        onOpenChange={(open) => !open && serverModal.close()}
        serverId={serverModal.id}
      />
      <McpGroupFormModal
        open={groupModal.open}
        onOpenChange={(open) => !open && groupModal.close()}
        serverId={groupModal.id}
      />
    </div>
  )
}
