# a2wave — Product

**a2wave turns the agent CLIs developers already run into digital workers the whole
team can call.**

---

## 1. The goal

**A business team can build a general-purpose business Agent** — not a pipeline
hardcoded for one scenario, but a digital worker that is reusable, composable, and
reachable from the channels the team already uses.

Each word carries weight:

* **General-purpose.** Generality comes from *combining information sources* — a real
  code checkout, know-how accumulated as Skills and Memory, live systems reached over
  MCP — never from a single one of them, and never from business logic baked into the
  platform. The platform makes each source reliable to attach and dependable to run
  against; what to do with them is the Agent's decision.
* **Business.** The same orchestration, pointed at different sources, does different
  kinds of work. This is why the platform must not privilege one source over others.
* **Build.** Teams build these Agents themselves, and **the barrier is lowered by the
  Agent already on their own machine, not by our UI.** Our users run Claude Code,
  Codex or Cursor Agent locally — that is the premise a2wave is built on. The same CLI
  that writes their code can write their prompt, fill in their config, generate their
  Agent YAML and drive the a2wave CLI. So a2wave adds no wizard for what a local Agent
  already does, and spends the effort on what no local Agent can provide (§4).

> **Trust model — a trusted internal team.** a2wave assumes Agent authors and Agent
> users are trusted colleagues acting in good faith. That is why Agents get genuine
> execution power instead of being sandboxed from one another: the guardrails (auth,
> per-Agent permissions, audit, rate limiting) enforce **accountability and least
> privilege among cooperating teammates**, not defense against a malicious insider.
> Exposing a2wave to untrusted users requires an added isolation layer.

---

## 2. Running in production

These patterns run in production inside Lilith Games. They are not demos — each
replaced a pipeline script or work that somebody previously did by hand.

| Scenario | Combination | What it does |
| :--- | :--- | :--- |
| **Fix it and open the MR** | SCM Source + Agent CLI + MCP | Not a suggestion in a comment thread. Edits files in a real checkout, commits, opens an MR you review like a teammate's. |
| **Scheduled code audit** | Schedule + SCM Source + Agent CLI + MCP | Runs on a cron rather than waiting for a repository event. Dependency drift, dead code, and convention violations are swept weekly; an MCP integration posts the result to chat. |
| **Knowledge Q&A** | SCM Source + Skills + Agent CLI | *Why is this module written this way? Who owns this table?* Answers from real code and the team's accumulated Skills. |
| **Production triage** | Live logs & service APIs via MCP + SCM Source + Agent CLI | Reads live logs, calls service APIs through MCP, traces them to the code path that caused it — before anyone opens a dashboard. |

Read the **combinations**, not the titles. One works mostly in a checkout, one is
driven by a schedule, one leans on Skills, one on live systems over MCP. That spread —
one platform, different source mixes — is the general-purpose claim doing real work.
Widening it means strengthening the sources and the runtime beneath them (§4).

---

## 3. Versus traditional workflow platforms

| Dimension | Traditional workflow (Dify, n8n) | a2wave |
| :--- | :--- | :--- |
| **Logic** | Manual wiring and variable mapping | Natural-language Agent logic over explicitly attached resources |
| **Execution** | Static API calls or code blocks | Autonomous Agent with real file and shell capability |
| **Errors** | Fails and halts the flow | Agent self-reflects and repairs at the code level |
| **Data** | Strict variable passing between nodes | Agent-scoped workspace and conversation context |
| **Extension** | Limited to preset plugins | A2A Agents, Skills, and MCP Servers composed through their respective contracts |

---

## 4. Where the effort goes

The platform builds what **no local Agent can provide for itself**. That is the whole
filter. A request that a user could satisfy by asking the CLI on their laptop is not a
platform feature — at most it is missing machine-readable surface (a CLI command, an
API, a schema, a Skill), never a form.

**Invested in:**

* **Runtime** — queueing, concurrency, credential injection, workspace isolation
* **Observability** — Run records, execution traces, diagnosis, token spend, audit
* **Fault tolerance** — retry with backoff, ordered provider fallback chains, restart recovery
* **Skills & tools** — hosting, discovery, permissions, progressive disclosure for MCP
* **Channels** — every way an Agent gets called, under one authentication contract (§5)
* **Permissions & audit** — SSO, per-Agent owner/editor/viewer, an entry behind every write

**Not invested in:** configuration wizards, visual prompt editors, form-filling UI for
what an Agent can generate, drag-and-drop orchestration, or any convenience screen
that a local Agent makes unnecessary. Every surface is permanent cost — i18n, E2E,
design tokens, and a rewrite each time the underlying CLI moves.

The constructive corollary: **the console and the CLI go through the same API**, an
Agent is a YAML file that can be reviewed and diffed, and `a2wave setup` generates
`.env` and `docker-compose.yml` instead of asking anyone to click through a console.
Keeping that surface complete and documented is how the barrier actually comes down.

*(Full rule text: [Iron Rules](../AGENTS.md#product-identity--iron-rules).)*

---

## 5. Publish channels — the authentication contract

Adding a channel is ordinary work; there is no closed list. What is not negotiable is
what the old sign-off gate existed to protect — **no unauthenticated entry points.**
Every new channel must have:

| Requirement | Meaning |
| :--- | :--- |
| **Attributable caller** | Every invocation resolves to an identity — signed-in user, bound SSO identity, Agent API key, or the Agent owner for platform-initiated triggers. A channel that cannot attribute its caller does not ship. |
| **Own `trigger_source`** | Every run is recorded in `runs` under its own source, keeping channel traffic separable in history, statistics and audit. |
| **No ad-hoc credential store** | Credentials live in schema-managed fields that are masked on read, or in an external CLI's keyring — never a new bespoke store. |

This is the required product contract, but the implementation has one known gap:
REST and A2A still expose `publishAuthType = 'none'` / `a2aAuthType = 'none'`.
Those modes are unauthenticated and do **not** satisfy the attributable-caller rule.
Treat them as existing implementation debt, not as precedent for a new channel or an
authorization to expand anonymous access. Retiring them requires a separate,
migration-compatible product and code change.

Current: API / OAuth / A2A / Feishu / Slack / Discord / schedule / chat page / GitLab
trigger (`glab`) / GitHub trigger (`gh`).

Recorded boundary decisions are retained because they explain why the current
channels fit the product rather than merely listing that they exist:

| Channel | Decision |
| :--- | :--- |
| Slack / Discord | Approved by the maintainers as native authenticated chat channels. |
| Chat page (`chat_app`) | Approved as a first-party, session-authenticated surface; every turn creates a Run with `trigger_source = 'chat_app'`. |
| GitLab / GitHub triggers | Approved as inbound polling triggers. They expose no new internet endpoint, keep forge credentials in the vendor CLI, attribute fired Runs to the Agent owner, and audit them through `agent.git_trigger`. |

The two git triggers poll through the vendor CLI and start a Run only when a watched
merge/pull request actually moves — the deliberate contrast with `schedule`, which
fires unconditionally and spends tokens even when nothing changed. The comparison
happens *outside* the Agent, so an idle repository costs nothing.

---

## 6. Native chat connections — hard constraints

These match the production implementation and **must not be violated** when planning
features or reviewing requirements.

| Principle | Description |
| :--- | :--- |
| **One process, one App, one connection** | Within a single API process, a given Feishu / Slack / Discord App ID may hold only **one** active connection. |
| **No connection sharing** | Each connected Agent uses its own provider client. Never promise "one physical connection multiplexed across Agents" as a product capability — the semantics are **slot mutual exclusion**. |
| **First come, first served** | With several published Agents on the same App ID, the first to connect holds the slot; the rest must not connect, and **must not preempt the incumbent**. The slot frees only when the incumbent unpublishes or stops. |
| **One bot per Agent (recommended)** | Agents that must connect independently to the same platform each need their own provider app and credentials. |
| **Multi-replica** | Each API instance enforces the above independently; the same app may hold one connection per Pod. Single-connection-across-replicas is not guaranteed. |

Consequently, "Agent Diagnosis" connection state reflects **the current API process
only**. Requirements that contradict these principles — Agents sharing one provider
app while both receive messages, or a later starter preempting the incumbent — are not
included in the product plan.

Feishu files, Slack Files, and Discord Attachments may be downloaded into the Run's
local attachment context. Provider URLs are restricted to the platform allowlists;
the shared attachment policy enforces size and extension limits, and temporary files
are cleaned up after processing.

---

> **"Let every intent create a precise ripple in the ocean of Agents."**
