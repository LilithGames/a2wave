# Provider 执行引擎

Provider 是 Agent 背后的底层执行引擎及其凭证。a2wave 本身不做推理——**所有代码执行与推理都委托给 Provider 对应的 agent CLI**。没有可用的 Provider，Agent 无法运行。

## 八个预设 Provider

平台内置八个不可删除的预设。每个预设都有稳定类型；显示名称可以调整，但不会影响底层 Engine 派发：

> [!IMPORTANT]
> **能在线拉取模型列表，是 Provider 的硬性条件。** 每个 Provider 都必须能用你绑定的凭证向其 CLI 问出「这套凭证可用哪些模型」。因此平台不再维护任何写死的模型清单——手工维护的清单会和账号实际可用的模型脱节，让你选到一个要到运行时才失败的模型。

| Provider | 底层 CLI | Skills 目录 | MCP 配置 | 代表模型 |
|----------|---------|------------|---------|---------|
| **Claude Code** | `claude-code` | `.claude/skills` | `.mcp.json` | `claude-opus-4-8`、`claude-sonnet-4-6`、`claude-haiku-4-5-20251001` |
| **Codex CLI** | `codex` | `.codex/skills` | 每次运行注入，不落文件 | `gpt-5.3-codex`、`gpt-5.4`、`gpt-5.2-codex` |
| **Cursor CLI** | `cursor` | `.cursor/skills` | `.cursor/mcp.json` | `composer-1.5`、`opus-4.6`、`sonnet-4.5`、`gemini-3-pro`、`gpt-5.x-codex` 等 |
| **OpenCode CLI** | `opencode` | `.opencode/skills` | 每次运行注入，不落文件 | 取决于服务器上配置的供应商（`provider/model` 二段式） |
| **Qoder CLI** | `qoder` | `.qoder/skills` | `.mcp.json` | `auto`、`ultimate`、`performance`、`efficient`、`lite`（可在线拉取账号实际可用清单） |
| **Trae CLI** | `trae` | `.traecli/skills` | `.trae/mcp.json` | 由 TRAE 企业控制台配置，在线拉取（如 `kimi-k2`、`doubao-seed` 系列） |
| **Kimi Code CLI** | `kimi` | `.kimi-code/skills` | `.kimi-code/mcp.json` | `kimi-code/k3`、`kimi-code/k3-256k`、`kimi-code/kimi-for-coding`、`kimi-code/kimi-for-coding-highspeed`（可在线拉取账号实际可用清单） |
| **Pi CLI** | `pi` | `.pi/skills`（每次运行显式传入） | Pi 内置运行时不支持 | localSession 使用 Pi 已配置的供应商；apiKey 枚举 Pi 内置的 `openai/*` 模型 |

> 预设 Provider **全部字段只读**：名称、脚本、路径由平台定义，能力由代码决定，模型清单则在 Agent 配置页按凭证实时拉取。Provider 详情页只保留一个操作——安装/更新它背后的 CLI。

> [!NOTE]
> **Copilot CLI 已下线。** GitHub Copilot CLI 没有任何可编程的列举模型命令，无法满足上面的硬性条件，只能靠写死清单维持，因此不再作为 Provider 提供。升级时原先绑定它的 Agent 会被解绑并清除其凭据；如果该 Agent 没有其它可用的 Provider（fallback 链里也没有），且此前处于**已发布**状态，会被自动**停用**——避免它在没有执行引擎的情况下继续接收调用。改选其它 Provider、重新配置模型后，重新发布即可恢复。

## 安装 Agent CLI（首次部署必做）

Provider 只是「配置」，真正干活的是它背后的 CLI。**镜像不预装任何 CLI**——八个受支持 CLI 合计远超 1GB，而单个部署通常只用一两个，全部打进镜像会让体积随支持的 CLI 数量线性膨胀。因此改为按需安装。

> [!IMPORTANT]
> 全新部署或升级镜像后，请先安装本部署实际要用的 CLI，否则绑定该 Provider 的 Agent 无法运行。

**安装方式**（需要管理员）：

1. 进入「**Providers**」页，每张卡片上直接显示该 Provider 的 CLI 是否已安装，未安装时就地点「安装」即可。
2. 安装在后台进行，状态会自动刷新，无需守着页面。
3. 点开某个 Provider 进入详情页，「**Agent CLI**」卡片里有更完整的信息：可执行文件名、锁定版本、当前版本、失败原因，以及「卸载」。

安装使用**平台锁定的版本**并校验文件完整性，所以没有「填个版本号装最新版」的入口——升级某个 CLI 的版本由平台维护者统一调整。

> [!TIP]
> 已安装的 CLI 保存在持久卷里，**升级镜像后不会丢失**，不需要每次部署重装。但 `docker compose down -v` 会连卷一起删除，届时需要重新安装。

不再需要某个 CLI 时，可在该 Provider 详情页的「Agent CLI」卡片里点「卸载」释放磁盘空间。

> [!TIP]
> 内网、气隙或由 IT 统一管控的环境装不上、也升级不了平台锁定的版本时，可以让 a2wave 直接用机器上已有的二进制：给服务进程设置对应的环境变量指向它，跳过平台自己的安装流程。
>
> `CLAUDE_CODE_PATH`、`CODEX_PATH`、`CURSOR_AGENT_PATH`、`OPENCODE_PATH`、`QODER_PATH`、`KIMI_PATH`、`PI_PATH`、`TRAE_PATH`
>
> 不设时默认按二进制名（如 `claude`、`qodercli`）在 `PATH` 上查找。诊断里「升级」类提示提到的「让部署指向另一个二进制」，指的就是这个。

> [!NOTE]
> 锁定版本是**精确版本**，不是「最低版本」。如果服务器上装的 CLI 版本**高于**锁定版本，状态会显示「非托管版本」而不是提示更新——它通常能正常工作，只是不是平台验证过的那个构建。此时按钮是「重装为锁定版本」，点了会**换成锁定版本**（可能是降级），请按需决定。
>
> 版本**低于**锁定版本时，看该 Provider 的**最低版本要求**（见本节下方关于最低版本要求的说明）：仍满足要求的显示「低于锁定版本」，是可正常运行的状态，更新只是可选项；只有低于最低版本要求才显示「版本过低」并标黄，按钮提示会写明需要的版本。两种情况都可以点「更新」装成锁定版本。

> [!CAUTION]
> 旧版本数据库升级后，Providers 页面可能提示存在不受支持的历史 Provider。该记录会保留用于诊断，但不会进入 Agent 的可选列表；仍绑定它的 Agent 会收到配置错误。请先备份数据库，再由平台管理员迁移或清理该历史记录后重试。

> [!NOTE]
> 部分 Provider 对服务器上安装的 CLI 有**最低版本要求**（Qoder CLI ≥ 1.0.0、Trae CLI ≥ 0.120.0、OpenCode CLI ≥ 1.18.0、Kimi Code CLI ≥ 0.30.0、Pi CLI ≥ 0.83.0）。这是**下限**不是精确版本，更高版本同样可用。检测服务器登录态时会同时上报已安装版本，低于要求会给出升级提示；绑定该 Provider 的 Agent 跑「综合诊断」也会报出一条错误级检查，写明已装版本与最低要求。版本过低时模型拉取、登录检测等功能可能不可用，但平台不会因此阻断运行。平台锁定的版本都满足这些要求。

## 凭证模式（authMode）

在引用 Provider 的 Agent 上选择凭证注入方式：

- **apiKey**：注入 API Key（如 `ANTHROPIC_API_KEY` 或各 CLI 等价物；Qoder 为 Personal Access Token，Trae 为企业控制台生成的 CLI 登录令牌）。Codex 与 Pi 还可为每个 Agent 配置可选的 Base URL，以连接 OpenAI 兼容代理。
- **oauth**：注入 `CLAUDE_CODE_OAUTH_TOKEN`（仅 Claude Code 生效）。
- **localSession**：使用「运行 a2wave 的服务器或容器」中 CLI 的部署级共享登录态（**非你当前浏览器所在的电脑**），不注入任何凭证。所有选择同一 Provider localSession 的 Agent 共用这套身份。

Claude Code 使用 apiKey 模式时，需要显式选择「API Key 请求头」；a2wave 不会根据 Key 前缀猜测鉴权方式：

- **x-api-key（兼容默认值）**：使用 `ANTHROPIC_API_KEY` / `x-api-key`，执行时原样传递配置的 Base URL。已有配置以及未保存该字段的配置都保持此行为，无论 Key 是否以 `sk-` 开头。
- **Authorization: Bearer（代理 Token）**：使用 `ANTHROPIC_AUTH_TOKEN` / Bearer 鉴权。仅在执行时，如果 Base URL 以 `/v1` 结尾会移除该后缀。

Codex 的 apiKey 模式支持可选的 **Base URL**。a2wave 通过 Codex 官方的 `openai_base_url` 运行时设置传入；留空时使用 Codex 默认的 OpenAI 地址。localSession 模式会忽略 Agent 中残留的 API Key 与 Base URL，确保部署级登录态仍是唯一凭据来源。

> [!NOTE]
> API 返回的已保存 Key、Token 或 Base URL 会显示为掩码。模型探测是无状态请求，点击「测试连接 & 拉取模型」前需要重新填写被掩码的字段；否则界面会提示重新输入，而不会把 `********` 当作真实凭证发送。

对于会通过 CLI 访问已配置网关的 Provider，「测试连接 & 拉取模型」要求网关提供模型清单。Codex 与 Pi 是例外：它们的 CLI 不连接已配置代理即可枚举内置模型，因此拉取成功只确认 CLI 模型目录，不会验证 Key 或 Base URL；首次实际执行才是最终的连通性检查。

### Docker 中的 localSession

`docker-compose.yml` 会把 CLI 用户目录 `/home/appuser` 保存在 `a2wave-cli-home` 持久卷中。重新构建镜像、重建容器或执行 `docker compose down` 不会清除登录态；只有显式执行 `docker compose down -v`、删除该卷或清空凭证目录才会清除。

除 Claude Code 外，可在容器中以 a2wave 服务用户登录：

```bash
docker compose exec -u appuser a2wave qodercli login
```

将末尾命令替换为对应 CLI：

| Provider | 登录命令 | 默认持久化位置 |
|----------|---------|----------------|
| Claude Code | `claude login` | `~/.claude` |
| Codex | `codex login` | `~/.codex` |
| Cursor | `cursor-agent login` | `~/.cursor` |
| OpenCode | `opencode auth login` | `~/.local/share/opencode`、`~/.config/opencode` |
| Qoder | `qodercli login` | `~/.qoder` |
| Trae | `traecli` | `~/.trae` |
| Kimi Code | `kimi login` | `~/.kimi-code` |
| Pi | 运行 `pi`，再输入 `/login` | `~/.pi/agent` |

> [!NOTE]
> 为兼容已有部署，Compose 默认仍把宿主机 `${HOME}/.claude` 只读挂载到容器。Claude Code 请优先在宿主机完成登录；由 sudo/systemd 启动 Docker 时，用 `.env` 中的 `A2WAVE_CLAUDE_LOGIN_DIR` 指向实际登录目录。其他 Provider 默认使用 `a2wave-cli-home`。

> [!CAUTION]
> localSession 是部署级共享身份，不是 Agent 独立身份。需要不同 Agent 使用不同账号时，请使用各 Provider 的 apiKey 模式。

### OpenCode 的特殊性

OpenCode 是开源的多供应商聚合 CLI——你在服务器上自行配置各家模型供应商（Anthropic / OpenAI / 自建代理等）的接入与凭证，因此它在 a2wave 里**仅支持 localSession 模式**：

- 凭证与供应商定义都在**运行 a2wave 的服务器**上，由管理员通过 `opencode auth login` 与 OpenCode 配置文件维护，属于**部署级共享账号**——所有使用 OpenCode 的 Agent 共用这一套配置。
- 模型列表自动从服务器拉取，模型 id 为 `供应商/模型` 二段式（如 `anthropic/claude-opus-4-8`），可选项取决于服务器上配置了哪些供应商。
- 挂载的 MCP Server 与 Skill 由平台在每次运行时自动注入，无需在 OpenCode 侧手工配置。

> [!NOTE]
> 如果 Agent 需要各自独立的凭证，请选择 Claude Code / Codex / Cursor / Qoder / Trae / Pi 并使用 apiKey 模式。OpenCode 与 Kimi Code 适合「服务器统一配好一套模型，所有 Agent 共享」的场景；Pi 两种模式都支持。

### Qoder 与 Trae

- **Qoder CLI**：与 Claude Code 用法一致的国产 agent CLI。apiKey 模式填 **Personal Access Token**（在 qoder.com 账号「Integrations」页生成，只显示一次）；也可用服务器上 `qodercli login` 的登录态。模型支持 `auto` / `ultimate` 等档位，点「拉取模型」可获取账号实际可用清单。
- **Trae CLI**：字节 TRAE 的企业版 CLI，**仅对 TRAE CN 企业旗舰版账号开放**。apiKey 模式填企业控制台「访问令牌」页生成的 **CLI 登录令牌**（`trae-lt-...`，有有效期）；有企业专属域名时在「企业专属域名」栏填入。可用模型由企业控制台配置决定，点「拉取模型」在线获取。

### Kimi Code

- **Kimi Code CLI**：月之暗面（Moonshot AI）的 agent CLI（`kimi`），**仅支持 localSession 模式**：
  - 在服务器上执行 `kimi login` 登录，走设备码流程：命令会打印验证链接与用户码，在浏览器中确认授权即可。凭证保存在 `~/.kimi-code/credentials/`。
  - Kimi Code **有意不从环境变量读取 API Key**（只能写进它自己的 `config.toml`），因此没有 apiKey / oauth 模式可选——与 OpenCode 一样，服务器登录态是所有使用该 Provider 的 Agent 的**部署级共享身份**。
  - 模型是该账号已配置的别名（如 `kimi-code/k3`），点「拉取模型」可在线获取实际清单。
  - 挂载的 Skill 与 MCP Server 由平台自动写入工作区（`.kimi-code/skills` 与 `.kimi-code/mcp.json`），无需在 Kimi 侧手工配置。
  - 非交互运行始终使用 Kimi 的 `auto` 审批策略，因此 Agent 的「只读 / 强制执行 / 自动批准 MCP」执行选项对它不适用，界面上不会出现。

> [!NOTE]
> Kimi Code 不在输出中上报 Token 用量，因此使用它的运行记录 Token 显示为 0。详见[运行记录](/wiki/runs)。

### Pi

- **Pi CLI**（`@earendil-works/pi-coding-agent`）是精简的开源多供应商 coding agent。a2wave 支持两种凭据模式：
  - **localSession**（兼容默认值）：在服务器或容器内运行 `pi`，输入 `/login`，配置该部署要使用的供应商。Pi 默认把登录与配置状态保存在 `~/.pi/agent`；所有绑定 Pi 的 Agent 共用这套**部署级身份**。点击「拉取模型」可读取 Pi 实时的 `--list-models` 清单。
  - **apiKey**：填写 Agent 独立的 Key 与可选的 OpenAI 兼容 Base URL。「拉取模型」会执行 Pi 自己的离线 `--list-models openai` 命令，并展示它报告的内置 `openai/*` 模型。该过程不会调用代理的 `/models` 接口，也不会验证 Key；实际执行才会检查连通性。Pi CLI 目录之外的自定义模型 ID 在此模式下不可选。
  - 每次 apiKey 探测与运行时，a2wave 都会为 Pi 内置 `openai` Provider 创建私有的临时 `models.json` 覆盖配置。文件通过隔离的子进程环境变量引用 Key，真实 Key 不会进入命令参数或日志；结束后临时目录会被删除，也不会改写部署的 `~/.pi/agent` 配置。
  - a2wave 把选中的 Skills 写到 `.pi/skills`，并在每次运行时显式传入。a2wave 的无头 Pi 运行会关闭 Pi 的全局/项目 Skills 与 Extensions，只加载已挂载、已审核的 Agent Skills。
  - Pi 有意**不内置 MCP 客户端**。当 Agent 把 Pi（包括启用的 fallback）与已挂载 MCP Server 或 A2A 路由组合使用时，配置页会立即标出冲突；向已发布 Agent 保存该冲突、发布或恢复 Agent 时，a2wave 也会在更改在线配置、发布状态或启动渠道之前拒绝，而不是静默地在缺少这些工具的情况下继续运行。草稿或停用状态下仍可保存配置，以便移除 MCP 能力或更换 Provider。如果已有的已发布 Agent 被拒绝，请先停止 Agent，移除 MCP 能力或更换 Provider，保存修复后的配置，再恢复 Agent。上游 Pi Extension 可以扩展 MCP，但 a2wave 不会静默安装或信任这类扩展。
  - Pi 在 a2wave 中只暴露**只读**执行选项。启用后仅允许 Pi 内置的 `read`、`grep`、`find`、`ls` 工具；Pi 不提供操作系统级沙箱。
  - localSession 运行沿用服务器服务用户的 HOME，因此 `/login` 以及 AWS Profile、Google ADC 等依赖用户目录的供应商凭据在拉取模型和实际执行时保持一致。两种模式的会话文件都存放在每个 Agent 的隔离目录中：同一工作区内的后续消息会恢复原会话；切换 worktree 时会把已有上下文 fork 到所选 worktree，并返回新的 session ID。如果本地持久化会话已丢失，a2wave 会记录告警，并让 Pi 使用原 session ID 创建空的新会话；当前 chat 可以继续，但已丢失的上下文无法恢复。

> [!NOTE]
> Pi 的每个 assistant 事件记录一次供应商调用的用量，自动 compaction 事件记录独立的摘要调用用量。a2wave 会累加这些官方输入、输出、推理与缓存字段，并把 Pi 已包含在 output 中的 reasoning 拆开，避免重复计数。详见[运行记录](/wiki/runs)。

## 配置 Provider

凭证与模型都配置在 **Agent** 上，而不是 Provider 上——同一个 Provider 可以被多个 Agent 用不同账号使用，可用模型也随账号不同而不同。

1. 打开要配置的 Agent，进入「配置」页的 Provider 区块。
2. 选择 Provider，填入凭证（API Key / OAuth）或确认走服务器登录态。
3. 点「拉取模型」（部分 Provider 在凭证就绪后自动拉取），从返回的清单里选模型。
4. 保存。

> [!CAUTION]
> Codex Base URL 是凭证边界，必须在同一个 Agent Provider 绑定中配置对应 API Key；a2wave 不会把 Agent 自定义地址与部署级 Codex Key 拼在一起使用。Pi 的 apiKey 模式也必须在 Agent 绑定中提供 Key。缺少这些凭证时，发布、恢复或在线配置更新会在生效前被拒绝。

> [!TIP]
> 模型下拉里的每一项都是**这套凭证当前真正可用**的模型。换 Provider 或改凭证后清单会失效，需要重新拉取。

管理员如需安装或更新 Provider 背后的 CLI，到「Providers」→ 对应 Provider 详情页操作。

### 使用内网 Provider 地址

点击「测试连接 & 拉取模型」时，a2wave 会解析 Base URL，并默认拒绝指向私网或保留地址的结果，防止该入口被用于访问服务器内网。如果企业模型网关只通过私网 DNS 提供服务，请由部署管理员在 `.env` 中配置精确主机名白名单并重启服务：

```dotenv
TRUSTED_PROVIDER_HOSTS=llm-proxy.internal.example.com,trae.internal.example.com
```

只填写主机名，不要包含 `https://`、端口、路径或通配符。白名单允许该主机解析到常规企业私网地址（IPv4 私网/CGNAT、IPv6 ULA）；私网 IP 字面量、loopback、multicast 和其它保留地址仍会被拒绝。云元数据端点 `169.254.169.254`、阿里云 `100.100.100.200`、AWS IPv6 `fd00:ec2::254` 及其 IPv4 映射/NAT64/6to4 表示即使命中白名单也会硬拒绝。

Claude Code 的 OAuth 与服务器登录态模型探测始终连接固定端点 `https://api.anthropic.com/v1/models`。a2wave 仅对这条不受用户控制的请求允许常规企业私网 DNS 结果，无需配置 `TRUSTED_PROVIDER_HOSTS`；永不允许的危险地址段仍会被拦截。使用 `api.anthropic.com` 的自定义 Provider Base URL 不会继承该例外。

> [!CAUTION]
> 白名单按 hostname 生效，而不是按完整 URL 生效：命中后，该主机下的 HTTP(S) 端口和路径都属于信任范围。只添加企业控制的专用 Provider 网关域名，不要添加承载其它敏感服务的共享域名，也不要添加用户可控制解析结果的域名。

> [!NOTE]
> Claude Code 的模型探测会把校验后的地址固定到连接层；Trae 等由 CLI 子进程自行联网的 Provider 只能在启动前校验 DNS，无法固定子进程的实际连接地址。部署环境仍应通过 DNS 管理和出站网络策略限制其只能访问预期网关。

## 查看依赖与删除

- 每个 Provider 详情页可查看 **依赖它的 Agent 列表**（`GET /api/providers/:id/dependents`）。
- 删除前请先确认无 Agent 在用，否则会影响已发布 Agent 的运行。

## 排错

| 症状 | 可能原因 | 解决 |
|------|---------|------|
| Agent 一运行就报「CLI 未安装」 | 镜像不预装 CLI，该 Provider 的 CLI 还没装 | 在 Providers 页对应卡片上点「安装」 |
| 升级镜像后 Agent 突然跑不了 | 持久卷被删除（如执行过 `docker compose down -v`） | 在 Providers 页重新安装 |
| 安装失败并提示校验不通过 | 网络异常或下载被代理篡改 | 打开该 Provider 详情页，在「Agent CLI」卡片里查看错误详情后重试；内网需确保能访问 npm registry 与各 CLI 下载源 |
| 状态显示「非托管版本」 | 服务器上的 CLI 版本高于平台锁定版本 | 通常可正常使用；如需与平台验证过的构建一致，点「重装为锁定版本」 |
| 状态显示「低于锁定版本」 | CLI 版本低于平台锁定版本，但仍满足该 Provider 的最低版本要求 | 不影响运行，无需处理；想与平台验证过的构建一致再点「更新」 |
| Agent 模型下拉为空 | 还没拉取模型，或凭证无效 | 在 Agent 配置页填好凭证后点「拉取模型」 |
| 执行报鉴权失败 | API Key/Token 失效或留空 | 重填凭证；或改用 localSession |
| OAuth 不生效 | 在非 Claude Code 上用了 oauth | oauth 仅 Claude Code 支持 |
| 自定义 Base URL 拉取模型提示 `private or reserved address`，并建议配置 `TRUSTED_PROVIDER_HOSTS` | Provider 域名在 a2wave 服务器内解析到常规私网地址 | 确认该端点可信后，由部署管理员将精确主机名加入 `TRUSTED_PROVIDER_HOSTS` 并重启服务 |
| Claude Code OAuth 拉取模型提示 `private or reserved address` | 服务器 DNS 将固定上游 `api.anthropic.com` 映射到了 loopback、link-local/云元数据、multicast 或其它禁止的保留地址 | 修正服务器 DNS 或出口代理；固定 OAuth 探测请求已允许常规私网 DNS 结果，加入 `TRUSTED_PROVIDER_HOSTS` 也不会绕过危险地址段限制 |
| OpenCode 模型下拉为空 | 服务器上未配置 OpenCode 供应商或未登录 | 由管理员在服务器执行 `opencode auth login` 并配置供应商 |
| Qoder 拉取模型失败 | PAT 无效，或服务器 qodercli 版本低于 1.0.0 | 重新生成 PAT；或在服务器升级 `qodercli update` |
| 容器重建后 localSession 失效 | CLI HOME 持久卷被删除，或命令以 root 而非 appuser 登录 | 检查 `a2wave-cli-home` 是否存在，并用 `docker compose exec -u appuser a2wave ...` 重新登录 |
| Trae 拉取模型为空 | 令牌无效/过期，或企业控制台未配置模型 | 重新生成 CLI 登录令牌；联系企业管理员在 TRAE 控制台配置可用模型 |
| Kimi Code 模型下拉为空 | 服务器上未登录，或未配置供应商 | 由管理员在服务器执行 `kimi login`，然后重新拉取模型 |
| Pi localSession 模型下拉为空 | 部署级 Pi 配置中没有可用凭证或模型 | 以服务用户运行 `pi`，输入 `/login`，再重新拉取模型 |
| Pi apiKey 运行拒绝模型 | 已保存模型不是 Pi 探测返回的 `openai/*` ID | 重新拉取模型，并选择 Pi 返回的 `openai/*` 条目 |
| 发布或恢复提示 `PROVIDER_BINDING_INVALID` | Pi apiKey 模式缺少 Agent Key，或 Codex Agent Base URL 没有在同一绑定中配置 Key | 为该绑定填写 Key；或移除 Agent Base URL，继续使用部署级 Codex 端点 |
| 配置页提示 Provider 与 MCP 冲突，或 Pi Agent 报错 `PROVIDER_MCP_UNSUPPORTED` | Pi 不内置 MCP 客户端，但 Agent 挂载了 MCP Server、配置了 A2A 路由，或在使用 MCP 的 Provider 链中启用了 Pi fallback | 按提示移除 MCP 能力或 Pi fallback，或改用原生支持 MCP 的 Provider，再重新发布或恢复；如需接入可信 Pi MCP Extension，先走明确的产品边界评审 |
| 删不掉 Provider | 仍有 Agent 依赖 | 先在 dependents 列表里改这些 Agent |

> [!CAUTION]
> 凭证属敏感信息，遵循企业安全规范保管，不要写进系统提示词或公开渠道。

## 相关

- [Agent 管理](/wiki/agents) · [核心理念与架构](/wiki/concepts) · [Skill 技能](/wiki/skills)
