import type { ApiResponse, PaginatedResponse } from '@a2wave/shared'

const API_BASE = '/api'

/**
 * 401 不踢去 /login 的公开路由：登录/引导/回调本就匿名可达；/share-login 是分享访客
 * 在拉起企业 SSO 前的中转页，挂载时会探 /auth/me（经 useLocale），无痕下必 401——
 * 若不豁免就会在 SSO 跳转前被踢回 /login，分享登录永远走不通。
 */
const AUTH_REDIRECT_EXEMPT = new Set(['/login', '/setup', '/share-login'])

/**
 * 同样豁免、但路径带参数所以无法用集合精确匹配的公开路由。
 * /invite/:code 是受邀人注册页：此时对方本就没有账号，把 401 踢去 /login 只会让邀请链接
 * 永远走不到注册表单。
 */
const AUTH_REDIRECT_EXEMPT_PREFIXES = ['/invite/']

/** Exported for tests: getting this wrong silently breaks a whole public entry point. */
export function isAuthRedirectExempt(pathname: string): boolean {
  return (
    AUTH_REDIRECT_EXEMPT.has(pathname) ||
    AUTH_REDIRECT_EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  )
}

/**
 * The single /login URL builder: the 401 handler below and AuthGuard's
 * `<Navigate>` race each other on the same page load, so both have to carry the
 * same returnTo. LoginPage validates the value through `safeReturnTo()`.
 */
export function buildLoginRedirect(pathname: string, search = ''): string {
  return `/login?returnTo=${encodeURIComponent(`${pathname}${search}`)}`
}

/**
 * A 401 sends the browser to /login carrying the page it was on. The plain
 * `/login` navigation this replaces was a full-page load, so it won out over the
 * `<Navigate to="/login?returnTo=…">` AuthGuard renders concurrently — and a
 * shared deep link (a chat page, a run) landed on the dashboard after signing in.
 */
function redirectToLogin(): void {
  const { pathname, search } = window.location
  if (isAuthRedirectExempt(pathname)) return

  window.location.href = buildLoginRedirect(pathname, search)
}

/**
 * 浏览器认证态走 HttpOnly cookie（API 写入），fetch 用 credentials: 'include' 自动携带。
 * 这里不再读写 localStorage —— XSS 也偷不到 token。
 */
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> =
    options?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      headers: { ...headers, ...((options?.headers as Record<string, string>) ?? {}) },
      ...options,
    })
  } catch {
    throw new Error('NETWORK_ERROR')
  }

  if (!res.ok) {
    if (res.status === 401) {
      redirectToLogin()
    }

    const body = await res.json().catch(() => null)
    const errorCode = body && typeof body.error === 'string' ? body.error : `HTTP_${res.status}`

    throw new Error(errorCode)
  }

  return res.json()
}

export const api = {
  get: <T>(path: string) => request<ApiResponse<T>>(path),
  list: <T>(path: string) => request<PaginatedResponse<T>>(path),

  post: <T>(path: string, data?: unknown) =>
    request<ApiResponse<T>>(path, {
      method: 'POST',
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),

  put: <T>(path: string, data: unknown) =>
    request<ApiResponse<T>>(path, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  patch: <T>(path: string, data: unknown) =>
    request<ApiResponse<T>>(path, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  delete: <T>(path: string) => request<ApiResponse<T>>(path, { method: 'DELETE' }),

  upload: <T>(path: string, formData: FormData) =>
    request<ApiResponse<T>>(path, {
      method: 'POST',
      body: formData,
    }),

  text: async (path: string): Promise<string> => {
    let res: Response
    try {
      res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
    } catch {
      throw new Error('NETWORK_ERROR')
    }

    if (!res.ok) {
      if (res.status === 401) {
        redirectToLogin()
      }
      throw new Error(`HTTP_${res.status}`)
    }

    return res.text()
  },
}
