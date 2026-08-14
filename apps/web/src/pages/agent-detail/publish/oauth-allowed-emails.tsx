// Email allowlist editor for the OAuth channel's `specified_users` access mode.
//
// Search picks colleagues out of the directory (the same `/user-lookup` endpoint the members
// dialog uses), but a raw address can also be typed in directly: the allowlist is matched
// against the *IdP's* email claim, so it legitimately contains people who have never signed
// into a2wave and therefore have no local row to look up.
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  OAUTH_ALLOWED_EMAILS_MAX,
  normalizeOauthAllowedEmail,
  oauthAllowedEmailSchema,
} from '@a2wave/shared'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface LookupRow {
  id: string
  username: string
  displayName?: string | null
  email?: string | null
}

interface OauthAllowedEmailsProps {
  emails: string[]
  onChange: (next: string[]) => void
  /** Read-only for a viewer: they can see who is allowed but must not edit a list they cannot save. */
  disabled?: boolean
}

export function OauthAllowedEmails({ emails, onChange, disabled }: OauthAllowedEmailsProps) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [errorKey, setErrorKey] = useState<string | null>(null)

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedQ(q), 300)
    return () => window.clearTimeout(handle)
  }, [q])

  const lookupQuery = useQuery({
    queryKey: ['user-lookup', debouncedQ],
    queryFn: () =>
      api.get<LookupRow[]>(`/user-lookup?q=${encodeURIComponent(debouncedQ)}&limit=10`),
    enabled: debouncedQ.trim().length > 0,
  })

  const listed = useMemo(() => new Set(emails.map(normalizeOauthAllowedEmail)), [emails])
  const lookupRows = (lookupQuery.data?.data ?? []).filter((row) => !!row.email)

  const add = (raw: string) => {
    // Validate with the *server's* schema, not a looser local regex. A local pattern that let
    // `a@b.c` become a chip only moved the rejection to publish time, where it surfaces as a
    // bare 400 with no indication of which address is at fault.
    const parsed = oauthAllowedEmailSchema.safeParse(raw)
    if (!parsed.success) {
      setErrorKey('agentPublish.oauthAllowedEmailsInvalid')
      return
    }
    const email = parsed.data
    if (listed.has(email)) {
      setErrorKey('agentPublish.oauthAllowedEmailsDuplicate')
      return
    }
    if (emails.length >= OAUTH_ALLOWED_EMAILS_MAX) {
      setErrorKey('agentPublish.oauthAllowedEmailsMax')
      return
    }
    setErrorKey(null)
    onChange([...emails, email])
    setQ('')
    setDebouncedQ('')
  }

  const remove = (email: string) => {
    setErrorKey(null)
    onChange(
      emails.filter((e) => normalizeOauthAllowedEmail(e) !== normalizeOauthAllowedEmail(email)),
    )
  }

  return (
    <div className="flex flex-col gap-2" data-testid="oauth-allowed-emails">
      <Label className="text-sm font-medium text-foreground">
        {t('agentPublish.oauthAllowedEmails')}
      </Label>

      {/* Enter alone is not enough: an owner who types an address and goes straight for
          "Publish" would otherwise have it silently dropped — the text sits visibly in the box
          while the saved list does not contain it. The button makes the pending state
          actionable, and stays enabled precisely when there is something to add. */}
      <div className="flex items-start gap-2">
        <div className="relative flex-1 min-w-0">
          <Search
            className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={q}
            disabled={disabled}
            onChange={(e) => {
              setQ(e.target.value)
              setErrorKey(null)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // The field doubles as a free-text entry, so Enter must not submit the
              // surrounding publish form on the way to adding an address.
              e.preventDefault()
              if (q.trim()) add(q)
            }}
            placeholder={t('agentPublish.oauthAllowedEmailsPlaceholder')}
            className="pl-7"
            data-testid="oauth-email-input"
            aria-label={t('agentPublish.oauthAllowedEmails')}
          />

          {debouncedQ.trim().length > 0 && lookupRows.length > 0 && (
            <div
              className="absolute z-20 mt-1 w-full rounded-md border border-border bg-card shadow-md max-h-60 overflow-auto"
              data-testid="oauth-email-lookup-list"
            >
              {lookupRows.map((row) => {
                const email = normalizeOauthAllowedEmail(row.email as string)
                const already = listed.has(email)
                return (
                  <button
                    type="button"
                    key={row.id}
                    disabled={already}
                    data-testid={`oauth-email-lookup-row-${row.id}`}
                    onClick={() => add(email)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors',
                      'hover:bg-surface-hover focus-visible:outline-none focus-visible:bg-muted',
                      already && 'opacity-60',
                    )}
                  >
                    <span className="font-medium">{row.displayName || row.username}</span>
                    <span className="text-xs text-muted-foreground">{email}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || !q.trim()}
          onClick={() => add(q)}
          data-testid="oauth-email-add"
        >
          {t('agentPublish.oauthAllowedEmailsAdd')}
        </Button>
      </div>

      {errorKey && (
        <div className="flex items-start gap-2 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{t(errorKey, { max: OAUTH_ALLOWED_EMAILS_MAX })}</span>
        </div>
      )}

      {emails.length === 0 ? (
        /* `warning-foreground` is the color for text sitting ON a solid warning fill
           (white in both light themes), so over a 10% tint it rendered white-on-near-white.
           Match the shared warning-notice recipe used elsewhere: subtle fill, warning
           hairline, `text-warning` copy with the icon tinted the same. */
        <div
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-xs text-warning"
          data-testid="oauth-allowed-emails-empty"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{t('agentPublish.oauthAllowedEmailsEmpty')}</span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {emails.map((email) => (
            <span
              key={email}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs"
              data-testid={`oauth-allowed-email-${email}`}
            >
              {email}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled}
                className="h-4 w-4"
                onClick={() => remove(email)}
                aria-label={`${t('agentPublish.oauthAllowedEmailsRemove')} ${email}`}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </Button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
