# Core Concepts & Architecture

Understanding a2wave's design orientation helps you decide "how a given requirement should be realized on the platform". This chapter explains what the platform is, how data flows, how the concepts fit together, and the product boundaries that must not be crossed.

## In One Sentence: Orchestrate, Don't Execute

a2wave is the **orchestration layer**. It is responsible for creating, configuring, triggering, and monitoring Agents; the actual reasoning and code execution are delegated to the underlying mature agent CLIs (Claude Code / Cursor Agent / OpenAI Codex). The platform **does not build its own** LLM inference, code execution, or sandbox runtime.

This leads to a direct corollary: **without a configured, available [Provider](/wiki/providers), an Agent cannot run** — because all execution capability comes from the CLI behind the Provider.

## Overall Data Flow

```
Trigger (API / Feishu / A2A / scheduled)
        │
        ▼
      Agent  ──reads──▶  System prompt + Skill + MCP + Knowledge Base + Memory
        │
        ▼
   Provider (spawns the underlying CLI subprocess to execute)
        │
        ▼
      Run (records input / output / logs) ──▶  Artifacts
```

Every trigger generates a [Run](/wiki/runs). Regardless of which channel it comes from, the execution path is identical — only the `triggerSource` differs.

## How the Core Concepts Fit Together

| Concept | Role | Relationship |
|------|------|------|
| **Agent** | Orchestration unit | References a Provider; mounts Skill / MCP / SCM Source / Knowledge Base; configures triggers and members |
| **Provider** | Execution engine + credentials | Decides which CLI and model to execute with; referenced by multiple Agents |
| **Skill** | Reusable capability package | Describes a workflow/knowledge via `SKILL.md`, mounted onto an Agent |
| **MCP Server** | Tool source | Provides callable tools to an Agent via the MCP protocol |
| **SCM Source** | Code workspace | Agent reads and writes the repository in an isolated worktree |
| **Knowledge Base** | Retrievable documents | Injects relevant content into the context when a Run starts |
| **Long-term Memory** | Cross-session memory | The platform automatically writes logs/insights, injects them at startup + retrieves them on demand |
| **Run / Artifacts** | Execution record | Auditable input, output, logs, and generated files |

> [!TIP]
> Selection mnemonic: use [MCP](/wiki/mcp-servers) to call external systems/tools; use [Skill](/wiki/skills) to package a workflow or knowledge; use the [Knowledge Base](/wiki/knowledge-base) for retrievable factual material; use [Long-term Memory](/wiki/memory) for cross-session preferences and history.

## The Six Iron Rules

These are the platform's hard boundaries; no feature will ever cross them — understanding them helps you avoid detours:

| # | Iron Rule | What It Means for You |
|---|------|-----------|
| 1 | **Orchestrate, don't execute** | The platform doesn't run models/code; capability comes from the underlying CLIs |
| 2 | **Extend through composition** | New capabilities come from combining Skill + MCP, not hardcoding into the platform |
| 3 | **Natural-language-driven** | Agents are configured through prompts and intent; no drag-and-drop DAG |
| 4 | **Agent autonomy** | The platform doesn't intervene in runtime reasoning/tool decisions; no "step approval" checkpoints |
| 5 | **Enterprise-grade first** | Authentication, rate limiting, and auditing are hard requirements; anonymous invocation is not supported. The goal is accountability and least privilege among trusted colleagues, not defense against a malicious insider |
| 6 | **Your local Agent lowers the barrier, not another screen** | Anything you can ask Claude Code / Codex / Cursor Agent on your own machine to do — write a prompt, fill in a config, generate Agent YAML, drive the CLI — the platform won't wrap in a wizard. It invests instead in what only the platform can give you: runtime, run records and diagnosis, fault tolerance, channels, permissions and audit |

## Related

- [Getting Started](/wiki/getting-started) · [Agent Management](/wiki/agents) · [Trigger Methods](/wiki/triggers) · [Glossary](/wiki/glossary)
