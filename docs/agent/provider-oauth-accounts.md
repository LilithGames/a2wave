# Shared ChatGPT accounts for Codex

The Codex Provider owns shared account registrations. An Agent selects one with
`authMode: oauth` and `providerOauthAccountId`, either at the Agent level or in a
`config.providerChain` entry. Claude's `providerOauthToken`, API keys, and
server-local CLI sessions retain their existing contracts.

## Ownership and credentials

- Authenticated teammates may list and bind accounts. The creator or an
  administrator may rename, reconnect, or remove an account.
- An account registration is identified by Provider, issued OAuth client ID, and
  subject. Email is display metadata, never the identity key.
- Access, refresh, and ID tokens are encrypted through the existing secret-box
  service. DTOs, audit details, Agent config, exports, and CLI output never carry
  these tokens. Account IDs are references, not credentials.
- Portable exports/imports and clones clear account bindings. Re-select an
  account in the destination. No account is chosen implicitly.
- Refresh uses a per-account mutex and a database lease/revision check so a
  rotated refresh token or a concurrent reconnect cannot be overwritten by an
  older request. A failed refresh never borrows a server-local Codex login.

## Browser login on a different computer

The authorization service accepts an HTTP callback at
`127.0.0.1:<port>/auth/callback`. For a remotely deployed a2wave instance, that
listener belongs on the computer running the browser.

1. The authenticated Web or CLI client creates a pending login under
   `/api/providers/:id/oauth-accounts/login`. It receives a login ID and a
   short-lived, single-use connection code.
2. The local CLI starts a listener on an OS-selected loopback port. It sends the
   redirect URI to `/api/provider-oauth-logins/:id/start`, authenticated with the
   connection code. The server creates PKCE, state, and nonce values.
3. The CLI opens its local `/auth/start` page, which redirects to OpenAI. The
   upstream authorization parameters are kept out of terminal output. Reconnects
   reuse the issued client ID and an email hint; ID tokens stay on the server.
4. The callback goes to the local CLI, which checks state and forwards the code,
   state, and issued client ID to the server's `/complete` endpoint. The server
   exchanges the code and verifies the signed ID token's issuer, audience,
   expiry, subject, and nonce before saving credentials.
5. The Web dialog polls the authenticated login-status endpoint. In an Agent
   editor it selects the new account, but the binding is only persisted by the
   normal Save action.

The connection code is entered through a hidden CLI prompt or `--code-stdin`;
it is never a command argument. These two relay endpoints use the restricted
login ticket, not anonymous access or a borrowed a2wave user session.

## Execution and discovery

Codex subscription runs use the upstream `codex app-server --listen stdio://`
protocol. a2wave supplies the `openai_chatgpt_plan` provider configuration and
the selected account's access token in the child process environment. Codex
continues to own the inference/tool loop. `CODEX_ACCESS_TOKEN` is a different
credential contract and is not used for subscription sharing.

The adapter initializes with the a2wave client identity, starts or resumes a
thread, submits one turn, and waits for `turn/completed`. Only a completed turn
is successful. Session reuse includes the account identity, so changing accounts
cannot resume a thread under another account.

Before a turn, the account resolver requests enough remaining token lifetime for
the configured task timeout, capped at 55 minutes and respecting the provider's
earliest-refresh time. If a turn then fails with a structured upstream 401, the
adapter refreshes once, restarts app-server, and resumes the same thread with a
continuation instruction. It does not resend the original task. Both attempts
share the original deadline and their usage is accumulated. A failed renewal or
second authentication failure stops the run rather than replaying the task via
generic retry. This is one recovery opportunity, not unlimited session renewal.

Model discovery calls the authenticated SIWC `/v1/models` endpoint and reads
`models[].slug`, keeping entries whose visibility is `list`. The bundled CLI
catalog is not evidence that the selected account is authorized to run a model.

## Verification

Keep these evidence layers separate:

- Unit and route tests: PKCE/identity verification, permissions, rotation,
  persistence, reference validation, DTO redaction, and app-server events.
- Web E2E with external OAuth fixtures: both entry points, account selection,
  account-specific model requests, and the normal Agent save contract.
- Real locked Codex binary: invocation flags and initialize/close protocol.
- Live account acceptance: browser consent, real model discovery, a completed
  a2wave Agent run, and a second turn resumed with the same account. Neither
  fixture tests nor initialize alone prove this layer.

Protocol references: [sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in),
[profiles and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions),
[Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server).
