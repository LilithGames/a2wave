# 触发方式

a2wave 当前提供 **十种发布渠道**：REST API、OAuth 授权、A2A 协议、飞书、Slack、Discord、定时触发、对话网页、GitLab 触发、GitHub 触发。一个 Agent 可同时启用多种。Slack 与 Discord 当前按飞书渠道的直连模式提供文本消息能力，后续会统一收敛到通用聊天渠道适配层。

## 在「渠道」页管理渠道

打开 Agent 的「渠道」标签，可以看到所有渠道以卡片平铺展示，一眼就能看出哪些已经启用。顶部的筛选可以按类别收窄：全部 / API / 协议 / 聊天机器人 / 定时 / 网页应用 / Git 仓库触发。

每张卡片上有两个独立的操作：

| 操作 | 作用 |
|------|------|
| **配置** | 打开该渠道的配置弹窗，填写并保存凭据与参数。**只保存配置，不会让 Agent 上线**。 |
| **启用开关** | 决定该渠道是否对外提供服务。 |

> [!NOTE]
> 「配置」和「启用」是两件事。你可以先把飞书的 App ID、Secret 填好存起来，暂时不启用；等准备好了再打开开关。

**未配置完成的渠道无法启用**——开关会置灰，鼠标悬停会提示先完成配置。例如 Slack 缺少 App Token 时，开关点不动，避免启用一个必然连不上的渠道。REST API 始终启用，因此没有开关。

改完配置后，点页面底部的「发布 / 更新渠道」让 Agent 正式上线；已上线的 Agent 在弹窗内保存配置会即时生效，且只影响该渠道，不会打断其它渠道的连接。

### 即时通讯渠道的连接状态

飞书、Slack、Discord 三个渠道各自与平台维持一条**长连接**，因此它们的卡片上会显示实时连接状态，标出各自的协议：飞书是 **WebSocket**、Slack 是 **Socket Mode**、Discord 是 **Gateway**。三个渠道同时启用时，靠协议名即可分辨是哪一条连接出了问题。

| 状态 | 含义 |
|------|------|
| **已连接** | 当前实例已建立该渠道的长连接，可正常收发消息。 |
| **重连中** | 连接已注册但尚未打开，通常会自动恢复。 |
| **本实例无连接** | Agent 已发布，但当前 API 实例没有该渠道的连接——多为 App 被其它 Agent 先占（见「一 App 一单连接」）或凭据有误。 |
| **待发布生效** | 开关刚被改动但尚未发布。连接状态**不会**随开关立即改变，点击「发布 / 更新渠道」后才会真正建立或断开。 |
| **状态获取失败** | 无法读取连接状态（接口异常或网络问题），此时实际连接可能正常也可能已断开。 |
| **未运行** | Agent 处于草稿或已停止状态，长连接不会建立。 |
| **未连接** | 该渠道已保存配置但未启用。**关闭渠道或停止 Agent 后，发布生效时连接即断开。** |

> [!IMPORTANT]
> 连接状态反映的是**服务端的真实连接**，不是开关的位置。因此改动开关后、点击发布前，卡片会显示「待发布生效」，而不是立刻跟着开关变化——这样可以区分「我改了但还没生效」和「已生效但连不上」这两种完全不同的情况。

> [!NOTE]
> 状态**仅反映当前服务实例**。多副本部署时，某一副本显示「本实例无连接」属正常现象——连接由抢到该 App 的那个副本持有。状态每 15 秒刷新一次，发布 / 停止 / 恢复运行后会立即刷新。

从未配置过的渠道不显示连接状态；其余渠道（REST API、OAuth、A2A、定时任务、对话页）都是入站 HTTP 或平台内部调度，不持有长连接，同样不显示。

---

## 1. API（Gateway 调用）

通过网关 API 调用已发布 Agent，适合后端服务、脚本、第三方系统集成。

### 调用

```
POST /api/gateway/:agentId/invoke
Authorization: Bearer <apiKey>     # publishAuthType=api_key 时必带
Content-Type: application/json
```

请求体字段：

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `message` | string | — | 必填，1–100000 字符 |
| `context` | object | — | 自定义上下文（`channel`/`caller` 为保留字，会被剥离） |
| `stream` | bool | `false` | 是否 SSE 流式 |
| `async` | bool | `true` | 是否异步（默认异步！） |
| `worktree` | object | — | `{name, cleanup: ephemeral\|ttl\|persistent, branch?}` |
| `attachments` | array | — | 图片/文件附件（先上传拿 token，见下方「附件」） |

可选请求头 `X-Idempotency-Key`：在该 Run 存活窗口内对重试去重。

### 三种返回

```bash
# 异步（默认）：立即返回 runId，去轮询
curl -X POST ".../api/gateway/<agentId>/invoke" -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" -d '{"message":"hi"}'
# → 202 { "data": { "runId": "run_..." } }   排队时额外带 "status":"queued"

# 同步：等执行完返回结果
curl ... -d '{"message":"hi","async":false}'
# → 200 { "data": { "reply":"...", "runId":"run_...", "durationMs": 1234 } }

# 流式：SSE，事件 update / log / done / error
curl ... -d '{"message":"hi","async":false,"stream":true}'
```

### 轮询与取消

```bash
# 查 Run 状态
curl ".../api/gateway/<agentId>/runs/<runId>" -H "Authorization: Bearer <key>"
# → { "data": { "runId, status, result, createdAt, updatedAt } }

# 取消（仅 running / queued 可取消）
curl -X POST ".../api/gateway/<agentId>/runs/<runId>/cancel" -H "Authorization: Bearer <key>"
```

### 约束

- **限流**：每个 Agent **60 次/分钟**。
- 队列满返回 `429`；未发布返回 `403`；鉴权失败 `401/403`；worktree 被占用 `409`。
- 认证：`/api/gateway` 使用 `api_key`（Bearer）/ IP 白名单；企业 OIDC 签发的 JWT 使用独立的 `/api/oauth` 渠道。

> [!NOTE]
> API Key 只能识别调用该接口的集成，不能自动知道集成背后的最终用户，因此运行记录通常只显示 `API`。如果需要把一次直接调用明确归因到某位企业用户，请使用 OAuth 接口并携带该用户自己的 OIDC JWT；在 `context` 中自行填写用户名不能替代身份鉴别。

> [!IMPORTANT]
> 部署在反向代理后时，设置 `TRUSTED_PROXY=true`，并在 `TRUSTED_PROXY_ADDRESSES` 中只填写代理与 a2wave 直接建立 TCP 连接的 IP 或 CIDR。Gateway、OAuth、A2A 会从右向左扫描 `X-Forwarded-For`，取第一个不受信任的节点，统一用于 IP 白名单、审计/渠道上下文和限流。代理必须覆盖 XFF，或按标准逐跳追加；不要保留未经校验的非标准链。

远程 A2A 路由默认支持普通私网、CGNAT 和 ULA 目标，同时保留 URL/DNS 校验、重定向逐跳复检、连接固定，以及对回环、链路本地、云元数据和其他保留地址的硬拒绝。设置 `ALLOW_PRIVATE_ROUTE_TARGETS=false` 可切换为仅公网模式；在该严格模式下，可用 `TRUSTED_A2A_ROUTE_HOSTS` 精确放行受控的私网 DNS 主机名，而不关闭其他保护。

### OAuth（企业 OIDC JWT）调用

OAuth 调用地址是 `POST /api/oauth/:agentId/invoke`。请求头携带调用者自己的 `Authorization: Bearer <OIDC_JWT>`；该 token 只证明“调用者是谁”，与 Agent 执行时使用的 Codex / Cursor / Claude Code 凭证相互独立。

> [!IMPORTANT]
> 本渠道**只接受企业 OIDC 身份提供商签发的 JWT**（通常是 access token），按 IdP 的 JWKS 验签，且 `aud` 必须命中**当前生效的 OIDC 渠道受众配置**。Settings 中的配置优先；仅当 Settings 中没有有效 OIDC 配置时，才回落到 `A2WAVE_OIDC_CHANNEL_AUDIENCES`。SAML 登录走的是浏览器断言流程，不产生可放进 `Authorization` 头的 token，因此**只配置了 SAML 的部署无法使用 OAuth 调用渠道**。

返回错误时优先读取 `error.code`、`error.message`、`error.action`：

| code | 谁需要处理 | 下一步 |
|------|------------|--------|
| `AUTH_REQUIRED` / `CALLER_TOKEN_INVALID` | 调用者 | 从调用方自己的 OIDC client 获取面向已配置 a2wave 资源受众的新 JWT |
| `CALLER_TOKEN_CLAIMS_INVALID` | 调用者 / 平台管理员 | 从已配置的 OIDC provider 获取包含 email claim 的新 JWT；`specified_users` 还要求邮箱已验证 |
| `CALLER_NOT_AUTHORIZED` / `IP_NOT_ALLOWED` | 调用者 + Agent 所有者 | 申请权限或切换允许的网络 |
| `PROVIDER_REAUTH_REQUIRED` / `PROVIDER_AUTH_FAILED` | Agent 所有者 | 重新登录或更新 Agent 的 Provider 凭证；调用者无需重登 |
| `AGENT_CONFIGURATION_ERROR` / `AGENT_WORKSPACE_UNAVAILABLE` | Agent 所有者 | 修复引擎、模型、MCP 或工作区配置；非占用类错误返回 `424` |
| `AGENT_QUEUE_FULL` / `SESSION_BUSY` | 调用者 | 等待当前 Run 完成后重试 |
| `OAUTH_NOT_CONFIGURED` / `AUTHORIZATION_CHECK_UNAVAILABLE` | 平台管理员 | 检查平台配置或稍后重试 |

> [!IMPORTANT]
> OAuth 接口的 HTTP `401` 只表示调用者的 OIDC JWT 无效。若 message 指向 Agent Provider，调用方不应清理自己的登录态。

### 公开元信息

外部系统如果只需要展示已发布 Agent 的公开信息，可使用公开只读接口批量查询：

```bash
curl ".../api/public/agents/metadata?agentIds=agt_1,agt_2"
```

返回字段包括 Agent 名称、配置页描述、OAuth 渠道当前是否可用，以及 OAuth 访问范围：

| 字段 | 说明 |
|------|------|
| `name` | Agent 名称 |
| `description` | Agent 配置页的描述 |
| `oauthEnabled` | Agent 已发布 OAuth 渠道，且平台已配置企业 OIDC 与非空的 OAuth 渠道受众时为 `true`；只开启 Agent 渠道但平台尚不能验签时为 `false` |
| `oauthAccessMode` | `all_idaas_users` 表示全体企业用户；`specified_users` 表示仅名单内的指定企业用户 |

未发布、已停止或不存在的 Agent 会统一返回 `exists: false`，不会暴露草稿信息。

---

## 2. 飞书

先在[飞书开放平台](https://open.feishu.cn/)的应用后台完成以下三组配置，再回 a2wave 填 App ID / App Secret：

1. **开通权限**：进入 **开发配置 → 权限管理**，开通 `im:message`（收发消息）与 `im:message.group_at_msg`（接收群里被 @ 的消息）。若在 a2wave 中开启了「解析用户身份」，还需 `contact:contact.base:readonly`、`contact:user.base:readonly`（姓名）与 `contact:user.email:readonly`（邮箱）；使用交互卡片则需 `cardkit:card:write`。权限变更后必须到 **版本管理与发布** 重新发版并等待审核通过才会生效。
2. **订阅事件**：进入 **开发配置 → 事件与回调 → 事件配置**，订阅方式选择 **长连接**（无需公网回调地址，a2wave 主动连接飞书），然后添加事件 `im.message.receive_v1`（接收消息）。
3. **订阅回调**（仅使用交互卡片时需要）：在同一页的 **回调配置** 中，订阅方式同样选择 **长连接**，并添加回调 `card.action.trigger`（卡片交互回调）。不使用交互卡片可跳过这一步。

> [!IMPORTANT]
> 「事件」和「回调」是飞书后台两项独立配置，各自都要单独选择长连接方式。只订阅了事件而漏了回调时，普通消息能收到，但交互卡片上的按钮点击不会有任何反应。

配置完成后，在 a2wave 的「渠道」页点「飞书机器人」卡片的「配置」，填写 **App ID / App Secret** 及触发与回复策略：

- **群聊**：被 @ 触发（`groupTriggerOnAt`，默认开）/ 任意新消息触发（默认关）；回复模式 `quote / new / none`。普通群消息的回复默认 @ 触发者；若在「回复时提醒」中选择「不 @任何人」，普通群回复也不再 @ 人。
- **话题群**：被 @ / 新话题 / 新评论触发；回复模式 `topic_reply / none`。「回复时提醒」可选择 @当前触发者（默认）、@话题发起人或不 @任何人。前两项决定「@ 谁」，仅对话题内回复生效——普通群消息没有话题发起人，始终 @ 触发者；「不 @任何人」决定「要不要 @」，对所有群回复（含普通群消息）生效。选择话题发起人时，平台会读取根消息发送者；读取失败则不 @，避免机器人转交场景下误提醒触发消息的机器人。此功能仅适用于纯文本和富文本回复。话题回复默认只发送本次消息内容，同一话题内的连续上下文依赖 Agent 会话历史；如需在每次回复中附带话题首条消息（文本/图片/文件），可在飞书配置弹窗开启「携带话题首条消息（根消息）内容」（`topicInjectRootMessage`）。
- **单聊（P2P）**：永远触发，回复模式可选。
- **回复内容类型**：`text / post / interactive / interactive_card / streaming_card`；可选把产物作为文件发送、是否解析用户身份。
- **文件消息**：用户在飞书里直接发送文件触发 Agent 时，平台会先下载文件，并把本轮可读取的文件路径写入输入内容和 `context.files`，Agent 可按该路径读取文件；运行结束后临时文件会自动清理。

> [!WARNING]
> **一 App 一单连接**。同一飞书 App ID 在单个 API 进程内只允许 **一条** 活跃 WebSocket，**先占先得、后启动不得抢占**。多个 Agent 要接飞书，必须各用 **独立的飞书应用**。连接状态可直接在「渠道」页的飞书卡片上查看（被抢占时显示「本实例无连接」），也可在 Agent「综合诊断」中查看。

### 交互卡片

把回复内容类型设为 **`interactive_card`** 后，Agent 在需要你**确认操作**或**填写/选择信息**才能继续时，会直接发出一张可点击、可填写的飞书卡片（确认/取消按钮、下拉单选、多选、文本输入、日期等），而不是用文字让你手敲回答。你操作并提交后，结果会作为新一轮输入回到**同一个会话**，Agent 据此继续往下走。

- **谁能点**：只有**卡片的接收者**（即触发这轮对话的人）能操作；群里其他人点击会被拒绝，避免替你误操作。
- **回复位置**：续跑后 Agent 的回复**始终挂在你最初提问的那条消息下**，而非一层层套在卡片下——即使连续弹出多张卡片，回复链也始终回到初始问题，群里不会越套越乱。
- **时效**：卡片有有效期，过期或已处理过的卡片再点击会提示失效，需要时重新发起对话。
- 没有需要交互的场景时，Agent 的普通回复会照常渲染成卡片样式展示。

---

## 3. Slack

先在 Slack App 管理后台完成以下三组配置：

1. **启用 Socket Mode**：进入 **Settings → Socket Mode**，开启 Socket Mode，并创建带 `connections:write` 权限的 App-Level Token（形如 `xapp-...`）。
2. **配置 OAuth 权限**：进入 **Features → OAuth & Permissions**，在 **Bot Token Scopes** 中添加 `app_mentions:read`、`chat:write`、`im:history`、`files:read` 和 `files:write`。其中 `files:read` 用于读取用户发送的 Slack Files，`files:write` 用于把 Agent 产物直接传回 Slack。修改权限后必须 **Install/Reinstall to Workspace**，再复制 Bot User OAuth Token（形如 `xoxb-...`）。
3. **订阅消息事件**：进入 **Features → Event Subscriptions**，开启 **Enable Events**，然后在 **Subscribe to bot events** 中添加 `app_mention` 和 `message.im`。

> [!IMPORTANT]
> OAuth 权限与 Event Subscriptions 是两项独立配置。即使 OAuth 授权成功，未开启 **Enable Events** 或未订阅 `app_mention`、`message.im` 时，Slack 仍不会把消息推送给 a2wave。

如需在公开或私有频道开启“所有新消息均触发”，还要订阅 `message.channels`、`message.groups`，并授予 `channels:history`、`groups:history`。

完成 Slack 后台设置后，在「渠道」页的 Slack 卡片点「配置」，填写 **App ID**（形如 `A...`）、**App Token**（`xapp-...`）和 **Bot User OAuth Token**（`xoxb-...`）。频道默认只在 @Bot 时触发；私信始终触发。测试频道消息前，先将 Bot 加入频道，再发送 `@Bot hello`；也可以直接私信 Bot。

> [!WARNING]
> 同一个 Slack App ID 在单个 API 进程内只允许一个 Agent 持有 Socket Mode 连接，后启动的 Agent不会抢占现有连接。多个 Agent 请使用不同 Slack 应用。

Slack 消息中的 Files 会按平台统一附件策略下载并交给 Agent；仅发送文件、不带正文的私信也能触发。Agent 的标准 Markdown 回复会通过 Slack Markdown Block 渲染，标题、表格、加粗、代码块与链接可直接显示，不会把 Markdown 标记原样发出。回复中的执行沙箱路径、`sandbox:` 链接和本地 HTML 下载标签会被清理，真正的产物由平台发送。Agent 运行产物默认直接上传到原会话，上传成功后不再重复展示下载区块；仅在上传失败时提供 a2wave 下载链接作为后备。可在 Slack 渠道配置中关闭文件直传。当前不发送按钮等交互组件。

---

## 4. Discord

在「渠道」页的 Discord 卡片点「配置」，填写 **Application ID** 与 **Bot Token**。在 Discord Developer Portal 中开启 **Message Content Intent**，邀请 Bot 时授予 `View Channels`、`Send Messages`、`Read Message History` 与 `Attach Files` 权限；若要在线程频道回复，还需 `Send Messages in Threads`。

服务器频道默认只在 @Bot 时触发，也可开启所有新消息触发；保存触发方式时，如果 Application ID 与 Bot Token 未变，运行中的 Gateway 连接会立即应用新配置，无需重新连接。回复可引用原消息、新发消息或关闭。私信始终触发。同一频道内按用户维持 Agent 会话，Discord Thread 会按各自 channel ID 隔离。

> [!IMPORTANT]
> “频道内所有新消息均触发”依赖 Developer Portal → Bot → Privileged Gateway Intents 中的 **Message Content Intent**。Bot 还必须能查看目标频道。为避免机器人互相回复形成循环，Bot 与 Webhook 发送的消息不会触发 Agent。

> [!WARNING]
> 同一个 Discord Application ID 在单个 API 进程内只允许一个 Agent 持有 Gateway 连接。多个 Agent 请使用不同 Discord 应用。

Discord Attachments 会按平台统一附件策略下载并交给 Agent；仅发送附件、不带正文的私信也能触发。Agent 运行产物默认直接上传到原会话，上传成功后不再重复展示下载区块；仅在上传失败时提供 a2wave 下载链接作为后备。Agent 输出中的执行沙箱临时链接不会发到外部聊天渠道。可在 Discord 渠道配置中关闭文件直传。当前不发送 Embed、按钮或 Modal。

---

## 5. 对话网页

把 Agent 发布成一个可分享的对话页面：左侧展示 Agent 的介绍、状态与创建者，右侧是完整的对话窗口。适合把一个 Agent 直接交给同事使用，不用教他们怎么用控制台。

在「渠道」页的「对话网页」卡片点「配置」，保存后打开卡片上的开关即可得到链接：

```
https://<你的域名>/agents/<agentId>/chat_app
```

点击链接右侧的图标可直接在新标签页打开预览，也可复制后发给同事。

可配置项：

| 配置 | 说明 |
|------|------|
| **页面标题** | 覆盖页面上展示的名称；留空则用 Agent 名称。 |
| **开场白** | 支持 Markdown，显示在对话开始前。留空则显示默认提示。 |
| **推荐提问** | 每行一个，最多 6 条；访问者点击即可直接提问。 |
| **显示创建者** | 是否在左侧展示该 Agent 的创建者。 |
| **允许上传附件** | 沿用全局附件限制（类型、大小、数量）。 |
| **显示思考过程** | 展示工具调用与中间步骤；关闭后只显示打字动效，体验更简洁。 |

> [!IMPORTANT]
> 对话网页**不支持匿名访问**。访问者必须登录 a2wave，且对该 Agent 有查看权限（owner / editor / viewer 或管理员）；未登录会跳转到登录页。链接本身不授予任何权限——把链接发给没有权限的人，对方只会看到「页面不可用」。
>
> 关闭渠道即时生效：每一轮对话都会校验渠道开关，已经打开页面的人也会立即无法继续提问，因此撤回链接不需要等对方关掉页面。
>
> 但要注意：关闭渠道只是**收回对话网页这个入口**，不是收回对该 Agent 的访问权。原本就有查看权限的人，仍可在 Agent 详情页用「测试对话」调用同一个 Agent。要真正阻止某人使用，需要移除他的 Agent 权限（见[成员与权限](/wiki/members)），或停止发布该 Agent。

每次对话都会写入运行记录，来源标记为 `对话网页`，可在「运行记录」中按渠道筛选，也会计入 Agent 统计，便于审计与排查。若 Agent 未激活或已停止发布，页面会明确说明原因，而不是静默失败。

---

## 6. A2A 协议

A2A（Agent-to-Agent）让外部 Agent 系统能发现并调用本平台 Agent，也让本平台 Agent 路由到符合标准的远程 A2A 服务。当前支持 **A2A 1.0 JSON-RPC**，并兼容 **A2A 0.3 JSON-RPC**。

### 发布为 A2A 服务

在 Agent 的「渠道」页启用「A2A 协议」，复制页面给出的 Agent Card URL 与调用端点。调用方先读取 Agent Card，再按 Card 声明的协议版本和端点发起请求。

```bash
# 发现：获取 Agent Card
curl -H "A2A-Version: 1.0" ".../api/a2a/<agentId>/.well-known/agent-card.json"

# A2A 1.0 调用：JSON-RPC
curl -X POST ".../api/a2a/<agentId>" -H "Authorization: Bearer <key>" \
  -H "A2A-Version: 1.0" -H "Content-Type: application/json" -d '{
    "jsonrpc":"2.0","id":"1","method":"SendMessage",
    "params":{
      "message":{"messageId":"msg-001","role":"ROLE_USER",
                 "parts":[{"text":"Hello, A2A!","mediaType":"text/plain"}]},
      "configuration":{"returnImmediately":false,"acceptedOutputModes":["text/plain"]}
    }
  }'
```

Agent Card 同样参与版本协商：请求 A2A 1.0 结构时应携带 `A2A-Version: 1.0`；省略该请求头会有意返回兼容 A2A 0.3 的 Card。

A2A 1.0 的流式方法为 `SendStreamingMessage`，任务查询与取消分别为 `GetTask`、`CancelTask`。异步调用把 `returnImmediately` 设为 `true`，返回 Task 后用 `GetTask` 轮询到终态。A2A 0.3 客户端仍可继续使用 `message/send`、`message/stream`、`tasks/get`、`tasks/cancel`，以及小写的角色与任务状态。鉴权使用 Agent 的 A2A API Key（`a2aAuthType` 仅支持 `none` / `api_key`）。OAuth 渠道的 OIDC JWT 在这里**不被接受**，会返回 `401`。

本地也可用 `pnpm a2a-demo -- <agentId> "..."` 脚本快速测试。A2A 消息除文本外还可携带图片/文件；A2A 1.0 与 0.3 的分片字段不同，示例见下方「附件」。

### 调用链来源

当调用方和接收方都支持 A2A 来源扩展时，远程调用会携带**直接调用方 Agent 名称**，并在上游已经识别用户时继续携带该用户的显示名。接收方的运行列表因此可以显示 `用户·调用方 Agent·A2A`；没有用户时显示 `调用方 Agent·A2A`。

来源扩展通过 Agent Card 协商。使用「Agent Card 发现」的路由会在对端声明支持时自动启用。「直连端点」没有 Agent Card 可供能力发现：选择 A2A 1.0 后，只有确认接收方支持 a2wave 来源扩展时，才显式开启「发送调用来源信息」。该开关默认关闭，直连 A2A 0.3 也不会发送扩展。未支持扩展的 A2A 服务仍可正常互通，只是运行记录会退化为较少层级，最少仍显示 `A2A`。

> [!IMPORTANT]
> 来源名称用于审计展示，不是授权凭据。A2A 调用仍必须通过 API Key 完成实际鉴权；接收方不应根据来源扩展中的显示名授予权限。

### 调用远程标准 A2A 服务

在 Agent 的「配置」页打开「A2A 路由」并添加远程 Agent：

1. 填写一个用于路由识别的名称。
2. 推荐选择「Agent Card 发现」，粘贴远程服务的 Agent Card URL。平台会读取 Card，并自动选择其中声明的 A2A 1.0 或 0.3 JSON-RPC 接口。
3. 如果对方没有可访问的 Agent Card，选择「直连端点」，填写 JSON-RPC URL 并明确选择 `A2A 1.0` 或 `A2A 0.3`。接收方兼容 a2wave A2A 1.0 来源扩展时，可再开启「发送调用来源信息」。
4. 远端要求 Bearer Key 时填写 API Key。保存后凭据只以掩码显示，不会出现在 Agent Card 或路由结果中。

> [!NOTE]
> 「直连端点」无法发现远端能力。直连 A2A 1.0 会保守使用非流式 `SendMessage`；历史 A2A 0.3 路由保留 `message/stream` 兼容路径。如需标准 A2A 1.0 流式输出，并且对方声明支持，请改用「Agent Card 发现」。

### 长任务、超时与取消

A2A 路由不再附加固定 5 分钟执行截止。有效执行时长继承**发起调用的 Agent** 在「配置 → 超时时间」中的单次执行上限；需要允许远程任务运行更久时，请调大发起方 Agent 的该配置（范围 5–120 分钟），而不是修改远程路由。配置了「总超时时间」时，整个 Run（包括重试和多次 Agent 调用）仍受总上限约束。

对于 A2A 1.0，平台会在首次请求中尽早取得 Task ID，然后按 Task 生命周期等待：非流式调用使用 `GetTask` 查询；流式连接在已知 Task ID 后连续 30 秒无事件，或连接意外断开时，先用 `SubscribeToTask` 重订阅，失败后再用 `GetTask` 恢复。恢复只使用已有 Task ID，**不会重发原始消息**，避免远端任务重复执行。断线前已经收到的部分 artifact 分块会保留，并在重连后与后续 append 分块继续合并。工作状态消息只作为进度展示，不会在终态没有正文时被当作最终成功答案；终态历史暂时不可用时，即使重订阅已经成功，也会继续按 `GetTask` 的退避策略重试。

如果父 Run 被取消或达到超时，平台会在已经取得 Task ID 时使用独立的短控制请求发送 `CancelTask`，并在返回结果中说明下游是否确认取消。已知 Task 超出路由结果安全上限，或者重订阅与查询均发生永久失败且最后观测到的 Task 仍在运行时，也会尝试执行同样的下游清理，避免调用方已经收到恢复错误、下游任务却在不可见状态下继续执行。即使底层 Agent CLI 已因超时进入退出流程，平台也会先为路由器保留一个短暂的清理窗口，等待取消请求完成后再终止进程。A2A 生命周期事件会直接显示在运行详情的「执行日志」时间线中，包括目标 Agent、Task ID、状态、重连次数和取消结果；其中不会记录请求正文或凭据。若连接在返回 Task ID 之前就失败，平台没有可安全重连或取消的标识，因此会直接报告失败，也不会猜测性重发。A2A 0.3 路由继续保持原协议兼容并继承父调用的取消信号，但完整的按 ID 重连与取消保证只适用于 A2A 1.0；长任务建议升级到 A2A 1.0。

> [!NOTE]
> 标准远端 Agent 返回 `INPUT_REQUIRED` 或 `AUTH_REQUIRED` 时，路由会把该状态作为非成功结果返回，并保留 Agent 的状态消息、`taskId` 与 `contextId`。路由工具目前不会自动续接这个远端任务；请在新调用中补充对方要求的上下文，或更新远端凭据后重试。

> [!NOTE]
> 已有的远程路由只有端点 URL，没有发现方式和版本信息；编辑时会继续按「直连端点 + A2A 0.3」处理，不会自动改变原有行为。要改用标准发现，请手动切换为「Agent Card 发现」并填写 Card URL。

> [!IMPORTANT]
> 当前远程路由支持 Card 中的 JSON-RPC 接口。Card URL 与最终选中的调用端点都会经过 URL、DNS 和重定向安全检查。普通企业私网服务默认可用；管理员可设置 `ALLOW_PRIVATE_ROUTE_TARGETS=false` 切换为仅公网模式，并通过 `TRUSTED_A2A_ROUTE_HOSTS` 配置精确的私网 DNS 例外。

---

## 7. 定时触发

让 Agent 按 Cron 在指定时间自动创建并执行 Run（如每日代码审查、周报、巡检）。在「渠道」页的「定时触发」卡片点「配置」：

- **cron**：5 字段 `分 时 日 月 周`。
- **intent**：触发时的意图文本，支持 Mustache 变量 `{{date}}` / `{{time}}` / `{{iso}}`。
- **timezone**：默认 `Asia/Shanghai`。
- **多计划**：同一个 Agent 可配置多条 cron，每条计划可以使用不同的触发意图和时区。

启用方式：发布渠道包含 `schedule`。常用 Cron：

| 表达式 | 含义 |
|--------|------|
| `0 9 * * *` | 每天 9:00 |
| `0 10 * * 1` | 每周一 10:00 |
| `*/30 * * * *` | 每 30 分钟 |
| `0 0 1 * *` | 每月 1 日 0:00 |

说明：分钟级精度；每个 Agent 可配置多个定时任务；定时 Run 与其它来源**共用同一队列**，受 Agent `maxConcurrency` 控制。

---

## 8. Git 仓库触发（GitLab / GitHub）

让 Agent 在**仓库真正发生变化时**才运行——比如有人提了新 MR、往 MR 里推了新提交、或在 MR 下留了评论。

### 与定时触发的区别

这是这个渠道存在的理由：**定时触发每到点就直接启动 Agent**，哪怕仓库一整天都没动静，每一次空跑都在消耗 token。Git 仓库触发把「有没有变化」这件事放在 Agent **外面**用 CLI 判断——轮询本身不消耗任何 token，只有确认真的变了才唤醒 Agent。

| | 定时触发 | Git 仓库触发 |
|---|---|---|
| 每个周期 | 一定执行 Agent | 只做一次 CLI 读取（0 token） |
| 仓库没变化 | 照样执行，浪费 token | 不触发 |
| 适用 | 日报、巡检等无关外部状态的任务 | 代码评审、MR 跟进 |

### 前置条件：CLI 自行安装与登录

平台**只探测、不安装**：`glab` / `gh` 需要你在服务器上自行安装并登录，凭据保存在 CLI 自己的 keyring 中，a2wave 从不接触也不存储你的 forge token。

```bash
# GitLab
glab auth login --hostname gitlab.example.com
# GitHub
gh auth login
```

**容器部署**：镜像里没有 keyring，且 `auth login` 是交互式的，因此容器内请改用环境变量下发令牌（平台会把它们透传给 CLI）：

```yaml
environment:
  GITLAB_TOKEN: glpat-xxxxxxxx     # GitLab
  GH_TOKEN: ghp_xxxxxxxx           # GitHub
  # GitHub Enterprise 另可用 GH_ENTERPRISE_TOKEN
```

配置弹窗里点「检测」可以查看当前状态（是否已安装 / 是否已认证 / 当前账号）。若显示未认证，轮询会持续失败，请先在服务器上完成登录。

> [!NOTE]
> **配额是按 CLI 登录态计的，不是按 Agent。** 同一台服务器上所有 Agent 共享同一个 `glab` / `gh` 登录，因此 forge 的 API 限流是**每 host 共享预算**。按默认值估算：每轮最多 5 次请求（整轮共享额度，与配置几行无关），每 30 秒一轮即 ≈ 10 请求/分钟，而 GitLab 认证用户默认额度约 1200–2000 请求/分钟，单个 Agent 余量充足；但配置多个高频 Agent 时需要按总量估算。

### 配置项

| 配置 | 说明 |
|------|------|
| **监听范围**（仅 GitLab） | 每一行可以选「单个仓库」或「整个群组」，详见下方[监听范围](#监听范围仅-gitlab)。GitHub 只支持单个仓库。 |
| **仓库 / 群组** | 直接粘贴地址，例如仓库 `https://gitlab.example.com/group/subgroup/repo`、群组 `https://gitlab.example.com/acme/platform`。Host 与路径由地址自动拆分并显示在输入框下方，无需分两个字段填写；MR/PR 页面链接会自动还原成所属仓库，群组的 MR 列表链接也会还原成群组。最多 5 行。各行是**逐个串行**拉取的（不并发），这样「读取」和「处理」之间没有时间窗，避免配置变更或停用时仍按旧配置触发；代价是行数上限较低——需要监控更多仓库时，优先改用「整个群组」而不是一行行加。 |
| **触发事件** | 新建 MR/PR、有新提交、有新评论、已合并或关闭。可多选。 |
| **轮询周期** | 默认 60 秒，可设 30–600 秒。周期越短越及时，但对 forge 的请求也越频繁。 |
| **目标分支过滤** | 逗号分隔，只关注合入这些分支的 MR/PR；留空表示不限。 |
| **忽略草稿** | 默认开启，跳过 Draft / WIP，避免过早触发。 |
| **触发提示词** | 发给 Agent 的提示词模板，支持占位符。已预填一份带全部占位符的默认模板（跟随界面语言），可直接使用或改写；改乱了用右上角「恢复默认」还原。占位符在编辑器里高亮显示，与系统提示词一致。 |

### 监听范围（仅 GitLab）

一个产品线往往有十几个仓库，而且**还在不断新建**。一行行加仓库不仅会撞上 5 行上限，新建的仓库也永远不会被监听到——除非有人记得回来改配置。所以「仓库」这一栏可以直接填**群组**：

| 范围 | 填什么 | 适合 |
|------|--------|------|
| **单个仓库** | 仓库地址，如 `.../group/subgroup/repo` | 只盯一个项目 |
| **整个群组** | 群组地址，如 `.../acme/platform` | 盯一条产品线；**自动递归包含所有子群组和其中的仓库**，新建仓库无需改配置即可生效 |

选「整个群组」时，一次请求就能取回该群组下所有仓库的 MR，**不是按仓库数逐个请求**，因此监听 20 个仓库和监听 1 个的开销基本一样。

> [!TIP]
> 群组地址填到哪一层就监听哪一层。填 `acme` 会覆盖它下面的全部子群组，填 `acme/platform/sdk` 则只覆盖这个子群组。**范围越小，触发越精准，也越不容易撞上下面的分页上限**。

触发时 `{{repo}}` 始终是**该 MR 实际所属的那个仓库**（如 `acme/platform/sdk/core`），而不是你填的群组路径，因此 Agent 拿到的永远是可以直接操作的仓库地址。

> [!WARNING]
> **范围越大，越要配合过滤条件。** 一个大群组下可能有几百个开启中的 MR，建议同时设置「目标分支过滤」，并谨慎勾选「有新评论」，否则 Agent 会被大量与你无关的活动唤醒。
>
> 另外，**每轮总共最多翻 5 页**（约 500 个开启中的 MR），这个额度是整轮共享的，不是每行各有 5 页——否则 5 行 × 5 页会让单轮耗时超出轮询周期。超出额度的部分本轮不再推断「已合并或关闭」（原因同下方的单页限制），其余事件正常触发；日志里会提示你缩小范围。

### 触发提示词的占位符

触发时会把实际的 MR/PR 信息填进模板，**Agent 因此不必再自己去查发生了什么**：

`{{event}}`、`{{repo}}`、`{{host}}`、`{{number}}`、`{{title}}`、`{{url}}`、`{{author}}`、`{{source_branch}}`、`{{target_branch}}`、`{{sha}}`

例如模板 `请 review {{repo}} 的 {{event}}：!{{number}} {{title}}（{{url}}）`，实际触发时会变成
`请 review acme/demo 的 commented：!50 fix(cli): 修复 computer-use（https://.../merge_requests/50）`。

### 行为细节

- **GitHub 侧走 GraphQL**：REST 的 PR 列表接口不返回评论数，也不返回来源分支，因此 `gh` 渠道改用一次 GraphQL 查询取回 head 提交、两个分支名和评论/评审数——仍是每仓库每轮一次请求。评审评论（review）也计入评论数，所以「有新评论」能覆盖代码评审。
- **超过 100 个开启 MR 的仓库不再判定「已关闭」**。两个 forge 单页上限都是 100，取不满一页才能确认看全了；页满时无法区分「已关闭」和「被挤出第一页」，因此这一轮不推断关闭，等仓库回到一页以内再报。其余事件不受影响。
- **轮询失败不会清空进度**（未登录、仓库改名/归档、forge 5xx、限流等），恢复后不会漏掉停机期间的变化，也不会误报一堆「已关闭」。
- **草稿转为「可评审」会触发**（按新建 MR 处理）。开启「忽略草稿」时，草稿期间不触发；一旦标记为可评审，即使没有新提交也会唤醒 Agent——这正是这个渠道最主要的使用场景。
- **首次启用只记录基线，不触发**。否则一开启就会被仓库里几十个存量 MR 同时触发，白白消耗 token。之后只有真正的新变化才触发。
- **每个变化的 MR/PR 各触发一次 Run**，便于单独追踪和重试。
- **单轮最多触发 5 次**：超出的部分不会丢，会顺延到下一轮继续触发，只是限制速率。
- **同一个 MR 同时有新提交和新评论时只触发一次**（按「有新提交」计），不会重复唤醒。
- 只比对「head 提交」与「评论数」，因此改标签、跑流水线这类无关变动**不会**触发。

> [!WARNING]
> **让 Agent 回帖评论时，注意「自己触发自己」。** 「有新评论」是按评论数变化判断的，而 Agent 自己发的评论同样会让评论数 +1——不做防护就会形成「评论 → 唤醒自己 → 再评论」的死循环，一直消耗 token。平台无法替你区分这条评论是人写的还是 Agent 写的（轮询只看到数字变大了）。
>
> 内置的「MR 自动评审」模板已经处理了这一点：它给每条评论固定加上一行标记 `=comments_by_a2wave=`，并在开工前先读一遍评论列表——如果本次是「有新评论」且最新评论带着这个标记，就直接跳过本次运行。自己写提示词让 Agent 回帖时，请照同样的思路做防护，或者干脆不勾选「有新评论」。
- Run 记录里会标明来源渠道与具体的 MR/PR 编号，便于排查「这次为什么被触发」。

启用方式：发布渠道包含 `glab` 或 `gh`；两者互相独立，可只用其中一个，也可同时启用。

---

## 附件（图片与文件）

给 Agent 发消息时可以带图片和文档。飞书、Slack 与 Discord 渠道会自动识别消息里的图片/文件；API、OAuth 与 Agent 测试界面走**两步上传**，A2A 使用协议原生分片。

**两步上传（API / OAuth / 测试界面）**

1. 先把文件上传到对应上传端点（`multipart/form-data`，字段名 `file`），拿到一个 `token`。上传端点按调用方鉴权方式区分：
   - 平台用户（Web 测试界面）：`POST /api/attachments`
   - Gateway（Agent API Key）：`POST /api/gateway/<agentId>/attachments`
   - OAuth（企业 OIDC JWT）：`POST /api/oauth/<agentId>/attachments`

```bash
curl -X POST ".../api/gateway/<agentId>/attachments" -H "Authorization: Bearer <key>" \
  -F "file=@./chart.png"
# → { "data": { "token":"att_...", "name":"chart.png", "mimeType":"image/png", "size":12345 } }
```

2. 调用 invoke 时在 `attachments` 里带上引用：

```bash
curl -X POST ".../api/gateway/<agentId>/invoke" -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" -d '{
    "message":"看看这张图",
    "attachments":[{"token":"att_...","name":"chart.png","mimeType":"image/png"}]
  }'
```

**在测试界面**：Agent 详情页的「测试」抽屉里，输入框旁的回形针按钮可选图片/文件，图片会显示缩略图预览；发送后附件会随消息一起交给 Agent。

**A2A 1.0**：在 `message.parts` 中使用 `raw`（base64）或 `url`，并提供文件名与媒体类型：

```json
{ "raw":"<base64>", "filename":"doc.pdf", "mediaType":"application/pdf" }
```

**A2A 0.3**：使用 `file` 分片，内容为内联 `bytes`（base64）或 `uri`：

```json
{ "kind":"file", "file": { "bytes":"<base64>", "name":"doc.pdf", "mimeType":"application/pdf" } }
```

> [!NOTE]
> 支持图片（png/jpg/jpeg/webp/gif）与常见文档（pdf/txt/md/csv/docx/xlsx），默认单文件上限 10MB、单次最多 10 个。上传的文件先进暂存区，默认保留 7 天后自动清理——管理员可在「设置 → 上传附件」调整保留时长、大小上限、允许类型。平台会把附件落盘并将其路径提供给底层 Agent，由 Agent 自行读取。在保留期内，运行记录/会话历史里的图片附件可直接预览；过期清理后仅显示文件名。

---

## 排错

| 症状 | 可能原因 | 解决 |
|------|---------|------|
| 调用 401/403 | Key 错 / Agent 未发布 | 核对 Bearer Key、确认已发布 |
| 调用 429 | 超限流或队列满 | 降频，或调大 maxConcurrency |
| 飞书收不到消息 | App 长连接被占用 | 多 Agent 各用独立飞书应用；看诊断 |
| Slack 收不到消息 | Socket Mode、事件订阅或权限未开启 | 检查 `xapp`/`xoxb` token、事件与 scopes；每个 Agent 使用独立 App |
| Discord 收不到消息 | Message Content Intent 或 Bot 权限未开启 | 检查 Intent、邀请权限与 Application ID；每个 Agent 使用独立 App |
| 定时不触发 | 未包含 schedule 渠道 / cron 错 | 确认发布渠道与 cron 表达式 |

## 相关

- [Agent 管理](/wiki/agents)（API Key、发布） · [运行记录](/wiki/runs)（状态/取消/产物） · [核心理念与架构](/wiki/concepts)
