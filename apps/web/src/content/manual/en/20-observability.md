# Observability (OpenTelemetry)

a2wave can export every Agent execution as a standard **OpenTelemetry trace** and push it to the observability platform you already run (OTel Collector, Jaeger, Grafana Tempo, Alibaba Cloud ARMS, Arize Phoenix, …). In your usual APM you can then see how long an execution took, how many times it retried, which tools it called, how long each tool ran, and how many tokens it used.

> [!NOTE]
> a2wave only **exports** — it stores no telemetry. Storage, querying and dashboards belong to your collector. The input, output and logs of each execution are still in [Runs](/wiki/runs).

## What a trace looks like

```
invoke_agent <Agent name>        one execution
└─ attempt                       one per retry / Provider switch
   └─ execute_tool <tool name>   one per tool call, with real start and end times
```

| Level | What you see |
|-------|--------------|
| `invoke_agent` | Agent, model, trigger channel, total tokens, retry count, final outcome (success / failed / timeout / cancelled) |
| `attempt` | Which attempt it was, the Provider and model used, that attempt's own tokens |
| `execute_tool` | Tool name, call duration, success or failure |

Every Provider (Claude Code, Codex, Cursor, …) exports exactly the same structure. Attributes follow the OpenTelemetry GenAI semantic conventions (`gen_ai.*`), which mainstream APMs recognise out of the box.

> [!NOTE]
> Some Providers do not report token usage. In that case the trace has no token attributes at all, rather than showing 0.

## Turning export on (administrators)

1. Go to **Settings → Tracing**.
2. Enter the **collector endpoint**: an OTLP/HTTP base URL such as `http://otel-collector:4318` — `/v1/traces` is appended for you, and the resolved URL is shown live under the field. A full ingest URL from your platform also works.
3. If the collector requires authentication, click **Add header** and enter a name (e.g. `Authorization`) and a value.
4. Click **Test connection**. It uses **what is in the form — no need to save first**: a2wave writes one synthetic test trace tagged `a2wave.test=true` and shows its trace ID, which you can look up in your APM to confirm it arrived.
5. Switch on **Enable export** and click **Save**. Every execution from then on is exported.

> [!NOTE]
> When a2wave runs in a container (Docker etc.), `127.0.0.1` / `localhost` is the a2wave container itself, not the host. For a collector on the host use `http://host.docker.internal:4318`, or the collector's network address.

| Setting | Notes |
|---------|-------|
| Enable export | When off, nothing is produced and execution carries no overhead |
| Collector endpoint | OTLP/HTTP only (`http://` or `https://`); gRPC is not supported |
| Auth headers | Stored encrypted; values are never shown again. Saved headers are listed by name, one per row: leave the value empty to keep it, type a new value to replace it, remove the row and save to delete it. To rename, remove and add |
| Capture content | See the next section; off by default |
| Service name (Advanced) | The service name shown in your APM; defaults to `a2wave` |
| Resource attributes (Advanced) | Attributes added to every span, as comma-separated `key=value` pairs, e.g. `deployment.environment=prod` |

> [!TIP]
> With Arize Phoenix, set **Resource attributes** to `openinference.project.name=<project>` to file traces under that project; without it they land in `default`.

> [!TIP]
> Only one collector can be configured. To send to several platforms, point a2wave at your own OTel Collector and let the Collector fan out.

## Capture content (off by default)

By default only **metadata** is exported: timing, tokens, model, status, tool names. The user's prompt, the Agent's reply, tool arguments and error text do **not** leave a2wave.

With **Capture content** on, that content is written into the trace too, which helps when you need to see what a specific execution said and called.

> [!WARNING]
> Once on, conversation content is sent to an external collector. First make sure the collector's access control and data retention meet your requirements.
> The system automatically masks the secrets the platform injected (Provider keys, Agent environment variables, MCP credentials, …) and tokens shaped like `Bearer …` or `sk-…`, and truncates each piece of content to 4096 characters. It cannot recognise sensitive information inside your business data.

Switching **Capture content** is recorded in the audit log (visible to administrators only).

## One trace across Agents and systems

- **Agent calling Agent**: when one Agent routes to another, both executions appear in the same trace, with the downstream execution nested under the upstream attempt.
- **Calling an Agent from your system**: send a standard `traceparent` request header when you call the [API or A2A](/wiki/triggers), and the Agent's execution joins your own system's trace. A malformed header is ignored and never affects the call itself.
- **Queueing and restarts**: executions that waited in the queue, or were resumed after a service restart, still join the original trace.
- **Retries**: automatic retries stay in the original trace; clicking **Retry** in the UI starts a new trace.

## Checking export health

The bottom of **Settings → Tracing** shows the time of the last successful export, the most recent error, and the number of dropped spans.

| Symptom | Likely cause |
|---------|--------------|
| Test connection reports "Export failed" | Wrong address or port, the collector's OTLP/HTTP receiver is not enabled, or the network is unreachable. The message includes the URL that was tried |
| Test connection reports "Connection refused" and mentions containers | A loopback address was entered in a container deployment — use `host.docker.internal` or the collector's network address |
| Last error is `Unauthorized` / 401 | Auth headers are missing or expired — enter them again and save |
| Dropped spans keep growing | The collector is unreachable. a2wave neither retries nor spools to disk; data beyond the in-memory buffer is dropped — **Agent execution is unaffected** |
| Settings changed but some requests ignore them | In a multi-replica deployment, export status and configuration apply per instance; other replicas need a restart |

> [!NOTE]
> A collector problem never makes an Agent execution fail or slow down — telemetry is a side channel.

## Configuring with environment variables

Operators can skip the UI and configure export with environment variables (applied at startup):

| Variable | Notes |
|----------|-------|
| `SETTINGS_OTEL_ENABLED` | `true` turns export on |
| `SETTINGS_OTEL_ENDPOINT` | Collector endpoint |
| `SETTINGS_OTEL_HEADERS` | Auth headers as JSON, e.g. `{"Authorization":"Bearer xxx"}`; encrypted at startup |
| `SETTINGS_OTEL_CAPTURE_CONTENT` | `true` turns content capture on; default `false` |
| `SETTINGS_OTEL_SERVICE_NAME` | Service name; default `a2wave` |
| `SETTINGS_OTEL_RESOURCE_ATTRIBUTES` | Resource attributes, comma-separated `key=value` |

## Current limitations

- Traces only — no metrics or logs. Derive metrics from traces in your APM if you need them.
- There is no "single model call" level; tokens are totals for the whole execution (or attempt).
- Tool results are not visible — only the tool name, its arguments (with content capture on) and its duration.
- Executions from before export was enabled are not backfilled.
