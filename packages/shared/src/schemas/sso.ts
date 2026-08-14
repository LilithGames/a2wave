import { z } from 'zod'

/**
 * DB config schemas for the SSO login methods (settings table, `sso` category, values are JSON
 * strings).
 *
 * Source of truth: DB (validated by these schemas) > env fallback (A2WAVE_OIDC_* /
 * A2WAVE_SAML_*). When the DB config is complete it wins as a whole; there is no
 * field-level mixing, which would make cross-source configurations hard to troubleshoot.
 *
 * Sensitive-field convention: the OIDC client_secret does **not** belong to ssoOidcConfigSchema —
 * it is submitted as `sso.oidcClientSecret` via PATCH /api/settings (the plaintext appears only in
 * the request body), and the server encrypts it with a key derived from AUTH_SECRET and stores it
 * as `sso.oidcClientSecretEnc`; read endpoints never return the plaintext.
 */

/**
 * Optional per-method callback origin override: an empty string falls back to
 * artifacts.publicBaseUrl (the default behavior).
 *
 * Why configure one per method rather than a single global value: a common deployment has "the IdP
 * only accepts a particular IP, while artifact downloads go through a domain name". publicBaseUrl
 * serves both artifact links and callbacks, so changing it for one affects the other.
 *
 * Validation is aligned with normalizeUsablePublicOrigin — only a bare origin
 * (scheme://host[:port]) is accepted: non-http(s), embedded credentials, query/fragment, and
 * non-root paths are rejected. The callback path is appended by the server as a fixed suffix
 * (e.g. `/auth/callback`), so a path smuggled into the origin would make the concatenated result
 * point at the wrong address. Loopback **is** allowed here (an intranet / local-debugging IdP is a
 * real scenario); production usability is still gated by the existing rules in
 * getSsoCallbackOrigin.
 */
/**
 * Normalizes a callback origin: `''` (unconfigured) is returned as-is; a valid value returns a
 * **bare origin**; otherwise `null`.
 *
 * This is the single validation implementation in the whole repo — schema persistence validation,
 * api runtime lookup, and web form validation all call it. A separate regex-based implementation
 * once lived on the shared side (because shared's lib has no DOM types), and it turned out not to
 * be equivalent to `new URL`: values like `https://host:99999` or `http://host\evil.com` passed
 * the regex, were persisted, and showed as active in the UI, yet at runtime URL parsing rejected
 * them and **silently fell back** to publicBaseUrl. The administrator believed it was configured
 * while the IdP actually received a different address — exactly the class of failure this feature
 * exists to eliminate. There can be only one validation standard; `URL` is a WHATWG standard,
 * built into both Node and browsers.
 *
 * Normalizing to a bare origin (lowercasing scheme/host, punycoding IDNs) keeps `${origin}/path`
 * concatenation stable — IdPs compare the callback address character by character.
 */
export function normalizeSsoCallbackOrigin(raw: string): string | null {
  const s = raw.trim()
  if (!s) return ''
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // Credentials / query / fragment are always rejected; path may only be empty or root (`/`).
  if (u.username || u.password || u.search || u.hash) return null
  if (u.pathname !== '' && u.pathname !== '/') return null
  return u.origin
}

export const ssoCallbackOriginSchema = z
  .string()
  .default('')
  .refine(
    (v) => normalizeSsoCallbackOrigin(v) !== null,
    'callbackOrigin must be a bare http(s) origin, e.g. https://a2wave.example.com',
  )
  // Persist a bare origin: storing `https://host/` would concatenate to
  // `https://host//auth/callback`, which the IdP's character-by-character comparison rejects.
  .transform((v) => normalizeSsoCallbackOrigin(v) ?? '')

// ─────────────────────────────────────────────────────────────
// Standard OIDC (authorization code + PKCE)
// ─────────────────────────────────────────────────────────────
export const ssoOidcConfigSchema = z.object({
  /** Whether enabled; when false the config is kept but inactive. Legacy configs without this field default to true. */
  enabled: z.boolean().default(true),
  /** IdP issuer; discovery address = {issuer}/.well-known/openid-configuration. */
  issuer: z.string().url(),
  clientId: z.string().min(1),
  /** Requested scopes; an empty string means the default "openid profile email". */
  scopes: z.string().default(''),
  /**
   * Audiences accepted on the **OAuth publish channel** (`publishAuthType: 'oauth'`).
   *
   * Separate from `clientId` on purpose. Login verifies `aud === clientId`, because an id_token
   * minted for this platform must name it. OAuth-channel callers instead request access tokens
   * whose `aud` identifies a2wave as the target resource server. The channel therefore needs an
   * explicit a2wave resource audience, which may differ from the login client's identifier.
   *
   * That does **not** mean any audience goes: without a list, every token the IdP ever signed for
   * any relying party would invoke the Agent. So this is an explicit allowlist, and an empty list
   * disables the channel (fail closed) rather than accepting everything.
   *
   * `clientId` is **not** folded in implicitly. That would silently promote every holder of an
   * a2wave *login* token into an authorized invoker of every `all_idaas_users` Agent, and since
   * `clientId` is always non-empty it would also make the fail-closed case above unreachable. A
   * deployment that wants to call with its own login token lists `clientId` here explicitly.
   */
  channelAudiences: z.array(z.string().min(1)).default([]),
  /** Callback origin override; redirect_uri = {origin}/api/auth/oidc/callback. Empty = fall back to publicBaseUrl. */
  callbackOrigin: ssoCallbackOriginSchema,
})
export type SsoOidcConfig = z.infer<typeof ssoOidcConfigSchema>

// ─────────────────────────────────────────────────────────────
// SAML 2.0 (a2wave acting as the SP)
// ─────────────────────────────────────────────────────────────
export const ssoSamlConfigSchema = z.object({
  /** Whether enabled; when false the config is kept but inactive. Legacy configs without this field default to true. */
  enabled: z.boolean().default(true),
  /** IdP SSO entry point (HTTP-Redirect binding address). */
  entryPoint: z.string().url(),
  /** IdP signing certificate: a full PEM, or the base64 body with the header/footer lines removed. */
  idpCert: z.string().min(1),
  /** SP entityId; empty string = the default {service address}/api/auth/saml/metadata. */
  spEntityId: z.string().default(''),
  /** Callback origin override; ACS = {origin}/api/auth/saml/acs. Empty = fall back to publicBaseUrl. */
  callbackOrigin: ssoCallbackOriginSchema,
})
export type SsoSamlConfig = z.infer<typeof ssoSamlConfigSchema>

/** Schema for each settings.sso JSON key — shared by PATCH validation and read-side parsing. */
export const SSO_CONFIG_SCHEMAS = {
  oidcConfig: ssoOidcConfigSchema,
  samlConfig: ssoSamlConfigSchema,
} as const
export type SsoConfigKey = keyof typeof SSO_CONFIG_SCHEMAS

/** Where the effective config came from: DB (settings page) or env (deployment env var fallback). */
export type SsoConfigSource = 'settings' | 'env'
