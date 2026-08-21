# Agent self-check — `/status` and `GET /agents/:id/status`

> Status: v1. One composed answer to "what is this Agent doing right now?",
> served programmatically — the reply never reaches the LLM.

## Why it exists

Before this, answering that question meant fanning out over `GET /agents/:id`,
`/diagnose`, `/stats`, `/git-trigger/status`, `/chat-connections`,
`/scm-sources/:id/status` and `/provider-clis` — and **live queue depth was on
none of them**. There was also no way to ask from the channel the user was
already in.

Iron Rule 6 places this squarely in *only the platform has the information*:
runtime, queueing and observability are what a user's local Agent cannot answer.

## The report

`buildAgentSelfReport(agent)` in
[`apps/api/src/lib/agent-self-report.ts`](../../apps/api/src/lib/agent-self-report.ts)
composes three parts and is the **single source** for every surface below.

```ts
interface AgentSelfReport {
  meta:   { id, name, icon, description, status, publishStatus, channels, model }
  health: { ok: boolean; checks: DiagnoseCheck[] }   // errors sorted first
  queue:  { running, queued, maxConcurrency, queueLimit, capacity }
  checkedAt: string
}
type AgentQueueCapacity = 'idle' | 'busy' | 'full'   // 'busy' still accepts work
```

Nothing here is measured independently:

| Part | Source |
|---|---|
| `meta.model` | `buildAgentConfig(agent).model` — not a column. A broken provider chain yields `null`, never a thrown report |
| `health` | `collectAgentExecutionChecks()` — the same checks `/diagnose` uses |
| `queue` | `taskQueueDb.countRunsByStatus()` + `getAgentMaxConcurrency()` + `MAX_QUEUE_LENGTH` |

**`running` must stay `max(dbCount, countActiveExecutionLeases(agentId))`** — the
rule `tryAcquireSlot` itself applies. Taking only the DB count reports `idle`
during the window where a peer replica holds a lease whose run row is not yet
`running`, contradicting the very admission decision the user is asking about.

`capacity` is derived, not stored: a slot free → `idle`; slots full but queue
below `MAX_QUEUE_LENGTH` (50) → `busy`; queue at the cap → `full` (work rejected).

Probing and rendering are split, exactly as `cli/commands/status.ts` splits them:
`formatAgentSelfReport(report, 'en' | 'zh')` is the only place prose is produced,
so the HTTP endpoint and a chat reply can never state different facts. Every
`error` check is listed verbatim — summarising an unrunnable Agent into one line
is precisely what an operator cannot act on.

## Surfaces

| Surface | How |
|---|---|
| REST | `GET /api/agents/:id/status` (`requireAgentRead`) |
| CLI | `a2wave agents status <id\|name> [--json]`; **exits 1** when `health.ok` is false |
| Feishu | via the lifecycle pipeline |
| Slack · Discord · Telegram · QQ Official | via `interceptNativeChatCommand` |
| A2A | `/status` as the prompt; answered as an ordinary completed task |
| Schedule · `glab` · `gh` | **Not supported** — these channels have no reply path at all |

Both registered commands share this coverage: `/status` everywhere above, and
`/new` on every chat channel (it is P2P-only by design, and meaningless over
A2A, which carries no user-facing session).

`/status` is deliberately **separate from `/diagnose`**: diagnose is an
owner-view deep check that fans out over peer Agents and probes the provider CLI,
too heavy to poll. They share the health checks, so they cannot disagree.

The endpoint writes **no audit entry**: it is a plain read that probes nothing,
unlike `agent.diagnose`.

## Responder commands

`/status` is the first command that answers **without reaching the engine**.

The pipeline always had the abort plumbing (`AbortableDecision`, consumed at
`feishu-service.ts`), but no plugin used it, and `dispatch-plugin.ts` documented
itself as having no abort path. `CommandSpec.respond` turns that abort into a
*delivery* path — the channel adapter already replies with
`abortReason.message` verbatim.

```ts
respond?: (ctx: CommandRespondCtx) => Awaitable<string | null>
```

- returns a string → abort with it as the reply; **no Run is created**, no
  concurrency slot consumed
- returns `null` → the match is revoked entirely and the text falls through to
  the LLM
- throws → generic copy is returned; the failure detail (connection strings,
  internal addresses) must never land in a chat window

Commands with *side effects* (`/new`) keep using `applySession` /
`runConfigPatch` and still reach the Agent. Only platform-answerable queries
become responders.

Two properties `/status` relies on, both different from `/new`:

- **no `allowedContexts`** — a queue that is not draining is usually noticed in a
  shared channel, so the command must work in groups
- **no session side effects** — a status query leaves the conversation untouched

### Channel wiring

Feishu runs the full lifecycle pipeline because its commands patch the run they
are about to start. A responder starts no run, so the native chat channels need
only the arbitration:
[`interceptNativeChatCommand`](../../apps/api/src/lib/native-chat-command.ts)
reuses `matchByLongestPrefix` and the same registered plugins.

That reuse is the point. QQ Official previously hand-rolled its own matcher call,
and it drifted — ignoring `allowedContexts` and guarding group scenes with its own
early return instead. That copy is now gone; QQ goes through the shared path like
every other channel.

The interceptor returns one of two things:

| Result | Meaning |
|---|---|
| `{ handled: true, reply }` | Answered from platform state. Reply and stop; **no run reserved** |
| `{ handled: false, intent?, resetSession? }` | Continue to the run. On a session-command match the prefix is stripped into `intent` and `resetSession` is set |

`/new` reaches these channels through the second branch:
`reserveNativeChatRun` already accepted `resetSession`, so only the arbitration
was missing. Its `applySession` hook is *not* invoked here — that hook needs a
`RunCtx` which does not exist before the run is reserved, so its one effect
(clearing the previous chat id) is expressed through the field the reservation
already understands. `allowedContexts: ['p2p']` still applies, so `/new` in a
group stays ordinary text on every channel.

Each channel intercepts **after its own trigger gate and before the run is
reserved**. Two channel-specific notes:

- **Slack** intercepts before the dedup bookkeeping and the `app_mention` grace
  timer — a command that starts no run needs neither.
- **QQ Official** matches against the raw `message.content`, not the assembled
  `intent`: the group branch prepends a sender-metadata block that would push the
  prefix off the start of the line.

## Reply language

A command reply never reaches the LLM, so it cannot pick up the conversation's
language the way a run's output does. The per-Agent `commandReplyLanguage`
column (`auto` | `en` | `zh`, default `auto`) decides it, set under **Agent
detail → Other settings**.

`auto` resolves from the invoking message
([`command-reply-language.ts`](../../apps/api/src/lib/command-reply-language.ts)):
Han characters → `zh`, otherwise `en`. It reads the message because **no channel
plumbs a sender locale into the run context today** — Feishu's `locale` keys
describe outbound post payloads, not the sender. Deliberately a hint, not
detection.

Adding a locale to `RunChannelContext` later would be the better signal; the
resolver takes a `hint` object precisely so that becomes an additive change.

## Adding another responder command

1. `createCommandPlugin({ commandName, prefixes, respond })` under
   `pipeline/commands/defs/`
2. register it in `pipeline/index.ts`
3. add it to `NATIVE_CHAT_COMMANDS` in `native-chat-command.ts` so the non-Feishu
   channels pick it up

Keep the prefix anchored at the start of the message — `matchByLongestPrefix`
already enforces a word boundary, so `/statuses` does not match `/status`.

## Adding a new chat channel — handle the commands

**A new chat channel must decide what it does with commands, and say so.** This
is the step most easily missed, because a channel that ignores commands still
looks like it works: messages reach the Agent and it answers. The failure is
silent — `/status` is passed to the model as literal text, so instead of the
platform's report the user gets the Agent *improvising* about its own health,
and `/new` never resets anything while appearing to.

That is exactly how Slack, Discord and Telegram shipped without `/new` for as
long as they did.

So, when adding a channel:

1. **Call `interceptNativeChatCommand`** after the channel's own trigger gate and
   before the run is reserved, passing the **raw user text** and the
   `p2p` / `group` context.
2. **Honour both outcomes** — replying on `handled: true`, and applying
   `intent` / `resetSession` to the reservation otherwise. Handling only the
   first silently drops `/new`.
3. **Do not write a second matcher.** Reuse the shared one, or the channel will
   drift from every other one exactly as QQ Official's copy did.
4. **If the channel has no reply path** (schedule, `glab`, `gh`), state that it
   is unsupported here and in the user manual rather than leaving it ambiguous —
   there is nowhere to send even a "command not recognised".
5. **Add the channel to the coverage table above** and to
   `apps/web/src/content/manual/{en,zh}/12-triggers.md`.
6. **Cover it with a test** asserting a command reserves no run, and that
   ordinary text mentioning a command mid-sentence still reaches the Agent.

Feishu is the exception to step 1: it runs the full lifecycle pipeline, since its
hooks patch the run they are about to start. A new channel should follow the
native-chat path unless it needs that.
