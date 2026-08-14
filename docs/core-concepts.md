# Core Concepts

Detailed description of the a2wave domain model. For an overview, see the root [AGENTS.md](../AGENTS.md).

## Agent

Digital worker with type (`llm`/`cursor`/`script`), system prompt, skills, API key, and publish status. CLI-backed execution is selected through its `providerId`, not through the legacy Agent type. Can mount MCP Servers (via `mcpServerIds`) and Skills (via `skills` ID array). Has a `workspaceType` (`scm` or `temp`) to determine its working directory: `scm` associates the agent with an SCM Source (via `scmSourceId`) — git Sources give each Agent its own persistent worktree under the Source's `workspacesPath` (P4 Sources use `localPath` directly, having no isolation mechanism); `temp` uses an auto-generated subdirectory under the global `workspacePath`. Can inject environment variables (via `env` — `Record<string, { value, sensitive }>`). System prompt supports Mustache template variables: `{{message}}`, `{{context}}`, `{{model}}` (current model), `{{agent_provider}}` (engine label, e.g. Cursor Agent / Claude Code / Codex). Executes locally on the API server via engine registry.

## Provider

Reusable execution-engine environment for one of the built-in CLI adapters. The stable `kind` field identifies `cursor`, `claude-code`, `codex`, `opencode`, `qoder`, `trae`, `kimi`, or `pi`; runtime dispatch, model probing, authentication, and Provider-specific UI use this field. `name` is display-only and can be renamed or localized without changing execution behavior.

Each Provider response includes a capability manifest derived from `kind`. The manifest describes supported authentication modes and credential fields, model discovery, MCP injection, session resume, sandbox behavior, and Agent-level execution options. Backend routes and the web UI consume the same manifest instead of maintaining separate name-based conditionals. Provider records also hold deployment settings such as `initScript`, `checkScript`, `skillsDir`, `mcpConfigPath`, and optional `minVersion` — a floor, not the lock's exact pin, so a newer CLI passes; a lower one is reported by both the login probe and `GET /api/agents/:id/diagnose` (`provider_cli_version_below_minimum`, severity `error`), and is diagnosed rather than blocked. Providers are system presets and can be shared by multiple Agents.

A Provider must be able to **enumerate the models its bound credentials can run** — `modelDiscovery` is `automatic` or `manual`, never absent. Providers therefore store no model catalog at all: the list is probed from the CLI per Agent credential, so it cannot drift from what the account can actually use. Consequently a Provider has no editable field, and `PATCH /api/providers/:id` rejects every body. `copilot` was retired under this rule: the GitHub Copilot CLI exposes no model-list command.

An Agent's `providerChain` stores its per-binding model, authentication mode, and credentials. Claude Code bindings in `apiKey` mode may also store `authHeaderStyle` (`x-api-key` or `bearer`); a missing value is resolved as `x-api-key` so existing and imported Agents retain their prior runtime contract. The same resolved style drives model probing and subprocess environment injection, without inspecting credential prefixes.

`localSession` always means a deployment-level shared CLI identity. In Docker, the API process has the explicit home `/home/appuser`; Compose persists that entire directory in `a2wave-cli-home`, so Cursor, Codex, OpenCode, Qoder, Trae, Kimi Code, and Pi configuration survives container replacement. Claude Code keeps its existing nested host `~/.claude` read-only mount for compatibility. Per-Agent runtime HOME isolation remains enabled for injected credential modes and is deliberately omitted for localSession; adapters may still place session history in an explicit per-Agent directory.

- **Codex CLI** uses `codex exec --json`, discovers workspace skills under `.codex/skills`, injects Agent-scoped MCP servers with `-c mcp_servers=...` per run without mutating `~/.codex/config.toml`, and authenticates through `OPENAI_API_KEY` or a local `codex login` session.
- **OpenCode CLI** uses `opencode run --format json`, discovers skills under `.opencode/skills`, and injects MCP configuration through `OPENCODE_CONFIG_CONTENT`. It supports local sessions only; deployment-level multi-provider credentials are stored by `opencode auth login`, and model identifiers are discovered through `opencode models`.
- **Qoder CLI** (`qodercli`, version 1.0.0 or newer) uses the Claude-Code-compatible headless stream protocol, resumes sessions with `--resume`, syncs MCP configuration to workspace `.mcp.json`, and authenticates through `QODER_PERSONAL_ACCESS_TOKEN` or a local login. Models are discovered with `qodercli --list-models`.
- **Trae CLI** (`traecli`, version 0.120.0 or newer) emits the same stream format, receives its model through a config override, syncs MCP configuration to `.trae/mcp.json`, and authenticates through `TRAECLI_PERSONAL_ACCESS_TOKEN` with an optional `TRAECLI_HOST`, or through a local login. Models are discovered with `traecli models`.
- **Kimi Code CLI** (`kimi`, version 0.30.0 or newer) uses `kimi -p --output-format stream-json`, whose NDJSON rows are OpenAI-chat-shaped (`role`/`tool_calls`) rather than Claude-Code-shaped, so it has a dedicated parser. It resumes sessions with `-r`, discovers skills under `.kimi-code/skills`, and syncs MCP configuration to `.kimi-code/mcp.json` — written in Kimi's dialect, where the remote transport is named by `transport` and a bare `url` means streamable HTTP. It supports local sessions only: authentication is the `kimi login` device-code OAuth flow, and the CLI deliberately does not read API keys from the environment, so there is no injected-credential mode. Models are discovered with `kimi provider list --json`. Non-interactive runs always apply the `auto` permission policy — `-p` rejects `--yolo`/`--auto`/`--plan` — so no Agent-level execution options are exposed.
- **Pi CLI** (`pi` from `@earendil-works/pi-coding-agent`, version 0.83.0 or newer) runs in JSON mode and treats `agent_settled` as the terminal event so retries and compaction can finish before a Run is settled. It inherits the deployment HOME for local-session credentials, stores sessions in an explicit per-Agent runtime directory, resumes an existing session in the same working directory, and forks its context when a chat moves to another worktree; missing session state fails explicitly rather than starting an empty conversation. Models are discovered with `pi --offline --list-models` and normalized as `provider/model`. Workspace skills under `.pi/skills` are passed explicitly while ambient skills, extensions, prompt templates, and themes are disabled. Pi supports local sessions only: run `pi` and use `/login` in the a2wave execution environment. Because Pi intentionally has no built-in MCP client, its capability manifest rejects MCP attachments. Its only Agent-level execution option is read-only mode, implemented with Pi's `read`, `grep`, `find`, and `ls` tools. Assistant and automatic-compaction usage are both included in Run token totals.

## MCP Server

Model Context Protocol server configuration. Supports **stdio** (local command), **sse**, and streamable **http** transports, plus **groups** that aggregate inline or referenced backends through progressive disclosure. Agents mount MCP servers to gain access to external tools and context.

stdio-capable and other `admin-only` MCP servers can only be bound to an Agent owned by an administrator. That binding remains usable through every approved execution channel while the Agent owner is still an active administrator, and is revalidated when each execution starts. The system-owned `a2wave-platform-admin` builtin is a stricter control-plane exception: it requires an explicitly identified active backend administrator and is never exposed to Gateway, OAuth, A2A, native chat, Chat Page, or scheduled execution. Group backends use the same runtime authorization rules.

## Skill

Reusable instruction set that defines agent capabilities. Skills are stored in two forms:
- **Metadata**: Stored in SQLite (id, name, description, content, storagePath, owner `userId`, `visibility`, optional remoteSource provenance, and sourceDirty).
- **Asset Files**: Stored in the filesystem under `A2WAVE_SKILLS_STORAGE` (default `./data/skills`).

### Storage Structure
```
{SKILLS_STORAGE_ROOT}/
  skl_xxx/                    # One directory per skill (skill ID)
    SKILL.md                  # Main instruction document (required)
    references/               # Reference documents
    scripts/                  # Executable scripts
    templates/                # Template files
    ...                       # Other attachments
```

### Content Sync Strategy
- **Visibility**: New Skills default to `private` and are discoverable only by their creator (administrators can still administer every row). Only an administrator may publish user-created Skills as `all-users`; platform-seeded built-ins are system-owned and persist as `all-users`. All such Skills are readable and bindable by every signed-in user, while mutations remain owner/admin-only. Runtime resolution rechecks the current value against the Agent owner, so revoking `all-users` stops foreign-owned Agents from loading the Skill on their next run. Authenticated Agent exports materialize only Skills visible to the exporter, and unauthenticated export-share links omit Skill contents entirely.
- **Import/Upload**: Parses YAML frontmatter from `SKILL.md` into metadata, and the body into `content`.
- **Remote install**: A public skills.sh or GitHub URL is resolved to a full GitHub commit SHA. The user previews discovered packages before a2wave downloads the same immutable archive again, verifies each selected package digest, and stores repository/path/revision provenance. No repository code is executed during installation.
- **Local divergence**: Editing a remotely installed Skill or replacing/appending its files sets `sourceDirty=true`; the original provenance remains available for audit.
- **Explicit remote updates**: Updates never run automatically. A check compares the installed base commit, current local files, and the latest commit on the stored ref. Non-conflicting changes merge automatically; files changed differently both locally and upstream are reported as conflicts. The caller must abort, preserve the local versions, or overwrite them with upstream versions. The filesystem replacement, metadata update, and audit entry use rollback-safe semantics.
- **Execution**: Skills are synced as files to the agent's working directory (e.g., `.cursor/skills/`) based on the Provider's `skillsDir` configuration. They are natively discovered and used by the execution engine (like Cursor Agent).

## SCM Source (Source Code Management)

Represents a version control repository that provides a working directory for Agents. Supports **Perforce P4** and **Git**. Each SCM Source persists a unique absolute `localPath`; Git create requests may omit it so the server allocates `SCM_STORAGE_ROOT/sources/<sourceIdSuffix>`. P4 requires an explicit operator-mounted path covered by the existing Client `Root` or `AltRoots`.

### Initial Sync and Agent Selectability

- **Initial sync timeout** — the config option `initialSyncTimeoutMin` (minutes, default 60) bounds the *first* sync of a source, which clones or seeds an entire checkout and so routinely outlasts the ordinary `EXEC_TIMEOUT_MS` applied to every later refresh. It is read when `initialSyncCompletedAt` is still NULL; once the first sync succeeds the standard timeout applies.
- **Initial sync completed** — every enabled source starts its first sync immediately in the background; `autoSync` controls only later interval refreshes. Restart recovery queues incomplete sources with a bounded concurrency instead of launching every clone together. Once an SCM Source has completed at least one **successful** sync, the system writes `initialSyncCompletedAt`. Only when this field has a value can the SCM Source be selected by an Agent.
- **Constraint** — an SCM that has not completed its initial sync cannot be selected when creating/editing an Agent; if an Agent is bound to such an SCM when executing a Run or Chat, the API returns 400. Subsequent scheduled sync (`syncIntervalMin`) logic is unaffected.

### P4 Source

A P4 Source encapsulates all Perforce connection parameters (`p4port`, `p4user`, `p4passwd`, `p4client`, optional `depotPath`) and manages code synchronization:

- **Connection check** — validates P4 server connectivity via `p4 info`.
- **Code sync** — executes `p4 sync` to pull latest code to `localPath`.
- **Auto-sync** — optional periodic synchronization at configurable intervals.
- **Sync status** — tracks `idle`, `syncing`, or `error` state with last sync timestamp and error message.

When an Agent uses `workspaceType: 'scm'` and references a P4 Source via `scmSourceId` (and that source has completed initial sync), the system automatically:
1. Sets the Agent's working directory to the Source's `localPath`.
2. Injects P4 environment variables (`P4PORT`, `P4USER`, `P4PASSWD`, `P4CLIENT`, `P4_CLIENT_ROOT`) into the execution environment.

### Git Source

A Git Source encapsulates Git repository parameters (`repoUrl`, `branch`, optional credentials) and manages code synchronization:

- **Connection check** — validates Git repository accessibility via `git ls-remote`.
- **Code sync** — executes `git pull` to pull latest code to `localPath`.
- **Auto-sync** — optional periodic synchronization at configurable intervals.
- **Sync status** — tracks `idle`, `syncing`, or `error` state with last sync timestamp and error message.

When an Agent uses `workspaceType: 'scm'` and references a Git Source via `scmSourceId` (and that source has completed initial sync), the system automatically:
1. Sets the Agent's working directory to a **per-Agent worktree** (`<workspacesPath>/agent-<agentId suffix>`, persistent). Agents sharing one Source therefore never share a working directory — a run of one Agent re-mounting skills/config cannot delete the files another Agent's in-flight run is executing. The worktree sits on its own branch (same name as the worktree), so the Agent's commits land on a real branch; on each run it advances to the Source's synced HEAD only when that is a fast-forward and no other run of the same Agent is executing (tracked modifications or unmerged commits pin it in place, and it follows the Source again once those commits are merged). If the worktree cannot be created, the run degrades to the Source's shared `localPath`.
2. Injects Git environment variables into the execution environment: `GIT_BRANCH` (the Source's tracked branch) always, and `A2WAVE_WORKSPACE_BRANCH` (the worktree's own branch) only when the run actually executes in its per-agent worktree.

P4 Sources have no isolation mechanism (a client spec is server-side state bound to a single `Root`), so P4 Agents keep using the Source's `localPath` directly.

> **Path uniqueness**: `localPath` must be an absolute path and unique across all SCM Sources, to avoid conflicts from multiple Sources sharing the same working directory.

### Worktree Root Directory (`workspacesPath`)

The optional SCM Source field `workspacesPath` customizes the root directory of per-run worktrees.

- When left empty (`null`), it defaults to `SCM_STORAGE_ROOT/workspaces/<sourceId underscore suffix>`; when set, all ephemeral/ttl/persistent worktrees create subdirectories by `name` under this directory. The historical `~/.a2wave/workspaces` root remains accepted for upgraded sources.
- When creating/updating an SCM Source, `workspacesPath` accepts a string or `null`; it is an absolute path and not shared with any other Source.
- Used to isolate large repos or move worktrees to a high-performance volume (such as an SSD).

## Run

Task execution instance (`pending` → `running` → `completed`/`failed`) with ordered run steps. Each agent chat creates a run with associated run steps tracking input, output, status, and duration. A Run also serves as a "conversation" container — chat messages are stored in `chat_messages` table linked via `runId`.

## ChatMessage

Individual chat message within a Run conversation. Has `role` (user/agent), `content`, and `createdAt`. Referenced by `runId`.

## Memory

Agent-scoped, filesystem-backed context that persists across Runs. Memory is shared by callers of
the same Agent and is not a requester profile or an authorization source.

Topic V2 uses progressive disclosure:

1. `MEMORY.md` is a compact startup Agent Summary, deterministic active-topic catalog, and fixed
   disclosure guide.
2. `memory/topics/*.md` stores bounded durable knowledge by stable reuse scope. The server owns the
   topic ID, path, frontmatter, and catalog entry; one focused recall selects and reads at most one
   active topic on demand. Selection is catalog-first with bounded-body fallback, and weak or tied
   matches fail closed without searching history. Archived topics live under `memory/topics/archive/`.
3. Daily and weekly worklogs preserve chronological Run history and evidence for search when a
   topic is missing or incomplete.

Automatic post-Run insights update only a matching bounded topic or create a sufficiently supported
new scope. A 1,500-token soft limit requests reorganization; a 2,000-token hard limit refuses L1
promotion while leaving the source in Run/worklog history. Topic V2 never model-compresses the main
file or topic files automatically. Existing single-file memory remains compatible until an editor
previews and commits a verbatim, coverage-checked topicization.

An explicit request to add one durable item uses one server-routed write that atomically selects the
topic, deduplicates the item, persists it, and rebuilds the catalog. Update and forget operations
retain the exact read-modify-replace flow because they must preserve unrelated topic content.

## Gateway API

A public API entry point for external systems (CI/CD, Feishu Bots, etc.) to invoke published Agents. It is a **peer relationship** with CI systems like Jenkins, not an upstream/downstream dependency. It returns the execution result synchronously after invocation; during execution, the Agent completes side-effect operations (such as code comments, message notifications, etc.) via MCP tools, which are configured in the Agent's system prompt and require no additional orchestration.

Includes request rate limiting (default 60 req/min) and authentication. API Key calls use `/api/gateway`; IDaaS calls use `/api/oauth`. Both share the `GatewayError` envelope, but OAuth errors are distinguished by responsible party as `caller`, `agent`, `provider`, and `platform`: only an invalid caller IDaaS token returns HTTP 401, while an invalid Agent Provider login returns `PROVIDER_REAUTH_REQUIRED` and advises contacting the Agent owner.

## Settings

Global configuration stored as key-value pairs grouped by `category`. Uses a composite primary key `(category, key)`. Currently supports `general` category with `workspacePath` (base directory for agent workspaces) and `timeoutMinutes` (execution timeout). Agents run in `<workspacePath>/<agent-name-slug>/` subdirectories.
