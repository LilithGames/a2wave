import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'
import i18n from '@/i18n'

/**
 * tailwind-merge only knows the stock scale, so a custom `--text-*` rung reads
 * to it as an unknown `text-*` — which it classifies as a colour utility and
 * drops against a real one like `text-foreground`. The size then silently
 * vanishes at runtime while the source still reads as though it applied.
 * Every custom font-size rung added in globals.css must be listed here.
 */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': ['text-dialog-title'] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Generate a unique ID, with fallback for non-secure contexts (e.g. LAN HTTP) */
export function uniqueId(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
}

export function formatRelativeTime(date: Date | string | number | null | undefined): string {
  if (date == null) return i18n.t('time.never')

  const d =
    date instanceof Date
      ? date
      : new Date(typeof date === 'number' && date < 1e12 ? date * 1000 : date)
  if (Number.isNaN(d.getTime())) return i18n.t('time.never')

  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return i18n.t('time.justNow')
  if (diffMin < 60) return i18n.t('time.minutesAgo', { count: diffMin })
  if (diffHour < 24) return i18n.t('time.hoursAgo', { count: diffHour })
  if (diffDay < 7) return i18n.t('time.daysAgo', { count: diffDay })

  return new Intl.DateTimeFormat(i18n.t('time.absoluteDateLocale'), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d)
}

/** Human-readable duration: `850ms` / `4.2s` / `1m 30s`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const remaining = Math.round(sec % 60)
  return `${min}m ${remaining}s`
}
