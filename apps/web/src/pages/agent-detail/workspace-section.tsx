import type { ScmSource } from '@a2wave/shared'
import { Select, Tag } from 'antd'
import { ExternalLink, FolderOpen, Info, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { ModePicker } from '@/components/ui/mode-picker'
import { selectFilterOption } from '@/lib/select-filter'

interface WorkspaceSectionProps {
  workspaceType: 'scm' | 'temp'
  setWorkspaceType: (v: 'scm' | 'temp') => void
  scmSubType: 'p4' | 'git'
  setScmSubType: (v: 'p4' | 'git') => void
  selectedScmSourceId: string | null
  setSelectedScmSourceId: (v: string | null) => void
  scmSourcesList: ScmSource[] | undefined
  resolvedWorkDir: { path: string; scmType: 'p4' | 'git' | null }
}

export function WorkspaceSection({
  workspaceType,
  setWorkspaceType,
  scmSubType,
  setScmSubType,
  selectedScmSourceId,
  setSelectedScmSourceId,
  scmSourcesList,
  resolvedWorkDir,
}: WorkspaceSectionProps) {
  const { t } = useTranslation()

  const completedSources =
    workspaceType === 'scm'
      ? (scmSourcesList?.filter(
          (s) => s.type === scmSubType && s.isEnabled && s.initialSyncCompletedAt != null,
        ) ?? [])
      : []

  const pendingSources =
    workspaceType === 'scm'
      ? (scmSourcesList?.filter(
          (s) => s.type === scmSubType && s.isEnabled && s.initialSyncCompletedAt == null,
        ) ?? [])
      : []

  // 只有下拉为空（无可用源）且存在未完成同步的源时，才提示原因
  const syncHint = (() => {
    if (completedSources.length > 0 || pendingSources.length === 0) return null
    if (pendingSources.some((s) => s.syncStatus === 'syncing')) return 'syncing'
    if (pendingSources.some((s) => s.syncStatus === 'error')) return 'error'
    return 'idle'
  })()

  return (
    <Card className="flex h-full flex-col">
      <CardContent className="flex flex-1 flex-col space-y-3 p-5">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <FolderOpen className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <Label className="text-sm font-medium text-foreground">
              {t('agentDetail.workspace')}
            </Label>
          </div>
          <p className="text-xs text-muted-foreground">{t('agentDetail.workspaceDesc')}</p>
        </div>

        {/* `temp` and the two SCM kinds are one mutually exclusive choice, so they
            are one control — the value flattens the (workspaceType, scmSubType) pair. */}
        {/* self-start: the card is a flex column, whose default `stretch` would
            blow this out to full width and strand the labels in a wide empty
            track. Scoped here rather than a global `.ant-segmented` rule —
            that rule would be unlayered, so it would outrank Tailwind's layered
            utilities everywhere and top-align every Segmented that sits in a
            flex-ROW next to a taller sibling. */}
        <ModePicker
          className="self-start"
          value={workspaceType === 'temp' ? 'temp' : scmSubType}
          onChange={(key) => {
            if (key === 'temp') {
              setWorkspaceType('temp')
            } else {
              setWorkspaceType('scm')
              setScmSubType(key as 'p4' | 'git')
            }
            setSelectedScmSourceId(null)
          }}
          options={[
            { value: 'temp', label: t('agentDetail.tempDir') },
            { value: 'p4', label: t('agentDetail.p4Source') },
            { value: 'git', label: t('agentDetail.gitSource') },
          ]}
        />

        {/* invisible: `temp` has no source to pick, but simply dropping the
            Select would shorten the card — and in an equal-height row that
            resizes every card beside it on each toggle. Keep the slot occupied
            and hide it instead, so switching options never shifts the layout. */}
        <div
          className={workspaceType === 'scm' ? undefined : 'invisible'}
          aria-hidden={workspaceType !== 'scm'}
        >
          <Select
            showSearch
            allowClear
            disabled={workspaceType !== 'scm'}
            placeholder={
              scmSubType === 'p4' ? t('agentDetail.selectP4') : t('agentDetail.selectGit')
            }
            value={selectedScmSourceId || undefined}
            onChange={(val) => setSelectedScmSourceId(val ?? null)}
            filterOption={selectFilterOption}
            options={completedSources.map((source) => ({
              value: source.id,
              label: source.name,
              localPath: source.localPath,
            }))}
            optionRender={(option) => {
              const data = option.data as { localPath?: string }
              return (
                <div className="flex flex-col min-w-0 overflow-hidden py-0.5">
                  <span className="truncate text-sm">{option.label}</span>
                  {data.localPath && (
                    <code className="text-xs text-muted-foreground font-mono truncate block">
                      {data.localPath}
                    </code>
                  )}
                </div>
              )
            }}
            popupRender={(menu) => (
              <>
                {menu}
                <div className="border-t border-border px-3 py-2">
                  <Link
                    to="/scm-sources"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-interactive-foreground underline-offset-4 transition-colors hover:underline"
                  >
                    {scmSubType === 'p4' ? t('agentDetail.manageP4') : t('agentDetail.manageGit')}
                    <ExternalLink className="h-3 w-3" aria-hidden="true" />
                  </Link>
                </div>
              </>
            )}
            className="w-full [&_.ant-select-selector]:!min-h-9"
            popupMatchSelectWidth
            getPopupContainer={() => document.body}
          />
        </div>

        {syncHint && (
          <div className="flex items-start gap-2 info-panel px-3 py-2.5">
            {syncHint === 'syncing' ? (
              <Loader2
                className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Info className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" aria-hidden="true" />
            )}
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-xs text-muted-foreground">
                {syncHint === 'syncing' && t('agentDetail.scmSyncingHint')}
                {syncHint === 'idle' && t('agentDetail.scmIdleHint')}
                {syncHint === 'error' && t('agentDetail.scmErrorHint')}
              </span>
              <Link
                to="/scm-sources"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-interactive-foreground underline-offset-4 transition-colors hover:underline"
              >
                {t('agentDetail.scmManage')}
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </Link>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 info-panel px-3 py-2.5">
          <code className="flex-1 text-xs font-mono text-muted-foreground break-all">
            {resolvedWorkDir.path || t('agentDetail.autoGenerated')}
          </code>
          {resolvedWorkDir.scmType && (
            <Tag
              color={resolvedWorkDir.scmType === 'p4' ? 'blue' : 'green'}
              className="text-2xs shrink-0 m-0"
            >
              {resolvedWorkDir.scmType === 'p4' ? 'P4' : 'Git'}
            </Tag>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
