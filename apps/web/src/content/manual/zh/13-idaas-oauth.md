# 企业 SSO（OAuth）配置

企业 SSO 是 a2wave 用来校验企业身份提供方（IdP）签发身份的配置。它和「后台企业登录」「用户鉴权访问」都有关：

- **后台企业登录**：在「设置 → 企业登录」开启 OAuth / 企业 SSO 登录后，Web 可使用 OIDC 或 SAML，CLI 企业登录则只使用 OIDC（也可回落到本地密码登录）。
- **用户鉴权访问**：在 Agent「发布」页的「OAuth 授权」卡片上开启后，外部调用方需要携带企业 OIDC 签发的 JWT（通常是 access token）访问 `/api/oauth/:agentId/invoke`（该渠道不支持 SAML，详见下文）。

支持两种标准协议：**OIDC（授权码 + PKCE）** 与 **SAML 2.0**。任一配置齐全并启用，登录页就会出现对应按钮；总开关是「设置 → 企业登录 → 启用 OAuth / 企业 SSO 登录」。

> [!TIP]
> **推荐在页面上配置。** 进入「设置 → 企业登录 → 登录方式」，展开 OIDC 或 SAML 面板填写并保存即可——**以数据库为准、保存后即时生效，无需重启**，且每个面板附带回调地址 / SP 元数据地址（一键复制给 IdP 注册）与「测试」按钮。下面的环境变量方式仍然可用，作为兜底：**页面未配置时回落到环境变量**；两者都配时以页面（数据库）为准。改环境变量需要重启 API。

> [!IMPORTANT]
> **OAuth 发布渠道复用 OIDC 配置。** Agent 以 `oauth` 方式发布时，调用方 token 的验签走的就是这里的企业 OIDC——签名公钥由 IdP 的 JWKS 自动提供并轮换，无需单独维护密钥。两点与登录不同：
>
> - **渠道有自己的受众（aud）白名单。** 登录必须 `aud = Client ID`，而接入自有服务的调用方并不持有它，因此渠道改按当前生效的 OIDC 渠道受众配置放行。Settings 中的配置优先；仅当 Settings 中没有有效 OIDC 配置时，才回落到 `A2WAVE_OIDC_CHANNEL_AUDIENCES`。**这里要填 IdP 为 a2wave 签发的受众**——JWT access token 的 `aud` 标识的是*目标资源服务器*（即本服务），且资源服务器必须确认自己在该受众内（[RFC 9068 §3](https://www.rfc-editor.org/rfc/rfc9068#section-3)）；各调用方通过 IdP 的 resource/audience 参数申请。**不要把其它应用的受众加进来**：那种 token 根本不是为 a2wave 签发的，放行它会让本渠道沦为那个服务 token 的 confused deputy——按调用方区分权限靠访问范围与邮箱名单，不是靠 `aud`。**Client ID 不会被自动加进来**——否则「能登录控制台」就等于「能调用每个 Agent」。当前生效的受众配置为空时即关闭该渠道（fail closed），绝不代表放行全部。
> - **关闭 OIDC 登录不会停掉渠道。** 登录方式的开关只管登录页出不出按钮；已发布的 oauth Agent 继续正常验签，避免「为了强制密码登录而顺手关掉 OIDC」把所有对外集成一起打断。
>
> OIDC 完全未配置时，渠道返回 `503 OAuth not configured`。

## 标准 OIDC 登录

标准 **OIDC（授权码 + PKCE）** 登录适合 Keycloak、Okta、Azure AD、Authing 等任何标准 OIDC IdP，也是 OAuth 发布渠道的验签来源。

推荐在「设置 → 企业登录 → OIDC」面板填写；也可用以下环境变量配置（改后需重启 API）：

| 变量 | 说明 |
|------|------|
| `A2WAVE_OIDC_ISSUER` | IdP 的 issuer 地址，端点通过 `{issuer}/.well-known/openid-configuration` 自动发现 |
| `A2WAVE_OIDC_CLIENT_ID` | 在 IdP 注册的 client_id |
| `A2WAVE_OIDC_CLIENT_SECRET` | 可选。缺省按 PKCE 公共客户端处理 |
| `A2WAVE_OIDC_SCOPES` | 可选。默认 `openid profile email` |
| `A2WAVE_OIDC_CHANNEL_AUDIENCES` | OAuth 渠道的环境变量兜底（逗号分隔）：填 a2wave 资源的受众标识。Settings 已配置时以 Settings 为准。Client ID 不会自动加入；仅当环境变量是当前生效的回退配置时，留空才会关闭渠道 |

配置好并在「设置 → 企业登录」开启 OAuth 后，登录页会出现 **「使用 OIDC 登录」** 按钮。点击后浏览器整页跳转到 IdP 完成认证，成功后自动回到站内；验签公钥走 JWKS 自动轮换，无需手动粘贴公钥。登录失败时登录页会显示具体原因（如登录会话过期、邮箱域名不在白名单等）。若 IdP 的 ID token 中不含邮箱（部分 IdP 只在 userinfo 端点返回邮箱），a2wave 会自动向 userinfo 端点补取，无需 IdP 侧额外配置。

在 IdP 侧注册应用时，回调地址（Redirect URI）填 `{服务地址}/api/auth/oidc/callback`。

> [!TIP]
> 设置页的「测试」按钮不只检查 discovery 连通性，还会向 IdP 的授权端点探测**回调地址是否已注册**：未注册时直接给出需要在 IdP 侧逐字符登记的地址（协议、主机、端口、路径都必须完全一致，`localhost` 与 `127.0.0.1` 互不通用）；测试通过时也会回显该地址，可直接复制去 IdP 注册。

## SAML 2.0 登录

面向只提供 SAML 的企业 IdP（如 ADFS、部分老牌 IAM），a2wave 可以作为 **SAML 2.0 SP** 接入。

> [!IMPORTANT]
> **SAML 只用于登录，不能用于 OAuth 调用渠道。** SAML 断言是浏览器表单 POST 到 ACS 的一次性凭据，不会签发可以长期放进 `Authorization: Bearer` 头的 token；OAuth 调用渠道只验签 **OIDC 签发的 JWT**。因此只配置了 SAML 的部署，用户可以正常登录 **Web 控制台**，但 Agent 的「OAuth 授权」渠道不可用（返回 `503 OAuth not configured`）；**CLI 的企业登录同样不可用**——`a2wave login` 走的是 OIDC 流程，此时只能用 `a2wave login --password` 本地密码登录。需要这两者时必须额外配置 OIDC。

推荐在「设置 → 企业登录 → SAML」面板填写；也可用以下环境变量配置（改后需重启 API）：

| 变量 | 说明 |
|------|------|
| `A2WAVE_SAML_IDP_ENTRY_POINT` | IdP 的 SSO 入口 URL（HTTP-Redirect binding 地址） |
| `A2WAVE_SAML_IDP_CERT` | IdP 签名证书（PEM，或去掉头尾行的 base64 体） |
| `A2WAVE_SAML_SP_ENTITY_ID` | 可选。SP entityId，默认 `{服务地址}/api/auth/saml/metadata` |

在 IdP 侧注册 SP 的步骤：

1. 打开 `GET {服务地址}/api/auth/saml/metadata`，把返回的 SP 元数据 XML（或该地址本身）提供给 IdP 管理员导入；
2. 确认 IdP 断言中携带用户邮箱（`email` 属性或 NameID 为邮箱），且**断言本身开启签名**（仅签 Response 整体不够）；
3. 配置上述环境变量并重启 API，在「设置 → 企业登录」开启 OAuth。

之后登录页会出现 **「使用 SAML 登录」** 按钮，点击后整页跳转到 IdP，认证成功自动回到站内。

> [!TIP]
> 设置页「测试」通过后会回显 IdP 侧需要登记的三个地址：**ACS 地址**（断言的 Destination/Recipient 必须逐字符一致）、**SP Entity ID**（断言的 Audience 必须一致）与 **SP 元数据地址**。IdP 侧登记的地址与这里显示的不一致（包括 `localhost` vs `127.0.0.1`）时，登录会被拒绝。

## 同一用户多种方式登录（账号归并）

同一个企业用户经 OIDC 与 SAML 登录时，IdP 返回的账号标识形态可能不同。a2wave 会按 **IdP 已验证的企业邮箱**把两种方式归并到同一个账号：先用其中一种方式登录过的用户，换用另一种方式登录仍是同一账号，不会产生重复用户。若 OIDC 身份显式标记邮箱未验证（`email_verified: false`），该邮箱不会用于归并（避免未验证邮箱冒用同邮箱账号）；IdP 未下发该声明时按已验证处理。

唯一的例外是邮箱属于一个**本地密码账号**（从未走过 SSO）：此时不会自动绑定，登录页会提示先用密码登录、再在「用户菜单 → 绑定企业身份」中完成绑定，避免同名邮箱抢占本地账号。

> [!NOTE]
> 两种登录方式（OIDC / SAML）可以并存，登录页按服务端配置依次显示对应按钮。用户菜单里的「绑定企业身份」以及分享页的「SSO 验证访问」同样支持这两种方式：入口按当前生效的登录方式渲染。为防止跨浏览器账号预劫持，「绑定企业身份」把绑定流锁定到发起绑定的那个浏览器（OIDC 用 HttpOnly 流程 cookie、SAML 用专用浏览器绑定 nonce）；换一个浏览器或会话失效完成回调都会被拒绝。
>
> **部署前提（OIDC / SAML）**：回调地址默认取「设置 → 运行产物 → 用户可访问地址」（`publicBaseUrl`）。生产环境未配置该地址、且该方式也没有单独填写回调地址时，OIDC / SAML 登录与「测试」会报「未配置对外访问地址」，请先填写为对外可访问的 `https://` 地址。

## 怎么确认自己已经绑定了企业身份

看左下角你的名字后面：绑定成功后会出现一枚绿色徽标，鼠标悬停能看到完整说明。侧边栏收起时（窄屏会自动收起）名字不显示，此时点开用户菜单，徽标在顶部你的用户名旁边。

徽标上的协议名来自**绑定当时服务端记录的真实协议**（`OIDC` / `SAML`），不是根据当前启用了哪些登录方式猜的——所以之后管理员增删登录方式，你的徽标都不会跟着变。本功能上线前就已绑定的存量账号显示通用的 `SSO`：平台当时没有记录协议，与其猜一个可能错的名字，不如如实显示"已绑定、方式未知"。

徽标描述的是**已存储的绑定**，不是你最近一次是怎么登录的。所以在多种方式并存的部署里，刚点了「SAML 登录」却看到 `OIDC` 徽标是正常的。

尚未绑定时不显示徽标，用户菜单里会出现可点击的「绑定企业身份」。绑定完成后该菜单项消失：已绑定是一种状态，不是还需要你操作的入口，所以只用徽标表示。

## 单独指定回调地址

两个面板（OIDC / SAML）各自带一个**可编辑的回调地址**：输入框里填协议 + 域名或 IP + 端口，右侧灰色部分是固定路径，改不了；下方一行实时显示拼出来的完整地址，可一键复制去 IdP 登记。

留空即用默认值——多数部署不用动它。以下情况才需要单独填：

- 服务用 IP 访问，但 IdP 只登记了域名（或反过来）；
- 产物下载走公网域名，而 SSO 回调必须走内网地址；
- 两种方式在 IdP 侧登记在不同的域名下。

各方式的固定路径与**接收方**：

| 方式 | 回调路径 | 谁接收 | 留空时的默认值 |
|------|----------|--------|----------------|
| OIDC | `/api/auth/oidc/callback` | API | 用户可访问地址 |
| SAML | `/api/auth/saml/acs`（SP 元数据地址同源） | API | 用户可访问地址 |

> [!IMPORTANT]
> 只能填到端口为止，不能带路径、`?` 参数或用户名密码——路径由 a2wave 固定拼接，多填会拼出打不开的地址，保存时会被拒绝。填完记得点「测试」：它用的就是这里的地址，能直接验出 IdP 侧有没有登记。

> [!WARNING]
> **本地开发（前后端分端口）时填 API 端口**：OIDC / SAML 的回调都由 API 提供，要填 API 端口（默认 3502）。生产环境前后端同源，只有路径不同。
>
> 另外，回调地址与 SP EntityID 都是**逐字符**比对，`localhost` 与 `127.0.0.1` 互不通用。SAML 若报「Audience 与 SP EntityID 不一致」，多半就是这两种写法混用了。

## 访问范围

企业 OIDC 负责证明“调用者是谁”；Agent 发布页里的 **访问范围** 决定“谁能调用这个 Agent”。

当前支持两种访问范围：

| 访问范围 | 说明 |
|----------|------|
| 全体企业用户 | 任何持有企业 OIDC 签发、`aud` 在白名单内、**且带有邮箱声明**的 JWT 的员工都能调用。 |
| 指定企业用户 | 只有名单内的邮箱能调用，其余一律拒绝。名单可以搜索同事添加，也可以直接输入邮箱。 |

选择 **指定企业用户** 时，名单为空表示**没有人**能调用（拒绝而不是放行），所以发布前至少要添加一个成员。名单按邮箱比对 OIDC JWT 里的 `email`，大小写不敏感。

> [!NOTE]
> 旧版本的「飞书应用可见范围」已下线。升级后，**已发布 OAuth 渠道**且用该范围的 Agent 会被迁移成 **指定企业用户** 且名单为空——也就是暂时拒绝所有调用，需要由 Agent 负责人补齐名单。这样做是为了避免升级把原本受限的 Agent 悄悄放开给全体员工。没有发布 OAuth 渠道的 Agent 则落到新默认值「全体企业用户」，不受影响。
>
> 因此 OAuth 渠道不再需要飞书 App ID / App Secret；只有飞书渠道本身才需要。

## 常见现象

| 现象 | 说明 |
|------|------|
| 设置页 OAuth 开关能打开，但 SSO 不能用 | OIDC / SAML 都还没配置齐全，或都被停用；在对应面板点「测试」可看到具体原因 |
| 发布页 OAuth 授权打开后出现红字 | 企业 OIDC 未配置（渠道会返回 `503`）。注意这与「OIDC 登录开关」无关——关掉登录不会停掉渠道 |
| 新接入方一直 401 | 多半是调用方拿到了面向错误资源的 token。让调用方申请一枚面向已配置 a2wave 受众的 token；不要把观察到的任意 `aud` 照抄进白名单，因为该 token 可能原本是为其它服务签发的 |
| 某段时间所有调用方一起 503「身份提供方不可用」 | a2wave 连不上 IdP（discovery / JWKS 拉取失败），不是调用方凭据的问题，无需重新签发 token；排查出网、DNS、代理即可 |
| `/api/oauth/:agentId/invoke` 直接发给别人后无法调用 | 对方还需要先在企业 IdP 完成认证拿到 token，并且必须在该 Agent 的权限边界内 |

## 调用错误怎么处理

OAuth API 的错误包含 `code`、`message`、`source`、`action` 和 `retryable`。调用程序应以 `code` 为主、以 `message` 作为给人的行动说明，不要只看 HTTP 状态猜原因。

| source | 表示什么 | 谁采取行动 |
|--------|----------|------------|
| `caller` | 调用方 token、权限、IP 或请求内容有问题 | 当前调用者 |
| `agent` | Agent 发布、队列、工作区或配置有问题 | Agent 所有者 |
| `provider` | Codex / Cursor / Claude Code 登录、额度或服务有问题 | Agent 所有者或稍后重试 |
| `platform` | SSO 或 a2wave 平台异常 | 平台管理员 |

同步调用在顶层 `error` 返回该结构；SSE 在 `event: error` 中返回；默认异步调用则在轮询结果的 `data.result.error` 返回。三者的 code 和 message 一致。

HTTP `424` 表示 Agent 的 Provider、执行引擎、模型、MCP 或工作区配置需要 Agent 所有者处理；工作区仅在被占用时返回 `409`。`INTERNAL_ERROR` 表示平台内部异常，`retryable` 为 `false`，调用方应携带 `details.runId` 联系平台管理员。

> [!WARNING]
> `PROVIDER_REAUTH_REQUIRED` 表示 Agent 的 Provider 登录失效。message 会明确要求联系 Agent 所有者；重新登录调用方自己的 SSO 账号不能解决。

## 相关

- [触发方式](/wiki/triggers) · [成员管理](/wiki/members) · [快速开始](/wiki/getting-started)
