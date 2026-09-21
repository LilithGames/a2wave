# 可观测性（OpenTelemetry）

a2wave 可以把每一次 Agent 执行导出为一条标准的 **OpenTelemetry Trace**，推送到你已有的可观测平台（OTel Collector、Jaeger、Grafana Tempo、阿里云 ARMS、Arize Phoenix 等）。这样你就能在熟悉的 APM 里看到：一次执行花了多久、重试了几次、调用了哪些工具、每个工具耗时多少、用了多少 Token。

> [!NOTE]
> a2wave 只负责**导出**，不保存任何遥测数据。存储、查询和看板由你的采集端负责。每次执行本身的输入输出与日志仍然在 [运行记录](/wiki/runs) 里。

## 一条 Trace 长什么样

```
invoke_agent <Agent 名称>        一次执行
└─ attempt                       每次重试 / 切换 Provider 各一段
   └─ execute_tool <工具名>      每次工具调用，带真实起止时间
```

| 层级 | 你能看到什么 |
|------|--------------|
| `invoke_agent` | Agent、模型、触发渠道、总 Token、重试次数、最终结果（成功 / 失败 / 超时 / 已取消） |
| `attempt` | 第几次尝试、用的是哪个 Provider 和模型、这次尝试自己的 Token |
| `execute_tool` | 工具名、调用耗时、成功还是失败 |

所有 Provider（Claude Code、Codex、Cursor 等）导出的结构完全一致。属性遵循 OpenTelemetry 的 GenAI 语义约定（`gen_ai.*`），主流 APM 可以直接识别。

> [!NOTE]
> 有的 Provider 不上报 Token 用量，这时 Trace 里不会出现 Token 属性，而不是显示为 0。

## 开启导出（管理员）

1. 进入「设置 → 链路追踪」。
2. 填写**采集端地址**：OTLP/HTTP 基础地址，例如 `http://otel-collector:4318`，系统会自动补上 `/v1/traces`（输入框下方实时显示实际上报地址）。平台给的是完整上报地址也可以直接填。
3. 采集端需要鉴权时，点「添加请求头」，填入名称（如 `Authorization`）和值。
4. 点「测试连接」。测试用的是**当前填写的内容，无需先保存**：系统会向采集端写入一条带 `a2wave.test=true` 标记的测试 Trace，并显示它的 Trace ID，你可以拿这个 ID 到 APM 里确认确实收到了。
5. 打开「启用导出」并点「保存」。此后的每次执行都会导出。

> [!NOTE]
> 用 Docker 等容器部署 a2wave 时，`127.0.0.1` / `localhost` 指的是 a2wave 容器自身，而不是宿主机。采集端跑在宿主机上请填 `http://host.docker.internal:4318`，或填采集端的网络地址。

| 配置项 | 说明 |
|--------|------|
| 启用导出 | 关闭时不产生任何数据，对执行没有开销 |
| 采集端地址 | 只支持 OTLP/HTTP（`http://` 或 `https://`），不支持 gRPC |
| 鉴权请求头 | 加密保存，值不会再显示。已保存的请求头按名称逐行列出，值显示为掩码：不动它表示不修改，点进去填入新值即替换，点移除并保存即删除；改名请先移除再添加 |
| 采集内容 | 见下一节，默认关闭 |
| 服务名（高级选项） | 在 APM 里显示的服务名，默认 `a2wave` |
| 资源属性（高级选项） | 附加到每个 span 的属性，`key=value`，多个用逗号分隔，例如 `deployment.environment=prod` |

> [!TIP]
> 使用 Arize Phoenix 时，在「资源属性」里填 `openinference.project.name=<项目名>`，Trace 就会归到该项目下；不填则进入 `default` 项目。

> [!TIP]
> 只能配置一个采集端。需要同时发往多个平台时，让 a2wave 发给你自己的 OTel Collector，再由 Collector 分发。

## 采集内容（默认关闭）

默认情况下，导出的只有**元数据**：耗时、Token、模型、状态、工具名。用户的提问、Agent 的回复、工具入参、报错文本都**不会**离开 a2wave。

打开「采集内容」后，这些内容会一并写进 Trace，便于排查具体某次执行说了什么、调了什么。

> [!WARNING]
> 打开后，对话内容会发送到外部采集端。请先确认采集端的访问权限和数据留存策略符合你的要求。
> 系统会自动掩码平台注入的密钥（Provider Key、Agent 环境变量、MCP 凭据等）以及形如 `Bearer …`、`sk-…` 的令牌，并把每段内容截断到 4096 个字符，但无法识别业务数据里的敏感信息。

切换「采集内容」会记入审计日志（仅管理员可查看）。

## 多个 Agent、多个系统串成一条链路

- **Agent 调 Agent**：一个 Agent 通过路由调用另一个 Agent 时，两次执行会出现在同一条 Trace 里，下游执行挂在上游那次尝试的下面。
- **从你的系统调用 Agent**：调用 [API 或 A2A](/wiki/triggers) 时带上标准的 `traceparent` 请求头，Agent 的执行就会接到你自己系统的 Trace 上。格式不合法的请求头会被忽略，不影响调用本身。
- **排队和重启**：排队等待的执行、服务重启后恢复的执行，仍然会接到原来的 Trace 上。
- **重试**：系统自动重试留在原 Trace 里；你在界面上手动点「重试」则会开一条新的 Trace。

## 查看导出状态

「设置 → 链路追踪」底部会显示最近一次成功上报的时间、最近的错误，以及被丢弃的 span 数量。

| 现象 | 可能原因 |
|------|----------|
| 测试连接提示「上报失败」 | 地址或端口不对、采集端没有开启 OTLP/HTTP 接收、网络不通。提示里会带上实际请求的地址 |
| 测试连接提示「连接被拒绝」并提到容器 | 容器部署下填了本机地址，改用 `host.docker.internal` 或采集端的网络地址 |
| 最近错误为 `Unauthorized` / 401 | 鉴权请求头缺失或已失效，重新填写后保存 |
| 已丢弃 span 持续增长 | 采集端不可达。a2wave 不会重试也不会落盘，超出内存缓冲的数据会直接丢弃，**不影响 Agent 执行** |
| 改了配置但部分请求不生效 | 多副本部署时，导出状态和配置按实例生效，其他副本需要重启 |

> [!NOTE]
> 采集端出问题永远不会导致 Agent 执行失败或变慢——遥测只是旁路观察。

## 用环境变量配置

运维也可以不进界面，直接用环境变量配置（启动时生效）：

| 变量 | 说明 |
|------|------|
| `SETTINGS_OTEL_ENABLED` | `true` 开启导出 |
| `SETTINGS_OTEL_ENDPOINT` | 采集端地址 |
| `SETTINGS_OTEL_HEADERS` | 鉴权请求头，JSON 格式，如 `{"Authorization":"Bearer xxx"}`；启动时加密保存 |
| `SETTINGS_OTEL_CAPTURE_CONTENT` | `true` 开启采集内容，默认 `false` |
| `SETTINGS_OTEL_SERVICE_NAME` | 服务名，默认 `a2wave` |
| `SETTINGS_OTEL_RESOURCE_ATTRIBUTES` | 资源属性，`key=value` 用逗号分隔 |

## 目前的限制

- 只导出 Trace，不导出 Metrics 和 Logs；需要指标时可在 APM 里从 Trace 派生。
- 没有「单次模型调用」这一层，Token 是整次执行（或整次尝试）的总量。
- 看不到工具的返回内容，只有工具名、入参（开启采集内容时）和耗时。
- 开启之前的历史执行不会补发。
