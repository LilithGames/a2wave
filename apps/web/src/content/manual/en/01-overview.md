# Overview & Navigation

Welcome to the **a2wave** User Manual. a2wave is a general-purpose **Agent building and orchestration platform** for enterprises: you use it to turn "intent" into externally triggerable, auditable, and operable automated Agents. Under the hood it reuses mature agent CLIs such as Claude Code, OpenAI Codex, and Cursor Agent, and extends capabilities via Skill / MCP / Knowledge Base / memory.

This page is the entry point of the manual. The table of contents on the left lists all chapters; below are recommended reading paths organized by "what you want to do" and "who you are".

## How to Use This Manual

- **Opening the manual any time** → click your avatar at the bottom left and pick "User Manual" from the popup menu (just above "About").
- **First-time users** → start with [Getting Started](/wiki/getting-started), then read [Core Concepts & Architecture](/wiki/concepts) to build an overall understanding.
- **Looking up a specific feature** → click the corresponding chapter in the table of contents on the left.
- **Running into problems** → check the "Troubleshooting" section at the end of each chapter, or the [FAQ](/wiki/faq).
- **Unfamiliar with a term** → check the [Glossary](/wiki/glossary).

## Quick Lookup by Scenario

| I want to… | Read this chapter |
|--------|--------|
| Build and publish an Agent | [Agent Management](/wiki/agents) → [Provider Execution Engine](/wiki/providers) |
| Install an Agent CLI (first step on a new deployment) | [Provider Execution Engine · Install an Agent CLI](/wiki/providers) |
| Give an Agent tools / external system capabilities | [MCP Server](/wiki/mcp-servers) |
| Package a reusable workflow or knowledge for an Agent | [Skills](/wiki/skills) |
| Let an Agent read and write a code repository | [SCM Sources](/wiki/scm-sources) |
| Let an Agent retrieve enterprise documents | [Knowledge Base](/wiki/knowledge-base) |
| Let an Agent remember preferences and history across sessions | [Long-term Memory](/wiki/memory) |
| Verify whether a config change actually improved the Agent | [Evaluation](/wiki/evaluation) |
| Trigger an Agent via API / Feishu / A2A / scheduled | [Trigger Methods](/wiki/triggers) |
| Send images or files to an Agent | [Trigger Methods · Attachments](/wiki/triggers) |
| Collaborate with others to maintain the same Agent | [Member Management](/wiki/members) |
| View the input, output, and logs of each execution | [Runs](/wiki/runs) |
| Share an Agent's generated web page/report with others | [Artifacts & Online Sharing](/wiki/artifacts) |
| Choose a light, dark, or high-contrast interface | [Appearance & Themes](/wiki/appearance) |

## Quick Lookup by Role

- **Users / business stakeholders**: [Getting Started](/wiki/getting-started) → [Agent Management](/wiki/agents) → [Evaluation](/wiki/evaluation) → [Trigger Methods](/wiki/triggers) → [Runs](/wiki/runs)
- **Integration developers**: [Trigger Methods](/wiki/triggers) (includes real invocation examples for API / A2A / scheduled) → [Agent Management](/wiki/agents) (API Key) → [Runs](/wiki/runs) (polling and cancellation)
- **Administrators**: [Provider Execution Engine](/wiki/providers) (**install the Agent CLIs first**) → [MCP Server](/wiki/mcp-servers) (usage scope / stdio-exclusive) → [Member Management](/wiki/members) → [Long-term Memory](/wiki/memory) (persistent volume)

## Product Boundary (in one sentence)

a2wave only does **orchestration**, not execution: it is responsible for creating, configuring, triggering, and monitoring Agents, while the actual reasoning and code execution are handled by the underlying agent CLIs. See [Core Concepts & Architecture](/wiki/concepts) for details.

## An Important Premise: Built for a Trusted Internal Team

a2wave is an Agent platform for **internal enterprise teams**. A core premise is that **the people who create Agents and the people who use them are all trusted colleagues, working to get their jobs done more efficiently**.

That is exactly why the platform gives Agents real execution power (reading/writing files, running commands, injected credentials) and encourages you to freely compose Skills, MCP, SCM sources, and knowledge bases to extend them — rather than walling authors off from one another behind layers of defense.

> [!IMPORTANT]
> The platform's login authentication, [member permissions](/wiki/members) (owner / editor / viewer), [run](/wiki/runs) audit trail, and rate limiting exist to enforce **clear accountability and least-privilege access among cooperating colleagues** — **not** to defend against a malicious insider, and not on the assumption that untrusted Agent configurations will be run. If you need to open a2wave up to untrusted users, add your own isolation layer.
