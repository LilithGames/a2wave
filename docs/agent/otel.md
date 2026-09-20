# OpenTelemetry trace export

Every Agent execution can be exported as an OpenTelemetry trace that follows the
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), pushed over
OTLP/HTTP to one collector configured in **Settings → Observability** (or via env).

Read this before touching `apps/api/src/lib/otel/`, the `traceParent` plumbing, or the `otel`
settings category.

## Boundaries — what this is and is not

| Rule | Why |
|---|---|
| **Export only.** No span, metric or trace is stored in a2wave. | Storage, query and dashboards are the collector's job (Iron Rule 1). Only configuration is persisted, in the existing `settings` table. |
| **One endpoint.** | Fan-out to several backends belongs to the operator's own OTel Collector. |
| **Traces only** (no metrics, no logs). | Tokens / duration / model / status are span attributes; backends derive metrics from spans. |
| **Provider-agnostic.** Nothing under `engine/<provider>-*.ts` or the stream parsers knows about tracing, and the CLIs' native telemetry is not used. | One span model for all providers; a new provider inherits it for free. |
| **Observation only, fail-open.** Tracing never fails, delays or reorders a run. | Iron Rule 4. Every tracer method is synchronous and swallows its own errors; a dead collector costs dropped spans and one rate-limited warning. |
| **Private provider.** The `BasicTracerProvider` is never registered globally and no context manager is installed. | Parent/child is passed explicitly, so nothing else in the process can interfere — and `OTEL_EXPORTER_OTLP_*` in the API's own env is ignored (`url` + `headers` are always explicit). |

## Span model

```
invoke_agent <agentName>        one per executeWithRetry call            (INTERNAL)
└─ attempt                      one per retry / provider-fallback try    (INTERNAL)
   └─ execute_tool <toolName>   paired from normalized tool_call events  (INTERNAL)
```

The single instrumentation seam is `executeWithRetry` (`lib/execute-with-retry.ts`) — the one
chokepoint every channel passes through, including A2A, evaluation and memory, which bypass
`runWithLifecycle`. Spans are built from three provider-neutral inputs only: `WorkerTaskPayload`,
the normalized `StreamLogEntry` stream, and `ExecuteWorkerResult`.

There is **no `chat` / LLM-call span**: the normalized events carry no per-LLM-call boundary and
token usage is reported once per execution, so such spans could only be invented.

| Span | Attributes |
|---|---|
| `invoke_agent` | `gen_ai.operation.name`, `gen_ai.provider.name` (engine type), `gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.request.model` (last attempt's), `gen_ai.conversation.id` (provider session id), `gen_ai.usage.*`, `a2wave.run.id`, `a2wave.task.id`, `a2wave.trigger.source`, `a2wave.attempt.count`, `a2wave.retry.count`, `a2wave.run.outcome` (`success` / `failed` / `timeout` / `cancelled`), `error.type` |
| `attempt` | `a2wave.attempt.number`, `a2wave.provider.index` / `.id` / `.name`, `gen_ai.request.model`, `a2wave.chat.reset`, this attempt's own `gen_ai.usage.*`, `error.type` |
| `execute_tool` | `gen_ai.operation.name`, `gen_ai.tool.name`, `gen_ai.tool.call.id` (when non-empty), `a2wave.tool.unpaired`, `a2wave.tool.incomplete` |

### OpenInference mirror

`gen_ai.*` is the primary convention. Backends that speak OpenInference (Arize Phoenix, Arize,
Langfuse) translate `gen_ai.*` into their own `llm.*` keys server-side, but they never derive the
keys their input / output / kind / session columns read — so those are written explicitly:

| Key | Span | Value |
|---|---|---|
| `openinference.span.kind` | all | `AGENT` (invoke_agent), `LLM` (attempt), `TOOL` (execute_tool) |
| `session.id` | invoke_agent | inherited caller session, else the run id |
| `input.value` / `input.mime_type` | invoke_agent, execute_tool | prompt (`text/plain`) / tool arguments (`application/json`) — **content-gated** |
| `output.value` / `output.mime_type` | invoke_agent | the reply — **content-gated** |

- **`attempt` is `LLM`, not `CHAIN`.** It is the span that carries model and token usage, and
  OpenInference backends total tokens and cost over `LLM` spans only; the `AGENT` root repeats the
  totals without being double-counted. Marking it `CHAIN` zeroes the backend's token and cost sums.
- **The session is the run id, not the provider session id** (`gen_ai.conversation.id`). The run id
  is stable across the turns of a conversation (the run row is reused), survives provider fallback,
  and is known before execution — the provider session id of a new conversation only exists after
  the run, too late to hand downstream. One trace must not carry two sessions: the backend picks
  one arbitrarily.

Root span events: `retry`, `provider_fallback`, and the agent-router's `a2a.task.*` lifecycle
events (primitive metadata only).

Rules a change must keep:

- **Usage is never defaulted.** Only reported `TokenUsage` fields become attributes; a provider
  that reports no tokens (kimi, qoder) yields none. `0` would claim a measurement.
- **Status comes from `ExecuteResult.success`**, never from the last `result` stream event.
  Cancellation is `UNSET` with `a2wave.run.outcome=cancelled` — a user stop is not an error.
- **Tool pairing tolerates every provider quirk:** empty `callId` pairs FIFO per tool name; a
  duplicate start is ignored; a terminal event with no start becomes a zero-length span
  (`a2wave.tool.unpaired`); tools still open when the attempt ends are closed with
  `a2wave.tool.incomplete`; events outside an attempt are dropped; at most 256 open tools.
- `a2wave.trigger.source` reads `channel_type` **only**. The rest of the channel context
  (`A2WAVE_CHANNEL_B64`, `user_info`) is PII and must never become an attribute.

## Content capture

`otel.captureContent` defaults to **off**. When off, these strings are never read, so they cannot
leak: the prompt, the Agent's output, tool arguments, and tool / run error text. `error.type`
(low-cardinality class) is always exported.

When on, content is added as `gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.tool.call.arguments` and span status messages — **masked, then truncated** to 4096
characters. Masking covers every credential the platform injected into that execution (provider
key / OAuth token, Agent env values, MCP env and header values) plus `Bearer …`, `sk-…`, `ak_…`,
`a2ak_…` shaped tokens. Tool *results* are not available: no normalized event carries them.

Toggling capture is audited (`settings.otel.updated` records the resulting boolean).

## Trace context propagation

| Hop | Mechanism |
|---|---|
| Inbound: API gateway, OAuth gateway, A2A | The `traceparent` request header is validated after auth (`normalizeTraceparent`; malformed → ignored, never a 4xx) and stored in `runs.executionMetadata.traceParent` and `WorkerTaskPayload.traceParent`. The `invoke_agent` span becomes a child of that remote span. |
| Queued / restart-resumed runs | `execute-chat-run.ts` reads `executionMetadata.traceParent`, so the run still joins the caller's trace. The interrupted process's own spans are lost. |
| Automatic job retry | `job-retry-scheduler.ts` carries `traceParent` to the replay run. |
| Manual retry | `buildRetryMetadata` is an allowlist and drops it on purpose: a human retry is a new trace. |
| Outbound: Agent → Agent | The **attempt** span's `traceparent` is injected as the `TRACEPARENT` env var via `injectRouterRuntimeEnvIntoAgentConfig` (same path as `A2WAVE_CHANNEL_B64`). The agent-router MCP forwards it as a `traceparent` header on local and remote A2A calls; it takes no OpenTelemetry dependency. The attempt span — not the tool span — is the parent because the router's env is fixed when the CLI is spawned. |
| Session | The trace's session id travels as W3C `baggage` (`session.id=…`): injected as the `BAGGAGE` env var next to `TRACEPARENT`, forwarded by the agent-router, read by `readInboundTraceContext`, stored as `executionMetadata.traceSession`. It is only honoured together with a valid `traceparent`. A downstream Agent's run therefore lands in the caller's session. |
| Outbound: CLI child | The same `TRACEPARENT` reaches the CLI child through `agentEnv`, so an instrumented tool the Agent runs can join the trace. |

`executionMetadata.traceParent` is a correlation id, not telemetry. The inbound `sampled` flag is
ignored: a2wave samples every run. Nothing is injected when export is off.

## Configuration

Settings category `otel` (all values are strings):

| Key | Meaning |
|---|---|
| `enabled` | `'true'` / `'false'`. Requires a non-empty endpoint. |
| `endpoint` | OTLP/HTTP base URL (`/v1/traces` is appended) or a full URL ending in `/traces`. http(s) only; no credentials, query or fragment. |
| `headersEnc` | AES-GCM ciphertext of a JSON header map. Server-managed. |
| `captureContent` | See above. |
| `serviceName` | `service.name`; empty = `a2wave`. |
| `resourceAttributes` | Extra resource attributes in the standard `OTEL_RESOURCE_ATTRIBUTES` format (`k=v,k=v`). Generic on purpose: backends route on resource attributes (environment, team, project — e.g. Arize Phoenix files spans under `openinference.project.name`). `service.name` / `service.version` / `service.instance.id` are managed and rejected here. |

**Secret convention** (same as `sso.oidcClientSecret`): headers are submitted as the plaintext
pseudo-key `otel.headers` (a JSON object string) in `PATCH /api/settings`, encrypted by
`prepareOtelSettingsPatch`, and only `headersEnc` is stored. `''` clears them; omitting the key
keeps them. `GET /api/settings/otel/status` returns header **names** and `headersSet` only.
A client-supplied `headersEnc` is rejected. Never add an `otel` key to `NON_ADMIN_READABLE_KEYS`.

**Env**: `SETTINGS_OTEL_ENABLED`, `SETTINGS_OTEL_ENDPOINT`, `SETTINGS_OTEL_CAPTURE_CONTENT`,
`SETTINGS_OTEL_SERVICE_NAME`, `SETTINGS_OTEL_RESOURCE_ATTRIBUTES` use the generic settings bridge. `SETTINGS_OTEL_HEADERS` (JSON map)
is special-cased in `resolveSettingsEnvEntry`: it is encrypted into `otel.headersEnc` and the
plaintext never reaches the settings table.

**SSRF stance**: the collector normally lives on loopback or a private address, so
`assertSafePublicUrl` does not apply (it would make the feature unusable) — the same stance as the
admin-configured OIDC issuer. Only cloud instance-metadata hosts are refused. The exporter follows
no redirects and no collector response body is ever returned to the admin.

**Endpoints** (admin only): `GET /api/settings/otel/status`, `POST /api/settings/otel/test`
(sends one span to the *saved* config, works while disabled, always `200` with `data.ok`).

## Runtime lifecycle

- `getOtelRuntime()` builds the provider lazily, keyed by a fingerprint of the raw `otel`
  settings, so it self-heals after boot, a PATCH, or the env bridge. Disabled = one synchronous
  cache read per run and no SDK objects.
- On a settings change the old runtime is **retired**, not killed: it shuts down once the last
  in-flight run releases it, so running traces still export.
- Batching: 5 s delay, 512 spans per batch, 2048 queued, 5 s export timeout, gzip.
- Graceful shutdown calls `flushTelemetry` after the lease drain (every span has ended by then),
  bounded to 2 s, well inside the 10 s hard budget. A crash loses in-flight spans.
- **Multi-replica**: the settings cache and the exporter are per-process. Only the replica that
  handled the save rebuilds; others apply it on restart. Status is reported with
  `scope: 'this-instance'`. See [postgresql.md](./postgresql.md).

## Known limitations

- No per-LLM-call spans or per-call token counts.
- No tool results.
- `gen_ai.conversation.id` is the provider session id (it changes on provider fallback), not
  `runs.conversationId`.
- A span reflects the execution verdict. If a concurrent cancellation wins the terminal DB
  transition, the run row and the span can disagree.
