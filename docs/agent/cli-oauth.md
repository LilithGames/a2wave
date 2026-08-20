# CLI OAuth Login (External IdP)

> Status: v1.0. The a2wave CLI exchanges an identity-provider (IdP) issued JWT for an a2wave self-signed token, sharing the deployment-level OAuth config with the existing [oauth-channel.md](./oauth-channel.md). The flow is configuration-driven and works with any OIDC IdP.

## Table of Contents

- [1. Background](#1-background)
- [2. End-to-end flow](#2-end-to-end-flow)
- [3. Deployment configuration (ops)](#3-deployment-configuration-ops)
- [4. Enablement and policy (admin)](#4-enablement-and-policy-admin)
- [5. User usage](#5-user-usage)
- [6. Status codes & troubleshooting](#6-status-codes--troubleshooting)
- [7. Related reading](#7-related-reading)

---

## 1. Background

The CLI previously only supported username/password login, making SSO integration inconvenient. This capability lets `a2wave login --oauth` go through your identity provider's SSO to obtain a JWT, then have the server exchange it for its own 24h token, which is saved to `~/.a2wave/config.json`.

**Two layers of separated concerns**:
- **Deployment layer** (ops): whether the IdP integration is physically configured → the enterprise **OIDC** login method (settings page, or the `A2WAVE_OIDC_*` env fallback; identical to [oauth-channel.md §3](./oauth-channel.md#3-deployment-configuration-ops))
- **Policy layer** (admin): whether CLI/Web SSO is allowed and who can get in → uses the `auth` category of the settings table, configured in the Web "Settings → Authentication & Security"

Environment not fully configured = 503 `OAUTH_NOT_CONFIGURED`; environment configured but admin has it off = 503 `OAUTH_DISABLED_BY_ADMIN`. The frontend can distinguish via `GET /api/auth/oauth/config`.

---

## 2. End-to-end flow

```
┌──────┐               ┌──────────────────┐         ┌──────────┐
│ User │               │ IdP SSO          │         │ a2wave   │
│ CLI  │               │ (browser)        │         │  /api    │
└──┬───┘               └────────┬─────────┘         └────┬─────┘
   │                            │                        │
   │ a2wave login --oauth       │                        │
   ├────────────────────────────────────────────────────>│
   │                            │   GET /oauth/config    │
   │<────────────────────────────────────────────────────┤
   │                            │  { enabled: true, ...} │
   │                            │                        │
   │ 1. read the SSO token cache (see §5.1 for path)     │
   │    (not expired → reuse the cached IdP JWT)         │
   │                            │                        │
   │ POST /api/auth/oauth/exchange                       │
   │ Body: { idaasToken: <jwt> }                         │
   ├────────────────────────────────────────────────────>│
   │                            │   verify sig + find/create user by email│
   │                            │   signToken()          │
   │<────────────────────────────────────────────────────┤
   │ { data: { token: a2w_xxx } }                       │
   │                            │                        │
   │ saveConfig({ url, token: a2w_xxx })                 │
   │ all subsequent APIs are exactly as before (Bearer a2w_xxx)│
```

**Why not let the CLI use the IdP JWT directly to call the API**: all other endpoints (PATCH /agents, POST /runs, etc.) now expect an a2wave self-signed token; doing a token exchange once makes the other paths completely oblivious.

**Key design points**:
- a2wave does not hold the IdP JWT and does not refresh it; when it expires, just run SSO again
- The IdP JWT is only kept in the local SSO token cache (path rules in §5.1); the CLI stores the a2wave token in `~/.a2wave/config.json` (mode 0o600)
- Auto-provisioning: on the first SSO login, a user is auto-created based on the email local part, with role = the `oauthDefaultRole` configured in settings

---

## 3. Deployment configuration (ops)

**Fully shared** with [oauth-channel.md §3](./oauth-channel.md#3-deployment-configuration-ops), no new env needed:

```bash
A2WAVE_OIDC_ISSUER='https://login.example.com/realms/acme'
A2WAVE_OIDC_CLIENT_ID='a2wave'
A2WAVE_OIDC_CLIENT_SECRET=''   # optional; omit for a PKCE public client
```

> The settings page (Settings → Enterprise login → OIDC) takes precedence over these env vars when
> configured. Signing keys come from the IdP's JWKS, so there is no static key to paste or rotate.

---

## 4. Enablement and policy (admin)

Once the deployment-level config is ready, go to "Settings → Authentication & Security" to enable the policy:

| Field | Default | Description |
|------|------|------|
| `oauthEnabled` | false | Master switch. Off = 503 OAUTH_DISABLED_BY_ADMIN |
| `oauthAllowedEmailDomains` | empty | Comma-separated, e.g. `example.com,example.org`. Empty = no restriction |
| `oauthDefaultRole` | user | Role for auto-provisioning; for security, keep it as user |
| `oauthAutoProvision` | true | When false, only pre-existing local users can use SSO |
| `passwordLoginEnabled` | true | When false, forces SSO for everyone; frontend + server double confirmation to avoid lockout |

**Key security gate**: the server intercepts the "disable password login + OAuth unavailable" combination at PATCH /api/settings, returning `AUTH_LOCKDOWN_REFUSED`; the Web settings page also shows a confirmation dialog before disabling password login.

Policy changes take effect across all instances within 30s (the in-process cache TTL of `auth-settings.ts`).

---

## 5. User usage

### 5.1 Directly `a2wave login` to open the browser

a2wave is self-hosted — there is no default hosted URL, so point the CLI at your instance first:

```bash
a2wave config set-url https://a2wave.example.com   # stored in ~/.a2wave/config.json
a2wave login
A2WAVE_URL=https://a2wave.example.com a2wave login  # same, via environment variable
```

Instance URL resolution order (highest to lowest priority):

1. `--url <url>` command line (not available on `login` itself; use `config set-url` or `$A2WAVE_URL` there)
2. `$A2WAVE_URL` environment variable
3. the url already stored in `~/.a2wave/config.json`

OAuth flow:
- Reads the SSO token cache first; hit and not expired = `reuse the cached IdP token`. Cache path resolution:
  1. `$A2WAVE_OAUTH_CACHE_PATH` (explicit override)
  2. `~/.a2wave/oauth.json` (default)

  The CLI owns one cache file and never probes for credential caches written by other tools. To deliberately share one, point `$A2WAVE_OAUTH_CACHE_PATH` at it.
- Cache invalid → resolve the SSO entry URL from `$A2WAVE_SSO_URL` (the IdP entry that redirects back to the CLI's loopback listener; unset ⇒ error pointing at `--idaas-token`), listen on `127.0.0.1:20265`, open the browser to the IdP SSO →
  the callback page JS extracts the token from the fragment and POSTs it back to `/callback/token` →
  `exchange` yields the a2wave token → write `~/.a2wave/config.json`
- Also writes the IdP token back to the resolved cache path, so the next login can reuse it

From the second time on, if the cached IdP token is still within its validity window, the whole process is silent (no browser opened).

### 5.3 One-time manual token (CI / headless)

```bash
a2wave login --idaas-token "<jwt>"
```

### 5.4 Remote machine with no browser (SSH / container / CI)

The loopback flow cannot complete there — see
[cli-device-login.md](./cli-device-login.md), which `a2wave login` selects
automatically over SSH.

### 5.5 Cache only, browser not allowed

```bash
a2wave login --no-browser     # errors out if the cache is invalid
```

### 5.6 Fall back to password login

```bash
a2wave login --password       # explicitly use the old username/password interaction
```

> When `passwordLoginEnabled=false`, password login is rejected.

### 5.7 Port conflict

The OAuth flow needs to listen locally on `127.0.0.1:20265`. If the port is occupied, the CLI errors out immediately and prompts:

```
Local port 20265 is already in use; cannot start the OAuth callback listener.
  Please free the port first (e.g.: lsof -ti:20265 | xargs kill) and retry.
```

20265 is a fixed callback port; if another SSO flow is already listening on it, wait for it to finish before running `a2wave login`.

---

## 6. Status codes & troubleshooting

| Situation | HTTP | body |
|------|------|------|
| OAuth env not fully configured | 503 | `OAUTH_NOT_CONFIGURED` |
| Admin disabled OAuth | 503 | `OAUTH_DISABLED_BY_ADMIN` |
| IdP JWT signature verification failed (expired/bad signature/aud mismatch) | 401 | `INVALID_IDAAS_TOKEN` |
| IdP JWT missing email claim | 400 | `IDAAS_TOKEN_MISSING_EMAIL` |
| Email domain not in the allowlist | 403 | `EMAIL_DOMAIN_NOT_ALLOWED` |
| autoProvision=false and no such local user | 403 | `USER_NOT_PROVISIONED` |
| User is disabled | 403 | `ACCOUNT_DISABLED` |
| Attempting login while password login is disabled | 403 | `PASSWORD_LOGIN_DISABLED` |
| Admin disabled both password and OAuth at once | 400 | `AUTH_LOCKDOWN_REFUSED` |

### 6.1 What if I'm locked out?

If you accidentally disable both password + OAuth becomes unavailable → the server blocks it, so in theory you can't lock yourself out. If you somehow get locked out through another route:

```bash
# Modify SQLite directly
sqlite3 data/a2wave.db "
  UPDATE settings SET value='true' WHERE category='auth' AND key='passwordLoginEnabled';
"
# Then restart the service process, or wait 30s for the auth-settings cache to expire
```

### 6.2 Audit tracing

```bash
sqlite3 data/a2wave.db "
  SELECT action, json_extract(details, '\$.email'), created_at
  FROM audit_logs
  WHERE action LIKE 'auth.oauth.%' OR action LIKE 'auth.password.%'
  ORDER BY created_at DESC LIMIT 20;
"
```

Successful logins go through `auth.oauth.login` (plaintext email); failures go through `auth.oauth.exchange_failed` (email is sha256-truncated to avoid audit-page scraping).

---

## 7. Related reading

- Headless / remote login (device grant): [cli-device-login.md](./cli-device-login.md)
- OAuth invocation channel for published Agents: [oauth-channel.md](./oauth-channel.md)
- External JWT signature verification policy: [`apps/api/src/lib/jwt-auth.ts`](../../apps/api/src/lib/jwt-auth.ts)
- SSO token cache path resolution: [`apps/cli/src/lib/token-cache.ts`](../../apps/cli/src/lib/token-cache.ts)

## Changelog

| Version | Date | Change |
|------|------|------|
| v1.0 | 2026-04-27 | Initial release: CLI OAuth exchange + admin policy + audit |
