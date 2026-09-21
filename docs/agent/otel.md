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
| `resourceAttributes` | Extra resource attributes in the standard `OTEL_RESOURCE_ATTRIBUTES` format (`k=v,k=v`). Generic on purpose: backends route on resource attributes (environment, team, project — e.g. Arize Phoenix files spans under `openinference.project.name`). `service.name` / `service.version` / `service.instance.id` are managed and rejected here. **`openinference.project.name` defaults to the service name** when it is not set here: OpenInference backends otherwise drop everything into a catch-all `default` project, and an admin who named the service expects to find its traces under that name. This is an a2wave default, not an OpenTelemetry or OpenInference rule (Phoenix's own SDK defaults to `default`); backends that do not speak OpenInference ignore the key. |

**Secret convention** (same as `sso.oidcClientSecret`): headers are submitted as the plaintext
pseudo-key `otel.headers` (a JSON object string) in `PATCH /api/settings`, encrypted by
`prepareOtelSettingsPatch`, and only `headersEnc` is stored. `''` clears them; omitting the key
keeps them. `GET /api/settings/otel/status` returns header **names** and `headersSet` only.
A client-supplied `headersEnc` is rejected. Never add an `otel` key to `NON_ADMIN_READABLE_KEYS`.

**Keep marker.** Stored values are never returned, so the editor lists saved headers by name and
cannot resubmit them. The submitted map is the **complete new set**, with one exception: a value of
exactly `OTEL_KEEP_HEADER_VALUE` (`********`) takes the value currently stored under that name
(exact, case-sensitive match).

| Submitted | Result |
|---|---|
| `{"Authorization":"********","x-new":"v"}` | `Authorization` keeps its stored value, `x-new` is added |
| a stored name absent from the map | that header is deleted |
| `********` for a name with no stored value | `400 INVALID_OTEL_HEADERS`, the message names the header — never an empty header |
| `''` | every header is cleared |

The decrypt helper lives in `lib/otel/headers.ts` so the read side (`config.ts`, which loads the
settings cache) and the write side (`settings-patch.ts`, loaded by the env bridge at boot) do not
import each other.

**Env**: `SETTINGS_OTEL_ENABLED`, `SETTINGS_OTEL_ENDPOINT`, `SETTINGS_OTEL_CAPTURE_CONTENT`,
`SETTINGS_OTEL_SERVICE_NAME`, `SETTINGS_OTEL_RESOURCE_ATTRIBUTES` use the generic settings bridge. `SETTINGS_OTEL_HEADERS` (JSON map)
is special-cased in `resolveSettingsEnvEntry`: it is encrypted into `otel.headersEnc` and the
plaintext never reaches the settings table.

**SSRF stance**: the collector normally lives on loopback or a private address, so
`assertSafePublicUrl` does not apply (it would make the feature unusable) — the same stance as the
admin-configured OIDC issuer. Only cloud instance-metadata hosts are refused. The exporter follows
no redirects and no collector response body is ever returned to the admin.

**Endpoints** (admin only): `GET /api/settings/otel/status`, `POST /api/settings/otel/test`.

## Test connection

`POST /api/settings/otel/test` works while export is disabled and **always answers `200`**; the
verdict is `data.ok`.

**Draft testing.** The optional JSON body is an `OtelTestDraft` — `endpoint`, `serviceName`,
`resourceAttributes`, `headers`, in the same string shapes as the `otel` section of
`PATCH /api/settings`. No body, or `{}`, tests the saved settings.

- The draft runs through the **same** `prepareOtelSettingsPatch` a save uses (endpoint
  normalization, the cloud-metadata block, the header keep marker), then is layered over the saved
  settings in memory: `otelConfigFromRaw({ ...saved, ...preparedPatch })`
  (`lib/otel/test-draft.ts`). Omitted keys fall back to the saved value.
- **Never persisted, never audited**, and the live runtime is not rebuilt. `enabled` and
  `captureContent` are ignored if sent.
- Anything a save would reject — and unknown keys, non-string values, a malformed body — is
  `{ ok: false, reason: 'INVALID_CONFIG', error: <the rule> }`, not a `400`.
- Header values never appear in a response, an error string or a log line.

**The test trace** (`lib/otel/test-trace.ts`) is a small synthetic run, because a bare span is
barely displayed by GenAI backends and proves nothing about how real runs will look. It drives the
real run tracer (`startRunTraceOn`) through a throwaway provider built like the production one —
same exporter, headers, service name and resource attributes — so its attributes cannot drift from
real runs:

```
invoke_agent a2wave connection test     AGENT, prompt "ping", reply "pong", 1 + 1 tokens
└─ attempt                              LLM, model a2wave-connection-test
```

Both spans carry **`a2wave.test = true`** (set by a span processor on the probe provider, so every
probe span gets it); filter on it to keep test data out of dashboards and cost totals.
`a2wave.trigger.source` is `otel_test`. Content is always shown on the test trace, whatever
`captureContent` says — it is synthetic. Both spans leave in one batch, so there is one verdict.

| Result | Meaning |
|---|---|
| `ok: true` + `traceId` + `testedUrl` | The collector accepted the trace; look `traceId` (32 hex) up in the backend. |
| `OTEL_NOT_CONFIGURED` | No usable endpoint in saved settings + draft. No request was made. |
| `INVALID_CONFIG` | The draft failed save validation; `error` says which rule. No request was made. |
| `LOOPBACK_REFUSED` | `ECONNREFUSED` on a loopback endpoint (`localhost`, `127.x`, `::1`). `error` keeps the raw message. |
| `EXPORT_FAILED` | Any other transport or HTTP failure; `error` is the exporter's message. |
| `TIMEOUT` | No answer within 6 s. |

`testedUrl` is present whenever a request was attempted.

**Loopback in containers.** `LOOPBACK_REFUSED` is nearly always a container deployment: inside the
a2wave container, `localhost` is the container itself, not the host running the collector. Point
the endpoint at the collector's service name on a shared Docker network, or at
`http://host.docker.internal:4318` (Docker Desktop; on Linux add
`--add-host=host.docker.internal:host-gateway` / `extra_hosts`).

**OTLP partial success is not detected.** `@opentelemetry/exporter-trace-otlp-proto` hands the
collector's response to an internal handler that only logs `partialSuccess` through the global
`diag` logger; the export result it reports is plain success. A collector that answers `200` while
rejecting spans therefore tests as `ok`. The `traceId` lookup is the verification.

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
