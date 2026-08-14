# Enterprise SSO (OAuth) Configuration

Enterprise SSO is the configuration a2wave uses to verify identities issued by an enterprise identity provider (IdP). It relates to both "backend enterprise login" and "user authenticated access":

- **Backend enterprise login**: after enabling OAuth / enterprise SSO login in "Settings → Enterprise Login", Web can use OIDC or SAML, while CLI enterprise login uses OIDC (or local password login as a fallback).
- **User authenticated access**: after enabling it on the Agent's OAuth card on the Channels tab, an external caller must carry a JWT issued by your enterprise OIDC provider (typically an access token) to access `/api/oauth/:agentId/invoke` (this channel does not support SAML — see below).

Two standard protocols are supported: **OIDC (authorization code + PKCE)** and **SAML 2.0**. Either one can be enabled once fully configured, and the corresponding button appears automatically on the login page; the master switch is "Settings → Enterprise Login → Enable OAuth / enterprise SSO login".

> [!TIP]
> **We recommend configuring it in the UI.** Go to "Settings → Enterprise Login → Login Methods", expand the OIDC or SAML panel, fill it in and save — **the database is authoritative, it takes effect immediately after saving with no restart needed**, and each panel comes with a callback address / SP metadata address (one-click copy for IdP registration) and a "Test" button. The environment-variable method below still works as a fallback: **when the UI is not configured, it falls back to environment variables**; when both are set, the UI (database) wins. Changing environment variables requires an API restart.

> [!IMPORTANT]
> **The OAuth publish channel reuses the OIDC config.** When an Agent is published with `oauth` auth, caller tokens are verified against this same enterprise OIDC — signing keys come from the IdP's JWKS and rotate automatically, so there is no separate key to maintain. Two things differ from login:
>
> - **The channel has its own audience (`aud`) allowlist.** Login requires `aud = Client ID`, which a caller integrating its own service does not hold, so the channel uses the current effective OIDC channel audience configuration instead. Settings takes precedence; `A2WAVE_OIDC_CHANNEL_AUDIENCES` is only the environment fallback when no valid OIDC configuration exists in Settings. **List the audience your IdP mints for a2wave** — for a JWT access token `aud` names the *target resource server* (this service), and the resource server must confirm it is in that audience ([RFC 9068 §3](https://www.rfc-editor.org/rfc/rfc9068#section-3)). Each caller requests it via the IdP's resource/audience parameter. **Do not list other applications' audiences**: such a token was never issued for a2wave, and accepting it makes this channel a confused deputy for that service's tokens — per-caller separation comes from the access scope and email allowlist, not from `aud`. **Client ID is not added automatically** — otherwise "can sign in to the console" would mean "can invoke every Agent". An empty effective audience configuration disables the channel (fail closed); it never means "allow everything".
> - **Turning off OIDC login does not stop the channel.** The login toggle only controls the sign-in button; already-published oauth Agents keep verifying callers, so forcing password-only sign-in does not break every external integration at once.
>
> When OIDC is not configured at all, the channel returns `503 OAuth not configured`.

## Standard OIDC login

Standard **OIDC (authorization code + PKCE)** login suits any standard OIDC IdP such as Keycloak, Okta, Azure AD, or Authing, and is also the verification source for the OAuth publish channel.

Configure it in the "Settings → Enterprise Login → OIDC" panel; the environment variables below act as a fallback (an API restart is required after changing them):

| Variable | Description |
|------|------|
| `A2WAVE_OIDC_ISSUER` | The IdP's issuer address; endpoints are auto-discovered via `{issuer}/.well-known/openid-configuration` |
| `A2WAVE_OIDC_CLIENT_ID` | The client_id registered with the IdP |
| `A2WAVE_OIDC_CLIENT_SECRET` | Optional. Treated as a PKCE public client when omitted |
| `A2WAVE_OIDC_SCOPES` | Optional. Defaults to `openid profile email` |
| `A2WAVE_OIDC_CHANNEL_AUDIENCES` | Environment fallback for the OAuth channel (comma-separated): the a2wave resource audience identifiers. Settings wins when configured. Client ID is not added automatically; when the environment is the active fallback, empty = channel disabled |

Once configured and with OAuth enabled in "Settings → Enterprise Login", the login page shows a **"Log in with OIDC"** button. Clicking it does a full-page redirect to the IdP to complete authentication, then automatically returns into the site after success; the verification public key uses JWKS auto-rotation, with no need to manually paste a public key. On login failure, the login page shows the specific reason (e.g. login session expired, email domain not on the allowlist, etc.). If the IdP's ID token does not contain an email (some IdPs only return the email at the userinfo endpoint), a2wave automatically fetches it from the userinfo endpoint, with no extra configuration needed on the IdP side.

When registering the app on the IdP side, set the callback address (Redirect URI) to `{service address}/api/auth/oidc/callback`.

> [!TIP]
> The "Test" button on the settings page not only checks discovery connectivity, but also probes the IdP's authorization endpoint to see **whether the callback address is registered**: when unregistered, it directly gives the address that must be registered character-for-character on the IdP side (protocol, host, port, and path must all match exactly; `localhost` and `127.0.0.1` are not interchangeable); when the test passes, it also echoes that address, which you can copy straight to the IdP for registration.

## SAML 2.0 login

For enterprise IdPs that only offer SAML (e.g. ADFS, some legacy IAM), a2wave can connect as a **SAML 2.0 SP**.

> [!IMPORTANT]
> **SAML covers login only — it cannot be used for the OAuth invocation channel.** A SAML assertion is a one-shot credential form-POSTed to the ACS endpoint; it issues no token that can be placed in an `Authorization: Bearer` header. The OAuth invocation channel verifies **OIDC-issued JWTs** exclusively. In a SAML-only deployment users can sign in to the **Web** console normally, but an Agent's OAuth channel is unavailable (it returns `503 OAuth not configured`), and **CLI** enterprise login is unavailable too — `a2wave login` uses the OIDC flow, leaving `a2wave login --password` as the only CLI option. Configure OIDC as well if you need either.

Configure it in the "Settings → Enterprise Login → SAML" panel; the environment variables below act as a fallback (an API restart is required after changing them):

| Variable | Description |
|------|------|
| `A2WAVE_SAML_IDP_ENTRY_POINT` | The IdP's SSO entry URL (HTTP-Redirect binding address) |
| `A2WAVE_SAML_IDP_CERT` | The IdP signing certificate (PEM, or the base64 body with header/footer lines removed) |
| `A2WAVE_SAML_SP_ENTITY_ID` | Optional. The SP entityId, defaulting to `{service address}/api/auth/saml/metadata` |

Steps to register the SP on the IdP side:

1. Open `GET {service address}/api/auth/saml/metadata` and provide the returned SP metadata XML (or the address itself) to the IdP admin to import;
2. Confirm the IdP assertion carries the user's email (the `email` attribute or a NameID that is an email), and that **signing is enabled on the assertion itself** (signing only the overall Response is not enough);
3. Configure the environment variables above and restart the API, then enable OAuth in "Settings → Enterprise Login".

Afterward, the login page shows a **"Log in with SAML"** button; clicking it does a full-page redirect to the IdP, and returns into the site automatically on successful authentication.

> [!TIP]
> After the settings-page "Test" passes, it echoes the three addresses that need registering on the IdP side: the **ACS address** (the assertion's Destination/Recipient must match character-for-character), the **SP Entity ID** (the assertion's Audience must match), and the **SP metadata address**. When the address registered on the IdP side differs from what's shown here (including `localhost` vs `127.0.0.1`), login is rejected.

## Same user logging in multiple ways (account merging)

When the same enterprise user logs in via OIDC and SAML, the account identifier returned by the IdP may take different forms. a2wave merges the two methods into one account by the **enterprise email verified by the IdP**: a user who has logged in via one method remains the same account when switching to another method, with no duplicate users created. If an OIDC identity explicitly marks the email as unverified (`email_verified: false`), that email is not used for merging (to prevent an unverified email from impersonating a same-email account); when the IdP does not send this claim, it is treated as verified.

The only exception is when the email belongs to a **local password account** (which has never gone through SSO): in that case no automatic binding happens, and the login page prompts you to first log in with the password, then complete binding under "User menu → Bind enterprise identity" — this avoids a same-name email hijacking a local account.

> [!NOTE]
> The two login methods (OIDC / SAML) can coexist, and the login page shows the corresponding buttons in order according to the server-side configuration. The "Bind enterprise identity" in the user menu and the "SSO verified access" on the share page likewise support both methods: the entry point renders according to the currently effective login method. To prevent cross-browser account pre-hijacking, "Bind enterprise identity" locks the binding flow to the browser that initiated the binding (OIDC uses an HttpOnly flow cookie, SAML uses a dedicated browser-binding nonce); completing the callback in another browser or with an invalidated session is rejected.
>
> **Deployment prerequisite (OIDC / SAML)**: the callback address (OIDC `redirect_uri` / SAML ACS) is taken only from "Settings → Run Artifacts → User-accessible address" (`publicBaseUrl`). When this address is not configured in production, OIDC / SAML login and "Test" report "no external access address configured"; please first set it to an externally accessible `https://` address.

## How do I confirm my enterprise identity is bound?

Look right after your name at the bottom left: once bound, a green badge appears there, and hovering it shows the full description. When the sidebar is collapsed (narrow screens collapse it automatically) your name is hidden — open the user menu and the badge sits next to your username at the top.

The protocol on the badge is **what the server recorded at bind time** (`OIDC` / `SAML`), not a guess from whichever login methods are enabled right now — so an admin adding or removing a method later never changes your badge. Accounts already bound before this feature shipped show the generic `SSO`: the platform did not record the protocol then, and stating "bound, method unknown" is more honest than guessing.

The badge describes the **stored binding**, not how you signed in most recently. On a deployment with several methods enabled it is therefore normal to click "Log in with SAML" and still see an `OIDC` badge.

While unbound there is no badge, and the user menu offers a clickable "Bind enterprise identity". Once bound, that row disappears: being bound is a state, not an action still waiting on you, so the badge alone carries it.

## Access scope

Enterprise SSO proves *who the caller is*; the **Access Scope** on the Agent's publish page decides *who may invoke this Agent*.

Two access scopes are supported:

| Access scope | Description |
|--------------|-------------|
| All enterprise users | Any employee holding a JWT issued by enterprise OIDC whose `aud` is on the allowlist, **and that carries an email claim**, can invoke it. |
| Specific enterprise users | Only the listed addresses can invoke it; everyone else is denied. Search for colleagues to add them, or type an address directly. |

Under **Specific enterprise users** an empty list means **nobody** can invoke the Agent (it denies rather than allows), so add at least one member before publishing. Entries are matched case-insensitively against the `email` claim in the OIDC JWT.

> [!NOTE]
> The former "Feishu app visibility scope" has been retired. On upgrade, Agents that used it **and publish the OAuth channel** are migrated to **Specific enterprise users** with an empty list — they deny every call until the Agent owner fills the list in. This keeps an upgrade from silently opening a deliberately restricted Agent to every employee. Agents without an OAuth channel simply land on the new "All enterprise users" default and are unaffected.
>
> The OAuth channel therefore no longer needs a Feishu App ID / App Secret; only the Feishu channel itself does.

## Common phenomena

| Phenomenon | Explanation |
|------|------|
| The settings-page OAuth switch turns on, but SSO doesn't work | Neither OIDC nor SAML is fully configured, or both are disabled; hit "Test" on the relevant panel to see the exact reason |
| Red text appears after enabling OAuth authorization on the publish page | Enterprise OIDC is not configured (the channel returns `503`). Note this is unrelated to the OIDC *login* toggle — turning login off does not stop the channel |
| A newly onboarded caller always gets 401 | Usually the caller obtained a token for the wrong resource. Ask it to request a token issued for the configured a2wave audience; do not copy an arbitrary observed `aud` into the allowlist, because that token may have been issued for another service |
| Every caller returns 503 "identity provider unavailable" at once | a2wave cannot reach the IdP (discovery / JWKS fetch failed). Caller credentials are fine and need no re-issuing; check egress, DNS and proxy |
| Sending `/api/oauth/:agentId/invoke` directly to someone else still won't work for them | The other party must first authenticate at the enterprise IdP to obtain a token, and must be within that Agent's permission boundary |

## Handling invocation errors

OAuth API errors contain `code`, `message`, `source`, `action`, and `retryable`. Calling programs should key on `code`, use `message` as the human-facing action instruction, and not guess the cause from the HTTP status alone.

| source | What it means | Who takes action |
|--------|----------|------------|
| `caller` | A problem with the caller's token, permission, IP, or request content | The current caller |
| `agent` | A problem with the Agent's publishing, queue, workspace, or configuration | The Agent owner |
| `provider` | A problem with the Codex / Cursor / Claude Code login, quota, or service | The Agent owner, or retry later |
| `platform` | An SSO or a2wave platform anomaly | The platform admin |

Synchronous calls return this structure in the top-level `error`; SSE returns it in `event: error`; the default async call returns it in the polled result's `data.result.error`. The code and message are consistent across all three.

HTTP `424` indicates the Agent's Provider, execution engine, model, MCP, or workspace configuration needs the Agent owner's attention; a workspace returns `409` only when it is occupied. `INTERNAL_ERROR` indicates a platform-internal anomaly with `retryable` as `false`, and the caller should contact the platform admin with `details.runId`.

> [!WARNING]
> `PROVIDER_REAUTH_REQUIRED` means the Agent's Provider login has expired. The message will explicitly ask you to contact the Agent owner; re-logging in the caller's own SSO account will not resolve it.

## Related

- [Trigger Methods](/wiki/triggers) · [Member Management](/wiki/members) · [Getting Started](/wiki/getting-started)
