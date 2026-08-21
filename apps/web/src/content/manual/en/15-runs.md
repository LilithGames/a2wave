# Runs

A Run is a single execution record of an Agent. Regardless of the trigger method, every execution generates a Run, viewable in "Runs" — this is the foundation of enterprise-grade auditability.

## State machine

| State | Meaning |
|------|------|
| `pending` | Created, waiting for an execution slot |
| `queued` | In the queue, waiting for a free Agent slot |
| `running` | Currently executing |
| `completed` | Completed successfully |
| `failed` | Errored during execution |
| `cancelled` | Cancelled / evicted / its merge request was merged or closed while the run waited in the queue |

Concurrency is controlled by the Agent's `maxConcurrency`: it runs immediately if a slot is free, otherwise it enters the queue.

## Trigger source and call provenance

Every Run is tagged with its source: `debug` (Web debugging) / `api` / `feishu` / `slack` / `discord` / `qq_official` / `a2a` / `schedule` / `oauth` / `chat_app` (chat page) / `glab` (GitLab repository trigger) / `gh` (GitHub repository trigger). The run list places all known provenance layers before the input intent in this order:

| Available information | Display example |
|-----------------------|-----------------|
| User, calling Agent, and source | `Alex Chen·SDK Manager Agent·A2A` |
| User is unavailable | `SDK Manager Agent·A2A` |
| Only the source is known | `A2A` |

The Agent in the row title is the **Agent that executed this Run**. The Agent inside the provenance label is the **immediate upstream Agent that called it**. Missing layers are omitted without hiding the provenance that is known.

> [!NOTE]
> Identity availability depends on the trigger: Feishu must be configured and permitted to resolve the sender; the OAuth channel can identify the user from its caller's OIDC JWT; and A2A can include the calling Agent and upstream user only when the peer supports and sends the provenance extension. SAML establishes a Web session and does not provide a caller bearer token for this channel. A regular API key proves that an integration holds the credential, not which end user is behind it, so those Runs normally show only `API`. These names support auditing and troubleshooting; access is still controlled by each channel's real authentication, and provenance data never replaces it.

## Viewing runs

- **Run list**: browse all Runs, their sources, and statuses.
- **Run details**: view this execution's input intent, output result, chat log, and run log; multi-step tasks include Run Steps.
- **Statistics overview**: counts, success rate, average duration, etc.

Run-list pagination is synced to the address bar (e.g. `/runs?page=2`), so refreshing or sharing the link returns you to the same page. The full-log viewer also records `logPage` in the current link while paging, and clears it automatically after the viewer is closed.

## Who can see which runs

Run visibility follows **Agent permissions**, matching the chats and statistics you already see on the Agent detail page:

| Your role | Runs you can see |
|-----------|------------------|
| Administrator | Every run |
| Owner of the Agent, or an editor / viewer [collaborator](/wiki/members) | **All** runs of that Agent, whoever triggered them and through whichever channel |
| Anyone unrelated to the Agent | Only the runs they triggered themselves |

> [!NOTE]
> Runs triggered through Feishu, an API Key, or OAuth have no signed-in a2wave user behind them, so the Agent is the only thing that can establish ownership — if you can open the Agent, you can see those runs.

**Acting on a run is stricter than viewing it.** Cancelling, rerunning, and executing all require write access to that run: a run you triggered counts as yours, otherwise you need owner or editor permission on its Agent. Rerunning additionally requires write access to the Agent — it really runs again with the Agent's credentials and workspace, and a Feishu-sourced run answers back into the original chat. So a viewer can cancel the debug run they started, but cannot rerun it.

## Token usage

When the underlying Agent CLI reports token usage, a2wave records it to help you understand consumption patterns:

- **Dashboard "Token leaderboard"**: alongside "By runs" and "By users", the dashboard home adds a **Token leaderboard** that ranks the Top 10 agents by aggregated token usage, so you can spot which agents consume the most.
- **Run details**: the drawer shows this Run's cumulative input / output / reasoning / cache-read / cache-write tokens.
- **Execution-log timeline**: each round's result entry inlines that round's input / output tokens, making it easy to pinpoint a step with abnormal single-round consumption.
- Large numbers are abbreviated as **K / M / B** (e.g. `12.3K`, `1.2M`).
- **Failed or cancelled runs retain usage reported before termination.** Usage that the CLI never emits cannot be reconstructed.
- The dashboard's "Today's tokens" is attributed by **when each conversation round actually happened**: a session created yesterday and continued today counts toward today.

The displayed total is the sum of five disjoint buckets: **input + output + reasoning + cache read + cache write**. It does not include or display monetary cost.

> [!NOTE]
> Token statistics depend on the underlying CLI reporting usage. An aggregate value of `0` can mean that no usage was reported in scope; it does not necessarily mean zero consumption. Historical Runs created before this feature also have no token data.

### Provider coverage

| Provider | Coverage level | Details |
|----------|----------------|---------|
| Claude Code | Official | Result events report input, output, cache-read, and cache-write tokens. |
| Codex CLI | Official | `turn.completed` reports input, output, and cached-input tokens. |
| OpenCode CLI | Official | `step-finish` reports input, output, reasoning, and cache tokens. |
| Pi CLI | Official | Each Assistant `message_end` event reports input, output, reasoning, cache-read, and cache-write usage for one provider call; `compaction_end` reports the separate summarization call. a2wave accumulates those calls and separates reasoning from Pi's inclusive output so the five displayed buckets remain disjoint. |
| Cursor CLI | Unreported | The official CLI Result schema does not include token usage; related statistics can appear as `0` or empty. |
| Qoder CLI | Not applicable | Standard mode is measured in Credits and does not provide real tokens for this statistic; BYOK does not change the current reporting scope. |
| Trae CLI | Undocumented | The official token-usage event schema is not public; usage is collected only when the CLI emits compatible fields. |
| Kimi Code CLI | Not reported | The `stream-json` output carries no usage event at all; related statistics show `0` or empty. |

## Full log (not truncated)

To control database size, the execution log in run details **keeps the beginning and drops the end** once it exceeds the entry-count limit (a "log truncated" marker appears). Meanwhile, the **full process log** of each execution is written out-of-band to a server-side NDJSON file, so the latter half of long tasks isn't lost:

- **View full log**: click "View full log" in the execution-log area; the in-app viewer loads the server-side log page by page, supporting filtering by All / Tool calls / Messages / Errors-retries, and paged browsing (defaults to the last page, prioritizing the failure scene). A2A long-task polling retries, resubscription failures, and cancellation failures are also included under Errors-retries so remote recovery problems can be inspected together.
- **Download full log**: the same area lets you download the raw NDJSON file (`GET /api/runs/:id/logs/download`), one JSON event per line, convenient for script analysis.

> Full-log files are retained for 14 days by default (adjustable via the environment variable `A2WAVE_RUN_LOG_RETENTION_DAYS`) and cleaned up automatically after expiry; a single file defaults to a 256 MiB limit.

## History retention

To keep accumulated run records from slowing down the database, the platform cleans up **expired finished runs** (along with their steps and chat messages) and **audit logs** once a day. Admins can adjust this on [Settings → Artifacts](/wiki/artifacts):

- **Automatic history cleanup**: master switch; turn it off to keep all history forever (for strict-audit deployments that archive externally).
- **History retention (days)**: defaults to **60 days**; deletes finished runs and audit logs older than this.

> [!NOTE]
> Only **finished** runs (completed / failed / cancelled) are pruned; in-progress or queued runs are untouched. Evaluation task history is **not** pruned either, so config can be compared across tasks.

## Operating on a Run

- **Rerun**: execute again based on an existing Run.
- **Cancel**: `POST /api/runs/:id/cancel` (or the gateway cancel endpoint); **only `running` / `queued` can be cancelled**.

## Artifacts

Files produced during a Run are saved as **artifacts**, viewable and downloadable in the artifact list and traceable after the run finishes (`GET /api/artifacts`, `/:id/download`).

> Whether artifacts are retained on disk depends on that invocation's worktree cleanup policy (`ephemeral` deletes immediately / `ttl` retains for N seconds / `persistent` retains long-term); see the `worktree` parameter in [Trigger Methods](/wiki/triggers).

Beyond downloading, artifacts can also generate an **online share link** in one click, letting the other party preview the web page or report directly — see [Artifacts & Online Sharing](/wiki/artifacts).

## Troubleshooting approach

1. Run `failed` or empty output → open the run details to see the error message and log.
2. Suspect an environment issue → go back to the Agent and run **Full Diagnosis** (Provider / engine / Feishu connection).
3. Stuck at `queued` → concurrency may be full; raise `maxConcurrency` or wait.

When an OAuth async call is queried and found `failed`, `data.result.error` is a structured error. Determine the responsible party by `source`, take the next step per `action`, and include `details.runId` when contacting the Agent owner or platform admin. `PROVIDER_*` does not mean the caller's OIDC JWT is faulty.

## Related

- [Trigger Methods](/wiki/triggers) · [Agent Management](/wiki/agents) (diagnosis) · [SCM Source](/wiki/scm-sources) (worktree)
