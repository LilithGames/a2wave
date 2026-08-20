# 快速开始

本章带你在几分钟内跑通「创建 → 配置 → 发布 → 触发 → 观察」的完整闭环。开始前先理解一句话：**a2wave 是编排层，不自带模型**——你必须先配好 [Provider](/wiki/providers)（底层执行引擎）才能让 Agent 真正运行。

## 登录

全新部署若未设置 `ADMIN_PASSWORD`，首次打开平台地址会进入初始化页，直接设置管理员密码即可，不需要额外的验证码。

```bash
curl -X POST http://localhost:3502/api/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"password":"<强密码>","confirmPassword":"<强密码>"}'
```

> [!WARNING]
> 初始化接口在管理员密码设置前是**不鉴权**的：谁先完成初始化，谁就是管理员。请在部署后立即完成初始化；若实例可被他人访问，建议直接用 `ADMIN_PASSWORD` 环境变量部署，跳过这个窗口。

- **密码登录**：用管理员初始化时设置的账号登录（受系统设置 `passwordLoginEnabled` 控制）。
- **企业 SSO**：管理员配置好 **OIDC** 或 **SAML** 后，Web 登录页会出现对应的登录按钮。OAuth 调用渠道复用 OIDC 配置；A2A 使用 Agent 独立的 A2A API Key，不接受该 OIDC JWT。

管理员可在「设置 → 企业登录」查看两种方式的生效状态，并用面板里的「测试」按钮验证连通性。页面只展示配置状态与非敏感摘要，不展示任何密钥内容。

> [!IMPORTANT]
> a2wave 是企业级平台：**不支持匿名调用、不跳过认证**。

### 在命令行登录

先告诉 CLI 你的实例地址，再登录：

```bash
a2wave config set-url https://a2wave.example.com
a2wave login
```

在本机，`a2wave login` 会直接拉起浏览器完成 SSO。

**在远程机器上**（SSH、容器、CI）没有可用的浏览器，`a2wave login` 会自动改用**设备码登录**：终端显示一个验证码，你在任意一台已登录 a2wave 的机器上打开提示的页面，输入验证码并确认，终端就会自动完成登录。

```
  Open this page:  https://a2wave.example.com/device
  Enter this code: WDJB-MJHT

  Waiting for approval… (Ctrl-C to cancel)
```

容器与 CI 不会被自动识别，可以显式指定：`a2wave login --device`。

> [!WARNING]
> **绝不要批准别人发给你的验证码。** 批准即代表那台设备可以用你的身份登录。确认页会显示发起登录的 IP、客户端和时间——只有当这次登录确实是你自己发起的，才点批准。验证码 10 分钟内有效，且只能使用一次。

### 用命令行令牌登录（CI / 无人值守）

设备码登录需要有人点一下批准，CI 里没有人。这种场景用**命令行令牌**：在「设置 → CLI 访问」里创建一个，起个名字（比如 `CI runner`），选好有效期，复制下来。

> [!WARNING]
> **令牌只显示这一次**，关掉就再也拿不到了。请立刻存进你的密钥管理里。

```bash
a2wave config set-url https://a2wave.example.com
a2wave login --token a2wc_xxxxxxxxxxxx
```

令牌拥有**创建者的全部权限**，不能单独缩小范围（唯一的例外：令牌不能用来再创建令牌，那需要真正登录）。所以建议**一台机器 / 一个任务一个令牌**——万一泄漏，只删掉那一个就行，不影响其他地方。

> [!IMPORTANT]
> 管理员创建的令牌会继承管理员权限，包括重置他人密码。给自动化用的令牌，建议用普通账号创建。

在同一个页面可以看到每个令牌的**最近使用时间**，据此判断哪些已经没人用了，可以删掉。删除立即生效。

## 五分钟上手

1. **配置 Provider**：进入「Providers」，在预设的 **Claude Code / Cursor CLI / Codex CLI / OpenCode CLI / Qoder CLI / Trae CLI / Kimi Code CLI / Pi CLI** 中选一个。凭证与模型配置在 Agent 上：填入凭证（API Key 或 OAuth，或使用服务器登录态）后点「拉取模型」并选择。详见 [Provider 执行引擎](/wiki/providers)。
2. **创建 Agent**：进入「Agents」→「新建 Agent」，选择「空白创建」或合适的场景模板。模板会预填名称、提示词和部分安全默认值，但凭证始终为空；确认 Provider、模型及所需能力后保存。
3. **挂载能力（可选）**：按需挂载 [Skill](/wiki/skills)、[MCP Server](/wiki/mcp-servers)、[代码源](/wiki/scm-sources)、[知识库](/wiki/knowledge-base)；需要跨会话记忆就开启 [长期记忆](/wiki/memory)。
4. **先调试**：在 Agent 详情页用 **Chat 调试**，无需对外触发即可验证提示词与能力是否符合预期。
5. **配置触发并发布**：在「渠道」区选择 [触发方式](/wiki/triggers)（API / 飞书 / A2A / 定时）中的一种或多种，点击 **发布**。
6. **观察运行**：每次触发都会生成一条 Run，在 [运行记录](/wiki/runs) 查看输入、输出、日志与产物。

## 一个最小可用示例

目标：做一个「收到一句话就回复」的 Agent，并用 API 调用它。

1. 配好 Claude Code Provider（填 API Key，启用 `claude-opus-4-8`）。
2. 新建 Agent「Echo 助手」，系统提示词写「你是一个简洁的助手，直接回答用户问题」。
3. 发布渠道勾选 **API**，认证选 **API Key**，发布后在详情页复制 Agent ID 与 API Key。
4. 调用（详见 [触发方式 · API](/wiki/triggers)）：

```bash
curl -X POST "https://<your-host>/api/gateway/<agentId>/invoke" \
  -H "Authorization: Bearer <apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","async":false}'
```

返回 `{"data":{"reply":"...","runId":"run_...","durationMs":1234}}`。

## 接下来

- 想理解平台为什么这么设计 → [核心理念与架构](/wiki/concepts)
- 想系统地配置 Agent → [Agent 管理](/wiki/agents)
- 想接入飞书 / A2A / 定时 → [触发方式](/wiki/triggers)
