# CLI Tokens

> Status: v1.0. Named, long-lived, individually revocable credentials for the a2wave CLI, CI jobs, and scripts. Created from **Settings → CLI access**; the plaintext is shown once and never again.

## Table of Contents

- [1. Why not a session token](#1-why-not-a-session-token)
- [2. Creating and using one](#2-creating-and-using-one)
- [3. Endpoints](#3-endpoints)
- [4. Security properties](#4-security-properties)
- [5. Session lifetime is separate](#5-session-lifetime-is-separate)
- [6. Related reading](#6-related-reading)

---

## 1. Why not a session token

Every other login path issues a session JWT: short-lived, signed, and tied to
`users.tokenVersion`, so bumping that version revokes all of them at once. That is
right for a browser and wrong for automation — a password change would silently
break every pipeline, and there is no way to retire one machine's credential
without retiring them all.

CLI tokens are the opposite shape:

| | Session JWT | CLI token |
|---|---|---|
| Form | Signed, stateless | Opaque, stored server-side |
| Lifetime | `AUTH_SESSION_TTL_DAYS` (default 7) | Chosen per token, or none |
| Revocation | All at once, via `tokenVersion` | One at a time |
| Identity | Anonymous among a user's tokens | Named, with last-used time |

They complement the [device grant](./cli-device-login.md) rather than replacing it:
device login is the interactive path for a human on a remote shell, and a CLI token
is for the unattended case where no one is there to approve anything.

---

## 2. Creating and using one

In the web UI: **Settings → CLI access → New token**. Give it a name (required —
it is the only way to tell two tokens apart later) and a lifetime, then copy the
value. It is not recoverable afterwards.

```bash
a2wave config set-url https://a2wave.example.com
a2wave login --token a2wc_xxxxxxxxxxxx
```

The CLI verifies the token against `/auth/me` before writing it, so a truncated
paste or an already-revoked token fails immediately rather than on some later
command.

Tokens carry the **full permissions of the user who created them**. There is no
scoping — a token can do anything its owner can, *except* mint another CLI token,
which requires a real session. Mint one per machine or job so a leak can be
contained by deleting just that one.

> An admin's token inherits admin rights, including the password-reset endpoint.
> Prefer creating automation tokens from a non-admin account.

---

## 3. Endpoints

All are session-authenticated and scoped to the caller; even an admin manages only
their own tokens here.

| Endpoint | Purpose |
|---|---|
| `GET /api/cli-tokens` | List the caller's tokens. Never returns a credential |
| `POST /api/cli-tokens` | Mint one. The **only** time the plaintext is returned. Requires a real session — a CLI token gets `403 SESSION_REQUIRED` |
| `DELETE /api/cli-tokens/:id` | Revoke. Takes effect on the next request |
| `GET /api/cli-tokens/session-policy` | Read-only session lifetime, for display |

---

## 4. Security properties

- **Only the SHA-256 is stored.** A database read yields nothing usable. No salt:
  the input is already 256 bits of CSPRNG.
- **The `a2wc_` prefix** makes the credential recognisable in a log or secret
  store, and lets the auth path tell it from a JWT without a database read.
- **A short display prefix** is kept so the list can distinguish two tokens without
  showing enough to reconstruct either.
- **Revocation is scoped by `userId` and guarded on "not already revoked"**, so one
  user cannot revoke another's token and a repeat call cannot re-audit.
- **Disabling an account cuts off its tokens too** — `isActive` is checked on every
  request, not just at creation.
- **`tokenVersion` deliberately does not apply.** That is what makes a password
  change safe for running pipelines; per-token revoke is the tool for cutting one off.
- **`lastUsedAt` is stamped best-effort** on each use. It is the only signal that
  distinguishes a live credential from a forgotten one, so it never fails the
  request that produced it.
- **Creation and revocation are audited**; use is not, since that would write an
  entry per API call. `details` carries the name, never the token.
- **A CLI token cannot mint another CLI token.** `POST /api/cli-tokens` requires a
  real session and answers `403 SESSION_REQUIRED` to a token-authenticated caller.
  Without that, revoking a leaked token would contain nothing — the holder would
  simply issue a replacement, which then appears in the owner's list as an ordinary
  entry. Listing and deleting stay open to tokens so automation can clean up after
  itself.
- **Escalation is bounded by the owner's role, not prevented outright.** For a
  `user`-role token the blast radius really is "what the owner can already do":
  `POST /auth/change-password` requires the current password, which a token does not
  carry. An **admin**-owned token is different — `POST /api/users/:id/reset-password`
  is admin-only and takes no old password, so a leaked admin token *can* set
  passwords and is equivalent to account takeover. Treat admin CLI tokens with the
  same care as an admin password, and prefer minting them from a non-admin account
  where the automation does not need admin rights.

---

## 5. Session lifetime is separate

`AUTH_SESSION_TTL_DAYS` governs browser and login-issued tokens, **not** these. It
stays an environment variable and requires a restart: `env.ts` deliberately keeps
security-sensitive numbers out of the settings table, where they could be widened
from a browser. The CLI access page displays the current value read-only so nobody
has to open `.env` to find out what it is.

```bash
# .env — range 1~365, default 7
AUTH_SESSION_TTL_DAYS=30
```

Changing it affects only newly issued tokens; existing ones keep their original
expiry.

---

## 6. Related reading

- Headless / remote interactive login: [cli-device-login.md](./cli-device-login.md)
- IdP SSO login for the CLI: [cli-oauth.md](./cli-oauth.md)
- Token generation and hashing: [`apps/api/src/lib/cli-token.ts`](../../apps/api/src/lib/cli-token.ts)
- Authentication path: [`apps/api/src/lib/session-auth.ts`](../../apps/api/src/lib/session-auth.ts)
- Endpoints: [`apps/api/src/routes/cli-tokens.ts`](../../apps/api/src/routes/cli-tokens.ts)

## Changelog

| Version | Date | Change |
|------|------|------|
| v1.0 | 2026-08-20 | Initial release: `cli_tokens` table, management UI, `a2wave login --token` |
