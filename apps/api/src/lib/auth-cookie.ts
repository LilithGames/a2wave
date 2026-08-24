import type { Context } from 'hono'
import { deleteCookie, setCookie } from 'hono/cookie'
import { env } from '../env.js'
import { AUTH_COOKIE_NAME, getAuthSessionTtlSeconds, LEGACY_AUTH_COOKIE_NAME } from './auth.js'

/**
 * cookie 是否带 Secure + 是否用 __Host- 前缀。默认按 NODE_ENV 推断；显式设了
 * AUTH_COOKIE_SECURE 时以它为准——给「production build 跑在 HTTP 入口后面」的内网
 * 部署一个出口（否则 Secure cookie 在 HTTP 下被浏览器丢弃，登录会无限循环）。
 *
 * 也是 auth-middleware 决定要不要兼容读 legacy cookie 名字的依据，保证读写两边
 * 看到的是同一条契约。
 */
export function isCookieSecure(): boolean {
  if (env.AUTH_COOKIE_SECURE !== undefined) return env.AUTH_COOKIE_SECURE === 'true'
  return env.NODE_ENV === 'production'
}

/**
 * 把 a2wave 自签 token 写到 HttpOnly cookie。secure=true 时用 __Host- 前缀（要求
 * 必须 HTTPS、Path=/、无 Domain），secure=false 时退回 legacy 名字以兼容 HTTP 入口。
 * SameSite=Lax 兼顾 SSO 跳转回来时也能携带 cookie，同时阻断跨站 POST CSRF。
 */
export function setAuthCookie(c: Context, token: string, remember = true): void {
  const secure = isCookieSecure()
  const cookieName = secure ? AUTH_COOKIE_NAME : LEGACY_AUTH_COOKIE_NAME
  setCookie(c, cookieName, token, {
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
    // remember=false must OMIT maxAge, not set a small one: a session cookie is
    // defined by the absence of both maxAge and expires, and that absence is the
    // whole "gone when the browser closes" guarantee on a shared machine. The
    // token's own 12h exp is the server-side backstop for a restored session.
    ...(remember ? { maxAge: getAuthSessionTtlSeconds() } : {}),
  })
}

export function clearAuthCookie(c: Context): void {
  // __Host- cookie 按规范只可能在 secure=true 时被设置过，这里就按这个不变量去删，
  // 不要参考当前的 isCookieSecure()——否则当 ops 把 AUTH_COOKIE_SECURE 从 true
  // 切到 false 时，清不掉浏览器里残留的 __Host- Secure cookie（属性不匹配）。
  // 删除请求总是同时发两条，兼容所有写入历史。
  deleteCookie(c, AUTH_COOKIE_NAME, { path: '/', secure: true })
  deleteCookie(c, LEGACY_AUTH_COOKIE_NAME, { path: '/' })
}
