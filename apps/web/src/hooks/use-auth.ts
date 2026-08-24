import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { api } from '@/lib/api'

/**
 * 浏览器认证态走 HttpOnly cookie，前端不再读写 token。
 * 登录态判断的真源是 GET /auth/me 是否返回 200。
 */

export interface AuthUser {
  id: string
  username: string
  displayName: string | null
  role: 'admin' | 'user'
  locale: 'zh' | 'en'
  /** SSO 绑定的邮箱（/auth/me 与 /login、/oauth/exchange 均返回） */
  email?: string | null
  /** 是否已绑定 SSO 身份；前端据此 gate「定时以我的身份过网关」开关 */
  idaasBound?: boolean
  /**
   * Which protocol established the binding ('oidc' | 'saml'), persisted
   * server-side at bind time. Null on rows predating the column, which means
   * "bound, protocol unknown" — never treat it as unbound.
   */
  idaasProtocol?: string | null
  /** 新手引导完成状态，按引导 id 存：{ newbie: 'completed' | 'dismissed' } */
  onboarding?: Record<string, 'completed' | 'dismissed'>
}

interface AuthStatus {
  needSetup: boolean
}

interface LoginResponse {
  /** token 仍在 body 里返回，方便 CLI / 程序化客户端使用；浏览器场景可忽略，cookie 已被 API 自动写入。 */
  token: string
  user: AuthUser
}

export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => api.get<AuthStatus>('/auth/status').then((r) => r.data),
    staleTime: 0,
    retry: false,
  })
}

export function useCurrentUser() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => api.get<AuthUser>('/auth/me').then((r) => r.data),
    staleTime: 1000 * 60 * 5,
    retry: false,
  })
}

export function useSetup() {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { handleLocally: true },
    mutationFn: (data: { password: string; confirmPassword: string }) =>
      api.post<LoginResponse>('/auth/setup', data).then((r) => r.data),
    onSuccess: (data) => {
      queryClient.setQueryData(['auth', 'me'], data.user)
      queryClient.invalidateQueries({ queryKey: ['auth', 'status'] })
    },
  })
}

export function useLogin() {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { handleLocally: true },
    mutationFn: (data: { username: string; password: string; remember: boolean }) =>
      api.post<LoginResponse>('/auth/login', data).then((r) => r.data),
    onSuccess: (data) => {
      queryClient.setQueryData(['auth', 'me'], data.user)
    },
  })
}

export function useChangePassword() {
  return useMutation({
    meta: { handleLocally: true },
    mutationFn: (data: { oldPassword: string; newPassword: string }) =>
      api.post<{ message: string }>('/auth/change-password', data),
  })
}

export function useUpdateLocale() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (locale: 'zh' | 'en') =>
      api.patch<{ locale: string }>('/auth/locale', { locale }).then((r) => r.data),
    onSuccess: (_data, locale) => {
      queryClient.setQueryData(['auth', 'me'], (old: AuthUser | undefined) =>
        old ? { ...old, locale } : old,
      )
    },
  })
}

/**
 * 更新新手引导完成状态（持久化到后端，按引导 id 合并）。乐观更新 /auth/me 缓存。
 */
export function useUpdateOnboarding() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (vars: { guide: string; status: 'completed' | 'dismissed' | 'reset' }) =>
      api
        .patch<{ onboarding: Record<string, 'completed' | 'dismissed'> }>('/auth/onboarding', vars)
        .then((r) => r.data),
    onSuccess: (data) => {
      queryClient.setQueryData(['auth', 'me'], (old: AuthUser | undefined) =>
        old ? { ...old, onboarding: data.onboarding } : old,
      )
    },
  })
}

/**
 * 退出登录：调后端 POST /auth/logout 让 tokenVersion 自增（吊销当前 token），
 * 后端同时清 cookie；本地清 react-query 缓存后跳登录页。
 *
 * 即便后端调用失败也强制本地登出 + 跳转，避免用户被卡在已登录 UI 上；
 * 服务端那张 token 的吊销靠后续重试或自然过期兜底。
 */
export function useLogout() {
  const queryClient = useQueryClient()
  return useCallback(async () => {
    try {
      await api.post('/auth/logout', {})
    } catch {
      // ignore — 本地登出仍然要做
    }
    queryClient.clear()
    // 清掉「引导进行中」本地标记：否则同一浏览器换账号登录时，会让已完成引导的下个用户被强制重进 tour。
    try {
      localStorage.removeItem('a2wave:onboarding:active')
    } catch {
      // ignore (private mode / storage disabled)
    }
    window.location.href = '/login'
  }, [queryClient])
}

/**
 * 服务端下发的单个 SSO 登录方式（oidc / saml）：服务端主导的标准流，前端整页
 * 跳转到 loginUrl（如 /api/auth/oidc/login），成功由服务端设 cookie 后 302 回站内，
 * 失败 302 到 /login?ssoError=<CODE>。
 */
export type SsoLoginMethod = { type: 'oidc'; loginUrl: string } | { type: 'saml'; loginUrl: string }

interface OauthConfig {
  enabled: boolean
  reason?: string
  /** 可用登录方式，按数组顺序渲染按钮。 */
  methods?: SsoLoginMethod[]
}

/** Public endpoint — tells the login page whether to render the SSO button. */
export function useOauthConfig() {
  return useQuery({
    queryKey: ['auth', 'oauth', 'config'],
    queryFn: () => api.get<OauthConfig>('/auth/oauth/config').then((r) => r.data),
    staleTime: 1000 * 60 * 5,
    // A public read-only endpoint: failure has no terminal "unauthenticated"
    // meaning, only a blip or a cold start. Without retries that one failure is
    // cached by staleTime and the login page silently loses its enterprise entry
    // until the user reloads.
    retry: 3,
  })
}
