import type { Context, Next } from 'hono'
import { getCookie } from 'hono/cookie'
import { env } from '../env.js'
import { validateAgentToken } from '../lib/agent-memory-token.js'
import { AUTH_COOKIE_NAME, LEGACY_AUTH_COOKIE_NAME } from '../lib/auth.js'
import { isCookieSecure } from '../lib/auth-cookie.js'
import { authenticateSessionToken } from '../lib/session-auth.js'

const DEFAULT_AUTH_SECRET = 'dev-secret-change-me'

/**
 * JWT authentication middleware.
 *
 * Token 来源（按优先级）：
 *   1. `Authorization: Bearer <jwt>` —— CLI / 程序化客户端
 *   2. `Cookie: __Host-a2wave_session=<jwt>` —— 浏览器（HttpOnly, production）
 *
 * Dev bypass 仅在三条件全部满足时触发：
 *   1. NODE_ENV 严格为 'development'（schema 默认值已改为 'production'，忘配即 fail-closed）
 *   2. E2E_STRICT_AUTH 未开启
 *   3. AUTH_SECRET 仍是默认的 'dev-secret-change-me'
 * 任一条件不满足（包括 NODE_ENV 为 test/production/未设），都强制走 JWT 校验。
 *
 * NOTE: env.ts now rejects the default secret in every environment except
 * NODE_ENV=test (where it is injected, but condition 1 requires 'development'),
 * so conditions 1+3 can never hold together in a schema-validated process —
 * the bypass is unreachable and local dev uses real login. The code path is
 * kept for now (unit tests mock env directly); removing it wholesale is a
 * separate change.
 *
 * 校验通过后还会比对 users.tokenVersion 与 token 里的 tv，不一致即 401（吊销）；
 * 同时确认 isActive，被禁用账号也直接 401。
 */
export async function authMiddleware(c: Context, next: Next) {
  const isDevBypass =
    env.NODE_ENV === 'development' &&
    !env.E2E_STRICT_AUTH &&
    env.AUTH_SECRET === DEFAULT_AUTH_SECRET
  if (isDevBypass) {
    c.set('userId' as never, 'usr_admin' as never)
    c.set('userRole' as never, 'admin' as never)
    c.set('authMethod' as never, 'session' as never)
    return next()
  }

  const authHeader = c.req.header('Authorization')
  let token: string | undefined
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7)
  } else {
    token = getCookie(c, AUTH_COOKIE_NAME)
    // 兼容 secure=false 的部署（HTTP 入口的内网 prod / dev）：写入端回落到 legacy 名字，
    // 读取端也得跟上，否则 cookie 写得进去但下一跳 middleware 找不着 → 401 死循环。
    // 走 secure 路径时严格只认 __Host-，防止 HTTP 中间人注入伪造的非前缀 cookie。
    if (!token && !isCookieSecure()) {
      token = getCookie(c, LEGACY_AUTH_COOKIE_NAME)
    }
  }

  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const user = await authenticateSessionToken(token)
  if (!user) {
    return c.json({ error: 'Invalid or expired token' }, 401)
  }

  c.set('userId' as never, user.id as never)
  // Use the current DB role; the token role is only a potentially stale issuance-time snapshot.
  c.set('userRole' as never, user.role as never)
  c.set('authMethod' as never, user.authMethod as never)
  return next()
}

/**
 * 判断当前请求是否由 admin 发起。
 *
 * 单点真源：requireAdmin middleware 与各路由中按字段条件门闩的 inline 检查都走这个，
 * 避免未来 admin 判定语义变化（例如多角色、继承权限）时两处失配。
 */
export function isAdmin(c: Context): boolean {
  const role = c.get('userRole' as never) as string | undefined
  return role === 'admin'
}

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function getNodeRemoteAddress(c: Context): string | undefined {
  // @hono/node-server specific: `incoming` is Node's IncomingMessage. Other runtimes
  // do not populate it, so agent subprocess token auth falls back to normal JWT auth.
  return (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
    ?.socket?.remoteAddress
}

/**
 * Memory routes dual-auth:
 *   - Localhost origin (agent subprocesses): accept a valid per-agent Bearer token
 *     and set `agentTokenId` in context to the validated agentId.
 *   - Everything else (including a localhost Bearer that is *not* an agent token —
 *     e.g. the CLI forwarding the user's session JWT, or a Vite dev proxy forwarding
 *     a browser cookie): fall back to JWT via authMiddleware.
 *
 * Agent tokens are opaque base64url random bytes (never JWTs), so a user session JWT
 * can never match an agent token and vice-versa — the fallback is safe. Previously a
 * localhost Bearer that failed the agent-token check hard-401'd instead of falling
 * back, so `a2wave agents memory *` against a localhost / same-host reverse-proxied
 * API always failed with "Session expired".
 */
export async function memoryAuthMiddleware(c: Context, next: Next) {
  const remoteAddress = getNodeRemoteAddress(c)
  if (remoteAddress && LOCALHOST_ADDRS.has(remoteAddress)) {
    const authHeader = c.req.header('Authorization')
    if (authHeader?.startsWith('Bearer ')) {
      // Agent subprocess path: validate per-agent token. On miss, don't 401 — the
      // Bearer may be a user session JWT (CLI), so fall through to JWT auth below.
      const agentToken = authHeader.slice(7)
      const agentId = validateAgentToken(agentToken)
      if (agentId) {
        c.set('agentTokenId' as never, agentId as never)
        c.set('agentMemoryToken' as never, agentToken as never)
        return next()
      }
    }
    // Not an agent token (missing / user JWT / dev-proxy cookie): fall through to JWT auth.
  }
  return authMiddleware(c, next)
}

/**
 * Admin-only middleware. Must be used after authMiddleware.
 */
export async function requireAdmin(c: Context, next: Next) {
  if (!isAdmin(c)) {
    return c.json({ error: 'Admin access required' }, 403)
  }
  return next()
}
