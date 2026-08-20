import {
  DEFAULT_INVITATION_TTL_HOURS,
  type Invitation as InvitationContract,
  type PaginatedResponse,
} from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Drawer, Select, Table, Tag, Tooltip } from 'antd'
import dayjs from 'dayjs'
import {
  Ban,
  Check,
  CircleCheck,
  Copy,
  KeyRound,
  Mail,
  MailOpen,
  Plus,
  ShieldCheck,
  ShieldOff,
  Trash2,
  X,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { message, modal } from '@/lib/antd-static'
import { api } from '@/lib/api'
import { formatApiError } from '@/lib/api-error'
import { copyText } from '@/lib/clipboard'
import { confirm } from '@/lib/confirm'

interface User {
  id: string
  username: string
  displayName: string | null
  /** SSO 用户的邮箱（IdP JWT email claim）；本地 password 用户为 null */
  email: string | null
  /** SSO 用户的 IdP sub claim；本地 password 用户为 null */
  idaasSub: string | null
  role: 'admin' | 'user'
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** Wire shape of an invitation: the shared contract with dates as JSON strings. */
type Invitation = Omit<InvitationContract, 'acceptedAt' | 'expiresAt' | 'createdAt'> & {
  acceptedAt: string | null
  expiresAt: string
  createdAt: string
}

const PAGE_SIZE = 20

/** `?view=` value that opens the invitations drawer. */
const INVITATIONS_VIEW = 'invitations'

/**
 * Client-side email shape check, used only to disable the submit button early.
 * The server's `emailSchema` remains authoritative — this exists so the admin is not made
 * to round-trip to learn they typed a comma.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Build the invitee-facing URL for a code. See InvitationLinkBox for why origin is local. */
function invitationUrl(code: string): string {
  return `${window.location.origin}/invite/${code}`
}

function checkPolicy(password: string) {
  return {
    minLength: password.length >= 8,
    hasUpper: /[A-Z]/.test(password),
    hasLower: /[a-z]/.test(password),
    hasDigit: /\d/.test(password),
  }
}

export function UsersPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const page = Math.max(1, Number.parseInt(searchParams.get('page') ?? '1') || 1)
  const [addOpen, setAddOpen] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetUserId, setResetUserId] = useState<string | null>(null)

  // The invitations drawer lives in the URL rather than in component state, so it can be
  // linked to ("check the pending invites") and survives a reload. Same reason `page` is
  // there: anything an admin might send to a colleague belongs in the address bar.
  const invitationsOpen = searchParams.get('view') === INVITATIONS_VIEW

  const setPage = (nextPage: number) => {
    const next = new URLSearchParams(searchParams)
    if (nextPage <= 1) {
      next.delete('page')
    } else {
      next.set('page', String(nextPage))
    }
    setSearchParams(next)
  }

  const setInvitationsOpen = (open: boolean) => {
    const next = new URLSearchParams(searchParams)
    if (open) {
      next.set('view', INVITATIONS_VIEW)
    } else {
      next.delete('view')
    }
    // Replace rather than push: opening and closing a drawer should not fill the history
    // stack, so Back returns to wherever the admin came from instead of toggling it shut.
    setSearchParams(next, { replace: true })
  }

  const { data: usersData, isLoading } = useQuery({
    queryKey: ['users', page],
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) })
      const res = await fetch(`/api/users?${params}`, { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to fetch users')
      return res.json() as Promise<PaginatedResponse<User>>
    },
  })

  const users = usersData?.data ?? []
  const pagination = usersData?.pagination

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  // Both surface their own failure in a modal below, so they opt out of the global
  // MutationCache toast — otherwise one failed role change notifies twice.
  // `deleteMutation` above deliberately does not: the global toast is its only
  // surface, and opting out would make a failed delete silent.
  const updateRoleMutation = useMutation({
    meta: { handleLocally: true },
    mutationFn: ({ id, role }: { id: string; role: 'admin' | 'user' }) =>
      api.patch(`/users/${id}/role`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  const updateStatusMutation = useMutation({
    meta: { handleLocally: true },
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.patch(`/users/${id}/status`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['users'] }),
  })

  const handleDelete = (user: User) => {
    confirm({
      title: t('users.deleteTitle'),
      content: t('users.deleteContent', { username: user.username }),
      okText: t('common.confirm'),
      danger: true,
      onOk: () => deleteMutation.mutateAsync(user.id),
    })
  }

  const roleLabel = (role: 'admin' | 'user') =>
    role === 'admin' ? t('users.roleAdmin') : t('users.roleUser')

  const handleToggleRole = (user: User) => {
    const next: 'admin' | 'user' = user.role === 'admin' ? 'user' : 'admin'
    confirm({
      title: t('users.changeRoleTitle'),
      content: t('users.changeRoleContent', {
        username: user.username,
        from: roleLabel(user.role),
        to: roleLabel(next),
      }),
      okText: t('common.confirm'),
      danger: next === 'admin',
      onOk: async () => {
        try {
          await updateRoleMutation.mutateAsync({ id: user.id, role: next })
        } catch (err) {
          modal.error({
            title: t('users.changeRoleFailed'),
            content: formatApiError(err, t),
          })
        }
      },
    })
  }

  const handleToggleStatus = (user: User) => {
    const next = !user.isActive
    confirm({
      title: next ? t('users.enableTitle') : t('users.disableTitle'),
      content: next
        ? t('users.enableContent', { username: user.username })
        : t('users.disableContent', { username: user.username }),
      okText: t('common.confirm'),
      danger: !next,
      onOk: async () => {
        try {
          await updateStatusMutation.mutateAsync({ id: user.id, isActive: next })
        } catch (err) {
          modal.error({
            title: t('users.changeStatusFailed'),
            content: formatApiError(err, t),
          })
        }
      },
    })
  }

  const columns = [
    {
      title: t('users.username'),
      dataIndex: 'username',
      key: 'username',
      render: (username: string, record: User) => (
        <div className="flex items-center gap-1.5">
          <span>{username}</span>
          {record.idaasSub && (
            <Tooltip title={t('users.ssoBadgeHint')}>
              <Tag color="cyan" style={{ marginInlineEnd: 0 }}>
                SSO
              </Tag>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      title: t('users.displayName'),
      dataIndex: 'displayName',
      key: 'displayName',
      render: (v: string | null) => v || '-',
    },
    {
      title: (
        <span className="inline-flex items-center gap-1.5">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" /> {t('users.email')}
        </span>
      ),
      dataIndex: 'email',
      key: 'email',
      render: (v: string | null) => v || <span className="text-muted-foreground">-</span>,
    },
    {
      title: t('users.role'),
      dataIndex: 'role',
      key: 'role',
      render: (role: 'admin' | 'user') => (
        <Tag color={role === 'admin' ? 'blue' : 'default'}>{roleLabel(role)}</Tag>
      ),
    },
    {
      title: t('users.status'),
      dataIndex: 'isActive',
      key: 'isActive',
      render: (active: boolean) => (
        <Tag color={active ? 'green' : 'default'}>
          {active ? t('common.enabled') : t('common.disabled')}
        </Tag>
      ),
    },
    {
      title: t('users.createdAt'),
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm'),
    },
    {
      title: t('users.actions'),
      key: 'actions',
      render: (_: unknown, record: User) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => handleToggleRole(record)}
          >
            {record.role === 'admin' ? (
              <ShieldOff className="h-3.5 w-3.5" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            {record.role === 'admin' ? t('users.demoteToUser') : t('users.promoteToAdmin')}
          </Button>
          {/* Disable stays available for admins too: a departing administrator is this
              feature's most real use case. "Cannot disable the last admin" is enforced by
              the backend gate rather than by hiding the button. */}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => handleToggleStatus(record)}
          >
            {record.isActive ? (
              <Ban className="h-3.5 w-3.5" />
            ) : (
              <CircleCheck className="h-3.5 w-3.5" />
            )}
            {record.isActive ? t('users.disable') : t('users.enable')}
          </Button>
          {/* SSO-only 用户 (passwordHash=null) 没法重置密码，UI 上隐藏 */}
          {!record.idaasSub && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => {
                setResetUserId(record.id)
                setResetOpen(true)
              }}
            >
              <KeyRound className="h-3.5 w-3.5" />
              {t('users.resetPassword')}
            </Button>
          )}
          {record.role !== 'admin' && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-destructive"
              onClick={() => handleDelete(record)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t('users.delete')}
            </Button>
          )}
        </div>
      ),
    },
  ]

  return (
    <>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t('users.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('users.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setInvitationsOpen(true)}>
            <MailOpen className="h-4 w-4" />
            {t('users.viewInvitations')}
          </Button>
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            {t('users.inviteUser')}
          </Button>
        </div>
      </div>

      <Table
        dataSource={users}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={false}
        // Dim disabled rows so dead accounts are obvious at a glance, without having to
        // read the status tag on every row
        rowClassName={(record: User) => (record.isActive ? '' : 'opacity-60')}
      />

      {pagination && (
        <Pagination
          className="mt-4"
          pagination={pagination}
          onPageChange={setPage}
          totalLabel={t('users.paginationTotal', { total: pagination.total })}
          previousLabel={t('users.prevPage')}
          nextLabel={t('users.nextPage')}
        />
      )}

      <InvitationsDrawer open={invitationsOpen} onOpenChange={setInvitationsOpen} />
      <InviteUserDialog open={addOpen} onOpenChange={setAddOpen} />
      <ResetPasswordDialog open={resetOpen} onOpenChange={setResetOpen} userId={resetUserId} />
    </>
  )
}

const INVITATION_STATUS_COLOR: Record<Invitation['status'], string> = {
  pending: 'blue',
  accepted: 'green',
  expired: 'default',
  revoked: 'default',
}

/**
 * Outstanding and historical invitations, in a drawer beside the roster.
 *
 * The page's subject is the user list; invitations are the occasional follow-up ("did they
 * sign up yet?"), so they sit one click away rather than pushing the roster up the page. The
 * drawer keeps the answer next to the list instead of on a route of its own.
 */
function InvitationsDrawer({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: invitations, isLoading } = useQuery({
    queryKey: ['user-invitations'],
    queryFn: () => api.get<Invitation[]>('/users/invitations').then((res) => res.data),
    // Only fetched once the drawer is opened: the roster is the page's job, and an
    // invitations request on every visit would be work nobody asked for.
    enabled: open,
  })

  const revokeMutation = useMutation({
    meta: { handleLocally: true },
    mutationFn: (id: string) => api.post(`/users/invitations/${id}/revoke`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['user-invitations'] }),
    onError: (err) => message.error(formatApiError(err, t)),
  })

  const copyLink = async (code: string) => {
    // Via copyText: navigator.clipboard is absent on a plain-HTTP origin, where this
    // used to report a failure it could actually have avoided.
    if (await copyText(invitationUrl(code))) {
      message.success(t('users.inviteCopied'))
    } else {
      message.error(t('users.inviteCopyFailed'))
    }
  }

  const columns = [
    {
      title: t('users.inviteEmail'),
      dataIndex: 'email',
      key: 'email',
      render: (email: string | null) =>
        email ? (
          <span className="text-foreground">{email}</span>
        ) : (
          // An unpinned link has no address to show; saying so beats an empty cell that
          // reads as missing data.
          <span className="text-muted-foreground">{t('users.inviteAnyEmail')}</span>
        ),
    },
    {
      title: t('users.role'),
      dataIndex: 'role',
      key: 'role',
      render: (role: 'admin' | 'user') => (
        <Tag color={role === 'admin' ? 'gold' : 'default'}>
          {role === 'admin' ? t('users.roleAdmin') : t('users.roleUser')}
        </Tag>
      ),
    },
    {
      title: t('users.status'),
      dataIndex: 'status',
      key: 'status',
      render: (status: Invitation['status']) => (
        <Tag color={INVITATION_STATUS_COLOR[status]}>{t(`users.inviteStatus.${status}`)}</Tag>
      ),
    },
    {
      title: t('users.inviteExpiresAt'),
      dataIndex: 'expiresAt',
      key: 'expiresAt',
      render: (expiresAt: string) => (
        <span className="text-sm text-muted-foreground">
          {dayjs(expiresAt).format('YYYY-MM-DD HH:mm')}
        </span>
      ),
    },
    {
      title: t('users.inviteInvitedBy'),
      dataIndex: 'invitedByName',
      key: 'invitedByName',
      render: (name: string | null) => (
        <span className="text-sm text-muted-foreground">{name ?? '-'}</span>
      ),
    },
    {
      title: t('users.actions'),
      key: 'actions',
      render: (_: unknown, record: Invitation) =>
        // Copy and revoke only make sense while the link can still be used; showing them on
        // a spent or expired row would offer an action that does nothing.
        record.status === 'pending' ? (
          <div className="flex items-center gap-1">
            {/* Icon-only controls: the tooltip is a hover affordance and leaves the button
                nameless to a screen reader, so each carries its own aria-label. */}
            <Tooltip title={t('users.inviteCopyLink')}>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('users.inviteCopyLink')}
                onClick={() => copyLink(record.code)}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </Tooltip>
            <Tooltip title={t('users.inviteRevoke')}>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t('users.inviteRevoke')}
                onClick={async () => {
                  const ok = await confirm({
                    title: t('users.inviteRevokeTitle'),
                    content: t('users.inviteRevokeContent'),
                  })
                  if (ok) revokeMutation.mutate(record.id)
                }}
              >
                <Ban className="h-4 w-4 text-destructive" />
              </Button>
            </Tooltip>
          </div>
        ) : null,
    },
  ]

  return (
    <Drawer
      open={open}
      onClose={() => onOpenChange(false)}
      placement="right"
      // Wider than a detail drawer: this is a six-column table, and a narrow panel would
      // wrap the email and the timestamp onto two lines each.
      width={760}
      title={t('users.invitationsTitle')}
      destroyOnHidden
    >
      <p className="mb-4 text-sm text-muted-foreground">{t('users.invitationsSubtitle')}</p>
      <Table
        dataSource={invitations ?? []}
        columns={columns}
        rowKey="id"
        loading={isLoading}
        pagination={false}
        size="small"
        locale={{ emptyText: t('users.invitationsEmpty') }}
        rowClassName={(record: Invitation) => (record.status === 'pending' ? '' : 'opacity-60')}
      />
    </Drawer>
  )
}

/**
 * Issue an invitation link.
 *
 * Deliberately does not create the account: the admin chooses the role and the deadline,
 * the invitee chooses their own username, email and password. So this dialog's success
 * state is a *link to copy*, not a closed dialog — closing on success would discard the one
 * thing the admin came here for.
 */
function InviteUserDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'admin' | 'user'>('user')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [issued, setIssued] = useState<Invitation | null>(null)

  const emailValid = !email || EMAIL_PATTERN.test(email.trim())

  const reset = () => {
    setEmail('')
    setRole('user')
    setNote('')
    setError('')
    setIssued(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  const mutation = useMutation({
    meta: { handleLocally: true },
    // No expiresInHours: the console offers no choice, so it lets the shared schema's
    // default apply rather than restating the value and letting the two drift apart.
    mutationFn: (data: { email?: string; role: 'admin' | 'user'; note?: string }) =>
      api.post<Invitation>('/users/invitations', data).then((res) => res.data),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['user-invitations'] })
      setIssued(created)
      setError('')
    },
  })

  const handleSubmit = async () => {
    setError('')
    if (!emailValid) return
    try {
      await mutation.mutateAsync({
        email: email.trim() || undefined,
        role,
        note: note.trim() || undefined,
      })
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  return (
    // 720 is the app's common wide-dialog size (the most-used width in the codebase);
    // reused rather than picked per-dialog so modals do not each land on their own value.
    <Dialog open={open} onOpenChange={handleOpenChange} width={720}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('users.inviteUser')}</DialogTitle>
          <DialogDescription>
            {issued
              ? t('users.inviteCreatedDesc')
              : // The validity is fixed, so it is stated once up front rather than offered as
                // a choice the admin has to make on every invitation.
                t('users.inviteUserDesc', { hours: DEFAULT_INVITATION_TTL_HOURS })}
          </DialogDescription>
        </DialogHeader>

        {issued ? (
          <div className="mt-4 space-y-3">
            <InvitationLinkBox invitation={issued} />
            <div className="info-panel px-3 py-2.5 text-xs text-muted-foreground">
              {t('users.inviteLinkHint', {
                expiresAt: dayjs(issued.expiresAt).format('YYYY-MM-DD HH:mm'),
              })}
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="invite-email">
                {t('users.inviteEmail')}
              </label>
              <Input
                id="invite-email"
                className="mt-1"
                type="email"
                placeholder={t('users.inviteEmailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <p className="mt-1 text-xs text-muted-foreground">{t('users.inviteEmailHint')}</p>
              {!emailValid && (
                <p className="mt-1 text-xs text-destructive">{t('users.inviteEmailInvalid')}</p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="invite-role">
                {t('users.role')}
              </label>
              <Select
                id="invite-role"
                className="mt-1 w-full"
                value={role}
                onChange={(next: 'admin' | 'user') => setRole(next)}
                options={[
                  { value: 'user', label: t('users.roleUser') },
                  { value: 'admin', label: t('users.roleAdmin') },
                ]}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-foreground" htmlFor="invite-note">
                {t('users.inviteNote')}
              </label>
              <Input
                id="invite-note"
                className="mt-1"
                placeholder={t('users.inviteNotePlaceholder')}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {error && (
              <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-600">{error}</div>
            )}
          </div>
        )}

        <DialogFooter>
          {issued ? (
            <Button onClick={() => handleOpenChange(false)}>{t('common.close')}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button loading={mutation.isPending} disabled={!emailValid} onClick={handleSubmit}>
                {t('users.createInvite')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The generated link plus a copy button.
 *
 * The link is built from `window.location.origin` rather than returned by the API: the
 * server has no reliable idea which host the admin reached it on (proxies, port forwards,
 * multiple ingress names), and a link pointing at the wrong origin is worse than none.
 */
function InvitationLinkBox({ invitation }: { invitation: Invitation }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const url = invitationUrl(invitation.code)

  const handleCopy = async () => {
    if (await copyText(url)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } else {
      message.error(t('users.inviteCopyFailed'))
    }
  }

  return (
    <div className="flex items-center gap-2">
      <code className="flex-1 truncate rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
        {url}
      </code>
      <Button variant="outline" onClick={handleCopy} aria-label={t('users.inviteCopyLink')}>
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        {copied ? t('users.inviteCopied') : t('common.copy')}
      </Button>
    </div>
  )
}

function ResetPasswordDialog({
  open,
  onOpenChange,
  userId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string | null
}) {
  const { t } = useTranslation()
  const [newPassword, setNewPassword] = useState('')
  const [error, setError] = useState('')

  const policy = checkPolicy(newPassword)
  const allValid = policy.minLength && policy.hasUpper && policy.hasLower && policy.hasDigit

  const mutation = useMutation({
    meta: { handleLocally: true },
    mutationFn: (data: { newPassword: string }) =>
      api.post(`/users/${userId}/reset-password`, data),
  })

  const handleSubmit = async () => {
    setError('')
    if (!allValid) return
    try {
      await mutation.mutateAsync({ newPassword })
      onOpenChange(false)
      setNewPassword('')
      setError('')
    } catch (err) {
      setError(formatApiError(err, t))
    }
  }

  const PolicyItem = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className="flex items-center gap-1.5 text-xs">
      {ok ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <X className="h-3.5 w-3.5 text-muted-foreground/40" />
      )}
      <span className={ok ? 'text-emerald-600' : 'text-muted-foreground'}>{label}</span>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('users.resetPasswordTitle')}</DialogTitle>
          <DialogDescription>{t('users.resetPasswordDesc')}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-sm font-medium text-foreground" htmlFor="reset-new-password">
              {t('auth.newPassword')}
              <span className="ml-0.5 text-destructive" aria-hidden="true">
                *
              </span>
            </label>
            <Input
              id="reset-new-password"
              type="password"
              className="mt-1"
              placeholder={t('auth.newPasswordPlaceholder')}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>

          {newPassword.length > 0 && (
            <div className="info-panel px-3 py-2.5 space-y-1">
              <PolicyItem ok={policy.minLength} label={t('auth.policyMinLength')} />
              <PolicyItem ok={policy.hasUpper} label={t('auth.policyUppercase')} />
              <PolicyItem ok={policy.hasLower} label={t('auth.policyLowercase')} />
              <PolicyItem ok={policy.hasDigit} label={t('auth.policyDigit')} />
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-600">{error}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button loading={mutation.isPending} disabled={!allValid} onClick={handleSubmit}>
            {t('users.resetPassword')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
