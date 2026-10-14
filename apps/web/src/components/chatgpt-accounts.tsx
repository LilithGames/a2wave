import type { ProviderOauthAccount } from '@a2wave/shared'
import { useQueryClient } from '@tanstack/react-query'
import { Select } from 'antd'
import { Copy, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  oauthAccountsKey,
  type ProviderOauthLogin,
  useDeleteProviderOauthAccount,
  useProviderOauthAccounts,
  useProviderOauthLoginStatus,
  useStartProviderOauthLogin,
  useUpdateProviderOauthAccount,
} from '@/hooks/use-provider-oauth-accounts'
import { message } from '@/lib/antd-static'
import { copyText } from '@/lib/clipboard'
import { confirm } from '@/lib/confirm'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'
import { Label } from './ui/label'

function accountName(account: ProviderOauthAccount): string {
  return account.label || account.email || account.id
}

/** The loopback listener belongs to the CLI on the browser's computer. */
function ChatGPTLoginDialog({
  providerId,
  account,
  onClose,
  onConnected,
}: {
  providerId: string
  account?: ProviderOauthAccount
  onClose: () => void
  onConnected?: (accountId: string) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [label, setLabel] = useState('')
  const [login, setLogin] = useState<ProviderOauthLogin | null>(null)
  const handledLogin = useRef<string | null>(null)
  const start = useStartProviderOauthLogin(providerId)
  const status = useProviderOauthLoginStatus(providerId, login?.loginId)
  const terminal = status.data?.status === 'failed' || status.data?.status === 'expired'
  // The secret is kept only in this mounted dialog, never in a URL or CLI argv.
  const server = new URL('/api', window.location.origin).href
  const command = login
    ? `a2wave providers accounts login --server ${server} --login-id ${login.loginId}`
    : ''

  useEffect(() => {
    if (
      status.data?.status !== 'completed' ||
      !status.data.accountId ||
      !login ||
      handledLogin.current === login.loginId
    )
      return
    handledLogin.current = login.loginId
    void queryClient.invalidateQueries({ queryKey: oauthAccountsKey(providerId) })
    onConnected?.(status.data.accountId)
    onClose()
  }, [status.data, login, providerId, queryClient, onConnected, onClose])

  const startLogin = async () => {
    try {
      const result = await start.mutateAsync(
        account ? { accountId: account.id } : label.trim() ? { label: label.trim() } : {},
      )
      setLogin(result)
    } catch {
      // The mutation's error state renders below without printing credentials.
    }
  }

  const copy = async (value: string) => {
    try {
      if (!(await copyText(value))) throw new Error('copy_failed')
      message.success(t('chatgptAccounts.copied'))
    } catch {
      message.error(t('chatgptAccounts.copyFailed'))
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} width={640}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {account ? t('chatgptAccounts.reconnect') : t('chatgptAccounts.connect')}
          </DialogTitle>
          <DialogDescription>{t('chatgptAccounts.loginDescription')}</DialogDescription>
        </DialogHeader>
        <div className="mt-5 space-y-4">
          {account ? (
            <p className="text-sm text-foreground">
              {t('chatgptAccounts.reconnectAccount', { account: accountName(account) })}
            </p>
          ) : !login ? (
            <div className="space-y-2">
              <Label htmlFor="chatgpt-account-label">{t('chatgptAccounts.labelOptional')}</Label>
              <Input
                id="chatgpt-account-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={100}
              />
            </div>
          ) : null}
          <p className="text-sm text-muted-foreground">{t('chatgptAccounts.sharedUsage')}</p>
          {login && !terminal ? (
            <div className="space-y-3">
              <p className="text-sm text-foreground">{t('chatgptAccounts.localCommandHint')}</p>
              <div className="flex items-start gap-2">
                <pre
                  data-testid="chatgpt-login-command"
                  className="min-w-0 flex-1 whitespace-pre-wrap break-all rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm"
                >
                  {command}
                </pre>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label={t('chatgptAccounts.copyCommand')}
                  onClick={() => void copy(command)}
                >
                  <Copy className="size-4" />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">{t('chatgptAccounts.codeHint')}</p>
              <Button
                type="button"
                variant="outline"
                data-testid="chatgpt-copy-code"
                onClick={() => void copy(login.loginToken)}
              >
                <Copy className="size-4" />
                {t('chatgptAccounts.copyCode')}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('chatgptAccounts.expires', {
                  time: new Date(login.expiresAt).toLocaleTimeString(),
                })}
              </p>
              <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                <Loader2 className="size-4 animate-spin" />
                {t(
                  status.data?.status === 'started'
                    ? 'chatgptAccounts.authorizing'
                    : 'chatgptAccounts.waiting',
                )}
              </p>
            </div>
          ) : null}
          {start.isError || status.isError || terminal ? (
            <div
              role="alert"
              className="space-y-2 rounded-lg border border-destructive/30 bg-destructive-subtle px-3 py-2.5 text-sm text-destructive"
            >
              <p>
                {t(
                  terminal
                    ? status.data?.status === 'expired'
                      ? 'chatgptAccounts.loginExpired'
                      : 'chatgptAccounts.loginFailed'
                    : status.isError
                      ? 'chatgptAccounts.statusFailed'
                      : 'chatgptAccounts.startFailed',
                )}
              </p>
              {status.isError ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void status.refetch()}
                >
                  {t('common.retry')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.close')}
          </Button>
          {!login || terminal ? (
            <Button
              type="button"
              data-testid="chatgpt-generate-code"
              disabled={start.isPending}
              onClick={() => void startLogin()}
            >
              {start.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('chatgptAccounts.generateCode')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AccountLoadError({ retry }: { retry: () => void }) {
  const { t } = useTranslation()
  return (
    <div role="alert" className="space-y-2 text-sm text-destructive">
      <p>{t('chatgptAccounts.loadFailed')}</p>
      <Button type="button" variant="outline" size="sm" onClick={retry}>
        {t('common.retry')}
      </Button>
    </div>
  )
}

export function ChatGPTAccountPicker({
  providerId,
  value,
  onChange,
}: {
  providerId: string
  value?: string
  onChange: (accountId: string) => void
}) {
  const { t } = useTranslation()
  const accounts = useProviderOauthAccounts(providerId)
  const [loginOpen, setLoginOpen] = useState(false)
  const options = (accounts.data ?? []).map((account) => ({
    value: account.id,
    label: `${accountName(account)}${account.email && account.email !== account.label ? ` · ${account.email}` : ''} · ${t(`chatgptAccounts.status.${account.status}`)}`,
  }))
  if (value && !options.some((option) => option.value === value)) {
    options.unshift({ value, label: t('chatgptAccounts.unavailableAccount', { id: value }) })
  }
  return (
    <div className="space-y-2">
      <Label required>{t('chatgptAccounts.account')}</Label>
      {accounts.isError ? <AccountLoadError retry={() => void accounts.refetch()} /> : null}
      <div className="flex flex-wrap gap-2">
        <Select
          data-testid="chatgpt-account-picker"
          aria-label={t('chatgptAccounts.account')}
          className="min-w-48 flex-1"
          showSearch
          optionFilterProp="label"
          value={value || undefined}
          placeholder={t('chatgptAccounts.selectAccount')}
          loading={accounts.isLoading}
          options={options}
          onChange={onChange}
        />
        <Button
          type="button"
          variant="outline"
          data-testid="chatgpt-connect-button"
          onClick={() => setLoginOpen(true)}
        >
          <Plus className="size-4" />
          {t('chatgptAccounts.connect')}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('chatgptAccounts.sharedUsage')}</p>
      <p className="text-xs text-muted-foreground">{t('chatgptAccounts.saveBindingHint')}</p>
      {loginOpen ? (
        <ChatGPTLoginDialog
          providerId={providerId}
          onClose={() => setLoginOpen(false)}
          onConnected={onChange}
        />
      ) : null}
    </div>
  )
}

export function ChatGPTAccountsCard({ providerId }: { providerId: string }) {
  const { t } = useTranslation()
  const accounts = useProviderOauthAccounts(providerId)
  const update = useUpdateProviderOauthAccount(providerId)
  const remove = useDeleteProviderOauthAccount(providerId)
  const [loginTarget, setLoginTarget] = useState<ProviderOauthAccount | 'new' | null>(null)
  const [renameTarget, setRenameTarget] = useState<ProviderOauthAccount | null>(null)
  const [label, setLabel] = useState('')

  const deleteAccount = (account: ProviderOauthAccount) =>
    confirm({
      title: t('chatgptAccounts.deleteTitle'),
      content: t('chatgptAccounts.deleteHint', { account: accountName(account) }),
      okText: t('common.delete'),
      danger: true,
      onOk: async () => {
        try {
          await remove.mutateAsync(account.id)
        } catch {
          message.error(t('chatgptAccounts.deleteFailed'))
        }
      },
    })

  return (
    <Card data-testid="chatgpt-accounts-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>{t('chatgptAccounts.title')}</CardTitle>
          <Button
            type="button"
            variant="outline"
            data-testid="chatgpt-connect-button"
            onClick={() => setLoginTarget('new')}
          >
            <Plus className="size-4" />
            {t('chatgptAccounts.connect')}
          </Button>
        </div>
        <CardDescription>{t('chatgptAccounts.sharedUsage')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {accounts.isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : accounts.isError ? (
          <AccountLoadError retry={() => void accounts.refetch()} />
        ) : !accounts.data?.length ? (
          <p className="text-sm text-muted-foreground">{t('chatgptAccounts.empty')}</p>
        ) : (
          accounts.data.map((account) => (
            <div
              key={account.id}
              data-testid={`chatgpt-account-row-${account.id}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="break-all text-sm font-medium text-foreground">
                    {accountName(account)}
                  </p>
                  <Badge variant="secondary">{t(`chatgptAccounts.status.${account.status}`)}</Badge>
                </div>
                {account.email ? (
                  <p className="break-all text-xs text-muted-foreground">{account.email}</p>
                ) : null}
                <p className="break-all text-xs text-muted-foreground">{account.id}</p>
              </div>
              {account.canManage ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setRenameTarget(account)
                      setLabel(account.label ?? '')
                    }}
                  >
                    {t('chatgptAccounts.rename')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setLoginTarget(account)}
                  >
                    <RefreshCw className="size-3.5" />
                    {t('chatgptAccounts.reconnect')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={remove.isPending}
                    onClick={() => deleteAccount(account)}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              ) : null}
            </div>
          ))
        )}
      </CardContent>
      {loginTarget ? (
        <ChatGPTLoginDialog
          providerId={providerId}
          account={loginTarget === 'new' ? undefined : loginTarget}
          onClose={() => setLoginTarget(null)}
        />
      ) : null}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('chatgptAccounts.rename')}</DialogTitle>
          </DialogHeader>
          <Input
            className="mt-4"
            aria-label={t('chatgptAccounts.label')}
            value={label}
            maxLength={100}
            onChange={(event) => setLabel(event.target.value)}
          />
          {update.isError ? (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {t('chatgptAccounts.renameFailed')}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={!label.trim() || update.isPending}
              onClick={async () => {
                if (!renameTarget) return
                try {
                  await update.mutateAsync({ accountId: renameTarget.id, label: label.trim() })
                  setRenameTarget(null)
                } catch {
                  /* The mutation error is shown in the dialog. */
                }
              }}
            >
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
