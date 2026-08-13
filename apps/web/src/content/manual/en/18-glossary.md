# Glossary

Quick reference of a2wave's core terms. Click a link to go to the corresponding chapter.

- **Agent** — the platform's core orchestration unit, = system prompt + Provider + mounted capabilities + trigger methods + members. See [Agent Management](/wiki/agents).
- **Provider (execution engine)** — the underlying agent CLI and its credentials (Claude Code / Cursor CLI / Codex CLI / OpenCode CLI / Qoder CLI / Trae CLI / Kimi Code CLI / Pi CLI), which actually run inference and code. See [Provider](/wiki/providers).
- **authMode (credential mode)** — the way the Agent injects credentials: `apiKey` / `oauth` / `localSession`. See [Provider](/wiki/providers).
- **MCP Server** — a service that provides tools to the Agent via the Model Context Protocol, of types stdio / sse / http / group. See [MCP Server](/wiki/mcp-servers).
- **Progressive disclosure** — when a group-type MCP lists tools, it returns only concise info and expands the full definition on demand, lowering context overhead. See [MCP Server](/wiki/mcp-servers).
- **Skill** — a reusable capability package (process/knowledge/template) described by `SKILL.md`. See [Skill](/wiki/skills).
- **Skill group** — an organizational unit for Skills, which can be mounted onto an Agent as a whole group. See [Skill](/wiki/skills).
- **SCM Source** — a code repository the Agent can read and write (Git / P4). See [SCM Source](/wiki/scm-sources).
- **Worktree (workspace)** — an isolated code copy created for a single execution; cleanup policies ephemeral / ttl / persistent. See [SCM Source](/wiki/scm-sources).
- **Knowledge Base** — a document collection for the Agent to retrieve from (upload / Feishu docx, wiki). See [Knowledge Base](/wiki/knowledge-base).
- **Long-Term Memory (Memory)** — cross-session memory maintained automatically by the platform (`MEMORY.md` + daily logs + index). See [Long-Term Memory](/wiki/memory).
- **Run** — a single Agent execution record, with states pending/queued/running/completed/failed/cancelled. See [Runs](/wiki/runs).
- **Run Step** — an execution step within a single Run (multi-step tasks). See [Runs](/wiki/runs).
- **Artifacts** — files generated during a Run that can be downloaded or shared online (web page / Markdown / directory). See [Artifacts & Online Sharing](/wiki/artifacts).
- **Trigger source (triggerSource)** — a Run's origin: debug / api / feishu / slack / discord / a2a / schedule / oauth / chat_app. See [Trigger Methods](/wiki/triggers).
- **Gateway** — the API entry point for externally invoking published Agents (`/api/gateway/...`). See [Trigger Methods](/wiki/triggers).
- **A2A** — the Agent-to-Agent protocol, for external Agents to discover and invoke this platform's Agents (JSON-RPC). See [Trigger Methods](/wiki/triggers).
- **System Prompt** — the Agent's core persona and rules, supporting Mustache variables. See [Agent Management](/wiki/agents).
- **Evaluation set** — a collection of evaluation cases used to repeatedly test one Agent. See [Evaluation](/wiki/evaluation).
- **Evaluation case** — one conversation of one or more request + expected-reply turns. See [Evaluation](/wiki/evaluation).
- **Evaluation task** — one replay of a set against the Agent's current config, freezing a provider/model/prompt snapshot. See [Evaluation](/wiki/evaluation).
- **Config snapshot** — the configuration a task recorded (provider + model + prompt, never credentials), used for comparison. See [Evaluation](/wiki/evaluation).
- **Member roles** — the three permission levels owner / editor / viewer. See [Member Management](/wiki/members).
- **Iron Rules** — the 6 hard constraints defining the product boundary. See [Core Concepts & Architecture](/wiki/concepts).

## Related

- [Overview & Navigation](/wiki/overview) · [Core Concepts & Architecture](/wiki/concepts)
