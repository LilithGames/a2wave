# Changelog

All notable changes to this project are documented in this file.

## v0.7.3

> ⚠️ **This release is not rolling-upgrade safe. Stop every API replica before
> applying its migrations, then start only the upgraded version.** Two
> independent reasons, either sufficient on its own, and both fail silently:
>
> 1. A pre-upgrade replica deletes workspace-removal reservations by id alone,
>    erasing the newer attempt-token fence.
> 2. A pre-upgrade replica writes no `instance_heartbeats` row, so an upgraded
>    peer reads it as dead and may reclaim leases and Git worktrees out from
>    under a process that is still running.
>
> Single-container SQLite deployments are unaffected in practice — there is only
> one replica — but the migrations still apply.

This is the stable cut of the v0.7.3 line, folding in everything from
`v0.7.3-rc.1` and `v0.7.3-rc.2` plus the entries marked new below.

### Channels

- **Telegram becomes a first-class channel**: publish an Agent to Telegram at parity with Discord — group and private triggers, attachments both ways, artifact upload, per-conversation sessions and restart recovery. Updates arrive over outbound long polling, so no public HTTPS ingress or callback URL is needed and a private deployment works unchanged; registering a bot clears any webhook previously set on it. Triggering on *every* group message additionally requires Group Privacy to be disabled via @BotFather.
- **QQ official bot channel (MVP)**: publish an Agent to a QQ official bot over the platform's WebSocket, bringing the channel count to twelve.
- **The agent's Publish tab is now Channels**: a more accurate name for what it manages — API, Feishu, Slack, schedules, repository triggers and the rest.
- **Ask an Agent what it is doing, from any channel** *(new)*: `/status` returns a self-check — provider and CLI health, mounted MCP and skills, live queue depth and concurrency — as a programmatic report rather than a guess. The same facts back the HTTP endpoint and the chat reply, so the two can never disagree. A new per-Agent reply-language setting controls the response language, since a command reply never reaches the LLM and cannot infer it from the conversation.
- **Feishu: a quoted reply no longer resurrects a stale direct-message session**: quoting a days-old message reopened that whole conversation and the model kept answering from context you had moved on from. Direct messages are now capped at the two-hour window like any other; group reply chains and topics still never expire. `/new` also works in a quoted direct-message reply, where it previously reached the Agent as literal prompt text.
- **Feishu and Slack no longer process a message twice**: deduplication keys on the message's own identity rather than the delivery envelope, so one message starts one run.

### Access and credentials

- **Multiple named API keys per channel** *(new)*: the API and A2A channels each held one plaintext key on the Agent row, so rotation broke every integration at once and any database read yielded live credentials. Keys are now individual rows storing only a hash and a display prefix, each with a required description, optional expiry and a last-used stamp — so you can answer "what is this key for, and is anyone still using it?" and retire one caller without touching the rest. A REST key can never authenticate an A2A request.
- **Sign in on a remote or headless machine**: `a2wave login` supports the OAuth 2.0 device grant — the terminal prints a short code, you approve it from a browser wherever you already have a session, and the waiting CLI receives a token. Selected automatically over SSH; containers and CI pass `--device`. The approval page shows the requesting IP, client and time so you can tell your own session from a code someone phoned you.
- **CLI tokens for automation**: named, long-lived, individually revocable credentials created from **Settings → CLI access**, for CI jobs and scripts. Unlike a session token, retiring one machine's credential no longer means retiring them all, and a password change no longer silently breaks every pipeline. The plaintext is shown once.
- **"Keep me signed in", with sliding renewal** *(new)*: session lifetime was one deployment-wide value, wrong at both ends — no way to ask for a shorter session on a shared machine, and a sign-out mid-task on day seven while working continuously. The checkbox (off by default) now decides at sign-in: unchecked gives a real session cookie that dies with the browser, checked gives the long-lived session, and continued activity renews it rather than expiring on a fixed schedule.
- **Invitation links replace admin-set passwords**: administrators issue an expiring single-use link instead of typing someone else's password, and the invitee chooses their own and lands signed in. Links are copyable and revocable from the invitations drawer, and re-inviting an address supersedes the outstanding link so only one is ever live.
- **Credentials survive an edit**: saving a form no longer persists the masked placeholder over the real secret.

### Runs and reliability

- **Artifacts are no longer delivered to the wrong run** *(new)*: runs of an Agent shared one artifacts directory, and ownership was inferred from file mtime — so a file written by a *concurrent* run inside the window was registered as the finishing run's own and sent to its user. Observed in production: one run issued no write at all yet shipped another run's spreadsheets. Each run now gets its own directory and the collector reads only that one, so concurrency, name collisions and clock skew stop mattering.
- **Opt-in job-level auto-retry** *(new)*: `maxJobRetries` (0–3, default off) replays a failed job as a brand-new run — fresh workspace, fresh session, re-admitted through the queue — which is what the manual rerun button builds, and what the existing in-job `maxRetries` cannot do because it inherits the failed attempt's dirty state. Deliberately narrower than the button since it fires unattended: cancelled runs are never replayed, and permanent or hard-quota errors are skipped because a fresh job would hit the identical wall. Every attempt stays its own record in the run list.
- **An interrupted run that never started executing is restarted** *(new)*: a run killed before its CLI emitted a single line was settled as `failed` and left there, since with no session id there was nothing to resume — leaving a human to re-trigger it by hand. This is routine, not exotic: a clone or sync on a large repository runs for minutes before the CLI starts, and a deploy landing in that window lost the whole run. Recovery now requeues such a run, gated on proof that it produced no output and therefore can have no side effects.
- **An interrupted run no longer loses its provider session**: a run's session id is recorded while it is still executing, not only on completion — previously the one case that needed to resume was the one case that never stored it.
- **A run abandoned by a dead instance is reaped and its queue restarts**: a temp-workspace run whose process died took no lease, so nothing could prove it was abandoned and it stayed `running` forever — pinning the Agent's concurrency and parking the queue indefinitely. Runs now carry an owner instance, and a periodic sweep settles those whose owner is provably gone, then restarts promotion. The verdict is ownership, never age, so a long-running review is never mistaken for a dead one.
- **A queued repository-trigger run skips a merge request that already finished**: a run whose subject was merged while it waited now re-probes and terminates as `cancelled` instead of spending tokens to conclude "already merged". Fails open on every ambiguous verdict, so a broken probe never cancels legitimate work.
- **Chat and run recovery fixes**: restored chats accept follow-ups again, run state recovers and refreshes correctly after a server restart, and interrupted A2A remote tasks are resumable.

### Storage and deployment

- **Managed SCM storage for Git sources**: `localPath` is now optional for Git and allocated under the managed storage root; P4 still requires an explicit path covered by its client `Root`. Existing bind mounts, source paths and legacy worktree roots survive the upgrade.
- **Cross-replica workspace recovery**: a crashed or unreachable replica no longer strands its checkouts. Processes publish a liveness heartbeat, and a surviving replica settles the abandoned workload, releases its lease, and converges the leftover worktree removal — work that previously required an operator to run SQL by hand. An instance that cannot renew its own heartbeat stops itself before peers may reclaim its workspaces.
- **PostgreSQL deployment path**: `a2wave setup` can provision a PostgreSQL 16 sidecar or point at an external server. Still experimental and not recommended for production; there is no SQLite → PostgreSQL data migration.
- **Git SCM Agents no longer share a working directory**: each Agent runs in its own worktree, where previously a run of one Agent could delete files a concurrent run of another was executing against. A worktree with unmerged agent commits or local modifications stays pinned (with a warning) and resumes following the source branch once that work lands upstream.

### Observability and UI

- **Queue depth and end-to-end latency on the agent overview** *(new)*: the overview could not answer the two questions operators actually ask — is this Agent backed up right now, and how long does a request take from arrival to result. Every existing duration metric measured execution only; wait time is now recorded per turn and charted alongside it. Historical rows render as "no data" rather than as zero.
- **Readable status colors and token chart** *(new)*: status colors are theme-correct in both light and dark, and the token chart is legible.
- **Smaller fixes**: Claude's multi-result output is preserved complete; OAuth metadata availability is reported as effectively resolved rather than as configured; the log panel's copy button copies the run id; URLs in chat messages are clickable; `a2wave --help` layout is repaired; the login page shows the server version; and the workspace path preview no longer strips CJK, kana and hangul, which sent anyone mounting or cleaning up a non-Latin-named Agent's directory to a path that did not exist.

### Other

- **GitLab triggers can watch an entire group**: name a namespace instead of enumerating repositories, and newly created repositories are picked up with no config edit.
- **The CLI is now an agent-first entry point**: commands and output are shaped for a local Agent to drive directly, rather than for hand-typing.
- **Reasoning effort and fast mode bind per provider chain entry**: both sit beside the model rather than once per Agent, because the legal effort levels follow the model. Levels are discovered per model alongside model ids, not hard-coded, and `diagnose` warns when a control is bound to a CLI that has no such setting.
- **A2A calls preserve caller provenance across hops**: run records show the full `user · calling Agent · source` chain even after a remote multi-hop invocation.
- **Repository auto-review is held to a P0/P1 bar**: the MR review template sends the Agent out of the diff into the surrounding code, works a checklist of what a diff-only pass reliably misses (call sites of a changed signature, old clients against a changed schema, irreversible migrations, swallowed errors, races), and keeps only findings that name the input or timing that reaches them. P2 and below stay out of the comment, and "no P0/P1 issues found" is stated as a valid result.
- **Thirteen P0/P1 defects closed by an API-surface audit** *(new)*, alongside an earlier sweep in which P4 sync errors stopped leaking the connection password, a failed topic merge rolls back instead of leaving the target holding a still-active source's facts, a failed Agent import no longer commits skill rows with empty files, and API-key regeneration plus SCM sync/check write the audit entries they were missing.
- **Windows fixes**: Codex multiline prompts are preserved, and CLI status probes work.

## v0.7.3-rc.2

> 🚧 **Release candidate.** Continues the v0.7.3 line: everything in `v0.7.3-rc.1`
> plus the entries below. Published as a GitHub pre-release, so the `Latest` badge
> stays on the newest stable version and the Docker `latest` tag does not move to it.
> Pull `ghcr.io/lilithgames/a2wave:0.7.3-rc.2` or install the exact npm version
> explicitly. The stable cut will ship as `v0.7.3`.

> ⚠️ **The rc.1 upgrade warning still applies in full — this release is not
> rolling-upgrade safe. Stop every API replica before applying its migrations,
> then start only the upgraded version.** See the v0.7.3-rc.1 notes below for the
> two reasons. rc.2 adds five further migrations, all additive (new
> `device_authorizations` and `cli_tokens` tables, a nullable `runs.owner_instance_id`
> column, and per-channel config columns for QQ and Telegram).

- **Telegram becomes a first-class channel**: publish an Agent to Telegram at parity with Discord — group and private triggers, attachments both ways, artifact upload, per-conversation sessions and restart recovery. Updates arrive over outbound long polling, so no public HTTPS ingress or callback URL is needed and a private deployment works unchanged; registering a bot clears any webhook previously set on it. Triggering on *every* group message additionally requires Group Privacy to be disabled via @BotFather.
- **QQ official bot channel (MVP)**: publish an Agent to a QQ official bot over the platform's WebSocket, bringing the channel count to twelve.
- **Sign in on a remote or headless machine**: `a2wave login` now supports the OAuth 2.0 device grant — the terminal prints a short code, you approve it from a browser wherever you already have a session, and the waiting CLI receives a token. Selected automatically over SSH; containers and CI pass `--device`. The approval page shows the requesting IP, client and time so you can tell your own session from a code someone phoned you.
- **CLI tokens for automation**: named, long-lived, individually revocable credentials created from **Settings → CLI access**, for CI jobs and scripts. Unlike a session token, retiring one machine's credential no longer means retiring them all, and a password change no longer silently breaks every pipeline. The plaintext is shown once.
- **Login sessions now last 7 days by default** (previously 1): a working week, so an ordinary user signs in about weekly. Override with `AUTH_SESSION_TTL_DAYS` (range 1–365); it applies only to new logins. Long-lived automation credentials are CLI tokens, not this.
- **Reasoning effort and fast mode bind per provider chain entry**: both sit beside the model rather than once per Agent, because the legal effort levels follow the model — one Agent-wide value is necessarily invalid for at least one entry. Levels are discovered per model alongside model ids, not hard-coded, and `diagnose` warns when a control is bound to a CLI that has no such setting.
- **An interrupted run no longer loses its provider session**: a run's session id is recorded while it is still executing, not only on completion — previously the one case that needed to resume was the one case that never stored it. This stores the resume target; acting on it automatically is separate work.
- **A run abandoned by a dead instance is reaped and its queue restarts**: a temp-workspace run whose process died took no lease, so nothing could prove it was abandoned and it stayed `running` forever — pinning the Agent's concurrency and parking the queue indefinitely. Runs now carry an owner instance, and a periodic sweep settles those whose owner is provably gone, then restarts promotion. The verdict is ownership, never age, so a long-running review is never mistaken for a dead one.
- **A queued repository-trigger run skips a merge request that already finished**: a run whose subject was merged while it waited in the queue now re-probes and terminates as `cancelled` instead of spending tokens to conclude "already merged". Fails open on every ambiguous verdict, so a broken probe never cancels legitimate work.
- **Feishu: a quoted reply no longer resurrects a stale direct-message session**: quoting a days-old message reopened that whole conversation and the model kept answering from context you had moved on from. Direct messages are now capped at the two-hour window like any other; group reply chains and topics still never expire. `/new` also works in a quoted direct-message reply, where it previously reached the Agent as literal prompt text.
- **Repository auto-review is held to a P0/P1 bar**: the MR review template now sends the Agent out of the diff into the surrounding code, works a checklist of what a diff-only pass reliably misses (call sites of a changed signature, old clients against a changed schema, irreversible migrations, swallowed errors, races), and keeps only findings that name the input or timing that reaches them. P2 and below stay out of the comment, and "no P0/P1 issues found" is stated as a valid result.
- **P4 sync errors no longer leak the connection password**: `p4d`'s raw stderr, which can echo `P4PASSWD` back, was persisted to the source's last-sync error and shipped to the sync-error webhook without redaction. Also in this fix: a failed topic merge now rolls back instead of leaving the target holding a still-active source's facts, a failed Agent import no longer commits skill rows with empty files, and API-key regeneration plus SCM sync/check now write the audit entries they were missing.
- **The workspace path shown for an Agent is the one it actually gets**: the preview stripped CJK, kana and hangul, so an Agent named in a non-Latin script displayed a directory that did not exist — sending anyone trying to mount or clean it up to the wrong place.
- **Smaller fixes**: Claude's multi-result output is preserved complete; OAuth metadata availability is reported as effectively resolved rather than as configured; the log panel's copy button copies the run id; URLs in chat messages are clickable; `a2wave --help` layout is repaired; and the login page shows the server version.

## v0.7.3-rc.1

> 🚧 **Release candidate.** Feature-complete and green on the full suite, but with no
> production soak time. It is published as a GitHub pre-release, so the `Latest` badge
> stays on the newest stable version; the Docker `latest` tag does not move to it either.
> Pull `ghcr.io/lilithgames/a2wave:0.7.3-rc.1` or install the exact npm version
> explicitly. Try it in a staging environment and report back; the stable cut will ship
> as `v0.7.3`.

> ⚠️ **This release is not rolling-upgrade safe. Stop every API replica before
> applying its migrations, then start only the upgraded version.** Two
> independent reasons, either sufficient on its own, and both fail silently:
>
> 1. A pre-upgrade replica deletes workspace-removal reservations by id alone,
>    erasing the newer attempt-token fence.
> 2. A pre-upgrade replica writes no `instance_heartbeats` row, so an upgraded
>    peer reads it as dead and may reclaim leases and Git worktrees out from
>    under a process that is still running.
>
> Single-container SQLite deployments are unaffected in practice — there is only
> one replica — but the migrations still apply.

- **Managed SCM storage for Git sources**: `localPath` is now optional for Git and allocated under the managed storage root; P4 still requires an explicit path covered by its client `Root`. Existing bind mounts, source paths and legacy worktree roots survive the upgrade.
- **Cross-replica workspace recovery**: a crashed or unreachable replica no longer strands its checkouts. Processes publish a liveness heartbeat, and a surviving replica settles the abandoned workload, releases its lease, and converges the leftover worktree removal — work that previously required an operator to run SQL by hand. An instance that cannot renew its own heartbeat stops itself before peers may reclaim its workspaces.
- **PostgreSQL deployment path**: `a2wave setup` can provision a PostgreSQL 16 sidecar or point at an external server. Still experimental and not recommended for production; there is no SQLite → PostgreSQL data migration.
- **Invitation links replace admin-set passwords**: administrators issue an expiring single-use link instead of typing someone else's password, and the invitee chooses their own and lands signed in. Links are copyable and revocable from the invitations drawer, and re-inviting an address supersedes the outstanding link so only one is ever live.
- **Git SCM Agents no longer share a working directory**: each Agent runs in its own worktree, where previously a run of one Agent could delete files a concurrent run of another was executing against. A worktree with unmerged agent commits or local modifications stays pinned (with a warning) and resumes following the source branch once that work lands upstream.
- **GitLab triggers can watch an entire group**: name a namespace instead of enumerating repositories, and newly created repositories are picked up with no config edit.
- **The CLI is now an agent-first entry point**: commands and output are shaped for a local Agent to drive directly, rather than for hand-typing.
- **The agent's Publish tab is now Channels**: a more accurate name for what it manages — API, Feishu, Slack, schedules, repository triggers and the rest.
- **A2A calls preserve caller provenance across hops**: run records show the full `user · calling Agent · source` chain even after a remote multi-hop invocation.
- **Chat and run recovery fixes**: restored chats accept follow-ups again, run state recovers and refreshes correctly after a server restart, and interrupted A2A remote tasks are resumable.
- **Feishu and Slack no longer process a message twice**: deduplication keys on the message's own identity rather than the delivery envelope, so one message starts one run.
- **Windows fixes**: Codex multiline prompts are preserved, and CLI status probes work.
- **Credentials survive an edit**: saving a form no longer persists the masked placeholder over the real secret.

## v0.7.2

- **`a2wave setup` now works with no flags**: `--image` is optional and defaults to the published image matching the CLI's own version (`ghcr.io/lilithgames/a2wave:<cli-version>`), so `npm i -g a2wave && a2wave setup` installs a running platform without cloning or building anything. Pass the flag only for a locally built or mirrored image.
- **`a2wave setup --upgrade` picks up the same default**: `a2wave update` followed by `a2wave setup --upgrade` moves an existing install to the matching release without retyping the image ref.
- **The container image is now public**: `ghcr.io/lilithgames/a2wave` can be pulled anonymously (tags `<version>` and `latest`); the READMEs document the CLI quick start and the direct `docker pull` path.

## v0.7.1

First public release, shipping the `a2wave` CLI to npm and multi-arch container images to GHCR.

- **Agent orchestration platform**: create, configure and orchestrate Agents in natural language. Execution capability comes from the underlying Agent CLIs (Cursor Agent / Claude Code / Codex); the platform does not intervene in an Agent's runtime decisions.
- **Publish Agents over many channels**: API, Feishu, Slack, Discord, A2A, schedules, a built-in chat page, and GitLab / GitHub repository triggers — repository triggers start a run only when a watched merge/pull request actually moves, instead of polling unconditionally.
- **Extend through Skills and MCP Servers**: compose Agent capability from Skills and MCP Servers (stdio / sse / http / group). A Skill is creator-private by default; an administrator may publish it to all users.
- **Providers and model discovery**: models are probed per bound credential rather than kept as a static catalog that drifts from what the account can actually run.
- **Agent CLIs installed at runtime**: the image preinstalls no Agent CLI. They are installed on demand from `provider-cli-lock.json` with pinned versions and SHA-256 verification, cutting over 1GB from the image; installation state is always probed from `PATH`, never trusted from the database.
- **Evaluation**: replay Case sets against an Agent's current configuration, freezing a provider / model / prompt snapshot for comparison across versions. The evaluation queue is isolated from the run queue, so a large evaluation cannot starve interactive chat.
- **Knowledge bases and workspaces**: connect Git and Perforce sources; runs and evaluations execute in isolated workspaces.
- **Enterprise capabilities**: password and SSO login, per-Agent owner / editor / viewer permissions, audit logging, rate limiting, and health/readiness probes.
- **Database backends**: SQLite single-file deployment by default. PostgreSQL is experimental, aimed at multi-instance deployments, not yet recommended for production, and has no SQLite → PostgreSQL data migration path.
- **In-app user manual**: a manual at `/wiki`, with a bilingual (Chinese / English) interface.
- **Documentation and CI**: streamlined README with configuration extracted into its own reference; the dependency license inventory check is now host-independent, and secret scanning uses the repository's own ruleset.
