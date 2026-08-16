# Agent Management

The Agent is a2wave's core orchestration unit. An Agent = **system prompt + execution engine ([Provider](/wiki/providers)) + mounted capabilities + trigger methods + members**. This chapter explains how to create, configure, publish, and collaborate on Agents.

## Agent Types

| Type | Description | Typical Use |
|------|------|---------|
| **cursor** (default) | Runs the Cursor Agent CLI, with full code editing + Shell execution | Editing code, running commands, engineering tasks |
| **llm** | Pure conversation/reasoning, no code execution | Q&A, text processing, lightweight assistants |
| **script** | Custom script execution | Scripted tasks with a fixed workflow |

## Key Configuration Options

On the Agent detail page you can configure:

- **Name / Icon / Description**: identifying information.
- **System Prompt**: the Agent's core persona and rules, supporting Mustache variables (e.g. `{{message}}`).
- **Provider and model**: choose the execution engine and specific model; supports a **Provider chain** (primary + fallback).
- **Reasoning effort and fast mode**: supported by some engines (Claude Code, Codex) and configured **beside each chain entry's model** — see "Reasoning Effort and Fast Mode" below.
- **Credential mode (authMode)**:
  - `apiKey`: injects an API Key (e.g. `ANTHROPIC_API_KEY`).
  - `oauth`: injects an OAuth Token (`CLAUDE_CODE_OAUTH_TOKEN`, Claude Code only).
  - `localSession`: uses the login session of the CLI on the **server running a2wave** (`~/.claude`, etc., not the computer where your browser currently is), injecting no credentials.
- **Workspace type (workspaceType)**: `temp` (temporary directory, default) or `scm` (bound to an [SCM Source](/wiki/scm-sources)).
- **Mounted capabilities**: [Skills](/wiki/skills) and Skill groups, [MCP Servers](/wiki/mcp-servers), [Knowledge Bases](/wiki/knowledge-base).
- **Environment variables (env)**: injected into the subprocess; can be marked `sensitive` for masking and clearing on clone.
- **Max concurrency (maxConcurrency)**: 1–5, controls how many Runs this Agent executes simultaneously; excess ones are queued.
- **Timeout**: a single Run can be set to 5–120 minutes, default 10 minutes; the execution is terminated when the limit is reached.
- **Long-term Memory**: see [Long-term Memory](/wiki/memory).
- **Evaluation**: verify config changes and compare models, see [Evaluation](/wiki/evaluation).
- **Publish channels and triggers**: see [Trigger Methods](/wiki/triggers).

## Reasoning Effort and Fast Mode

Some execution engines — currently **Claude Code** and **Codex** — let you tune how deeply the model thinks and how fast it answers. Both controls sit **beside the model of each Provider chain entry**, not once per Agent: a chain can mix engines and models, and each model offers different levels.

### Reasoning effort

A higher level means deeper reasoning, at more time and cost. **The available levels come from the selected model**, not from a list the platform maintains: a2wave fetches them together with the model list, so what you see is what these credentials can really use with that model.

- **Leave it empty** to use the CLI's own default.
- Switching models refreshes the levels. A level the new model also offers is kept as is; one it does not offer falls back to **that model's own default** (or to empty, meaning the CLI default, when discovery reports no default).
- Some models (lightweight ones, typically) accept no level at all, and the field says so.

> [!NOTE]
> Behind a self-hosted proxy the model endpoint usually returns model names only, with no level list. The field is then disabled and says no level information was discovered. Leaving it empty is fine — the run uses the CLI default — and a level configured earlier is not lost.

### Fast mode

Runs at a higher output speed, usually at premium pricing. It is a plain switch with no levels.

**Turning it on does not by itself guarantee it applies**: that also depends on the model, the account plan and how the engine is reached (a third-party proxy typically cannot enable it). When a condition is unmet the run simply proceeds at normal speed without failing. To see whether a given run actually used it, check the execution parameters in its [run record](/wiki/runs).

## Creating an Agent

1. Go to the "Agents" page and click **New Agent**.
2. In the template selector, choose "Create blank" or start from a template.
3. Fill in the **name** and **system prompt**, and select the **Provider** and model.
4. Mount Skills / MCP / SCM Sources / Knowledge Bases as needed, and configure env and concurrency.
5. Save to enter the detail page, where you can continue editing or publish.

Scenario templates prefill a name, prompt, and safe defaults so you can start from a proven working pattern:

| Template | Best for | Prefilled | You still confirm |
|----------|----------|-----------|-------------------|
| My First Agent | General Q&A and lightweight tasks | General prompt, Claude Code, guided publishing | Provider credential and model |
| Support Investigator | Read-only customer, permission, and business investigations | Evidence chain, permission boundaries, escalation rules | Data-source Skills / MCP servers / knowledge bases |
| Codebase Q&A | Explaining implementation, call paths, and configuration | Read-only mode, SCM workspace, code-evidence rules | A synchronized code source |
| Code Review Assistant | Reviewing an MR, PR, or target diff | Read-only mode, SCM workspace, severity and gate rules | A synchronized code source and validation tools |
| Incident Analyst | Alert, log, and metric investigation | Read-only mode, timeline, confidence, and containment structure | Observability Skills or MCP servers |
| Data Inspector | Scheduled or ad-hoc trend and anomaly analysis | Timezone, baseline, anomaly ranking, and report contract | Data source, metric definitions, scheduling/delivery settings |
| Documentation Maintainer | Incremental documentation updates and full audits | SCM workspace, two-mode routing, single-write-target rule | Code source, documentation target, documentation Skill / MCP |
| Artifact Generator | Downloadable reports, CSV, and JSON files | File formats, naming, validation, and delivery rules | Inputs and acceptance criteria |
| Web App Generator | Static web apps with an online preview | artifact directory, authenticated seven-day auto-sharing | Provider credential, model, and page requirements |

> [!IMPORTANT]
> A template is an **editable starting point**, not a clone of a production Agent. It carries no production credentials, environment values, Provider / SCM / MCP instance IDs, members, publish channels, or recipients. A platform template auto-binds only system-owned built-in Skills visible to all users. Review the Provider, model, code source, and mounted capabilities before saving.

## Browsing the Agent List

The "Agents" page shows the Agents you have permission to access: **pinned Agents appear first**, and the rest are sorted by creation time from newest to oldest. When there are many, use the pagination controls at the bottom of the page to switch to the previous / next page; the current page is reflected in the address bar (e.g. `/agents?page=2`), so you return to the same page after refreshing or sharing the link. If you can't see a certain Agent, first check whether it's on a later page, then check whether you have owner / editor / viewer permission.

## Pinning Frequently Used Agents

Pin the Agents you use most often so they stay reliably at the top of the list, without paging to find them.

- **How to pin**: hover over an Agent card, and a pin icon appears to the right of the card name; click it to pin. A solid, highlighted pin indicates it is pinned. Click again to unpin.
- **Sorting rule**: multiple pinned items are arranged in the **order you clicked to pin them** — later-pinned items come after already-pinned ones; after unpinning, the Agent returns to the normal list (sorted by creation time).
- **Who can pin**: pinning requires write permission on the Agent (owner / editor; admins too). With only viewer permission, the pin does not appear.
- **Scope**: pinning only changes the display order of the list; it does not affect the Agent's execution, publish status, or trigger behavior.

## Lifecycle: Draft / Published / Stopped

| Status | Meaning | External Invocation |
|------|------|---------|
| `draft` | Draft, not published | Cannot be triggered externally |
| `published` | Published, active | Listens on the configured trigger channels |
| `stopped` | Previously published, now stopped | The gateway returns `403 AGENT_NOT_PUBLISHED` |

- **Publish**: set to a triggerable state (only after publishing does it listen on channels such as Feishu).
- **Stop**: pause receiving triggers (e.g. temporarily taking the Feishu connection offline).
- **Resume**: set a stopped Agent back to the running state.

## Debugging

The **Chat debugging** on the detail page lets you verify the prompt and capabilities without an external trigger; the `viewer` role can debug too. Runs produced by debugging are isolated per caller.

## Cloning and API Key

- **Clone**: copies the configuration; the clone belongs to the current operator. **For security, cloning clears all `sensitive` environment variables and Provider credentials (API Key / BaseUrl / OAuth Token are emptied), keeping only the `authMode` to prompt you to re-enter them**.
- **Import / export**: for an authenticated download, administrators may export every mounted Skill; a regular user may export only Skills they own or Skills visible to all users, so Agent read access never reveals another user's private Skill. A temporary 24-hour share link contains no Skill content or accompanying files; the importer must install and rebind the required Skills in the target instance. Exported packages never carry Slack or Discord tokens. After import, these channels remain disabled with empty configuration; enter credentials for the target workspace or server before publishing again. Upload requests retain the global 10 MiB body limit; URL imports accept at most 50 MiB compressed data and have a 120-second overall deadline. Before parsing or writing anything, the archive's declared metadata is checked against limits of 10,000 entries, 10 MiB per entry and per Skill, 500 files per Skill, and 100 MiB total uncompressed data; unsafe, duplicate, or escaping paths are rejected. Every redirect and DNS answer is validated and pinned. Exact `TRUSTED_IMPORT_HOSTS` entries may allow ordinary enterprise-private DNS, but never loopback, link-local/cloud-metadata (including Alibaba and IPv6 IMDS), reserved addresses, wildcards, or IP literals.
- **Reset API Key**: invalidates the old Key and generates a new gateway invocation key (`POST /api/agents/:id/regenerate-api-key`).

## Overview and Trends

The **Overview** tab answers "how is this Agent actually being used". The top row holds cumulative metrics (total runs, success rate, average duration, today's runs, token usage); below it, **Trends** spreads the same data across a time axis so you can read direction rather than just totals.

**Time range**: choose Today / Last 7 days / Last 30 days / Last 90 days / Custom. "Today" buckets by **hour**, the rest by **day**; a custom range of two days or less also switches to hourly. Days with no activity still appear on the axis as zero, so a break in a line means "genuinely no calls", not missing data.

The four charts are:

| Chart | What it shows |
|-------|---------------|
| **Runs by status** | Runs per bucket, stacked by completed / failed / running / queued / pending / cancelled, so you can tell a one-off failure spike from a sustained one |
| **Askers** | Distinct people who asked something in each bucket |
| **Token usage** | Input and output token consumption, for watching cost trends |
| **Avg response time (per turn)** | Mean latency of a single conversation turn |

> [!NOTE]
> **Askers** counts distinct callers per bucket: signed-in users are identified by account, external channels (Feishu and the like) by caller name, and one person arriving through several channels still counts once. Runs with no caller identity — scheduled triggers, plain API keys — are excluded.

> [!IMPORTANT]
> **Avg response time (per turn)** measures a single turn, while the **average duration** card at the top measures a whole run. A multi-turn run contributes several turns to the former, so the two numbers differing is expected, not a bug.

Token usage is attributed to **when each turn happened**: for a conversation spanning midnight, yesterday's turns count toward yesterday and today's toward today, rather than all landing on the day the conversation started.

## Diagnosis

The **comprehensive diagnosis** on the detail page checks the execution engine, Provider, and Feishu / Slack / Discord connections in one click — it's the go-to entry point for troubleshooting "why isn't it working". Connection status only reflects the current API instance.

## Permission Roles

Agents are isolated into three levels — **owner / editor / viewer** (admin equals owner):

| Role | Capabilities |
|------|------|
| **viewer** | Read-only + Chat debugging |
| **editor** | Read/write + publish/stop/clone/share |
| **owner** | On top of editor, can delete + manage members |

For adding and managing members, see [Member Management](/wiki/members).

## Troubleshooting

| Symptom | Possible Cause | Fix |
|------|---------|------|
| 403 when calling after publishing | Agent not published / stopped | Confirm the status is `published` |
| Execution error "No engine" | Provider not configured or engine unavailable | Run "comprehensive diagnosis" and check the Provider credentials |
| Can't see a certain Agent | No access permission | Ask the owner to add you as a member |
| Insufficient permission (403) when changing config | You are a viewer | Requires editor or above |

## Related

- [Provider Execution Engine](/wiki/providers) · [Evaluation](/wiki/evaluation) · [Trigger Methods](/wiki/triggers) · [Member Management](/wiki/members) · [Runs](/wiki/runs) · [Long-term Memory](/wiki/memory)
