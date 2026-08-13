# Trigger Methods

a2wave currently provides **eight publish channels**: REST API, OAuth, A2A protocol, Feishu, Slack, Discord, scheduled trigger, and chat page. A single Agent can enable multiple at once. Slack and Discord currently provide text messaging through the same direct-connection model as Feishu and will later converge on a shared chat-channel adapter.

## Managing channels on the Publish tab

The Agent's **Publish** tab lays every channel out as a card, so you can see at a glance which ones are on. The filter above the grid narrows by category: All / API / Protocol / Chat Bots / Scheduled / Web App.

Each card carries two independent actions:

| Action | What it does |
|--------|--------------|
| **Configure** | Opens the channel's dialog to fill in and save its credentials and settings. **Saves config only — it does not put the Agent live.** |
| **Enable switch** | Controls whether the channel actually serves traffic. |

> [!NOTE]
> Configuring and enabling are separate. You can save your Feishu App ID and Secret now and leave the bot switched off until you are ready.

**A channel that is not fully configured cannot be enabled** — its switch is greyed out, with a tooltip explaining why. If Slack is missing its App Token, for example, the switch stays disabled rather than letting you turn on a channel that could never connect. REST API is always on and therefore has no switch.

Once configured, click **Publish / Update** at the bottom of the page to put the Agent live. For an Agent that is already live, saving in a channel's dialog takes effect immediately and only affects that channel — the other channels' connections are left alone.

### Connection status for chat channels

Feishu, Slack and Discord each hold their own **long connection** to the platform, so their cards show a live connection status labelled with the protocol each one speaks: **WebSocket** for Feishu, **Socket Mode** for Slack, and **Gateway** for Discord. With all three enabled at once, the protocol name is what tells you which connection to go and debug.

| Status | Meaning |
|--------|---------|
| **Connected** | This instance holds the channel's long connection and messages flow normally. |
| **Reconnecting** | The connection is registered but not yet open; it usually recovers on its own. |
| **No connection on this instance** | The Agent is published, but this API instance holds no connection for that channel — usually because another Agent claimed the app first (see "one App, one connection"), or the credentials are wrong. |
| **Pending publish** | The switch was just changed but not published yet. The connection does **not** follow the switch immediately — it is opened or dropped when you click Publish / Update. |
| **Status unavailable** | The connection status could not be read (API error or network problem); the socket may or may not still be up. |
| **Not running** | The Agent is a draft or has been stopped, so no long connection is established. |
| **Not connected** | The channel has saved config but is not enabled. **Disabling a channel or stopping the Agent drops its connection once the change is published.** |

> [!IMPORTANT]
> The status reports the **real server-side connection**, not the position of the switch. So after you flip a switch but before you publish, the card reads "Pending publish" rather than following the switch — that keeps "I changed it but haven't applied it" distinguishable from "it applied but cannot connect", which are entirely different problems.

> [!NOTE]
> The status reflects **this server instance only**. In a multi-replica deployment it is normal for one replica to report "no connection on this instance" — the connection is held by whichever replica claimed the app. Status refreshes every 15 seconds, and immediately after publish / stop / resume.

A channel that was never configured shows no connection status; nor do the remaining channels (REST API, OAuth, A2A, scheduled, chat page), which are inbound HTTP or internal scheduling and hold no long connection.

**The Agents list and the Agent detail header** also show a summary indicator carrying the **worst** status across that Agent's enabled chat channels — so a dropped connection is visible while scanning the list, without opening each Agent's Publish tab.

---

## 1. API (Gateway invocation)

Invoke a published Agent through the gateway API — suitable for backend services, scripts, and third-party system integration.

### Invocation

```
POST /api/gateway/:agentId/invoke
Authorization: Bearer <apiKey>     # required when publishAuthType=api_key
Content-Type: application/json
```

Request body fields:

| Field | Type | Default | Description |
|------|------|------|------|
| `message` | string | — | Required, 1–100000 characters |
| `context` | object | — | Custom context (`channel`/`caller` are reserved and will be stripped) |
| `stream` | bool | `false` | Whether to stream via SSE |
| `async` | bool | `true` | Whether asynchronous (async by default!) |
| `worktree` | object | — | `{name, cleanup: ephemeral\|ttl\|persistent, branch?}` |
| `attachments` | array | — | Image/file attachments (upload first to get a token; see "Attachments" below) |

Optional request header `X-Idempotency-Key`: deduplicates retries within that Run's lifetime window.

### Three response modes

```bash
# Async (default): returns runId immediately, then poll
curl -X POST ".../api/gateway/<agentId>/invoke" -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" -d '{"message":"hi"}'
# → 202 { "data": { "runId": "run_..." } }   also carries "status":"queued" when queued

# Sync: waits for completion and returns the result
curl ... -d '{"message":"hi","async":false}'
# → 200 { "data": { "reply":"...", "runId":"run_...", "durationMs": 1234 } }

# Streaming: SSE, events update / log / done / error
curl ... -d '{"message":"hi","async":false,"stream":true}'
```

### Polling and canceling

```bash
# Query Run status
curl ".../api/gateway/<agentId>/runs/<runId>" -H "Authorization: Bearer <key>"
# → { "data": { "runId, status, result, createdAt, updatedAt } }

# Cancel (only running / queued can be canceled)
curl -X POST ".../api/gateway/<agentId>/runs/<runId>/cancel" -H "Authorization: Bearer <key>"
```

### Constraints

- **Rate limit**: **60 requests/minute** per Agent.
- Full queue returns `429`; unpublished returns `403`; auth failure `401/403`; occupied worktree `409`.
- Authentication: `/api/gateway` uses `api_key` (Bearer) / IP allowlist; JWTs issued by your enterprise OIDC provider use the separate `/api/oauth` channel.

> [!NOTE]
> An API key identifies the integration calling the endpoint, not the end user behind that integration, so run history normally shows only `API`. If a direct invocation must be attributed to a specific enterprise user, use the OAuth endpoint with that user's own OIDC JWT. Supplying a user name inside `context` is not a substitute for identity verification.

> [!IMPORTANT]
> Behind a reverse proxy, set `TRUSTED_PROXY=true` and list only the proxy's direct TCP addresses or CIDRs in `TRUSTED_PROXY_ADDRESSES`. Gateway, OAuth, and A2A then use the first untrusted hop found by walking `X-Forwarded-For` from right to left for IP allowlists, audit/channel context, and rate limits. The proxy must overwrite XFF or append every hop; never preserve an unvalidated, non-standard chain.

Remote A2A routes support ordinary private, CGNAT, and ULA targets by default. URL/DNS validation,
redirect revalidation, connection pinning, and the hard deny for loopback, link-local, cloud
metadata, and other reserved ranges remain active. Set `ALLOW_PRIVATE_ROUTE_TARGETS=false` to
require public targets. In that strict mode, `TRUSTED_A2A_ROUTE_HOSTS` can admit exact controlled
private DNS hostnames without disabling the remaining protections.

### OAuth (enterprise OIDC JWT) invocation

The OAuth invocation endpoint is `POST /api/oauth/:agentId/invoke`. The request header carries the caller's own `Authorization: Bearer <OIDC_JWT>`; that token only proves "who the caller is" and is independent of the Codex / Cursor / Claude Code credentials the Agent uses when executing.

> [!IMPORTANT]
> This channel accepts **only JWTs issued by your enterprise OIDC provider** (typically an access token), verified against the IdP JWKS with an `aud` in the **current effective OIDC channel audience configuration**. Settings takes precedence; `A2WAVE_OIDC_CHANNEL_AUDIENCES` is only the environment fallback when no valid OIDC configuration exists in Settings. SAML login uses a browser-based assertion flow and produces no token that can be placed in an `Authorization` header, so **a SAML-only deployment cannot use the OAuth invocation channel**.

When an error is returned, prefer reading `error.code`, `error.message`, and `error.action`:

| code | Who needs to act | Next step |
|------|------------|--------|
| `AUTH_REQUIRED` / `CALLER_TOKEN_INVALID` | Caller | Obtain a fresh JWT from the caller's own OIDC client for the configured a2wave resource audience |
| `CALLER_TOKEN_CLAIMS_INVALID` | Caller / platform admin | Obtain a new JWT from the configured OIDC provider containing an email claim; `specified_users` additionally requires a verified email |
| `CALLER_NOT_AUTHORIZED` / `IP_NOT_ALLOWED` | Caller + Agent owner | Request permission or switch to an allowed network |
| `PROVIDER_REAUTH_REQUIRED` / `PROVIDER_AUTH_FAILED` | Agent owner | Re-log in or update the Agent's Provider credentials; the caller does not need to re-log in |
| `AGENT_CONFIGURATION_ERROR` / `AGENT_WORKSPACE_UNAVAILABLE` | Agent owner | Fix the engine, model, MCP, or workspace configuration; non-occupancy errors return `424` |
| `AGENT_QUEUE_FULL` / `SESSION_BUSY` | Caller | Wait for the current Run to finish, then retry |
| `OAUTH_NOT_CONFIGURED` / `AUTHORIZATION_CHECK_UNAVAILABLE` | Platform admin | Check the platform configuration or retry later |

> [!IMPORTANT]
> An HTTP `401` on the OAuth interface only means the caller's OIDC JWT is invalid. If the message points to the Agent Provider, the caller should not clear their own login state.

### Public metadata

If an external system only needs to display public info about published Agents, it can batch-query the public read-only interface:

```bash
curl ".../api/public/agents/metadata?agentIds=agt_1,agt_2"
```

The returned fields include the Agent name, the description from its config page, whether the OAuth channel is enabled, and the OAuth access mode:

| Field | Description |
|------|------|
| `name` | Agent name |
| `description` | Description from the Agent's config page |
| `oauthEnabled` | Whether the publish channels include OAuth |
| `oauthAccessMode` | `all_idaas_users` means all enterprise users; `specified_users` means only the addresses on the allowlist |

Agents that are unpublished, stopped, or nonexistent uniformly return `exists: false`, without exposing draft information.

---

## 2. Feishu

First complete these three groups of settings in the [Feishu Open Platform](https://open.feishu.cn/) app console, then return to a2wave to fill in the App ID / App Secret:

1. **Grant permissions**: go to **Development configuration → Permission management** and grant `im:message` (send and receive messages) and `im:message.group_at_msg` (receive @-mentions in groups). If you enable “Fetch sender user info” in a2wave, also grant `contact:contact.base:readonly`, `contact:user.base:readonly` (name) and `contact:user.email:readonly` (email); interactive cards additionally need `cardkit:card:write`. Permission changes only take effect after you publish a new version under **Version management & release** and it is approved.
2. **Subscribe to events**: go to **Development configuration → Events & callbacks → Events**, choose **long connection** as the subscription mode (no public callback URL needed — a2wave connects out to Feishu), then add the `im.message.receive_v1` event.
3. **Subscribe to callbacks** (only needed for interactive cards): on the same page under **Callbacks**, again choose **long connection** as the subscription mode and add the `card.action.trigger` callback. Skip this if you do not use interactive cards.

> [!IMPORTANT]
> Events and callbacks are two independent settings in the Feishu console, and each needs its own long-connection mode. If you subscribe to the event but miss the callback, ordinary messages arrive fine but button clicks on interactive cards do nothing at all.

Once that is done, open the Feishu Bot card's **Configure** dialog on the Publish tab in a2wave and set the **App ID / App Secret** plus the trigger and reply policies:

- **Group chat**: triggered on being @-mentioned (`groupTriggerOnAt`, on by default) / triggered on any new message (off by default); reply modes `quote / new / none`. Replies to ordinary group messages mention the trigger sender by default; selecting “Do not mention anyone” under “Mention on reply” turns that off for ordinary group replies as well.
- **Topic group**: triggered on @-mention / new topic / new comment; reply modes `topic_reply / none`. “Mention on reply” can target the trigger sender (default), the topic creator, or no one. The first two answer “whom to mention” and apply to topic replies only — an ordinary group message has no topic creator, so it always mentions the trigger sender. “Do not mention anyone” answers “mention at all?” and applies to every group reply, ordinary messages included. When the topic creator is selected, the platform reads the root message sender; if that lookup fails, it mentions no one rather than notifying a triggering bot by mistake. This applies only to plain-text and rich-text replies. By default a topic reply only sends the current message content, and continuous context within the same topic relies on the Agent's session history; to attach the topic's first message (text/images/files) on every reply, enable “Include the topic root message content” (`topicInjectRootMessage`) on the publish tab.
- **Direct message (P2P)**: always triggers; reply mode is selectable.
- **Reply content type**: `text / post / interactive / interactive_card / streaming_card`; optionally send artifacts as files, and choose whether to resolve the user's identity.
- **File messages**: when a user triggers the Agent by sending a file directly in Feishu, the platform first downloads the file and writes the readable file path for this round into the input content and `context.files`; the Agent can read the file at that path. Temporary files are cleaned up automatically after the run finishes.

> [!WARNING]
> **One App, one connection**. Within a single API process, a given Feishu App ID may hold only **one** active WebSocket — **first come, first served; later starters must not preempt**. Multiple Agents connecting to Feishu must each use a **separate Feishu app**. The connection status is shown directly on the Feishu card in the Publish tab (a preempted app reads "no connection on this instance"), and also in the Agent's "Full Diagnosis".

### Interactive cards

Once you set the reply content type to **`interactive_card`**, whenever the Agent needs you to **confirm an action** or **fill in / choose information** to continue, it will directly send a clickable, fillable Feishu card (confirm/cancel buttons, dropdown single-select, multi-select, text input, date, etc.) instead of asking you to type out an answer. After you act and submit, the result returns as a new round of input to **the same session**, and the Agent continues accordingly.

- **Who can act**: only the **card's recipient** (the person who triggered this round of conversation) can act; clicks by others in the group are rejected, avoiding mistaken actions on your behalf.
- **Where replies land**: after continuing, the Agent's reply **always attaches to your original question message**, rather than nesting layer by layer under the cards — even if several cards pop up in a row, the reply chain always returns to the initial question, so the group doesn't get increasingly tangled.
- **Validity**: cards have an expiry; clicking an expired or already-handled card shows an "invalid" prompt, and you'll need to start a new conversation if needed.
- When there's nothing to interact with, the Agent's ordinary reply is still rendered in the card style as usual.

---

## 3. Slack

Complete these three groups of settings in Slack App Management first:

1. **Enable Socket Mode**: open **Settings → Socket Mode**, enable Socket Mode, and create an App-Level Token (for example, `xapp-...`) with `connections:write`.
2. **Configure OAuth scopes**: open **Features → OAuth & Permissions** and add `app_mentions:read`, `chat:write`, `im:history`, `files:read`, and `files:write` under **Bot Token Scopes**. `files:read` reads Slack Files sent by users, while `files:write` uploads Agent artifacts back to Slack. After changing scopes, you must **Install/Reinstall to Workspace**, then copy the Bot User OAuth Token (for example, `xoxb-...`).
3. **Subscribe to message events**: open **Features → Event Subscriptions**, turn on **Enable Events**, then add `app_mention` and `message.im` under **Subscribe to bot events**.

> [!IMPORTANT]
> OAuth scopes and Event Subscriptions are separate settings. Even after OAuth succeeds, Slack will not deliver messages to a2wave unless **Enable Events** is on and `app_mention` plus `message.im` are subscribed.

To trigger on every new message in public or private channels, also subscribe to `message.channels` and `message.groups`, and grant `channels:history` plus `groups:history`.

After completing the Slack-side setup, open the Slack card's **Configure** dialog on the Publish tab and enter the **App ID** (`A...`), **App Token** (`xapp-...`), and **Bot User OAuth Token** (`xoxb-...`). Channel messages trigger on @mention by default, while direct messages always trigger. Before testing in a channel, add the bot to that channel and send `@Bot hello`; you can also DM the bot directly.

> [!WARNING]
> Within one API process, a Slack App ID can be held by only one Agent's Socket Mode connection. A later Agent does not preempt the existing connection. Use separate Slack apps for multiple Agents.

Slack Files are downloaded under the platform-wide attachment policy and provided to the Agent; a file-only direct message can also trigger a run. Standard Markdown responses from the Agent are rendered through Slack Markdown Blocks, so headings, tables, bold text, code blocks, and links display correctly instead of exposing raw Markdown markers. Execution-sandbox paths, `sandbox:` links, and local HTML download controls are removed from replies; the platform delivers the actual artifacts. Agent artifacts are uploaded directly to the original conversation by default. Successful uploads do not repeat the download section; an a2wave download link is sent only as a fallback when an upload fails. Direct file delivery can be disabled in the Slack channel settings. Interactive components such as buttons are not sent.

---

## 4. Discord

Open the Discord card's **Configure** dialog on the Publish tab and provide the **Application ID** and **Bot Token**. Enable **Message Content Intent** in the Discord Developer Portal, then invite the bot with `View Channels`, `Send Messages`, `Read Message History`, and `Attach Files`. Add `Send Messages in Threads` when using thread channels.

Server-channel messages trigger on @mention by default, with an option to trigger on every new message. When the Application ID and Bot Token are unchanged, saving message behavior updates the active Gateway connection immediately without reconnecting. Replies can reference the original message, send a new message, or be disabled. Direct messages always trigger. Agent sessions are maintained per user within a server channel, while Discord threads are isolated by their channel ID.

> [!IMPORTANT]
> “Trigger on every new channel message” requires **Message Content Intent** under Developer Portal → Bot → Privileged Gateway Intents. The bot must also be able to view the target channel. Messages sent by bots and webhooks do not trigger the Agent, preventing reply loops.

> [!WARNING]
> Within one API process, a Discord Application ID can be held by only one Agent's Gateway connection. Use separate Discord applications for multiple Agents.

Discord Attachments are downloaded under the platform-wide attachment policy and provided to the Agent; an attachment-only direct message can also trigger a run. Agent artifacts are uploaded directly to the original conversation by default. Successful uploads do not repeat the download section; an a2wave download link is sent only as a fallback when an upload fails. Execution-sandbox links in Agent output are not exposed to external chat channels. Direct file delivery can be disabled in the Discord channel settings. Embeds, buttons, and modals are not sent.

---

## 5. Chat page

Publish an Agent as a shareable chat page: its profile, status and creator on the left, a full conversation window on the right. Good for handing an Agent straight to a colleague without teaching them the console first.

Open the Chat Page card's **Configure** dialog on the Publish tab; once saved, switch the card on and you get a link:

```
https://<your-domain>/agents/<agentId>/chat_app
```

Use the icon beside the link to preview it in a new tab, or copy it and send it to a colleague.

Configuration:

| Setting | Description |
|---------|-------------|
| **Page title** | Overrides the name shown on the page; falls back to the Agent name when blank. |
| **Welcome message** | Markdown, shown before the first turn. Leave blank for the default hint. |
| **Suggested questions** | One per line, up to 6. Visitors can tap one to ask it directly. |
| **Show creator** | Whether to display the Agent's creator in the sidebar. |
| **Allow attachments** | Uses the global attachment limits (type, size, count). |
| **Show thinking** | Reveal tool calls and intermediate steps. Turn off for a cleaner, purely conversational view. |

> [!IMPORTANT]
> The chat page is **never anonymous**. Visitors must be signed in to a2wave and have read access to the Agent (owner / editor / viewer, or admin); signed-out visitors are sent to the login page. The link itself grants nothing — send it to someone without access and they will only see "Page unavailable".
>
> Disabling the channel takes effect immediately: the toggle is checked on every turn, so anyone who already had the page open can no longer ask anything. Revoking a link does not require them to close it first.
>
> Note what this does and does not do: turning the channel off withdraws **this page as an entry point**, not access to the Agent itself. Anyone who already had read permission can still invoke the same Agent through **Test chat** on the Agent detail page. To actually stop someone from using it, remove their Agent permission (see [Members & permissions](/wiki/members)) or stop publishing the Agent.

Every conversation is written to run history with the source marked `Chat Page`, so it can be filtered by channel under **Runs** and counts toward the Agent's statistics for auditing and troubleshooting. If the Agent is inactive or has been stopped, the page says so explicitly rather than failing silently.

---

## 6. A2A Protocol

A2A (Agent-to-Agent) lets external Agent systems discover and invoke this platform's Agents, and lets this platform's Agents route to standards-compliant remote A2A services. The platform supports **A2A 1.0 JSON-RPC** and remains compatible with **A2A 0.3 JSON-RPC**.

### Publish as an A2A service

Enable **A2A Protocol** on the Agent's Publish tab, then copy the Agent Card URL and invocation endpoint shown there. A caller first reads the Agent Card, then sends requests to the protocol version and endpoint advertised by the card.

```bash
# Discovery: fetch the Agent Card
curl -H "A2A-Version: 1.0" ".../api/a2a/<agentId>/.well-known/agent-card.json"

# A2A 1.0 invocation: JSON-RPC
curl -X POST ".../api/a2a/<agentId>" -H "Authorization: Bearer <key>" \
  -H "A2A-Version: 1.0" -H "Content-Type: application/json" -d '{
    "jsonrpc":"2.0","id":"1","method":"SendMessage",
    "params":{
      "message":{"messageId":"msg-001","role":"ROLE_USER",
                 "parts":[{"text":"Hello, A2A!","mediaType":"text/plain"}]},
      "configuration":{"returnImmediately":false,"acceptedOutputModes":["text/plain"]}
    }
  }'
```

The Agent Card is version-negotiated as well: include `A2A-Version: 1.0` when requesting the v1 shape. Omitting the header intentionally returns an A2A 0.3-compatible Card.

For A2A 1.0, the streaming method is `SendStreamingMessage`; task lookup and cancellation are `GetTask` and `CancelTask`. For async operation, set `returnImmediately` to `true`, then poll the returned Task with `GetTask` until it reaches a terminal state. A2A 0.3 clients can continue to use `message/send`, `message/stream`, `tasks/get`, and `tasks/cancel`, together with the lowercase role and task-state values. Authentication uses the Agent's A2A API Key (`a2aAuthType` is `none` or `api_key`). The OAuth channel's OIDC JWT is **not** accepted here and returns `401`.

Locally, `pnpm a2a-demo -- <agentId> "..."` provides a quick test. A2A messages can carry images/files as well as text; A2A 1.0 and 0.3 use different part fields, shown under **Attachments** below.

### Call provenance

When both the caller and receiver support the A2A provenance extension, a remote invocation carries the **immediate calling Agent's name** and, when an upstream channel has already identified a user, that user's display name. The receiver's run list can therefore show `user·calling Agent·A2A`, or `calling Agent·A2A` when no user is available.

The extension is negotiated through the Agent Card. Routes using **Agent Card discovery** enable it automatically when the peer advertises support. A **Direct endpoint** has no card for capability discovery: select A2A 1.0 and then explicitly enable **Send caller provenance** only when the receiver supports the a2wave extension. The switch is off by default, and direct A2A 0.3 routes never send the extension. A2A peers without the extension remain fully interoperable; their run history simply falls back to fewer layers, down to `A2A` when only the source is known.

> [!IMPORTANT]
> Provenance names are for audit display, not authorization. The A2A call must still pass real API Key authentication, and a receiver must not grant access from a display name in the provenance extension.

### Invoke a remote standard A2A service

Open **A2A Route** on the Agent's Configuration tab and add a remote Agent:

1. Enter a name used to identify the target during routing.
2. Prefer **Agent Card discovery** and paste the remote service's Agent Card URL. The platform reads the card and automatically selects its advertised A2A 1.0 or 0.3 JSON-RPC interface.
3. If the service has no reachable Agent Card, choose **Direct endpoint**, enter its JSON-RPC URL, and explicitly select `A2A 1.0` or `A2A 0.3`. For a compatible A2A 1.0 receiver, optionally enable **Send caller provenance**.
4. If the remote service requires a Bearer key, enter its API Key. After saving, the credential is shown only as a mask and is never included in the Agent Card or routing result.

> [!NOTE]
> **Direct endpoint** mode cannot discover remote capabilities. Direct A2A 1.0 therefore uses non-streaming `SendMessage` conservatively, while existing A2A 0.3 routes retain the `message/stream` compatibility path. Use **Agent Card discovery** when you need standard A2A 1.0 streaming and the peer advertises it.

### Long tasks, timeouts, and cancellation

A2A routing no longer adds a fixed five-minute execution deadline. The effective execution window inherits the **calling Agent's** single-execution limit under **Configuration → Timeout**. Increase that setting on the calling Agent (5–120 minutes) when a remote task legitimately needs more time; there is no separate route timeout to update. If **Total timeout** is configured, its whole-Run limit still covers retries and multiple Agent calls.

For A2A 1.0, the platform obtains a Task ID as early as possible and then follows that Task's lifecycle. Non-streaming calls use `GetTask`. If a streaming connection with a known Task ID is idle for 30 seconds or disconnects unexpectedly, the router first uses `SubscribeToTask` and falls back to `GetTask`. Recovery uses only the existing Task ID and **never resends the original message**, preventing duplicate remote execution. Partial artifact chunks received before a disconnect remain part of the invocation and are combined with later append chunks after reconnection. Working-state messages remain progress only and are not returned as the successful final answer when a terminal Task has no response body. A temporarily unavailable terminal history read continues with the same `GetTask` backoff policy even after resubscription succeeded.

When the parent Run is canceled or reaches its timeout, the router sends `CancelTask` through an independent short control request whenever a Task ID is known, and reports whether downstream cancellation was confirmed. The same best-effort cleanup is attempted when a known Task exceeds the router's result safety limits, or when both reconnect and polling fail permanently while the last observed Task is still running. This prevents a downstream task from continuing unseen after the caller has received a recovery error. Even when the underlying Agent CLI has begun exiting after a timeout, the platform gives the router a brief cleanup window and waits for the cancellation request before terminating the process. A2A lifecycle events appear directly in the Run detail's **Execution log** timeline, including the target Agent, Task ID, state, reconnect attempts, and cancellation result. They never contain the request body or credentials. A connection that fails before returning a Task ID cannot be safely reconnected or canceled, so the router reports the failure without guessing or replaying the message. A2A 0.3 routes remain protocol-compatible and inherit the parent's cancellation signal, but the full reconnect-and-cancel-by-ID guarantee applies only to A2A 1.0; use A2A 1.0 for long-running work.

> [!NOTE]
> If a standard remote Agent returns `INPUT_REQUIRED` or `AUTH_REQUIRED`, routing reports a non-success result containing the Agent's status message plus its `taskId` and `contextId`. The route tool does not resume that remote task automatically; provide the requested context in a new invocation, or update the remote credentials before retrying.

> [!NOTE]
> Existing remote routes contain only an endpoint URL. When edited, they keep their original behavior as **Direct endpoint + A2A 0.3**. To adopt standard discovery, explicitly switch to **Agent Card discovery** and enter the card URL.

> [!IMPORTANT]
> Remote routing currently supports JSON-RPC interfaces advertised by the card. Both the Agent Card URL and selected invocation endpoint pass URL, DNS, and redirect safety checks. Ordinary enterprise-private services work by default; administrators can set `ALLOW_PRIVATE_ROUTE_TARGETS=false` for public-only mode and use `TRUSTED_A2A_ROUTE_HOSTS` for exact private-DNS exceptions.

---

## 7. Scheduled trigger

Have an Agent automatically create and execute Runs at specified times on a Cron schedule (e.g. daily code review, weekly reports, inspections). Open the Schedule Trigger card's **Configure** dialog on the Publish tab:

- **cron**: 5 fields `minute hour day month weekday`.
- **intent**: the intent text at trigger time, supporting the Mustache variables `{{date}}` / `{{time}}` / `{{iso}}`.
- **timezone**: defaults to `Asia/Shanghai`.
- **Multiple schedules**: the same Agent can be configured with multiple cron entries, each using a different trigger intent and timezone.

To enable: include `schedule` in the publish channels. Common Cron expressions:

| Expression | Meaning |
|--------|------|
| `0 9 * * *` | Every day at 9:00 |
| `0 10 * * 1` | Every Monday at 10:00 |
| `*/30 * * * *` | Every 30 minutes |
| `0 0 1 * *` | Day 1 of each month at 0:00 |

Notes: minute-level precision; each Agent can be configured with multiple scheduled tasks; scheduled Runs **share the same queue** as other sources and are subject to the Agent's `maxConcurrency`.

---

## Attachments (images and files)

When messaging an Agent you can include images and documents. Feishu, Slack, and Discord automatically recognize images/files in a message; API, OAuth, and the Agent test UI use a **two-step upload**, while A2A uses protocol-native parts.

**Two-step upload (API / OAuth / test UI)**

1. First upload the file to the corresponding upload endpoint (`multipart/form-data`, field name `file`) to get a `token`. The upload endpoint differs by the caller's authentication method:
   - Platform user (Web test UI): `POST /api/attachments`
   - Gateway (Agent API Key): `POST /api/gateway/<agentId>/attachments`
   - OAuth (enterprise OIDC JWT): `POST /api/oauth/<agentId>/attachments`

```bash
curl -X POST ".../api/gateway/<agentId>/attachments" -H "Authorization: Bearer <key>" \
  -F "file=@./chart.png"
# → { "data": { "token":"att_...", "name":"chart.png", "mimeType":"image/png", "size":12345 } }
```

2. When calling invoke, include the reference in `attachments`:

```bash
curl -X POST ".../api/gateway/<agentId>/invoke" -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" -d '{
    "message":"take a look at this chart",
    "attachments":[{"token":"att_...","name":"chart.png","mimeType":"image/png"}]
  }'
```

**In the test UI**: in the "Test" drawer on the Agent detail page, the paperclip button next to the input box lets you pick an image/file; images show a thumbnail preview, and after sending, the attachment is handed to the Agent along with the message.

**A2A 1.0**: use `raw` (base64) or `url` in `message.parts`, together with a filename and media type:

```json
{ "raw":"<base64>", "filename":"doc.pdf", "mediaType":"application/pdf" }
```

**A2A 0.3**: use a `file` part with inline `bytes` (base64) or `uri`:

```json
{ "kind":"file", "file": { "bytes":"<base64>", "name":"doc.pdf", "mimeType":"application/pdf" } }
```

> [!NOTE]
> Supports images (png/jpg/jpeg/webp/gif) and common documents (pdf/txt/md/csv/docx/xlsx), defaulting to a 10MB per-file limit and up to 10 per call. Uploaded files first enter a staging area, retained for 7 days by default before automatic cleanup — admins can adjust the retention duration, size limit, and allowed types in "Settings → Upload Attachments". The platform persists attachments to disk and provides their paths to the underlying Agent, which reads them itself. Within the retention window, image attachments in run records / chat history can be previewed directly; after expiry cleanup, only the filename is shown.

---

## Troubleshooting

| Symptom | Possible cause | Solution |
|------|---------|------|
| Invocation 401/403 | Wrong key / Agent not published | Verify the Bearer key, confirm it's published |
| Invocation 429 | Rate limit exceeded or queue full | Reduce frequency, or raise maxConcurrency |
| Feishu not receiving messages | App long connection is occupied | Give each Agent its own separate Feishu app; check diagnostics |
| Slack not receiving messages | Socket Mode, event subscriptions, or scopes are missing | Check the `xapp`/`xoxb` tokens, events, and scopes; use one app per Agent |
| Discord not receiving messages | Message Content Intent or bot permissions are missing | Check the intent, invite permissions, and Application ID; use one app per Agent |
| Schedule not triggering | schedule channel not included / cron wrong | Confirm the publish channel and cron expression |

## Related

- [Agent Management](/wiki/agents) (API Key, publishing) · [Runs](/wiki/runs) (status/cancel/artifacts) · [Core Concepts & Architecture](/wiki/concepts)
