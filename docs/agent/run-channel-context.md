# Run Channel Context — cross-channel unified context

> Status: v1. `runSteps.input.context.channel` and `WorkerTaskPayload.context.channel` share a unified shape.

## What it is

a2wave supports five trigger channels: API (OAuth/REST), A2A, Feishu bot, Schedule, Web Debug. In the early implementation, every run carried a "call context" written to `runSteps.input.context.*`, but **the two main paths had inconsistent shapes**:

- OAuth/REST/A2A nested the identity under `caller.idaasUser` (IDaaS claims naming);
- Feishu flattened fields at the top level of context and used a `sender_user` sub-object to return the name/email obtained from the contact API.

This brought duplicate read logic to the Agent executor, sub-agents, logs, and the audit page: the same user calling across channels looked like two different people, and the `email` field was in different locations on the two paths.

**Goal**: unify the call context of all channels into the three-part `{ channel_type, channel_info, user_info }`.

## Landing spots

- `runSteps.input.context.channel` — Run step input; visible on the run detail page, used for auditing and replay.
- `WorkerTaskPayload.context.channel` — the same object the Agent executor reads at runtime via the worker payload.

Old fields (`caller`, `sender_*`, `sender_user`, etc.) are no longer written to new runs; historical DB records are kept as-is.

## Full shape definition

```ts
type RunChannelContext =
  | { channel_type: 'api';      channel_info: GatewayChannelInfo;  user_info: UserInfo | null; display_name?: string }
  | { channel_type: 'a2a';      channel_info: GatewayChannelInfo;  user_info: UserInfo | null; display_name?: string }
  | { channel_type: 'feishu';   channel_info: FeishuChannelInfo;   user_info: UserInfo | null; display_name?: string }
  | { channel_type: 'schedule'; channel_info: ScheduleChannelInfo; user_info: null;            display_name?: string }
  | { channel_type: 'debug';    channel_info: DebugChannelInfo;    user_info: UserInfo | null; display_name?: string }

interface UserInfo {
  email: string                                       // always present; zod-validated z.string().email()
  name?: string
  mobile?: string
  source: 'idaas' | 'feishu' | 'a2wave'              // where the email was resolved from
  source_id?: string                                  // sub | open_id | a2wave userId — cross-run dedup
}

interface GatewayChannelInfo {                        // shared by api and a2a
  auth: 'oauth' | 'api_key' | 'none'
  client_ip?: string
  request_id?: string
  oauth?: { issuer: string; sub: string; tenant_id?: string; union_id?: string }
  caller_agent?: { agent_id?: string; agent_name?: string }   // only for a2a internal agent-to-agent
}

interface FeishuChannelInfo {
  app_id: string
  chat_id: string
  chat_type: string                  // 'p2p' | 'group' | 'topic' | ...
  message_id: string
  thread_id?: string
  sender_type: string                // 'user' | 'bot' | ...
  sender_open_id: string
  sender_union_id?: string
  sender_user_id?: string
}

interface ScheduleChannelInfo { schedule_id?: string; cron?: string }
interface DebugChannelInfo    { triggered_by_user_id: string }
```

Field naming is uniformly **snake_case**, aligned with Feishu's existing convention and IDaaS's `user_id`.

## Comparison table for the five channels

| channel_type | key channel_info fields | user_info source | Notes |
|---|---|---|---|
| `api` | `auth`, `oauth?`, `client_ip` | OAuth claims | `auth ∈ {'oauth','api_key','none'}`; for OAuth, fills `oauth.issuer/sub` |
| `a2a` | `auth`, `oauth?`, `caller_agent?` | OAuth claims (passed through) | `caller_agent` identifies the internal agent-to-agent call chain |
| `feishu` | `app_id`, `chat_id`, `chat_type`, `message_id`, `sender_open_id` | Feishu contact API | `fetchUserInfo` must be enabled to get `user_info` |
| `schedule` | `schedule_id?`, `cron?` | — | Triggered by no one; `user_info` is always `null` |
| `debug` | `triggered_by_user_id` | a2wave user table | Web debug entry; resolves email from the logged-in user |

## Cases where user_info is null

- **`channel_type === 'schedule'`**: always `null` (tightened at the type level).
- **OAuth JWT missing `email` claim**: `null` + `logger.warn` (issuer / sub known).
- **Feishu `fetchUserInfo` disabled**: `null`, no log (the user disabled it deliberately).
- **Feishu contact API failed or returned with missing email**: `null` + `logger.warn` (open_id known).
- **debug with no logged-in user** (should not happen in theory): `null`.

## How the Agent executor reads it

The worker payload already exposes the unified shape; on the executor side, read it like this:

```ts
// in custom worker / processing logic
const channel = payload.context.channel
if (channel.user_info?.email) {
  // one piece of logic across all channels: audit, personalization, correlating enterprise identity by email
}
if (channel.channel_type === 'feishu') {
  // Feishu-native identifiers are still in channel_info
  const { chat_id, sender_open_id } = channel.channel_info
}
```

It can also be rendered directly in the System prompt template (mustache):

```mustache
{{#context.channel.user_info}}
Current calling user: {{name}} ({{email}})
{{/context.channel.user_info}}
{{^context.channel.user_info}}
This is a system/anonymous trigger, no user identity available.
{{/context.channel.user_info}}
```

## Cross-agent pass-through

There are two deliberately different pass-through mechanisms:

- **Private a2wave hop headers** are used for local/internal routing. The `a2wave-agent-router` MCP packs the upstream `channel` as a whole, base64url-encodes it, and sends it in `X-A2WAVE-Channel-B64`. When the trust conditions below are met, the downstream `buildGatewayChannel` restores the authoritative `user_info` without overwriting the current hop's authentication facts.
- **The optional A2A 1.0 caller-provenance extension** is used for standards-compatible remote routing. It carries only the immediate caller Agent name/id and the upstream user's display name. It never carries email, mobile, provider subject identifiers, or the serialized channel payload, and the receiver stores it as display/audit provenance rather than authoritative `user_info`. Agent Card routes negotiate support; a direct A2A 1.0 endpoint requires the separate caller-provenance opt-in. See [Caller provenance extension v1](../extensions/caller-provenance-v1.md).

This separation keeps interoperable remote calls useful in run history without silently turning a self-asserted display name into an authenticated enterprise identity.

### Trust model (opt-in, not default)

The forwarded `user_info` becomes the identity the downstream agent runs and is audited under, so it is not an "audit-only" field. `buildGatewayChannel` only adopts the upstream header when **all** of the following three conditions hold (see `isTrustedHop`):

1. `channel === 'a2a'` (the REST `api` channel has no internal hop);
2. the inbound auth of this hop is **`a2aAuthType === 'api_key'`** — the caller proves it holds this agent's A2A-specific key (shared key). This excludes `none` (with no key, anyone could forge an identity) and `oauth` (the end-user token must not overwrite its own `user_info`);
3. the called agent explicitly enables **`trustForwardedIdentity`** (default `false`) — the owner declares "a caller holding my A2A key may speak on behalf of a user's identity".

If any of the three is missing, the private header is ignored, and the downstream rebuilds the context based on the current request's own credentials (`user_info` is usually `null`). **Trust anchor = holding the A2A-specific key + owner opt-in**; holding this key is equivalent to being able to impersonate any user to the gateway, so manage it like a highly sensitive secret. `caller_agent` remains an audit record rather than an authorization input.

> A2A inbound auth (`a2aAuthType` / `a2aEndpointApiKey`, prefix `a2ak_`) is fully decoupled from the REST channel (`publishAuthType` / `endpointApiKey`, prefix `ak_`) and can be rotated/revoked independently.

The object received downstream has `user_info` from upstream, `channel_type` switched to `'a2a'`, and `channel_info.caller_agent` annotating the upstream agent (if known); **`channel_info.auth` always reflects the true inbound auth of this hop** (api_key/none/oauth), never overwritten by the upstream auth — auditing needs to distinguish "an OAuth user called this hop directly" from "an api_key intermediate Agent forwarded an OAuth user's request". The upstream OAuth identity is preserved via `channel_info.oauth` + `user_info` for trace tracking.

## ⚠️ Runtime env note (`A2WAVE_CHANNEL_B64`)

To pass the identity through to the subprocess Agent's outbound MCP call chain, a2wave base64url-encodes the whole `channel` (**including `user_info.email` / `user_info.mobile`**) at executor startup and stuffs it into the `A2WAVE_CHANNEL_B64` environment variable.

- **Reversible encoding**: base64url is not encryption; any code that gets the environment variable can restore the original JSON.
- **Contains PII**: email, phone number, IDaaS `sub`, etc. are all in there.
- **Common leak channels**: debug `console.log(process.env)` in Agent code, log collectors (Datadog / Sentry / Grafana Loki) reporting the whole process env, environment snapshots attached to crash stack traces.

**Requirements for Agent authors**:

- **Do not** dump `process.env` directly to logs or stdout.
- If you really need environment variables in the logs, add `A2WAVE_CHANNEL_B64` to the redact list.
- Read only, don't write: do not stuff this value into other outbound HTTP requests (the a2wave-agent-router MCP already handles a2a hop pass-through internally; other scenarios don't need it).

**Requirements for ops**: mark `A2WAVE_CHANNEL_B64` as always-redact in the log collector's scrub rules.

> Future plan: switch to passing via stdin / Unix socket, leaving only channel_type + channel_info (non-PII part) in the env. Tracked.

## Historical data

- Old runs (`caller` / `sender_*` / `sender_user`) are kept in the DB and **not migrated**; the run detail page displays the raw JSON directly, so you can still see the original fields.
- New runs write **a unified `channel` + a one-layer flat shim** (next section), so the external contract is not broken during the transition period.
- The DB schema needs no migration (`runSteps.input` is an unconstrained JSON column).

## ⚠️ Runtime contract change (BREAKING CHANGE, transition period)

> This change affects **all** user Agents that reference flat fields like `{{context.sender_user}}` / `{{context.chat_id}}` / `{{context.message_id}}`. **Please read before rolling out.**

### Why it affects you

Early Feishu triggers laid these fields directly at the top of `context`, and many user Agents wrote `{{context.chat_id}}`, `{{context.sender_user.name}}`, etc. in their system prompt / MCP tools / mustache templates. After this MR unifies identity/channel info by nesting it under `context.channel`, **old references will silently get `undefined`** (templates render an empty string) without erroring.

### The compromise in this version

During the transition, `buildFeishuContext` writes **both** kinds of fields:

```ts
{
  channel: { channel_type: 'feishu', channel_info: {...}, user_info: {...} | null },
  // —— DEPRECATED flat shim (identical to before MR !84) ——
  sender_type,
  sender_id,          // open_id (string, not object)
  message_id,
  chat_id,
  thread_id,
  chat_type,
  sender_user,        // ↔ the old feishu contact API userInfo object
}
```

Old references still work; new references read from `context.channel.*`.

### Migration guide

| Old field | New path |
|---|---|
| `context.chat_id` | `context.channel.channel_info.chat_id` |
| `context.chat_type` | `context.channel.channel_info.chat_type` |
| `context.message_id` | `context.channel.channel_info.message_id` |
| `context.thread_id` | `context.channel.channel_info.thread_id` |
| `context.sender_type` | `context.channel.channel_info.sender_type` |
| `context.sender_id` (open_id string) | `context.channel.channel_info.sender_open_id` |
| `context.sender_user.name` | `context.channel.user_info.name` |
| `context.sender_user.email` | `context.channel.user_info.email` |

### Deprecation timeline

- **v1 (current version)**: the shim is written; new code uses `context.channel.*` exclusively.
- **v2 (next major version)**: the shim is removed; only `context.channel` remains. This will be announced in advance.

If your Agent is still using the flat fields, please migrate before v2.

## Other known limitations

- **Topic-thread rerun reply location**: if the original Feishu message is in a topic thread (has `thread_id`), the reply produced after clicking "Rerun" lands in the chat root, not in the original topic thread. `sendFeishuMessageByContext` does not currently support in-thread replies; the product decision is pending.

## Related documents

- [docs/agent/oauth-channel.md](./oauth-channel.md) — OAuth/IDaaS JWT channel identity injection details
- [AGENTS.md](../../AGENTS.md) — project top-level guide
