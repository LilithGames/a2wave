# CLI Device Login (Remote / Headless Machines)

> Status: v1.0. `a2wave login` on a machine with no browser — SSH, a container, CI — shows a short code that the user approves from a browser on any machine where they already have an a2wave session. Implements the OAuth 2.0 Device Authorization Grant, [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628).

## Table of Contents

- [1. Why](#1-why)
- [2. End-to-end flow](#2-end-to-end-flow)
- [3. User usage](#3-user-usage)
- [4. How the CLI chooses a flow](#4-how-the-cli-chooses-a-flow)
- [5. Endpoints](#5-endpoints)
- [6. Security properties](#6-security-properties)
- [7. Status codes & troubleshooting](#7-status-codes--troubleshooting)
- [8. Related reading](#8-related-reading)

---

## 1. Why

The SSO flow in [cli-oauth.md](./cli-oauth.md) binds a loopback listener on `127.0.0.1:20265`
and asks the IdP to redirect a browser back to it. Over SSH that browser is on the *other*
machine, so the callback can never arrive; in a container or CI job there is no browser at all.
Before this, the only headless path was `--idaas-token <jwt>`, which requires the user to
obtain an IdP-issued `id_token` by some other means first.

The device grant closes that gap without inventing a second credential type: it relays a
session the user has already established, through whatever login the deployment permits
(password, OIDC, or SAML). No new way into the platform is created.

---

## 2. End-to-end flow

```
┌────────────┐                    ┌──────────┐              ┌──────────────┐
│ Remote box │                    │ a2wave   │              │ User browser │
│  (no GUI)  │                    │  /api    │              │ (any machine)│
└─────┬──────┘                    └────┬─────┘              └──────┬───────┘
      │ a2wave login                   │                           │
      │ POST /auth/device/code         │                           │
      ├───────────────────────────────>│                           │
      │ { deviceCode, userCode,        │  row: status=pending      │
      │   verificationUri, interval }  │                           │
      │<───────────────────────────────┤                           │
      │                                │                           │
      │  prints:  Open https://a2wave.example.com/device           │
      │           Enter code  WDJB-MJHT                            │
      │                                │      GET /device          │
      │                                │<──────────────────────────┤
      │                                │  (session guard; signs in │
      │                                │   via password/OIDC/SAML  │
      │                                │   if needed)              │
      │                                │  GET /auth/device/pending │
      │                                │<──────────────────────────┤
      │                                │  { userCode, clientIp,    │
      │                                │    userAgent, requestedAt}│
      │                                │  POST /auth/device/approve│
      │                                │<──────────────────────────┤
      │                                │  row: status=approved,    │
      │                                │       user_id=<approver>  │
      │ POST /auth/device/token (poll) │                           │
      ├───────────────────────────────>│                           │
      │ { token: a2w_xxx }             │  row: status=claimed      │
      │<───────────────────────────────┤                           │
      │ saveConfig + saveCredential    │                           │
```

The issued token is exactly what every other login path produces — `signToken()`, honouring
`AUTH_SESSION_TTL_DAYS`. There is no refresh token and no device-specific token type, so every
downstream route is oblivious to how the session was established.

---

## 3. User usage

On the remote machine:

```bash
a2wave config set-url https://a2wave.example.com   # or export A2WAVE_URL
a2wave login
```

```
  Open this page:  https://a2wave.example.com/device
  Enter this code: WDJB-MJHT

  Waiting for approval… (Ctrl-C to cancel)
```

Open that page in a browser where you are already signed in to a2wave, type the code, check
that the shown IP and client match your own session, and approve. The terminal continues by
itself.

Force the flow explicitly (for example inside a container, which is not auto-detected):

```bash
a2wave login --device
```

---

## 4. How the CLI chooses a flow

`a2wave login` with no arguments picks the device grant when `SSH_CONNECTION`, `SSH_TTY`, or
`SSH_CLIENT` is set — the loopback flow provably cannot complete there, so waiting for a
callback that will never arrive is never the right default.

Explicit flags always win, so a non-interactive job never starts waiting for a human:

| Invocation | Flow |
|---|---|
| `a2wave login` (local) | Loopback SSO (cache → browser) |
| `a2wave login` (over SSH) | **Device grant** |
| `a2wave login --device` | Device grant, anywhere |
| `a2wave login --idaas-token <jwt>` | One-shot IdP token exchange, even over SSH |
| `a2wave login --no-browser` | Cache only, even over SSH |
| `a2wave login --password` | Username + password |

Containers and CI are deliberately *not* auto-detected: there is no reliable marker, and
guessing wrong would push a local user onto a two-step flow for no reason.

---

## 5. Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /api/auth/device/code` | none (rate limited) | Start a login; returns both codes. 503 `PUBLIC_BASE_URL_NOT_SET` in production when no public origin is configured |
| `POST /api/auth/device/token` | none (rate limited) | CLI poll; RFC 8628 error codes |
| `GET /api/auth/device/pending?userCode=` | session | What the approver is about to authorize |
| `POST /api/auth/device/approve` | session | Bind the request to the caller |
| `POST /api/auth/device/deny` | session | Refuse it |

The first two are unauthenticated by necessity — the calling machine has no credential yet,
which is the entire point. Both are rate limited, but on **their own bucket** rather than the
shared `authRateLimit`: one login polls every 5s (~13 requests/min), so two concurrent logins
behind a single NAT egress IP would otherwise 429 each other out of the shared 30/min budget.

State machine: `pending → approved → claimed` is the success path; `denied` and expiry are
terminal. `claimed` is terminal too, which is what makes a device code single-use.

---

## 6. Security properties

- **The verification URL comes from explicit configuration**, never from an inferred `Host` /
  `X-Forwarded-Host` header. `/code` is unauthenticated, so an attacker who beat real traffic to
  a freshly restarted instance could otherwise pin every later login's printed link to their own
  domain and harvest live user codes. In production an unset public origin fails the request
  rather than printing an unusable link; outside production it falls back to localhost.
- **The device code is stored only as SHA-256.** A database read must not yield something
  replayable against the token endpoint. No salt: the input is already 256 bits of CSPRNG.
- **The user code omits `I`, `O`, `U`, `1`, `0`** so it survives being read aloud or retyped,
  and normalization *rejects* those characters rather than coercing them — coercion would let
  two distinct inputs collide on one row.
- **The approve page shows the requesting IP, client, and time.** This is the approver's only
  signal for telling their own remote shell apart from a code an attacker phoned them, which is
  the one attack this flow is meaningfully exposed to. The page also carries an explicit warning.
- **A prefilled link (`verificationUriComplete`) never auto-approves.** It fills the code in;
  the decision still requires a click, because the decision *is* the control.
- **Single use.** A claimed code is refused, so a token is minted at most once per login.
  The claim is a compare-and-set on `approved`, so two concurrent polls cannot both succeed.
- **Account status is re-checked at claim time**, not only at approval — an account can be
  disabled in between, and claim is the moment the credential is actually handed out.
- **Unknown and expired codes answer identically** (`expired_token`), so the endpoint is not an
  oracle for which codes exist.
- **Expired rows are swept hourly** by `startDeviceAuthorizationSweeper()`, independently of
  the configurable data-retention policy — that policy can be disabled, which would otherwise
  leave a row per login attempt forever. Expiry is enforced on read regardless, so the sweep is
  housekeeping rather than a correctness guarantee.
- **All four transitions are audited**: `auth.device.requested` / `approved` / `denied` /
  `claimed`. Neither code appears in `details` — both are live credentials, and `details` is
  rendered verbatim to every admin.

---

## 7. Status codes & troubleshooting

`POST /auth/device/token` uses the RFC's own error strings, all with HTTP 400:

| Body | Meaning | CLI behavior |
|---|---|---|
| `authorization_pending` | Nobody has approved yet | Keep polling |
| `slow_down` | Polled inside `interval` **while still pending** | Add 5s to the interval, keep polling |
| `access_denied` | Refused in the browser, or the account is disabled | Stop, report |
| `expired_token` | Expired, unknown, or already claimed | Stop, tell the user to start over |

| Symptom | Cause |
|---|---|
| `does not support device login (404)` | Server predates this feature; upgrade it or use `--idaas-token` |
| Code expired before approval | 10-minute TTL; run `a2wave login` again |
| `PUBLIC_BASE_URL_NOT_SET` (503) | Production instance with no `artifacts.publicBaseUrl`. Set it, or the printed link would be a localhost address the remote machine cannot open |
| HTTP 429 during polling | The CLI backs off (honouring `Retry-After`) and keeps polling; it does not abandon the login |

Audit tracing:

```bash
sqlite3 data/a2wave.db "
  SELECT action, resource_id, created_at FROM audit_logs
  WHERE action LIKE 'auth.device.%' ORDER BY created_at DESC LIMIT 20;
"
```

### Alternative: SSH port forwarding

The loopback flow also works over SSH if the callback port is forwarded, which needs no
device grant at all:

```bash
ssh -L 20265:localhost:20265 user@remote
```

This covers only SSH — not containers or CI — and requires the user to remember it, so it is
documented as a fallback rather than the recommended path.

---

## 8. Related reading

- IdP SSO login for the CLI: [cli-oauth.md](./cli-oauth.md)
- Unattended automation credentials: [cli-tokens.md](./cli-tokens.md)
- OAuth invocation channel for published Agents: [oauth-channel.md](./oauth-channel.md)
- Code generation and poll pacing: [`apps/api/src/lib/device-code.ts`](../../apps/api/src/lib/device-code.ts)
- Endpoints: [`apps/api/src/routes/auth-device.ts`](../../apps/api/src/routes/auth-device.ts)
- CLI poll loop: [`apps/cli/src/commands/device-login.ts`](../../apps/cli/src/commands/device-login.ts)
- Expiry sweep: [`apps/api/src/lib/device-authorization-sweep.ts`](../../apps/api/src/lib/device-authorization-sweep.ts)

## Changelog

| Version | Date | Change |
|------|------|------|
| v1.0 | 2026-08-20 | Initial release: device grant endpoints + `/device` approve page + CLI auto-selection over SSH |
