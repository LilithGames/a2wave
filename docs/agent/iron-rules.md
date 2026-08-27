# Product Identity, Trust Model & Iron Rules

## Product identity

a2wave is a general-purpose Agent building and orchestration platform for
enterprises. It builds on mature agent CLIs such as Claude Code / OpenAI Codex /
Cursor Agent, extends capabilities via Skills and MCP Servers, and publishes
Agents over API / Feishu / Slack / Discord / A2A / scheduled / chat page / GitLab
repository trigger / GitHub repository trigger.

**The goal: a business team can build a general-purpose business Agent** — not a
pipeline hardcoded for one scenario, but a reusable, composable digital worker
callable from the channels the team already uses. Generality comes from
*combining information sources* — a code checkout, Skills and Memory, live systems
over MCP — never from a single one of them. The platform makes each source
reliable to attach and dependable to run against; what to do with them is the
Agent's decision. See [docs/PRODUCT.md](../PRODUCT.md).

## Trust model — an internal enterprise team

a2wave assumes **Agent authors and Agent users are all trusted colleagues acting
in good faith**. Agents run the underlying CLIs with real capabilities
(filesystem, shell, injected credentials) *by design*; the platform does not
sandbox trusted authors from each other, nor defend against a malicious insider
deliberately building a hostile Agent.

Security controls — authentication, per-Agent owner/editor/viewer permissions,
audit logging, rate limiting, per-run credential injection — enforce
**accountability and least privilege among cooperating teammates**, not
containment of an adversary inside the trust boundary.

**What this means when working in this repo:** do not file, "fix", or harden
against threats that only arise from a hostile authenticated author — that is
outside the design, and such changes add complexity while protecting nobody. This
does *not* relax the controls that do apply: never skip authentication, never
allow anonymous invocation, never drop an audit entry, and never put credentials
in `details` (Iron Rule 5). Deployments exposing a2wave to untrusted users must add
their own isolation layer.

Full statement: [SECURITY.md](../../SECURITY.md) · [docs/PRODUCT.md](../PRODUCT.md)

## Iron Rules

Every new feature must be checked against these first.

| # | Iron Rule | Description |
|---|------|------|
| 1 | **Orchestrate, don't execute** | a2wave is the orchestration layer; execution capability comes from the underlying agent CLIs (Claude Code/Codex/Cursor). Do not build our own LLM inference, code execution, or sandbox runtime. |
| 2 | **Extend through composition** | New capabilities are delivered by combining Skills + MCP Servers, not by hardcoding business logic into the platform core. If a feature can be solved with a Skill or MCP, it should not become a built-in platform feature. |
| 3 | **Natural-language-driven, not flow-driven** | Agents are configured and orchestrated in natural language — prompts, intents, and A2A messages. No drag-and-drop DAG editor, no traditional workflow primitives like variable mapping or conditional branches. |
| 4 | **Agent autonomy — the platform does not intervene in execution details** | The platform creates, configures, triggers, and monitors Agents; it does not interfere with an Agent's runtime reasoning or tool-call decisions. No "step approval", "manual checkpoints", or other flow controls that break Agent autonomy. |
| 5 | **Enterprise-grade constraints, scoped by the trust model** | Security (AUTH_SECRET, rate limiting), auditability (Run records; for background work that deliberately writes none, an equivalent audit-log entry — see Evaluation), and operability (health checks, logs) are hard requirements. Never sacrifice infrastructure for "quick trial" experiences. No anonymous invocation; never skip authentication. But the goal is **accountability and least privilege among trusted colleagues** (see the trust model above), *not* containment of a hostile insider — do not harden against threats that only a malicious authenticated author could pose. |
| 6 | **The barrier is lowered by the user's own local Agent, not by our UI** | Our users already run Claude Code, Codex, or Cursor Agent on their own machines. Anything they can accomplish by asking *that* Agent — writing a prompt, filling in a config, generating an Agent YAML, driving the CLI or API — does not earn a platform screen. The platform's effort concentrates on what no local Agent can provide: runtime, observability, fault tolerance, Skill and tool hosting, channels, permissions and audit. |

> **For feature requests that violate the Iron Rules, contact the maintainers for
> confirmation before proceeding.**

## Applying Rule 6

Rules 1–5 constrain a feature's *shape*; Rule 6 constrains where effort goes, since
a convenience screen can satisfy all five and still only add weight. Ask of a
request: **could the user get this by asking the Agent on their laptop?**

| Answer | Verdict | Examples |
|---|---|---|
| **Yes** | No new screen. What may be missing is machine-readable surface — a CLI command, API, schema or Skill — never a form. | Visual prompt editor, Skill-binding wizard, MCP parameter form, config generator |
| **No — only the platform has the information** | Build it. | Run failure cause, execution traces, token spend, diagnosis, audit trail |
| **No — only the platform has the capability** | Build it. | Runtime and queueing, retry and fallback, credential injection, permissions, channels, Skill/MCP hosting |

Hence: console and CLI share one API, an Agent is reviewable/diffable YAML, and
`a2wave setup` writes `.env` and `docker-compose.yml` instead of demanding clicks.
The answer to "users can't figure this out" is a better CLI, API and docs for their
Agent to read. Rule 6 governs what is *added* — retiring an existing surface is its
own change, with its own review.
