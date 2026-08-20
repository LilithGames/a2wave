import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Table, Tag, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
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
import { message } from '@/lib/antd-static'
import { api } from '@/lib/api'
import { formatApiError } from '@/lib/api-error'
import { copyText } from '@/lib/clipboard'
import { confirm } from '@/lib/confirm'

interface CliToken {
  id: string
  name: string
  tokenPrefix: string
  expiresAt: string | null
  lastUsedAt: string | null
  revokedAt: string | null
  createdAt: string
}

interface SessionPolicy {
  sessionTtlDays: number
  configurable: boolean
}

const EXPIRY_CHOICES = [30, 90, 365, 0] as const

type TokenStatus = 'active' | 'revoked' | 'expired'

function statusOf(token: CliToken): TokenStatus {
  if (token.revokedAt) return 'revoked'
  if (token.expiresAt && dayjs(token.expiresAt).isBefore(dayjs())) return 'expired'
  return 'active'
}

const STATUS_COLOR: Record<TokenStatus, string> = {
  active: 'green',
  revoked: 'default',
  expired: 'orange',
}

/**
 * CLI token management.
 *
 * The list is the page; creation lives behind a button, because minting a token is
 * occasional and the form would otherwise dominate a surface people mostly visit to
 * audit what already exists.
 */
export function CliTokensCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)

  const { data: tokens, isLoading } = useQuery({
    queryKey: ['cli-tokens'],
    queryFn: () => api.get<CliToken[]>('/cli-tokens').then((r) => r.data),
  })

  const { data: policy } = useQuery({
    queryKey: ['cli-tokens', 'session-policy'],
    queryFn: () => api.get<SessionPolicy>('/cli-tokens/session-policy').then((r) => r.data),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/cli-tokens/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cli-tokens'] }),
  })

  const handleDelete = (token: CliToken) => {
    confirm({
      title: t('cli.deleteTitle'),
      content: t('cli.deleteContent', { name: token.name }),
      okText: t('common.delete'),
      danger: true,
      onOk: () => deleteMutation.mutateAsync(token.id),
    })
  }

  const columns = [
    {
      title: t('cli.colName'),
      dataIndex: 'name',
      key: 'name',
      render: (name: string, record: CliToken) => (
        <div className="min-w-0">
          <div className="truncate text-foreground">{name}</div>
          {/* The prefix is all that can safely identify a token after creation. */}
          <code className="font-mono text-xs text-muted-foreground">{record.tokenPrefix}…</code>
        </div>
      ),
    },
    {
      title: t('cli.colStatus'),
      key: 'status',
      render: (_: unknown, record: CliToken) => {
        const status = statusOf(record)
        return <Tag color={STATUS_COLOR[status]}>{t(`cli.status.${status}`)}</Tag>
      },
    },
    {
      title: t('cli.colLastUsed'),
      dataIndex: 'lastUsedAt',
      key: 'lastUsedAt',
      render: (lastUsedAt: string | null) => (
        // "Never used" is the signal that a token is safe to delete, so it is stated
        // rather than left as an empty cell that reads as missing data.
        <span className="text-sm text-muted-foreground">
          {lastUsedAt ? dayjs(lastUsedAt).format('YYYY-MM-DD HH:mm') : t('cli.never')}
        </span>
      ),
    },
    {
      title: t('cli.colExpires'),
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      render: (expiresAt: string | null) => (
        <span className="text-sm text-muted-foreground">
          {expiresAt ? dayjs(expiresAt).format('YYYY-MM-DD') : t('cli.expiryNever')}
        </span>
      ),
    },
    {
      title: t('users.actions'),
      key: 'actions',
      width: 80,
      render: (_: unknown, record: CliToken) => (
        <Tooltip title={t('common.delete')}>
          {/* Neutral until hover, matching the users table: a row of permanently red
              icons reads as a warning state rather than an available action. */}
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('common.delete')}
            className="text-muted-foreground hover:text-destructive"
            onClick={() => handleDelete(record)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </Tooltip>
      ),
    },
  ]

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" />
              {t('cli.title')}
            </CardTitle>
            <CardDescription className="mt-1">{t('cli.desc')}</CardDescription>
          </div>
          <Button onClick={() => setCreateOpen(true)} className="shrink-0">
            <Plus className="h-4 w-4" />
            {t('cli.create')}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <Table
          dataSource={tokens ?? []}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={false}
          size="small"
          locale={{ emptyText: t('cli.empty') }}
          rowClassName={(record: CliToken) => (statusOf(record) === 'active' ? '' : 'opacity-60')}
        />

        {policy && (
          <div className="info-panel px-4 py-3">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm font-medium text-foreground">{t('cli.sessionTtl')}</span>
              <span className="font-mono text-sm text-foreground">
                {t('cli.sessionTtlValue', { days: policy.sessionTtlDays })}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              <Trans
                i18nKey="cli.sessionTtlHint"
                components={{ b: <strong className="font-medium text-foreground" /> }}
              />
            </p>
          </div>
        )}
      </CardContent>

      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Card>
  )
}

/**
 * Mint a token.
 *
 * Two states in one dialog: the form, then the credential. The second state has no
 * cancel — the token exists either way, and the only useful action left is copying
 * it before it becomes unrecoverable.
 */
function CreateTokenDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [expiresInDays, setExpiresInDays] = useState<number>(90)
  const [issued, setIssued] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')

  const reset = () => {
    setName('')
    setExpiresInDays(90)
    setIssued(null)
    setCopied(false)
    setError('')
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const mutation = useMutation({
    meta: { handleLocally: true },
    mutationFn: (body: { name: string; expiresInDays?: number }) =>
      api.post<{ token: string }>('/cli-tokens', body).then((r) => r.data),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['cli-tokens'] })
      setIssued(created.token)
      setError('')
    },
  })

  const handleSubmit = async () => {
    setError('')
    if (!name.trim()) {
      setError(t('cli.nameRequired'))
      return
    }
    try {
      await mutation.mutateAsync({
        name: name.trim(),
        ...(expiresInDays > 0 ? { expiresInDays } : {}),
      })
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  const handleCopy = async () => {
    if (!issued) return
    // Report the real outcome: this value is unrecoverable, so a success state on a
    // copy that silently failed would send the user away empty-handed.
    if (await copyText(issued)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      message.error(t('cli.copyFailed'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange} width={560}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{issued ? t('cli.created') : t('cli.createTitle')}</DialogTitle>
          <DialogDescription>
            {issued ? t('cli.createdWarning') : t('cli.createDesc')}
          </DialogDescription>
        </DialogHeader>

        {issued ? (
          <div className="mt-4 flex items-center gap-2">
            {/* One line, scrollable: a 48-character secret wrapped to two lines made
                the dialog lurch and read as if the value itself were malformed. */}
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
              {issued}
            </code>
            <Button
              variant="outline"
              onClick={handleCopy}
              aria-label={t('cli.copy')}
              className="shrink-0"
            >
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              {copied ? t('cli.copied') : t('cli.copy')}
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="cli-token-name">
                {t('cli.name')}
              </label>
              <Input
                id="cli-token-name"
                className="mt-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('cli.namePlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSubmit()
                }}
                autoFocus
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('cli.nameHint')}</p>
            </div>

            <div>
              <span className="text-sm font-medium text-foreground">{t('cli.expiry')}</span>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {EXPIRY_CHOICES.map((days) => (
                  <Button
                    key={days}
                    type="button"
                    variant={expiresInDays === days ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setExpiresInDays(days)}
                  >
                    {days === 0 ? t('cli.expiryNever') : t('cli.expiryDays', { count: days })}
                  </Button>
                ))}
              </div>
              {expiresInDays === 0 && (
                <p className="mt-1.5 text-xs text-muted-foreground">{t('cli.expiryHint')}</p>
              )}
            </div>

            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-600">{error}</div>
            )}
          </div>
        )}

        <DialogFooter>
          {issued ? (
            <Button onClick={() => handleOpenChange(false)}>{t('cli.done')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={handleSubmit} disabled={mutation.isPending}>
                {t('cli.submit')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
