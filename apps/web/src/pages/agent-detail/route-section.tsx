import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { selectFilterOption } from '@/lib/select-filter'
import { Checkbox, Select, Tag } from 'antd'
import { Eye, EyeOff, Plus, Route, Settings2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { hasConfiguredRouteTargets } from './provider-capabilities'
import type { RemoteEntry } from './types'

interface RouteAgentOption {
  id: string
  name: string
  icon?: string | null
}

interface RouteSectionProps {
  /**
   * Mirrors "configured means enabled" back into the form state. There is no
   * separate persisted flag — `a2aRouteTargets` is saved as null when empty —
   * so the section derives enablement from the targets and reports it upward
   * rather than letting the user toggle the two out of sync.
   */
  setRouteEnabled: (v: boolean) => void
  localAgentIds: string[]
  setLocalAgentIds: (v: string[]) => void
  showLocalChildOutput: boolean
  setShowLocalChildOutput: (v: boolean) => void
  showRemoteChildOutput: boolean
  setShowRemoteChildOutput: (v: boolean) => void
  remoteEntries: RemoteEntry[]
  addRemoteEntry: () => void
  updateRemoteEntry: (id: string, field: keyof RemoteEntry, value: string | boolean) => void
  removeRemoteEntry: (id: string) => void
  publishedA2aAgents: RouteAgentOption[]
}

/** Cap on preview chips so a long target list can't stretch the summary card. */
const MAX_PREVIEW_TARGETS = 4

export function RouteSection({
  setRouteEnabled,
  localAgentIds,
  setLocalAgentIds,
  showLocalChildOutput,
  setShowLocalChildOutput,
  showRemoteChildOutput,
  setShowRemoteChildOutput,
  remoteEntries,
  addRemoteEntry,
  updateRemoteEntry,
  removeRemoteEntry,
  publishedA2aAgents,
}: RouteSectionProps) {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)

  // Must match the save path's predicate in `use-agent-form.ts` exactly, which
  // keeps a remote only when BOTH fields are filled. With `||` here, a row with
  // a name but no URL counted as a target — the card claimed "1 remote" and the
  // derived flag said enabled, while save dropped it and persisted null, so the
  // entry silently vanished on reload with the form still looking clean.
  const namedRemotes = remoteEntries.filter((entry) => entry.name.trim() && entry.url.trim())
  const targetCount = localAgentIds.length + namedRemotes.length
  // Same helper the Provider/MCP compatibility warning derives `routeEnabled`
  // from, so the card and that warning can never disagree.
  const configured = hasConfiguredRouteTargets({ localAgentIds, remoteEntries })

  const previewLabels = [
    ...localAgentIds.map((id) => publishedA2aAgents.find((agent) => agent.id === id)?.name ?? id),
    ...namedRemotes.map((entry) => entry.name.trim() || entry.url.trim()),
  ]

  // Routing is enabled precisely when targets exist — keep the form flag in
  // step with the targets instead of exposing a switch that could contradict
  // them (an "enabled" agent with zero targets saves as disabled anyway).
  useEffect(() => {
    setRouteEnabled(configured)
  }, [configured, setRouteEnabled])

  /**
   * Opens the editor, seeding a blank remote row only when there is nothing to
   * edit yet — otherwise the empty state would open onto an empty dialog.
   * Guarding on `remoteEntries.length` matters: `sameRemoteEntries` compares
   * length first, so appending a row unconditionally flips the form to dirty
   * and triggers the unsaved-changes prompt even if the user only looked.
   */
  const openEditor = () => {
    if (remoteEntries.length === 0) addRemoteEntry()
    setDialogOpen(true)
  }

  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col space-y-3 p-5">
        <div className="space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <Route className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Label className="text-sm font-medium text-foreground">{t('agentRoute.title')}</Label>
            {configured && (
              <span className="text-muted-foreground text-xs tabular-nums">{targetCount}</span>
            )}
          </div>
          <p className="text-muted-foreground text-xs">{t('agentRoute.titleDesc')}</p>
        </div>

        {configured ? (
          <div className="flex-1 space-y-2">
            <p className="text-muted-foreground text-xs">
              {t('agentRoute.targetSummary', {
                local: localAgentIds.length,
                remote: namedRemotes.length,
              })}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {previewLabels.slice(0, MAX_PREVIEW_TARGETS).map((label) => (
                <Tag key={label} className="m-0 max-w-[180px] truncate text-xs">
                  {label}
                </Tag>
              ))}
              {previewLabels.length > MAX_PREVIEW_TARGETS && (
                <span className="self-center text-muted-foreground text-xs tabular-nums">
                  +{previewLabels.length - MAX_PREVIEW_TARGETS}
                </span>
              )}
            </div>
          </div>
        ) : (
          // flex-1 + centering: in a stretched row the empty box would otherwise
          // hug the header and leave a gap above the bottom-pinned action.
          <div className="flex flex-1 items-center justify-center rounded-md border border-border/50 border-dashed bg-muted/30 px-3 py-3 text-center">
            <p className="text-muted-foreground text-xs">{t('agentRoute.emptyHint')}</p>
          </div>
        )}

        {/* mt-auto pins the action to the card's bottom edge so it lines up
            across a stretched row regardless of how tall the summary is. */}
        <div className="mt-auto flex justify-end pt-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={openEditor}
            data-testid="route-configure"
          >
            {configured ? (
              <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {configured ? t('agentRoute.configure') : t('agentRoute.addTarget')}
          </Button>
        </div>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen} width={720} scrollBody>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('agentRoute.title')}</DialogTitle>
            <DialogDescription>{t('agentRoute.titleDesc')}</DialogDescription>
          </DialogHeader>

          <div className="-mr-4 mt-4 max-h-[65vh] space-y-4 overflow-y-auto pr-4">
            {/* Streaming card output switches */}
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={showLocalChildOutput}
                  onChange={(e) => setShowLocalChildOutput(e.target.checked)}
                />
                <span className="text-muted-foreground">
                  {t('agentRoute.showLocalChildOutput')}
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={showRemoteChildOutput}
                  onChange={(e) => setShowRemoteChildOutput(e.target.checked)}
                />
                <span className="text-muted-foreground">
                  {t('agentRoute.showRemoteChildOutput')}
                </span>
              </div>
            </div>

            {/* Local Agents */}
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">{t('agentRoute.localAgents')}</Label>
              <Select
                mode="multiple"
                showSearch
                value={localAgentIds}
                onChange={setLocalAgentIds}
                placeholder={t('agentRoute.localAgentsPlaceholder')}
                className="w-full"
                options={publishedA2aAgents.map((a) => ({
                  label: `${a.icon || ''} ${a.name}`.trim(),
                  value: a.id,
                }))}
                filterOption={selectFilterOption}
                getPopupContainer={() => document.body}
              />
            </div>

            {/* Remote Agents */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs text-muted-foreground">
                  {t('agentRoute.remoteAgents')}
                </Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addRemoteEntry}
                  className="h-7 gap-1 text-xs"
                >
                  <Plus className="h-3 w-3" />
                  {t('agentRoute.addRemote')}
                </Button>
              </div>

              {remoteEntries.length === 0 && localAgentIds.length === 0 && (
                <div className="rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  {t('agentRoute.noTargetsHint')}
                </div>
              )}

              {remoteEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="space-y-2 rounded-lg border border-border bg-muted/20 p-3"
                >
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t('agentRoute.remoteConnectionMode')}
                      </Label>
                      <Select
                        value={entry.connectionMode ?? 'direct'}
                        onChange={(value) => updateRemoteEntry(entry.id, 'connectionMode', value)}
                        className="mt-1 w-full"
                        size="small"
                        options={[
                          {
                            value: 'agent_card',
                            label: t('agentRoute.remoteConnectionModeAgentCard'),
                          },
                          {
                            value: 'direct',
                            label: t('agentRoute.remoteConnectionModeDirect'),
                          },
                        ]}
                        getPopupContainer={() => document.body}
                      />
                    </div>
                    {(entry.connectionMode ?? 'direct') === 'direct' ? (
                      <div>
                        <Label className="text-xs text-muted-foreground">
                          {t('agentRoute.remoteProtocolVersion')}
                        </Label>
                        <Select
                          value={entry.protocolVersion ?? '0.3'}
                          onChange={(value) =>
                            updateRemoteEntry(entry.id, 'protocolVersion', value)
                          }
                          className="mt-1 w-full"
                          size="small"
                          options={[
                            { value: '1.0', label: 'A2A 1.0' },
                            { value: '0.3', label: 'A2A 0.3' },
                          ]}
                          getPopupContainer={() => document.body}
                        />
                      </div>
                    ) : (
                      <div className="flex items-end pb-1 text-muted-foreground text-xs">
                        {t('agentRoute.remoteAgentCardHint')}
                      </div>
                    )}
                  </div>
                  {(entry.connectionMode ?? 'direct') === 'direct' && (
                    <div className="rounded-md bg-muted/50 px-2.5 py-2 text-muted-foreground text-xs">
                      {t('agentRoute.remoteDirectStreamingHint')}
                    </div>
                  )}
                  {(entry.connectionMode ?? 'direct') === 'direct' &&
                    (entry.protocolVersion ?? '0.3') === '1.0' && (
                      <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2">
                        <Checkbox
                          aria-label={t('agentRoute.remoteCallerProvenance')}
                          checked={Boolean(entry.callerProvenance)}
                          onChange={(event) =>
                            updateRemoteEntry(entry.id, 'callerProvenance', event.target.checked)
                          }
                        />
                        <div className="space-y-0.5">
                          <div className="text-sm text-foreground">
                            {t('agentRoute.remoteCallerProvenance')}
                          </div>
                          <p className="text-muted-foreground text-xs">
                            {t('agentRoute.remoteCallerProvenanceHint')}
                          </p>
                        </div>
                      </div>
                    )}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t('agentRoute.remoteName')}
                      </Label>
                      <Input
                        value={entry.name}
                        onChange={(e) => updateRemoteEntry(entry.id, 'name', e.target.value)}
                        placeholder={t('agentRoute.remoteNamePlaceholder')}
                        className="mt-1 h-8 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {(entry.connectionMode ?? 'direct') === 'agent_card'
                          ? t('agentRoute.remoteAgentCardUrl')
                          : t('agentRoute.remoteUrl')}
                      </Label>
                      <Input
                        value={entry.url}
                        onChange={(e) => updateRemoteEntry(entry.id, 'url', e.target.value)}
                        placeholder={
                          (entry.connectionMode ?? 'direct') === 'agent_card'
                            ? t('agentRoute.remoteAgentCardUrlPlaceholder')
                            : t('agentRoute.remoteUrlPlaceholder')
                        }
                        className="mt-1 h-8 text-sm"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t('agentRoute.remoteDescription')}
                      </Label>
                      <Input
                        value={entry.description}
                        onChange={(e) => updateRemoteEntry(entry.id, 'description', e.target.value)}
                        placeholder={t('agentRoute.remoteDescriptionPlaceholder')}
                        className="mt-1 h-8 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        {t('agentRoute.remoteApiKey')}
                      </Label>
                      <div className="relative mt-1">
                        <Input
                          type={entry.showApiKey ? 'text' : 'password'}
                          value={entry.apiKey}
                          onChange={(e) => updateRemoteEntry(entry.id, 'apiKey', e.target.value)}
                          placeholder={t('agentRoute.remoteApiKeyPlaceholder')}
                          className="h-8 pr-9 text-sm"
                        />
                        <button
                          type="button"
                          onClick={() =>
                            updateRemoteEntry(entry.id, 'showApiKey', !entry.showApiKey)
                          }
                          aria-label={
                            entry.showApiKey
                              ? t('agentDetail.hideValue')
                              : t('agentDetail.showValue')
                          }
                          title={
                            entry.showApiKey
                              ? t('agentDetail.hideValue')
                              : t('agentDetail.showValue')
                          }
                          className="-translate-y-1/2 absolute top-1/2 right-2 text-muted-foreground hover:text-foreground"
                        >
                          {entry.showApiKey ? (
                            <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRemoteEntry(entry.id)}
                      className="h-7 gap-1 text-destructive text-xs hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                      {t('agentRoute.removeRemote')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
