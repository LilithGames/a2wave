# 概览与导航

欢迎使用 **a2wave** 使用手册。a2wave 是面向企业的通用 **Agent 搭建与编排平台**：你用它把「意图」变成可被外部触发、可审计、可运维的自动化 Agent，底层复用 Claude Code、OpenAI Codex、Cursor Agent 等成熟 agent CLI，通过 Skill / MCP / 知识库 / 记忆扩展能力。

本页是手册的入口。左侧目录是完整章节列表；下面按「你想做什么」和「你是谁」给出推荐阅读路径。

## 如何使用本手册

- **随时打开手册** → 点左下角你的头像，在弹出菜单里选「使用手册」（位于「关于」上方）。
- **第一次用** → 先读 [快速开始](/wiki/getting-started)，再读 [核心理念与架构](/wiki/concepts) 建立整体认知。
- **查具体功能** → 直接点左侧目录对应章节。
- **遇到问题** → 看各章末尾的「排错」小节，或 [常见问题](/wiki/faq)。
- **不懂术语** → 查 [术语表](/wiki/glossary)。

## 按场景速查

| 我想…… | 看这章 |
|--------|--------|
| 搭一个 Agent 并发布 | [Agent 管理](/wiki/agents) → [Provider 执行引擎](/wiki/providers) |
| 安装 Agent CLI（新部署第一步） | [Provider 执行引擎 · 安装 Agent CLI](/wiki/providers) |
| 给 Agent 加工具 / 外部系统能力 | [MCP Server](/wiki/mcp-servers) |
| 给 Agent 封装可复用的流程或知识 | [Skill 技能](/wiki/skills) |
| 让 Agent 读写代码仓库 | [SCM 代码源](/wiki/scm-sources) |
| 让 Agent 检索企业资料 | [知识库](/wiki/knowledge-base) |
| 让 Agent 跨会话记住偏好与历史 | [长期记忆](/wiki/memory) |
| 验证改了配置之后 Agent 有没有变好 | [评测](/wiki/evaluation) |
| 用 API / 飞书 / A2A / 定时 触发 Agent | [触发方式](/wiki/triggers) |
| 给 Agent 发图片或文件 | [触发方式 · 附件](/wiki/triggers) |
| 多人协作维护同一个 Agent | [成员管理](/wiki/members) |
| 查看每次执行的输入输出与日志 | [运行记录](/wiki/runs) |
| 把 Agent 产出的网页/报告分享给别人看 | [产物与在线分享](/wiki/artifacts) |
| 调整浅色、深色或高对比界面 | [外观与主题](/wiki/appearance) |

## 按角色速查

- **使用者 / 业务方**：[快速开始](/wiki/getting-started) → [Agent 管理](/wiki/agents) → [评测](/wiki/evaluation) → [触发方式](/wiki/triggers) → [运行记录](/wiki/runs)
- **集成开发者**：[触发方式](/wiki/triggers)（含 API / A2A / 定时 的真实调用示例）→ [Agent 管理](/wiki/agents)（API Key）→ [运行记录](/wiki/runs)（轮询与取消）
- **管理员**：[Provider 执行引擎](/wiki/providers)（**先安装 Agent CLI**）→ [MCP Server](/wiki/mcp-servers)（使用范围 / stdio 专属）→ [成员管理](/wiki/members) → [长期记忆](/wiki/memory)（持久卷）

## 产品边界（一句话）

a2wave 只做 **编排**，不做执行：它负责创建、配置、触发、监控 Agent，真正的推理与代码执行由底层 agent CLI 完成。详见 [核心理念与架构](/wiki/concepts)。

## 一个重要前提：面向可信的内部团队

a2wave 是**企业内部团队**使用的 Agent 平台。它的一个基本前提是：**创建 Agent 的人和使用 Agent 的人都是可信的同事，都是为了把工作做得更高效**。

正因为如此，平台会赋予 Agent 真实的执行能力（读写文件、执行命令、注入凭据），并鼓励你自由组合 Skill、MCP、代码源、知识库来扩展它——而不是把作者之间相互隔离、层层设防。

> [!IMPORTANT]
> 平台的登录鉴权、[成员权限](/wiki/members)（所有者 / 编辑者 / 查看者）、[运行记录](/wiki/runs)审计、限流等机制，是用来在**协作同事之间落实"权责清晰、按需授权"**的，而**不是**用来防范恶意内部人员、也不假定要运行不可信的 Agent 配置。若你需要把 a2wave 开放给不可信用户，请自行叠加额外的隔离手段。
