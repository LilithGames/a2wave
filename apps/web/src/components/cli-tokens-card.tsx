import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { formatApiError } from '@/lib/api-error'

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

function isExpired(token: CliToken): boolean {
  return !!token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()
}

/**
 * CLI token management.
 *
 * The plaintext comes back exactly once, from the create call, so it is held in
 * component state and shown in a dismissible panel — there is no way to recover
 * it afterwards, and the copy explicitly says so.
 */
export function CliTokensCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  const [expiresInDays, setExpiresInDays] = useState<number>(90)
  const [issued, setIssued] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [pendingRevoke, setPendingRevoke] = useState<CliToken | null>(null)

  const { data: tokens = [] } = useQuery({
    queryKey: ['cli-tokens'],
    queryFn: () => api.get<CliToken[]>('/cli-tokens').then((r) => r.data),
  })

  const { data: policy } = useQuery({
    queryKey: ['cli-tokens', 'session-policy'],
    queryFn: () => api.get<SessionPolicy>('/cli-tokens/session-policy').then((r) => r.data),
  })

  const create = useMutation({
    meta: { handleLocally: true },
    mutationFn: (body: { name: string; expiresInDays?: number }) =>
      api.post<{ token: string }>('/cli-tokens', body).then((r) => r.data),
  })

  const revoke = useMutation({
    meta: { handleLocally: true },
    mutationFn: (id: string) => api.delete(`/cli-tokens/${id}`),
  })

  const handleCreate = async () => {
    setError('')
    if (!name.trim()) {
      setError(t('cli.nameRequired'))
      return
    }
    try {
      const result = await create.mutateAsync({
        name: name.trim(),
        ...(expiresInDays > 0 ? { expiresInDays } : {}),
      })
      setIssued(result.token)
      setName('')
      queryClient.invalidateQueries({ queryKey: ['cli-tokens'] })
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  const handleRevoke = async (token: CliToken) => {
    setError('')
    try {
      await revoke.mutateAsync(token.id)
      queryClient.invalidateQueries({ queryKey: ['cli-tokens'] })
    } catch (err) {
      setError(formatApiError(err, t))
    } finally {
      setPendingRevoke(null)
    }
  }

  const copyIssued = async () => {
    if (!issued) return
    await navigator.clipboard.writeText(issued)
    setCopied(true)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4" />
          {t('cli.title')}
        </CardTitle>
        <CardDescription>{t('cli.desc')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {issued ? (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
            <p className="text-sm font-medium text-foreground">{t('cli.created')}</p>
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
              {t('cli.createdWarning')}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-muted px-3 py-2 font-mono text-xs">
                {issued}
              </code>
              <Button variant="outline" size="sm" onClick={copyIssued}>
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                <span className="ml-1.5">{copied ? t('cli.copied') : t('cli.copy')}</span>
              </Button>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="mt-3"
              onClick={() => {
                setIssued(null)
                setCopied(false)
              }}
            >
              {t('cli.done')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="cli-token-name" required className="text-sm font-medium">
                {t('cli.name')}
              </Label>
              <Input
                id="cli-token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('cli.namePlaceholder')}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cli-token-expiry" className="text-sm font-medium">
                {t('cli.expiry')}
              </Label>
              <div className="flex flex-wrap gap-2">
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
                <p className="text-xs text-muted-foreground">{t('cli.expiryHint')}</p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button onClick={handleCreate} disabled={create.isPending}>
              {t('cli.create')}
            </Button>
          </div>
        )}

        <div>
          {tokens.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">{t('cli.empty')}</p>
          ) : (
            <div className="divide-y divide-border/50">
              {tokens.map((token) => (
                <div key={token.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        {token.name}
                      </span>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {token.tokenPrefix}…
                      </code>
                      {token.revokedAt && (
                        <span className="text-xs text-muted-foreground">{t('cli.revoked')}</span>
                      )}
                      {!token.revokedAt && isExpired(token) && (
                        <span className="text-xs text-amber-600">{t('cli.expired')}</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('cli.colLastUsed')}:{' '}
                      {token.lastUsedAt
                        ? new Date(token.lastUsedAt).toLocaleString()
                        : t('cli.never')}
                      {token.expiresAt
                        ? ` · ${t('cli.colExpires')}: ${new Date(token.expiresAt).toLocaleDateString()}`
                        : ''}
                    </p>
                  </div>
                  {!token.revokedAt && (
                    <Button variant="ghost" size="sm" onClick={() => setPendingRevoke(token)}>
                      {t('cli.revoke')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {policy && (
          <div className="rounded-lg border border-border bg-muted/30 p-4">
            <div className="flex items-baseline justify-between gap-4">
              <span className="text-sm font-medium text-foreground">{t('cli.sessionTtl')}</span>
              <span className="font-mono text-sm text-foreground">
                {t('cli.sessionTtlValue', { days: policy.sessionTtlDays })}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{t('cli.sessionTtlHint')}</p>
          </div>
        )}
      </CardContent>

      <AlertDialog open={!!pendingRevoke} onOpenChange={(open) => !open && setPendingRevoke(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{pendingRevoke?.name}</AlertDialogTitle>
          <AlertDialogDescription>{t('cli.revokeConfirm')}</AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setPendingRevoke(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingRevoke && handleRevoke(pendingRevoke)}
              disabled={revoke.isPending}
            >
              {t('cli.revoke')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
