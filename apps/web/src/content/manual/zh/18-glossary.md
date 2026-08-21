# 术语表

按拼音/英文速查 a2wave 的核心术语。点击链接进入对应章节。

- **Agent** — 平台的核心编排单元，= 系统提示词 + Provider + 挂载能力 + 触发方式 + 成员。见 [Agent 管理](/wiki/agents)。
- **Provider（执行引擎）** — 底层 agent CLI 及其凭证（Claude Code / Cursor CLI / Codex CLI / OpenCode CLI / Qoder CLI / Trae CLI / Kimi Code CLI / Pi CLI），真正执行推理与代码。见 [Provider](/wiki/providers)。
- **authMode（凭证模式）** — Agent 注入凭证的方式：`apiKey` / `oauth` / `localSession`。见 [Provider](/wiki/providers)。
- **MCP Server** — 通过 Model Context Protocol 给 Agent 提供工具的服务，类型有 stdio / sse / http / group。见 [MCP Server](/wiki/mcp-servers)。
- **渐进式披露（progressive disclosure）** — group 类型 MCP 列举工具时只返回精简信息，按需再展开完整定义，降低上下文开销。见 [MCP Server](/wiki/mcp-servers)。
- **Skill（技能）** — 以 `SKILL.md` 描述的可复用能力包（流程/知识/模板）。见 [Skill](/wiki/skills)。
- **Skill 分组** — 对 Skill 的组织单位，可整组挂到 Agent。见 [Skill](/wiki/skills)。
- **SCM 代码源** — Agent 可读写的代码仓库（Git / P4）。见 [SCM 代码源](/wiki/scm-sources)。
- **Worktree（工作区）** — 为单次执行创建的隔离代码副本；清理策略 ephemeral / ttl / persistent。见 [SCM 代码源](/wiki/scm-sources)。
- **知识库** — 供 Agent 检索的文档集合（上传 / 飞书 docx、wiki）。见 [知识库](/wiki/knowledge-base)。
- **长期记忆（Memory）** — 平台自动维护的跨会话记忆（`MEMORY.md` + 每日日志 + 索引）。见 [长期记忆](/wiki/memory)。
- **Run** — 一次 Agent 执行记录，状态 pending/queued/running/completed/failed/cancelled。见 [运行记录](/wiki/runs)。
- **Run Step** — 一次 Run 内的执行步骤（多步任务）。见 [运行记录](/wiki/runs)。
- **产物（Artifacts）** — Run 中生成、可下载或在线分享的文件（网页 / Markdown / 目录）。见 [产物与在线分享](/wiki/artifacts)。
- **触发渠道（triggerSource）** — Run 的来源：debug / api / feishu / slack / discord / qq_official / a2a / schedule / oauth / chat_app。见 [触发方式](/wiki/triggers)。
- **Gateway（网关）** — 对外调用已发布 Agent 的 API 入口（`/api/gateway/...`）。见 [触发方式](/wiki/triggers)。
- **A2A** — Agent-to-Agent 协议，供外部 Agent 发现并调用本平台 Agent（JSON-RPC）。见 [触发方式](/wiki/triggers)。
- **系统提示词（System Prompt）** — Agent 的核心人设与规则，支持 Mustache 变量。见 [Agent 管理](/wiki/agents)。
- **评测集** — 一批评测用例的集合，用于反复验证同一个 Agent。见 [评测](/wiki/evaluation)。
- **评测用例** — 一段对话，含一到多轮「请求 + 期望应答」。见 [评测](/wiki/evaluation)。
- **评测任务** — 用 Agent 当前配置跑一遍评测集，并冻结 provider/模型/提示词快照。见 [评测](/wiki/evaluation)。
- **配置快照** — 评测任务留存的配置记录（provider + 模型 + 提示词，不含密钥），用于横向对比。见 [评测](/wiki/evaluation)。
- **成员角色** — owner / editor / viewer 三级权限。见 [成员管理](/wiki/members)。
- **铁律** — 定义产品边界的 6 条硬约束。见 [核心理念与架构](/wiki/concepts)。

## 相关

- [概览与导航](/wiki/overview) · [核心理念与架构](/wiki/concepts)
