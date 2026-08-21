import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

interface StatCardProps {
  /** Card title (already translated). */
  title: ReactNode
  /** Icon node, e.g. `<Activity className="h-4 w-4 text-interactive-foreground" />`. */
  icon: ReactNode
  /** Tailwind classes for the icon tile background, e.g. `bg-success-subtle`. */
  iconTileClass: string
  /** Main metric value. */
  value: ReactNode
  /** Optional sub-line under the value. */
  hint?: ReactNode
  /** When true, renders a skeleton in place of value/hint. */
  loading?: boolean
  /** When set, the whole card becomes a link. */
  to?: string
}

/**
 * Shared KPI stat card used by the global dashboard and the per-agent overview tab.
 */
export function StatCard({ title, icon, iconTileClass, value, hint, loading, to }: StatCardProps) {
  const card = (
    <Card
      className={
        to
          ? 'group-hover:border-primary/15 group-hover:shadow-md transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          : undefined
      }
    >
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        <div className={`flex size-9 items-center justify-center rounded-xl ${iconTileClass}`}>
          {icon}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-24" />
          </div>
        ) : (
          <>
            <div className="text-[28px] font-semibold tabular-nums text-foreground leading-none">
              {value}
            </div>
            {hint != null && <p className="text-xs text-muted-foreground mt-2">{hint}</p>}
          </>
        )}
      </CardContent>
    </Card>
  )

  return to ? (
    <Link to={to} className="group">
      {card}
    </Link>
  ) : (
    card
  )
}
