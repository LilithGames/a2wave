/**
 * API key management for an Agent's `api` / `a2a` channel.
 *
 * Lives in its own file rather than inside publish-tab.tsx, which is already past
 * 1800 lines. The plaintext is shown exactly once, in a modal, at creation.
 */
import { Modal, Select, Table, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { AlertCircle, KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  type AgentApiKey,
  type AgentApiKeyChannel,
  useAgentApiKeys,
  useCreateAgentApiKey,
  useRevokeAgentApiKey,
  useUpdateAgentApiKey,
} from '@/hooks/use-agents'
import { modal } from '@/lib/antd-static'
import { CopyButton } from '@/pages/agent-detail/copy-button'

interface ApiKeyListProps {
  agentId: string | undefined
  channel: AgentApiKeyChannel
}

/**
 * Max description length. Mirrors `MAX_KEY_NAME_LENGTH` in
 * apps/api/src/lib/agent-api-key.ts — the server rejects anything longer, so the
 * input caps at the same value rather than letting the user type into a 400.
 */
const MAX_NAME_LENGTH = 24

/** Lifetime options offered at creation. `0` means "never expires". */
const EXPIRY_OPTIONS = [0, 30, 90, 365] as const

type KeyState = 'active' | 'expiring' | 'expired' | 'revoked'

/** Warn a week ahead: enough notice to rotate before an integration starts failing. */
const EXPIRING_SOON_DAYS = 7

export function keyState(key: AgentApiKey, now: Date = new Date()): KeyState {
  if (key.revokedAt) return 'revoked'
  if (!key.expiresAt) return 'active'
  const expiry = new Date(key.expiresAt).getTime()
  if (expiry <= now.getTime()) return 'expired'
  return expiry - now.getTime() <= EXPIRING_SOON_DAYS * 86_400_000 ? 'expiring' : 'active'
}

export function ApiKeyList({ agentId, channel }: ApiKeyListProps) {
  const { t } = useTranslation()
  const { data: keys, isLoading } = useAgentApiKeys(agentId, channel)
  const createKey = useCreateAgentApiKey(agentId)
  const revokeKey = useRevokeAgentApiKey(agentId, channel)
  const updateKey = useUpdateAgentApiKey(agentId, channel)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [expiresInDays, setExpiresInDays] = useState<number>(0)
  const [mintedKey, setMintedKey] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<AgentApiKey | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const rows = keys ?? []
  const activeCount = rows.filter((k) => !k.revokedAt).length

  async function handleCreate() {
    if (!name.trim()) return
    const res = await createKey.mutateAsync({
      channel,
      name: name.trim(),
      ...(expiresInDays > 0 ? { expiresInDays } : {}),
    })
    setCreating(false)
    setName('')
    setExpiresInDays(0)
    // Unrecoverable after this modal closes — only the hash is stored.
    if (res?.data?.key) setMintedKey(res.data.key)
  }

  async function handleRename() {
    if (!renaming || !renameValue.trim()) return
    await updateKey.mutateAsync({ keyId: renaming.id, name: renameValue.trim() })
    setRenaming(null)
  }

  function confirmRevoke(key: AgentApiKey) {
    modal.confirm({
      title: t('agentApiKeys.revokeTitle'),
      content: t('agentApiKeys.revokeConfirm', { name: key.name }),
      okText: t('agentApiKeys.revoke'),
      okButtonProps: { danger: true },
      cancelText: t('common.cancel'),
      onOk: () => revokeKey.mutateAsync(key.id),
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium text-foreground">{t('agentApiKeys.title')}</Label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!agentId}
          onClick={() => setCreating(true)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="ml-1.5">{t('agentApiKeys.newKey')}</span>
        </Button>
      </div>

      {/* Zero active keys under api_key auth is a fail-closed state: every caller gets
          403. It has to be loud, not inferred from an empty table. */}
      {!isLoading && activeCount === 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2.5 text-sm text-warning">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('agentApiKeys.noActiveKeysWarning')}
        </div>
      )}

      <Table<AgentApiKey>
        dataSource={rows}
        rowKey="id"
        size="small"
        loading={isLoading}
        pagination={false}
        locale={{ emptyText: t('agentApiKeys.empty') }}
        columns={[
          {
            title: t('agentApiKeys.name'),
            dataIndex: 'name',
            render: (_v, key) => {
              const state = keyState(key)
              return (
                <div className="flex items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className={state === 'revoked' ? 'text-muted-foreground line-through' : ''}>
                    {key.name}
                  </span>
                  {state === 'expired' && (
                    <Badge variant="destructive">{t('agentApiKeys.stateExpired')}</Badge>
                  )}
                  {state === 'expiring' && (
                    <Badge variant="secondary">{t('agentApiKeys.stateExpiringSoon')}</Badge>
                  )}
                  {state === 'revoked' && (
                    <Badge variant="outline">{t('agentApiKeys.stateRevoked')}</Badge>
                  )}
                </div>
              )
            },
          },
          {
            title: t('agentApiKeys.prefix'),
            dataIndex: 'keyPrefix',
            render: (prefix: string) => (
              <span className="font-mono text-xs text-muted-foreground">{prefix}…</span>
            ),
          },
          {
            title: t('agentApiKeys.expiresAt'),
            dataIndex: 'expiresAt',
            render: (value: string | null) =>
              value ? (
                dayjs(value).format('YYYY-MM-DD')
              ) : (
                <span className="text-muted-foreground">{t('agentApiKeys.never')}</span>
              ),
          },
          {
            title: t('agentApiKeys.lastUsed'),
            dataIndex: 'lastUsedAt',
            render: (value: string | null, key) =>
              value ? (
                <Tooltip title={key.lastUsedIp ?? undefined}>
                  <span>{dayjs(value).format('YYYY-MM-DD HH:mm')}</span>
                </Tooltip>
              ) : (
                <span className="text-muted-foreground">{t('agentApiKeys.neverUsed')}</span>
              ),
          },
          {
            title: '',
            width: 90,
            render: (_v, key) =>
              key.revokedAt ? null : (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={t('agentApiKeys.rename')}
                    onClick={() => {
                      setRenaming(key)
                      setRenameValue(key.name)
                    }}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={t('agentApiKeys.revoke')}
                    onClick={() => confirmRevoke(key)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                  </Button>
                </div>
              ),
          },
        ]}
      />

      {/* Create */}
      <Modal
        open={creating}
        title={t('agentApiKeys.newKey')}
        onCancel={() => setCreating(false)}
        onOk={handleCreate}
        okButtonProps={{ disabled: !name.trim() || createKey.isPending }}
        okText={
          createKey.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            t('agentApiKeys.create')
          )
        }
        cancelText={t('common.cancel')}
      >
        <div className="flex flex-col gap-3 pt-2">
          <div className="flex flex-col gap-1.5">
            <Label required className="text-sm">
              {t('agentApiKeys.name')}
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, MAX_NAME_LENGTH))}
              maxLength={MAX_NAME_LENGTH}
              placeholder={t('agentApiKeys.namePlaceholder')}
            />
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-muted-foreground">{t('agentApiKeys.nameHelp')}</p>
              <p className="shrink-0 text-xs text-muted-foreground">
                {name.length}/{MAX_NAME_LENGTH}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-sm">{t('agentApiKeys.expiry')}</Label>
            <Select
              value={expiresInDays}
              onChange={setExpiresInDays}
              options={EXPIRY_OPTIONS.map((days) => ({
                value: days,
                label:
                  days === 0 ? t('agentApiKeys.never') : t('agentApiKeys.days', { count: days }),
              }))}
            />
          </div>
        </div>
      </Modal>

      {/* Show-once plaintext */}
      <Modal
        open={!!mintedKey}
        title={t('agentApiKeys.createdTitle')}
        onCancel={() => setMintedKey(null)}
        onOk={() => setMintedKey(null)}
        okText={t('common.close')}
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <div className="flex flex-col gap-3 pt-2">
          {/* Plain description, matching the CLI-token dialog: this states what the
              dialog *is*, not that something went wrong. A red panel here reads as an
              error and desensitises the one notice that is a real warning (below). */}
          <p className="text-sm text-muted-foreground">{t('agentApiKeys.showOnceWarning')}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
              {mintedKey}
            </code>
            {/* CopyButton, not a raw navigator.clipboard call: that API is absent on a
                plain-HTTP origin and no-ops inside a focus-trapping dialog — exactly
                where this sits. It also owns the copied ✓ feedback. */}
            <CopyButton text={mintedKey ?? ''} label={t('common.copy')} />
          </div>
        </div>
      </Modal>

      {/* Rename */}
      <Modal
        open={!!renaming}
        title={t('agentApiKeys.rename')}
        onCancel={() => setRenaming(null)}
        onOk={handleRename}
        okButtonProps={{ disabled: !renameValue.trim() || updateKey.isPending }}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
      >
        <div className="pt-2">
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value.slice(0, MAX_NAME_LENGTH))}
            maxLength={MAX_NAME_LENGTH}
            placeholder={t('agentApiKeys.namePlaceholder')}
          />
        </div>
      </Modal>
    </div>
  )
}
