import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useAuthStatus, useCurrentUser } from '@/hooks/use-auth'
import { buildLoginRedirect } from '@/lib/api'

export function AuthGuard({ children }: { children: ReactNode }) {
  const { data: status, isLoading: statusLoading } = useAuthStatus()
  const { data: user, isLoading: userLoading, isError } = useCurrentUser()
  const location = useLocation()

  if (statusLoading) {
    return <LoadingScreen />
  }

  // Need setup? Redirect to setup page
  if (status?.needSetup) {
    return <Navigate to="/setup" replace />
  }

  // 真源：GET /auth/me 是否返回 200。cookie 不存在 / 失效 / tokenVersion 不匹配都会 401。
  if (userLoading) {
    return <LoadingScreen />
  }
  if (isError || !user) {
    // Carry the target so a shared link survives the login round-trip. This is the
    // normal way someone reaches the chat page: follow a colleague's link, sign in,
    // and land on the page they were sent — not on the dashboard. Built by the same
    // helper the 401 handler uses, since either navigation may be the one that wins.
    return <Navigate to={buildLoginRedirect(location.pathname, location.search)} replace />
  }

  return <>{children}</>
}

function LoadingScreen() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background">
      <div className="flex items-center gap-2 text-muted-foreground">
        <div className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </div>
    </div>
  )
}
