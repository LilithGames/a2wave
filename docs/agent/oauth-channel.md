# OAuth Authorization Channel (External IdP JWT + configurable access scope)

> Status: v1.3. External IdP JWT signature verification + per-Agent access scope (all enterprise users / specific enterprise users). The channel is configuration-driven, works with any OIDC identity provider, and has **no dependency on Feishu**.

## Table of Contents

- [1. Background and goals](#1-background-and-goals)
- [2. Overall flow](#2-overall-flow)
- [3. Deployment configuration (ops)](#3-deployment-configuration-ops)
- [4. Publishing the Agent (Owner)](#4-publishing-the-agent-owner)
- [5. Caller integration (Skill developers)](#5-caller-integration-skill-developers)
- [6. Status code quick reference](#6-status-code-quick-reference)
- [7. Troubleshooting handbook](#7-troubleshooting-handbook)
- [8. Known limitations](#8-known-limitations)
- [9. Related reading](#9-related-reading)

---

## 1. Background and goals

Beyond `none` / `api_key`, a2wave provides a third authentication method: **OAuth authorization (external IdP)**, used to narrow the user population when exposing an Agent externally. Compared with the first two:

| Auth method | Who can call | Identity auditable | Permission boundary |
|---------|-------|-----------|---------|
| `none` | Anyone within the IP allowlist | ❌ | IP |
| `api_key` | Any service holding the shared key | ❌ (no individual identity) | Key |
| `oauth` | Users of your identity provider; can optionally be narrowed to an explicit email allowlist | ✅ (email/sub/tenant) | Agent publish config |

**Two layers of validation**:

1. **Identity layer (who are you?)** — IdP JWT signature verification, confirming a user of your identity provider and extracting claims like sub / email
2. **Authorization layer (can you use this agent?)** — executed per the Agent's `oauthAccessMode`:
   - `all_idaas_users` (default): allow if the JWT is valid and carries an `email` claim — every such user of the identity provider can call
   - `specified_users`: the caller's **verified** `email` claim must appear in the Agent's email allowlist (`agents.oauth_allowed_emails`); comparison is case-insensitive and whitespace-trimmed

Both layers must pass before allowing the request. The verified identity `{email?, sub, tenant?}` is
written into the run channel context for business permission decisions or auditing. An address
explicitly marked `email_verified: false` satisfies the revocation gate in `all_idaas_users`, but it
is not promoted into `user_info.email`.

> ⚠️ **Fail-closed allowlist**: `specified_users` with an empty or unset allowlist denies **everyone**. There is no "empty means unrestricted" shortcut — an Agent narrowed on purpose must never widen itself because its roster was cleared. Callers whose token carries no verified `email` claim are rejected in this mode as well (`MISSING_VERIFIED_EMAIL`).

**Explicitly not done**: a2wave self-signed tokens / refresh tokens / dynamic client registration / a self-built user table / per-agent IdP credentials / directory group lookups (the allowlist is a literal list of emails, not a query against your IdP's groups).

---

## 2. Overall flow

```
┌──────────┐      ┌────────────┐      ┌──────────────────────────────┐
│  Caller  │      │ IdP / SSO  │      │            a2wave            │
│ (Skill)  │      │   tool     │      │             /api             │
└────┬─────┘      └─────┬──────┘      └──────────────┬───────────────┘
     │                  │                            │
     │ 1) obtain token  │                            │
     ├─────────────────>│                            │
     │ browser SSO →    │                            │
     │   IdP issues JWT │                            │
     │<─────────────────┤                            │
     │                  │                            │
     │ 2) POST /api/oauth/<id>/invoke                │
     │    Authorization: Bearer <JWT>                │
     ├──────────────────────────────────────────────>│
     │                  │                            │
     │                  │        ┌───────────────────┴───────────────┐
     │                  │        │ 2a) JWT verify via JWKS           │
     │                  │        │     iss / aud / exp / sub         │
     │                  │        └───────────────────┬───────────────┘
     │                  │                            │
     │                  │        ┌───────────────────┴───────────────┐
     │                  │        │ 2b) email claim present?          │
     │                  │        │      no  → 403 CLAIMS_INVALID     │
     │                  │        │ 2c) read oauthAccessMode          │
     │                  │        │                                   │
     │                  │        │  all_idaas_users → allow          │
     │                  │        │                                   │
     │                  │        │  specified_users →                │
     │                  │        │    verified email claim present?  │
     │                  │        │      no  → 403 CLAIMS_INVALID     │
     │                  │        │    email ∈ oauth_allowed_emails?  │
     │                  │        │      (case-insensitive, trimmed)  │
     │                  │        │      no  → 403 NOT_AUTHORIZED     │
     │                  │        │      yes → allow                  │
     │                  │        └───────────────────┬───────────────┘
     │                  │                            │
     │     202 + runId or 401/403/503                │
     │<──────────────────────────────────────────────┤
```

**Key points**

- JWT verification: the enterprise **OIDC** config (Settings → Enterprise login) — signature via the IdP's JWKS, plus strict `iss / exp / sub`. Keys rotate through JWKS, so there is no static public key to paste or re-paste
- Accepted signature algorithms: `RS256` / `RS384` / `RS512` / `PS256` / `ES256` / `ES384` (symmetric algorithms are always rejected). The CLI mirrors this by exchanging any non-`HS256` JWT, so an IdP on an elliptic-curve algorithm needs no client-side change
- Access scope: both modes require an `email` claim; `all_idaas_users` has no further email-authorization check, while `specified_users` requires a verified email and an Agent allowlist match
- Allowlist decision (`specified_users` only): the JWT must carry a **verified** `email` claim (an unverified email is treated as absent); the value is trimmed and lower-cased on both sides before comparison. An empty or NULL `agents.oauth_allowed_emails` denies everyone
- The decision is a **local column read** — no outbound call, no cache, no TTL, so an allowlist edit takes effect on the very next request
- Identity landing: `runSteps.input.context.channel.channel_info.oauth` + `user_info.email` when the email is accepted as verified; otherwise `user_info` may be null

Code entry points:

| Component | File |
|------|------|
| JWT policy | `apps/api/src/lib/jwt-auth.ts` |
| OIDC config + token verification | `apps/api/src/lib/oidc.ts` |
| Gateway middleware (access-mode decision) | `apps/api/src/middleware/gateway-auth.ts` |
| Channel context construction | `apps/api/src/lib/run-channel.ts` |

---

## 3. Deployment configuration (ops)

The OAuth channel has **no configuration of its own** — it reuses the enterprise **OIDC login**
method. Configure OIDC once (Settings → Enterprise login → OIDC, or the env fallback below) and the
channel is ready; there is no separate key to distribute or rotate.

```bash
# Enterprise OIDC (env fallback; the settings page takes precedence when configured)
A2WAVE_OIDC_ISSUER='https://login.example.com/realms/acme'
A2WAVE_OIDC_CLIENT_ID='a2wave'
A2WAVE_OIDC_CLIENT_SECRET=''        # optional; omit for a PKCE public client

# Environment fallback for the a2wave resource audience your IdP mints tokens for
# (comma-separated). Settings takes precedence when it contains a valid OIDC configuration.
# This names THIS service, not the callers -- see the audience note in section 4.
# Empty = channel disabled.
A2WAVE_OIDC_CHANNEL_AUDIENCES='https://a2wave.example.com'
```

| Variable | Required | Description |
|------|------|------|
| `A2WAVE_OIDC_ISSUER` | ✓ | IdP issuer; discovery at `{issuer}/.well-known/openid-configuration`, signing keys from its JWKS |
| `A2WAVE_OIDC_CLIENT_ID` | ✓ | client_id registered at the IdP. **Not** an implicit channel audience — add it explicitly to the current effective OIDC channel audience configuration if callers use a2wave login tokens |
| `A2WAVE_OIDC_CLIENT_SECRET` | ✗ | Omit to treat a2wave as a PKCE public client |
| `A2WAVE_OIDC_CHANNEL_AUDIENCES` | ✓ (for this channel) | Environment fallback for the a2wave resource audience identifiers. Settings takes precedence when a valid Settings OIDC configuration exists; when the environment is the active fallback, empty = channel disabled |

> The authorization layer is now entirely local (a column on the Agent), so it has no ops-level knob
> of its own — nothing to configure, cache, or rotate beyond the OIDC block above.

### Audience: why the channel has its own allowlist

Login verification (`POST /auth/oauth/exchange`) requires `aud === client_id`, because an id_token
minted for this platform must name it. The channel cannot reuse that rule: a caller integrating
its own service does not hold an a2wave login id_token, so enforcing `client_id` would restrict the
channel to "callers already holding an a2wave login token" — the opposite of what it exists for.

> ⚠️ **`aud` names the resource being called, not the caller.** For a JWT access token, `aud`
> identifies the **target resource server** and the resource server must verify it is in that
> audience ([RFC 9068 §3](https://www.rfc-editor.org/rfc/rfc9068#section-3)). So the value to
> allowlist is the audience your IdP mints **for a2wave** (an API/resource identifier such as
> `https://a2wave.example.com` or an IdP-side API scope) — configured once, then requested by
> each caller via the IdP's resource/audience parameter.
>
> Do **not** list other applications' audiences to "let them in": a token whose `aud` names a
> different resource server was never issued for a2wave, and accepting it makes this channel a
> confused deputy for that service's tokens. One audience shared by every caller is normal and
> correct here; per-caller separation is what `oauthAccessMode` and the email allowlist provide.

The answer is a separate allowlist, **not** skipping the check. With no `aud` constraint at all,
every token the IdP ever signed for any relying party would authenticate here — including tokens
belonging to unrelated internal apps, and ones captured from their logs or proxies — while
`oauthAccessMode='all_idaas_users'` has no second gate behind it. So the channel verifies `aud`
against the **current effective OIDC channel audience configuration**. Settings takes precedence;
`A2WAVE_OIDC_CHANNEL_AUDIENCES` is only the environment fallback when no valid Settings OIDC
configuration exists. An empty effective allowlist disables the channel rather than opening it.

`client_id` is deliberately **not** folded in. It would read as a convenience — "calling with our
own login token just works" — but it silently turns "can sign in to the console" into "can invoke
every `all_idaas_users` Agent", and because `client_id` is always non-empty it would also make the
fail-closed case above unreachable. List it explicitly if you want that.

Identity remains anchored by the IdP (issuer + JWKS signature + `exp` + `sub`); *authorization* is
a separate layer, enforced per Agent by `oauthAccessMode`.

### The channel is independent of the OIDC **login** toggle

Disabling the OIDC login method (Settings → Enterprise login) only removes the sign-in button. It
does **not** disable this channel — already-published Agents keep verifying callers, because
otherwise switching the console to password-only or SAML sign-in would take down every external
integration at the same time.

### Behavior when config is missing (lazy loading)

- OIDC not configured, or its audience allowlist empty → returns `503 OAuth not configured` on the first oauth request (no ERROR log; being unconfigured is a legitimate state). Note the channel deliberately **ignores** the OIDC *login* toggle: disabling the sign-in button does not stop already-published oauth Agents
- IdP discovery / JWKS unreachable → infrastructure failure, so the request is rejected `503` `AUTHORIZATION_CHECK_UNAVAILABLE` (retryable), **not** `401`; the cause is in the request log
- `none` / `api_key` channels are entirely unaffected

Design intent: don't block other already-enabled channels, and facilitate production canary rollout.

---

## 4. Publishing the Agent (Owner)

### 4.1 Choose the access scope

The `OAuth Authorization` subpage of the publish page provides two access scopes:

| Access scope | zh copy | Behavior | Use case |
|----------|------|------|----------|
| `all_idaas_users` (default) | 全体企业用户 | Allow once the IdP JWT passes and carries an email claim | Every user of the identity provider with an email claim can call |
| `specified_users` | 指定企业用户 | After the IdP JWT passes, require the caller's verified email to be on the Agent's allowlist | A named set of people — a pilot group, one team, a handful of integrators |

The English labels are "All enterprise users" / "Specific enterprise users".

### 4.2 Maintaining the email allowlist (only `specified_users`)

The allowlist lives on the Agent itself (`agents.oauth_allowed_emails`, a JSON string array), so the Owner maintains it in a2wave — there is no external directory, group, or third-party app to configure.

- Enter one **login email per person**, exactly as the IdP issues it in the `email` claim
- Matching is **case-insensitive** and ignores surrounding whitespace, so `Alice@Example.com ` and `alice@example.com` are the same person
- The claim must be **verified** by the IdP; a token carrying an unverified email is treated as carrying none and is rejected with `403 CALLER_TOKEN_CLAIMS_INVALID`
- **An empty list denies everyone.** This is deliberate: an Agent restricted on purpose must not fall open when its roster is cleared. To open an Agent up, switch the mode to `all_idaas_users` rather than emptying the list
- Changes take effect on the **next request** — the decision reads the column directly, with no cache in front of it
- The allowlist is an internal personnel roster: it is **never included in agent export**, and a bundle imported elsewhere lands with an empty list that the importer must fill in

### 4.3 Publish in a2wave

1. `Agent details → Publish`
2. Switch to the `OAuth Authorization` subpage and enable the OAuth authorization channel
3. Choose the access scope:
   - `全体企业用户` (`all_idaas_users`): nothing further to fill in
   - `指定企业用户` (`specified_users`): enter the allowed emails
4. Click "Publish" / "Update publish"

**Persistence on publish**: `oauthAllowedEmails` is written only when the mode is `specified_users`; selecting `all_idaas_users` **NULLs the column**, so a later switch back to `specified_users` starts from an empty (deny-all) list rather than silently resurrecting a stale roster. The channel no longer performs any Feishu-credential validation on publish — the former `400 OAUTH_CHANNEL_REQUIRES_FEISHU_CREDENTIALS` is gone, and Feishu App ID / App Secret are needed by the **Feishu channel alone**.

**Publish-time validation**: publishing the `oauth` channel under `specified_users` with an empty effective allowlist returns `400 OAUTH_ALLOWED_EMAILS_REQUIRED`. This is a **server-side** gate, matching `SLACK_CONFIG_REQUIRED` and friends — the frontend's readiness check is the friendly early warning, not the only line of defence, since CLI and API clients (and the Agents migration 0100 landed on an empty list) reach the route directly. Without it an owner could publish a live channel that 403s every caller.

**Switching auth methods**: `api_key → oauth` requires re-publishing, and the original API Key becomes invalid immediately.

### 4.4 Upgrading from `feishu_scope`

The retired `feishu_scope` mode is translated by migration `0100_awesome_marrow.sql`, **scoped to Agents that actually publish the `oauth` channel**. Those become `specified_users` **with a NULL allowlist**: fail-closed by design, because the visible scope lived on the Feishu side and cannot be transcribed into emails automatically, and an upgrade must never widen an Agent that was deliberately restricted. Their owners re-enter the allowed emails before external callers succeed again; until then callers get `403 CALLER_NOT_AUTHORIZED`.

Everything else lands on the new `all_idaas_users` default. The narrowing matters because `feishu_scope` was this column's **DEFAULT** since migration 0071 — so it also marks every Agent that never once touched the setting. Translating all of them would strand the entire existing estate on a deny-all list, make the new default unreachable for any pre-existing row, and report `specified_users` for Agents with no OAuth channel at all.

> The migration is a plain `ALTER TABLE … ADD COLUMN` + `UPDATE`, deliberately **not** the table
> rebuild drizzle generates for a default change. `DROP TABLE agents` runs with foreign keys live
> (the migrator's transaction makes `PRAGMA foreign_keys=OFF` a no-op, and `db/client.ts` connects
> with them ON), which either aborts the upgrade on a NO ACTION child or silently CASCADE-empties
> `agent_members` / `evaluation_sets` / … . The column therefore still carries its old
> `'feishu_scope'` DEFAULT; nothing relies on it, since every INSERT supplies the column.
> Regression test: `src/db/__tests__/migration-0100-oauth-access-mode.test.ts`.

Agent **import** applies the same rule to bundles exported before the removal, with the same NULL allowlist. A bundle with **no** `oauthAccessMode` counts as retired too: bundles predating 0071 carry no mode, yet their source Agent ran on the `feishu_scope` default.

Agent **clone** preserves the source's access tier and starts the copy with a NULL allowlist — the roster is personnel data and is deliberately not copied, but the tier must not slide open with it. The copy therefore publishes only once its new owner enters their own list.

> ⚠️ **Every insert into `agents` must pass `oauthAccessMode` explicitly.** Drizzle binds the
> column's TS-side default into the INSERT, so omitting it writes the retired `feishu_scope`
> rather than deferring to SQLite — and reads normalize that to the **open** mode. An insert path
> that forgets this column silently downgrades an Agent to "all enterprise users".
> `normalizeOauthAccessMode()` is read-side hygiene, never the guard that decides a tier.

---

## 5. Caller integration (Skill developers)

### 5.1 Prepare the Token

Obtain a token from your caller's OIDC client for the configured a2wave resource audience. Its
`aud` must be accepted by the current effective OIDC channel audience configuration (see §3).
Settings takes precedence; `A2WAVE_OIDC_CHANNEL_AUDIENCES` is only the environment fallback when no
valid OIDC configuration exists in Settings.

The token must also carry an email claim: the gateway rejects an address-less token with `403` in **both** access modes, and `specified_users` additionally requires that address to be **verified** and on the Agent's allowlist.

The token cached by `a2wave login` is **not** automatically accepted — it is minted for the login client (`aud === client_id`), which the allowlist deliberately excludes. Without a matching `aud` the call fails with `401`, not `403`.

```bash
# Obtain this through the caller application's OIDC flow. Configure that IdP client
# to request the a2wave resource audience and the email scope.
TOKEN='<JWT issued by the configured OIDC provider for the a2wave resource audience>'
```

The `a2wave login` cache can be used for manual testing only when the login Client ID is explicitly
included in the current effective channel audiences; it is rejected by default.

### 5.2 REST invocation

The OAuth channel lives at `/api/oauth/...`. Do **not** send this token to
`/api/gateway/...` — that route accepts only an Agent API key and answers a valid OIDC JWT
with `401`.

```bash
curl -X POST https://a2wave.example.com/api/oauth/agt_xxx/invoke \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "async": true}'
# → 202 { "data": { "runId": "run_xxx" } }
```

### 5.3 A2A JSON-RPC

> ⚠️ **A2A does not accept the OAuth token prepared above.** `a2aAuthType` is constrained to
> `none | api_key` (`publishAuthTypeEnum`), so `validateGatewayAuth`'s oauth branch is unreachable
> from this route — sending an OIDC JWT here returns `401`. Authenticate A2A with the Agent's A2A
> API key instead; the snippet below uses that key, not `$TOKEN` from §5.1.

```js
const res = await fetch(`${A2WAVE_BASE}/api/a2a/agt_xxx`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${a2aApiKey}`, // the Agent's A2A API key, NOT an OIDC JWT
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    },
  }),
})
```

### 5.4 The identity received on the Run

After signature + access-scope verification pass, the identity lands in `runSteps.input.context.channel` (a unified shape, see [run-channel-context.md](./run-channel-context.md)):

```json
{
  "channel_type": "api",
  "channel_info": {
    "auth": "oauth",
    "client_ip": "10.0.0.x",
    "oauth": {
      "issuer": "https://idp.example.com/",
      "sub": "user@example.com",
      "tenant_id": "...",
      "union_id": "..."
    }
  },
  "user_info": {
    "email": "user@example.com",
    "name": "user",
    "source": "idaas",
    "source_id": "user@example.com"
  }
}
```

For the normal verified-email case shown above, the Agent executor reads the address from
`payload.context.channel.user_info.email` and the IdP-anchored subject from
`channel_info.oauth.sub`. Under `all_idaas_users`, a token whose address is explicitly marked
`email_verified: false` may still pass the revocation gate, but `user_info` is then null; use the
subject for auditing and do not treat the unverified address as caller identity.

> ⚠️ **`channel_info.feishu_scope` is no longer written.** It was populated only by the retired
> `feishu_scope` mode, so new runs never carry it and executors no longer receive
> `channel_info.feishu_scope.{open_id,user_id,union_id}`. The field is retained in the Zod schema so
> historical run records stay readable — an executor that still reads those Feishu IDs must migrate
> to `user_info.email` and resolve the mapping on its own side.

> A2A and the REST gateway, the two invocation paths, share the same landing spot; even if the REST request is queued (`tryAcquireSlot === 'queued'`), the caller info is persisted along with the run.

---

## 6. Status code quick reference

| Situation | HTTP | code | Caller action |
|------|------|------|------------|
| JWT valid + has access | 200 / 202 | — | Process the response normally or poll the Run |
| Missing `Authorization` header | 401 | `AUTH_REQUIRED` | Obtain an IdP token and add the Bearer header |
| JWT invalid, expired, or verification failed | 401 | `CALLER_TOKEN_INVALID` | Request a new JWT from the caller's OIDC client for the configured a2wave resource audience |
| JWT missing an `email` claim (both modes) | 403 | `CALLER_TOKEN_CLAIMS_INVALID` | Request a new JWT containing `email` |
| JWT email is not verified (`specified_users` only) | 403 | `CALLER_TOKEN_CLAIMS_INVALID` | Request a new JWT containing a verified `email` |
| Email not on the Agent's allowlist | 403 | `CALLER_NOT_AUTHORIZED` | Contact the Agent owner for authorization |
| IP not in the allowlist | 403 | `IP_NOT_ALLOWED` | Switch to an allowed network or update the allowlist |
| OAuth policy not deployed | 503 | `OAUTH_NOT_CONFIGURED` | Contact the platform admin; changing the token won't help |
| IdP unreachable during token verification | 503 | `AUTHORIZATION_CHECK_UNAVAILABLE` | **Retry** (`retryable: true`) — the caller's credentials are not implicated |
| Agent Provider login expired | 424 | `PROVIDER_REAUTH_REQUIRED` | Agent owner re-logs into the Provider; the caller need not re-log in |

The error envelope uniformly contains `code`, `message`, `source`, `action`, `retryable`, and an optional `details.runId`. Synchronous, SSE, and async-polling execution errors use the same structure.

**Retired with `feishu_scope`**: `NOT_IN_FEISHU_SCOPE`, `REQUIRES_FEISHU_CREDENTIALS` and `FEISHU_CHECK_UNAVAILABLE` no longer exist in `GatewayAuthErrors`. Their replacement is the single `NOT_IN_ALLOWED_USERS` (`'User not in the allowed user list'`) → HTTP **403** / code `CALLER_NOT_AUTHORIZED` / source `caller` / action `contact_agent_owner`. Note the class change: the old outcome could be a 503 blamed on an unreachable third party, whereas the allowlist decision is local and therefore always a definitive 403. `MISSING_VERIFIED_EMAIL` is retained and now applies to `specified_users`.

> ⚠️ **`AUTHORIZATION_CHECK_UNAVAILABLE` is still emitted — keep your retry logic.** Only the
> Feishu-visibility *source* of it is gone. The channel still returns it (503, `retryable: true`)
> when the **IdP itself** is unreachable during token verification, and as the fallback for any
> other 503. Dropping the retry branch for this code would turn a transient IdP blip into a hard
> failure across every integration — the exact scenario the code exists for.
> `AGENT_OAUTH_MISCONFIGURED` genuinely is unreachable now; it survives only as an unused
> `GatewayErrorCode` member.

---

## 7. Troubleshooting handbook

### 7.1 Call returns `401 CALLER_TOKEN_INVALID`

- Wrong `Authorization` header format (must be `Bearer <jwt>`, scheme is case-insensitive)
- JWT expired → obtain a fresh JWT through the caller application's OIDC flow, requesting the configured a2wave resource audience; refreshing the `a2wave login` cache does not fix an audience mismatch unless the login Client ID is explicitly allowlisted
- `iss` mismatch → decode at [jwt.io](https://jwt.io) and compare against the configured OIDC issuer (must match exactly, trailing slash included)
- **`aud` not on the channel allowlist** — the most common failure when onboarding a new caller. Have the caller request a token issued for the configured a2wave resource audience (through the IdP's resource/audience parameter). Do **not** copy the rejected token's observed `aud` into the allowlist: it may identify another service, and accepting it would recreate the confused-deputy flaw described in §3
- Signature not verifiable against the IdP's JWKS (token minted by a different IdP, or the key was rotated out)

### 7.2 Call returns `503 OAUTH_NOT_CONFIGURED`

- Enterprise OIDC is not configured (issuer / client_id missing). Note this is **not** affected by the OIDC login toggle — disabling login leaves the channel running
- Check Settings → Enterprise login → OIDC (or the `A2WAVE_OIDC_*` env fallback), then run its "Test" action
- Startup logs name this case explicitly, including the "old `A2WAVE_OAUTH_IDAAS_*` still set, OIDC never configured" upgrade gap

### 7.2b Call returns `503 Identity provider unavailable`

Different from the above: the config is fine, but a2wave could not reach the IdP to verify the token
(discovery or JWKS fetch failed / timed out). This is deliberately **not** a 401 — the caller's
credentials are not the problem, and telling integrators otherwise sends them rotating tokens that
were always valid.

- Check egress from the API process to the issuer (firewall, split-horizon DNS, proxy)
- Settings → Enterprise login → OIDC → "Test" runs the same discovery server-side and reports a clearer error
- Retry once the IdP is reachable; nothing needs re-issuing on the caller side

### 7.3 Call returns `403 CALLER_NOT_AUTHORIZED`

The JWT is valid, but the caller's email is not on the Agent's allowlist (`specified_users`). In order of likelihood:

- **The Agent was migrated off `feishu_scope` and its allowlist is still NULL.** Migration `0100_awesome_marrow.sql` translates fail-closed, so every previously scoped Agent rejects everyone until the Owner enters the emails. This is the expected symptom right after an upgrade — see §4.4
- The user's IdP `email` claim differs from the address the Owner typed (a different domain, or a personal alias). Decode the token and compare the exact claim value; case and surrounding whitespace do **not** matter, anything else does
- The Owner opened the wrong Agent — the allowlist is per Agent, not shared across a workspace

Fix: `Agent details → Publish → OAuth Authorization`, add the email, re-publish. It takes effect on the next request; there is no cache to wait out.

### 7.4 Call returns `403` on the email claim

Two distinct gates, in this order — the first runs **before** the access-mode branch, so switching
the Agent's mode does not bypass it:

1. **No email claim at all** (`MISSING_EMAIL_CLAIM`) — rejected in **both** access modes. The
   address is what makes a disabled account revocable, so an address-less token is refused even
   under `all_idaas_users`. An `email_verified: false` address still satisfies *this* gate.
2. **No verified email** (`MISSING_VERIFIED_EMAIL` / `CALLER_TOKEN_CLAIMS_INVALID`) — reachable
   only under `specified_users`, which matches the verified address against the allowlist.

- The IdP client is not requesting the `email` scope → add it to the caller's client config
- The claim is present but `email_verified` is false → the IdP treats that address as unconfirmed; a2wave will not authorize on it under `specified_users`. Have the user verify the address at the IdP
- Switching to `all_idaas_users` relaxes only gate 2. A token carrying **no** email claim keeps failing in either mode

### 7.5 Call returns `424 PROVIDER_REAUTH_REQUIRED`

- The caller's IdP token has already been verified; do not have the caller re-log in
- Based on `details.provider`, have the Agent owner re-log into the affected Provider CLI (for example Codex, Cursor, Claude Code, or Pi) in the a2wave execution environment
- After the fix, use `details.runId` to cross-reference the logs, then re-issue the call

### 7.6 After switching to oauth, the old API Key call gets 401

- Expected behavior. After switching the auth method, the old shared key is no longer accepted
- The caller needs to migrate to an IdP-issued JWT, or temporarily fall back to `api_key` and re-publish

### 7.7 Discovery / JWKS unreachable

- Verification fetches `{issuer}/.well-known/openid-configuration` and then the JWKS. If the API process cannot reach the IdP (egress firewall, split-horizon DNS, proxy), every call fails `503` (`AUTHORIZATION_CHECK_UNAVAILABLE`) — deliberately not `401`, since the caller's credentials are not at fault
- Settings → Enterprise login → OIDC → "Test" runs the same discovery from the server, so it reproduces the failure with a clearer message

### 7.8 Browser SSO doesn't redirect back

- An issue on the IdP or SSO-tool side, out of a2wave's scope. Check the redirect/callback configuration of your IdP client and the SSO tool you use to obtain the JWT.

### 7.9 Debugging tips: observation and manual verification

**Check logs**: keywords `OAuth request authenticated` (passed) / `OAuth request rejected`

**Compare the actual claim against the allowlist**: decode the caller's token and read `email` / `email_verified` — this is the exact pair the allowlist is matched against, so it settles most 403s on the spot

```bash
printf '%s' "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{email, email_verified, aud, iss}'
```

**Read the persisted allowlist** (when you have DB access and want to confirm what was actually saved):

```bash
sqlite3 data/a2wave.db \
  "SELECT id, oauth_access_mode, oauth_allowed_emails FROM agents WHERE id='agt_xxx';"
```

A `NULL` in `oauth_allowed_emails` under `specified_users` is the fail-closed state — deny-all, not unrestricted.

---

## 8. Known limitations

### 8.0 SAML cannot drive this channel — OIDC only

`validateGatewayAuth` verifies the caller's bearer token through `verifyOauthChannelToken` →
`verifyWithIdpJwks`, i.e. a **JWT checked against the IdP's JWKS**, and
`isOauthChannelConfigured()` reads the OIDC config alone. SAML is structurally unable to feed
it: an assertion is a one-shot XML credential form-POSTed to the ACS endpoint, not a bearer
token a caller can replay in an `Authorization` header.

Consequence for a **SAML-only deployment**: the **Web** console signs in normally, but every
OAuth-published Agent answers `503 OAUTH_NOT_CONFIGURED`. The **CLI** has no SAML path either —
`a2wave login` drives the OIDC flow and exchanges the resulting JWT, so a SAML-only deployment
leaves `a2wave login --password` as the only CLI credential. Such deployments must configure OIDC
in addition to SAML.

Two wording traps when writing user-facing copy:

- "enterprise SSO" covers both protocols while this channel covers only one, so name OIDC
  explicitly rather than saying "SSO token".
- Do **not** narrow it to "ID token" either. `verifyWithIdpJwks` requires only `exp` and `sub`
  (plus issuer / audience / algorithm) and checks no ID-token discriminator such as `typ`,
  `token_use`, or `nonce`, so a JWT **access** token with an allowlisted `aud` verifies here —
  as well as an ID token. Since the channel's `aud` allowlist
  deliberately excludes `clientId`, an ID token (whose `aud` *is* the client id) is usually the
  wrong thing to reach for. Say "a JWT issued by the configured OIDC provider".

### 8.1 Restart loses the OAuth identity of queued requests

The OAuth identity is carried by an in-memory registry (`pending-job-registry.ts`). When the server restarts while a request is in the `queued` state:

- `recoverOnStartup` still recovers and executes this run
- But `takePendingContext(runId)` returns `undefined` → `runSteps.input.context.caller` is empty
- The request itself completes normally, **but the OAuth audit chain breaks**

This is an active trade-off in the current version: avoiding adding a column + a DB write for every enqueued request.

**Audit scan**:
```bash
sqlite3 data/a2wave.db \
  "SELECT rs.run_id, rs.created_at FROM run_steps rs JOIN runs r ON r.id=rs.run_id
   WHERE r.trigger_source='api' AND json_extract(rs.input, '$.context.caller') IS NULL
   ORDER BY rs.created_at DESC LIMIT 20;"
```

**Future plan**: add a `caller_context (JSON)` column to the `runs` table, written on enqueue, fallen back to on memory miss, and cleared on completion.

### 8.2 The allowlist is a manual roster, not a directory query

`specified_users` matches literal emails stored on the Agent; it does not resolve IdP groups, departments, or organizational units. A team whose membership changes often has to be maintained by hand on every affected Agent, and the same person appearing on ten Agents means ten edits. This is a deliberate trade for having **no** outbound dependency in the authorization path — the decision is a local column read, so it cannot fail, time out, or go stale. Population-level authorization by directory group is out of scope for this version.

### 8.3 Only the login email identifies the caller

Authorization keys on the JWT's **verified** `email` claim alone. A user whose IdP issues a different address than the one the Owner entered is rejected, and mail aliases are not resolved — only the exact claim value (case-insensitive, trimmed) counts. There is no fallback to `sub` or any other claim, keeping the decision criteria unified and auditable.

### 8.4 No per-caller revocation before token expiry

Removing an email from the allowlist stops the **next** call, but a token already issued stays cryptographically valid until it expires; a run already accepted keeps running. Nothing here is cached, so removal is effective immediately at the request boundary — but it is not a session kill switch.

---

## 9. Related reading

- Unified channel context shape: [run-channel-context.md](./run-channel-context.md)
- CLI-side SSO login + token exchange: [cli-oauth.md](./cli-oauth.md)
- JWT signature verification policy: `apps/api/src/lib/jwt-auth.ts`
- A2A protocol demo: [../a2a-demo.md](../a2a-demo.md)

## Changelog

| Version | Date | Change |
|------|------|------|
| v1.0 | 2026-04-17 | Initial release: deployment-level external IdP JWT verification |
| v1.1 | 2026-04-21 | Added Feishu app visible-scope permission decision; the default permission list includes `contact:user.id:readonly` and 8 others; `channel_info.feishu_scope` persisted |
| v1.2 | 2026-06-26 | OAuth publish adds access scope: default Feishu app visible scope, switchable to all IdP users (`all_idaas_users`) |
| v1.3 | 2026-08-05 | Retired the Feishu visible-scope mode (`feishu_scope`) and its Feishu credential dependency; replaced by an email allowlist (`specified_users`, `agents.oauth_allowed_emails`), with `all_idaas_users` now the default. Rows that actually published the oauth channel are migrated fail-closed by `0100_awesome_marrow.sql` (`specified_users` + NULL allowlist) while the rest land on the new default — `feishu_scope` was also the column DEFAULT, so it marked far more than the restricted subset. Publishing an empty allowlist is rejected with `400 OAUTH_ALLOWED_EMAILS_REQUIRED`; `channel_info.feishu_scope` is no longer written |
