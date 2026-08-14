<div align="center">

<img src="https://raw.githubusercontent.com/LilithGames/a2wave/main/apps/web/public/brand-icons/default.svg" alt="a2wave" width="72" height="72" />

# a2wave

**把你已经在用的 Agent CLI，变成整个团队都能调用的共享服务。**

用自然语言描述一个 Agent，绑定模型 Provider，发布到飞书、Slack、Discord、HTTP API
或定时任务。不画流程图，不写胶水代码。

[![CI](https://github.com/LilithGames/a2wave/actions/workflows/ci.yml/badge.svg)](https://github.com/LilithGames/a2wave/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

[核心概念](./docs/core-concepts.md) · [项目指南](./AGENTS.md) · [贡献指南](./CONTRIBUTING.md) · [安全策略](./SECURITY.md)

[English](./README.md) | **简体中文**

</div>

## a2wave 是什么

a2wave 把你已经在用的 Agent CLI——**Claude Code、Cursor Agent、OpenAI Codex 等**——变成
受治理的共享服务，可从飞书、Slack、Discord、HTTP API 或定时任务直接触达。

用自然语言描述一个 Agent，绑定模型 Provider，用 Skills 和 MCP Server 扩展能力，然后发布。
凭证注入、运行排队、审计留痕、权限控制和消息投递，都交给 a2wave。

**a2wave 只做编排，不做执行。** 不内置 LLM 推理、不内置沙箱运行时、也没有拖拽式 DAG
编辑器——执行能力来自底层 CLI，编排用自然语言表达。这些边界是强制约束的，详见
[产品铁律](./AGENTS.md#product-identity--iron-rules)。

### 和其他方案的区别

|  | a2wave | 工作流编排（n8n、Dify、Flowise） | 裸用 Agent CLI |
|---|---|---|---|
| **逻辑怎么表达** | 自然语言 | 节点、连线、变量映射 | 自然语言 |
| **谁能用** | 整个团队，从他们本来就在用的渠道 | 谁打开编辑器谁用 | 谁有终端谁用 |
| **模型执行** | 你现有的 CLI + 你自己的凭证 | 厂商托管的运行时 | 仅本地 |
| **治理能力** | 按 Agent 的权限、审计留痕、运行排队 | 视产品而定 | 无 |

如果你的团队已经在用某个 Agent CLI，需要的是把它**共享出去**——带上权限控制、审计留痕，
并投递到飞书或 Slack——而不是把它的推理过程重画成一张图，那 a2wave 就是合适的选择。

## 核心能力

- 🤖 **自带 Agent CLI** —— Claude Code、Cursor Agent、OpenAI Codex、OpenCode、Qoder、
  Trae、Kimi、Pi 均可作为可互换的执行引擎，按需从锁定并校验哈希的 lockfile 安装。
- 🌊 **一次发布，多渠道触达** —— 同一个 Agent 可通过 HTTP API、飞书、Slack、Discord、
  A2A 协议、定时任务、GitLab / GitHub 仓库触发和平台自建聊天页触达。
- 🧩 **以组合方式扩展** —— 通过 Skills 与 MCP Server（stdio / SSE / HTTP / 代理分组）
  增加能力，而不是 fork 平台本身。
- 🔗 **Agent 之间互相调用** —— 基于 A2A 协议调用其他 Agent，包括部署在你的实例之外的。
- 📚 **持久化记忆** —— 按 Agent 隔离，支持渐进式披露与关键词、向量、混合检索。
- 🧪 **内置评测** —— 用整理好的用例集回放当前 Agent 配置，并冻结 provider / 模型 /
  提示词快照，保证对比公平。
- 📦 **Git 与 Perforce 工作区** —— Agent 在真实检出上工作，评测运行获得隔离的 worktree。
- 🔐 **企业级认证** —— OIDC 与 SAML 单点登录、按 Agent 的 owner/editor/viewer 权限、
  限流，以及每一次写操作背后的审计记录。

## 信任模型

a2wave 面向**企业内部团队**设计，假设创建 Agent 的人与使用 Agent 的人，都是**善意行事、
值得信任的同事**。

这一假设塑造了产品边界。Agent 运行的底层 CLI *在设计上*就拥有真实能力：文件系统访问、
Shell 执行、注入的凭证。平台刻意**不**在作者之间做沙箱隔离，也不防御精心构造恶意 Agent
的内部攻击者。认证、按 Agent 划分的权限、审计日志、限流这些控制，是为了在协作的同事之间
落实**问责与最小权限**，而不是围堵已在信任边界内部的对手。

> [!IMPORTANT]
> 把 a2wave 暴露给不可信用户，或运行不可信的 Agent 配置，超出当前设计范围——请自行添加
> 隔离层。完整说明见 [SECURITY.md](./SECURITY.md)。

## 快速开始（CLI）

自动拉取已发布的镜像，生成 `docker-compose.yml` 与 `.env`，启动容器并等待健康检查通过
—— 无需克隆仓库，也无需自行构建：

```bash
npm i -g a2wave
a2wave setup
```

如需同时部署内置 PostgreSQL 容器：

```bash
a2wave setup \
  --yes \
  --with-postgres \
  --dir "$HOME/a2wave-pg" \
  --port 3512
```

CLI 会自动选择与自身版本一致的版本化镜像。升级时应继续使用同一个安装目录：版本号属于
CLI 和镜像，不应写进 `$HOME/a2wave-pg`。PostgreSQL 目前仍是实验性功能，生产环境使用前请先阅读
[数据库后端](#数据库后端)。

生成的部署会包含独立的 `a2wave-workspace` 命名卷。新建 Git 代码源时，a2wave 会自动在该卷中
分配托管路径，无需进入容器创建或猜测目录。P4 代码源则必须填写已挂载的绝对路径，并确保该路径
被现有 P4 Client 的 `Root` 或 `AltRoots` 覆盖。

> [!NOTE]
> PostgreSQL 部署参数是在 CLI v0.7.2 之后加入的，已发布的 `a2wave@0.7.2` 包中并不包含。
> 执行上述命令前，请先确认 `a2wave setup --help` 已列出 `--with-postgres`。

## 快速开始（Docker）

从仓库克隆并自行构建镜像：

```bash
cp .env.example .env       # 开箱即用，无需修改
docker compose up -d --build
```

或直接使用已发布的镜像：

```bash
docker pull ghcr.io/lilithgames/a2wave:latest
```

访问 **http://localhost:3502**，然后创建 Agent、绑定模型 Provider 并发布。应用内手册
`/wiki` 有完整的第一个 Agent 上手流程。

> 如果 `ADMIN_PASSWORD` 留空，谁先打开 setup 页面谁就拿到 admin 账号。在 `.env` 中设置
> 它可以关闭这个窗口。

> [!IMPORTANT]
> **macOS 用户**请先把以下配置加入 `.env`。`/data/workspace` 不在 Docker Desktop 默认
> 共享的宿主机路径中，因此需要改为用户目录下的路径；同时固定容器 UID/GID，避免 VirtioFS
> 将宿主机 bind mount 报告为 root 所有。
>
> ```bash
> A2WAVE_WORKSPACE_DIR=$HOME/a2wave-workspace
> A2WAVE_RUN_AS_UID=10001
> A2WAVE_RUN_AS_GID=10001
> ```

所有配置项都有可用默认值，完整列表见 [`.env.example`](./.env.example)，逐项说明见
[配置说明](./docs/agent/configuration.md)。

## 本地开发

需要 **Node.js ≥ 22**（与镜像的 `node:22-slim` 运行时一致）和 **pnpm ≥ 9**。

```bash
pnpm install
cp .env.example .env       # AUTH_SECRET 留空，pnpm dev 会自动生成
pnpm dev                   # API :3502 + Web :3501
pnpm stop                  # 上次运行留下孤儿进程占用端口时用它释放
```

更多开发指南、API 文档与数据库操作见 [AGENTS.md](./AGENTS.md)。
CLI 的安装、升级与发布见 [CLI 安装与发布](./docs/agent/cli-install-publish.md)。

## 数据库后端

后端仅由 `DATABASE_URL` 决定：`postgres://` 协议表示 PostgreSQL，其他一律当作 SQLite
文件路径。

**SQLite（默认，官方支持）** —— 无需任何配置，上面的快速开始即是单容器部署，数据库位于
命名卷上。

**PostgreSQL ≥ 9.6（实验性）** —— 用 `postgres` profile 启动，它会带上内置的数据库容器：

```bash
# PostgreSQL 下 AUTH_SECRET 必填。请生成后追加，不要把命令本身当作值粘贴进去：
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
echo "DATABASE_URL=postgres://a2wave:a2wave@postgres:5432/a2wave" >> .env

docker compose --profile postgres up -d
```

迁移在启动时自动执行并选择对应的迁移谱系；API 会先等待数据库健康检查通过，冷启动是安全
的。数据库端口不会发布到宿主机——本地试用之外的场景请先修改 `POSTGRES_PASSWORD`。

> [!IMPORTANT]
> URL 里的 `postgres` 是 **compose 服务名**，只在 compose 网络内可解析。宿主机上运行的
> 命令（`pnpm dev`、`pnpm db:migrate`）读的是同一份 `.env`，会解析失败。若要让容器内的
> PostgreSQL 与本地 SQLite 并存，请把 `DATABASE_URL` 移出 `.env`，改为按命令传入——见
> [docs/agent/postgresql.md](./docs/agent/postgresql.md#running-docker-postgresql-alongside-a-local-sqlite-instance)。

> [!WARNING]
> PostgreSQL 目前是**实验性**的，尚不推荐用于生产：它能通过完整测试套件与端到端冒烟测试，
> 但没有生产环境的长期验证。**不存在 SQLite → PostgreSQL 的数据迁移路径**——切换意味着从
> 空数据库开始。它面向多实例部署，因为单个 SQLite 文件无法被安全共享。详细说明（含多副本
> 时的进程内缓存注意事项）见 [docs/agent/postgresql.md](./docs/agent/postgresql.md)。

## 发布渠道

已发布的 Agent 可通过 HTTP API、飞书、Slack、Discord、A2A 协议、定时任务、
GitLab / GitHub 仓库触发，以及平台自建的聊天页触达。

> 飞书渠道目前支持飞书（feishu.cn）应用；Lark 国际版（larksuite.com）暂不可配置。

## 文档

| 文档 | 内容 |
|------|------|
| [核心概念](./docs/core-concepts.md) | Agent、Provider、Skill、MCP Server、代码源、Run、评测 |
| [配置说明](./docs/agent/configuration.md) | 全部环境变量与 Settings 覆盖项 |
| [项目指南](./AGENTS.md) | 架构、完整 API 参考、测试策略、开发约定 |
| [CLI 安装与发布](./docs/agent/cli-install-publish.md) | `a2wave` CLI 的安装、升级与发布流程 |
| [贡献指南](./CONTRIBUTING.md) | 开发环境、提交约定、质量门禁、AI 贡献政策 |
| [安全策略](./SECURITY.md) | 信任模型与漏洞披露流程 |

服务运行后还提供交互式 API 参考（`/api/docs`，Swagger UI）与应用内用户手册（`/wiki`）。

## 用 AI 构建

a2wave 自身就是大量使用 AI 编码 Agent 构建的——对于一个 Agent 编排平台来说，这是最贴切的
建设方式。每一个变更都要经过完整的测试金字塔（单元 / 集成 / E2E）、强制的 lint 与
typecheck 门禁，以及人工评审。AI 辅助的贡献以同样的标准欢迎，详见
[AI 贡献政策](./CONTRIBUTING.md#ai-contribution-policy)。

## 参与贡献

欢迎提 issue、参与讨论与提交 PR。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)——其中包含
开发环境搭建、提交信息约定、质量门禁与 AI 贡献政策。注意 a2wave 有明确的产品边界
（[AGENTS.md](./AGENTS.md) 中的产品铁律），越界的特性需要先与维护者讨论。参与本项目即表示
你同意遵守[行为准则](./CODE_OF_CONDUCT.md)。

> [!WARNING]
> 请**不要**通过公开 issue 或 PR 报告安全漏洞——按 [SECURITY.md](./SECURITY.md) 的流程
> 私下披露。

## 贡献者

感谢每一位为 a2wave 做出贡献的伙伴——完整名单见
[贡献者图谱](https://github.com/LilithGames/a2wave/graphs/contributors)。

## 开源协议

基于 [Apache License 2.0](./LICENSE) 授权。Copyright 2026 Lilith Games——署名与随附的
第三方材料见 [NOTICE](./NOTICE)。
