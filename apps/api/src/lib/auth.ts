import { hash, verify } from '@node-rs/argon2'
import { verify as jwtVerify, sign } from 'hono/jwt'
import type { JWTPayload } from 'hono/utils/jwt/types'
import { env } from '../env.js'

/** 密码策略: 至少 8 字符，包含大写、小写、数字 */
export const PASSWORD_POLICY = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireDigit: true,
}

export function validatePassword(password: string): { valid: boolean; message?: string } {
  if (password.length < PASSWORD_POLICY.minLength) {
    return { valid: false, message: 'PASSWORD_TOO_SHORT' }
  }
  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(password)) {
    return { valid: false, message: 'PASSWORD_NEED_UPPER' }
  }
  if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(password)) {
    return { valid: false, message: 'PASSWORD_NEED_LOWER' }
  }
  if (PASSWORD_POLICY.requireDigit && !/\d/.test(password)) {
    return { valid: false, message: 'PASSWORD_NEED_DIGIT' }
  }
  return { valid: true }
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain)
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  return verify(hashed, plain)
}

export function getAuthSessionTtlSeconds(): number {
  return env.AUTH_SESSION_TTL_DAYS * 24 * 60 * 60
}

/**
 * Lifetime of a session the user declined to persist ("keep me signed in"
 * unchecked). Deliberately a constant rather than an env knob: it is the
 * shared-computer story, and a deployment that raised it to match
 * AUTH_SESSION_TTL_DAYS would silently delete the very protection the checkbox
 * promises. 12h covers a working day so the choice does not become annoying.
 *
 * The cookie for such a session carries no maxAge (dies at browser close); this
 * is the server-side half, so a restored browser session cannot resurrect it
 * beyond the window either.
 */
export const SHORT_SESSION_TTL_SECONDS = 12 * 60 * 60

export function getShortSessionTtlSeconds(): number {
  return SHORT_SESSION_TTL_SECONDS
}

/**
 * TTL for a newly issued session token, honouring the user's "keep me signed
 * in" choice. Single source of truth for both the JWT `exp` and the cookie
 * `maxAge` so the two can never disagree.
 */
export function getSessionTtlSeconds(remember: boolean): number {
  return remember ? getAuthSessionTtlSeconds() : getShortSessionTtlSeconds()
}

export interface JwtPayload {
  sub: string // userId
  role: string
  /** Token 版本号，与 users.tokenVersion 比对；不一致即视为吊销。 */
  tv: number
  /**
   * Whether the user asked to stay signed in. Carried in the token because
   * sliding renewal must reissue with the *same* lifetime the user chose —
   * without it, a renewed short session would silently be upgraded to the full
   * TTL, quietly undoing the shared-computer protection. Absent on tokens
   * issued before this claim existed; those are read as `true`, matching the
   * persistent-cookie behaviour they were actually issued with.
   */
  rm?: boolean
  iat: number
  exp: number
}

export interface SignTokenInput {
  id: string
  role: string
  tokenVersion: number
}

/**
 * Sign a session JWT.
 *
 * `remember` defaults to true so every pre-existing caller (SSO, device login,
 * invitation accept, password change) keeps its current full-TTL behaviour; only
 * the password login path, which can actually ask the user, passes false.
 */
export async function signToken(user: SignTokenInput, remember = true): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: JWTPayload = {
    sub: user.id,
    role: user.role,
    tv: user.tokenVersion,
    rm: remember,
    iat: now,
    exp: now + getSessionTtlSeconds(remember),
  }
  return sign(payload, env.AUTH_SECRET)
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  const payload = await jwtVerify(token, env.AUTH_SECRET, 'HS256')
  return payload as unknown as JwtPayload
}

export const AUTH_COOKIE_NAME = '__Host-a2wave_session'
export const LEGACY_AUTH_COOKIE_NAME = 'a2wave_session'
