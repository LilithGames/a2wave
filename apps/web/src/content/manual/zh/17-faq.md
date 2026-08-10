# 常见问题（FAQ）

## a2wave 自己会跑模型吗？

不会。a2wave 是 **编排层**，执行来自底层 agent CLI（Cursor / Claude Code / Codex）。平台不自建 LLM 推理、代码执行或沙箱。必须先配好 [Provider](/wiki/providers) 才能让 Agent 运行。详见 [核心理念与架构](/wiki/concepts)。

## 加新能力该用 Skill 还是 MCP，还是知识库/记忆？

- 调外部系统/工具 → [MCP Server](/wiki/mcp-servers)
- 封装可复用流程或知识 → [Skill](/wiki/skills)
- 可检索的事实资料 → [知识库](/wiki/knowledge-base)
- 跨会话的偏好与历史 → [长期记忆](/wiki/memory)

原则是「扩展靠组合」：能用 Skill / MCP 解决的，就不该做成平台内置功能。

## 为什么飞书 Agent 收不到消息？

最常见是 **飞书长连接被占用**：同一飞书 App ID 在单个 API 进程内只允许一条活跃长连接，先启动者优先。多个 Agent 接飞书请各用 **独立飞书应用**。连接状态可直接在「发布」页的渠道卡片上查看（飞书 / Slack / Discord 都会显示各自的协议与实时状态），也可在 Agent「综合诊断」中查看。详见 [触发方式](/wiki/triggers)。

## API 调用为什么默认不直接返回结果？

`/invoke` 的 `async` 默认 **true**，立即返回 `runId`，需轮询 `runs/:runId`。要同步拿结果，传 `"async": false`（见 [触发方式 · API](/wiki/triggers)）。

## 调用返回 429 怎么办？

先看 `error.code`：

- `RATE_LIMITED`：调用方超过 API 请求频率，按 `Retry-After` 等待后重试。
- `AGENT_QUEUE_FULL`：Agent 执行队列已满，等已有 Run 完成；Agent 所有者也可以评估调整 `maxConcurrency`。

两者虽然都是 HTTP 429，下一步不同，不要只按状态码处理。

## Agent 发布后没反应 / 输出为空？

1. 详情页跑 **综合诊断**，检查 Provider 与执行引擎。
2. 到 [运行记录](/wiki/runs) 看对应 Run 的日志与错误。
3. 确认触发配置正确（API Key、飞书应用、cron 表达式等）。

## 我看不到某个 Agent？

Agent 按成员权限隔离，你只能看到自己是 owner/editor/viewer 的 Agent。请联系其 owner 加你为成员，详见 [成员管理](/wiki/members)。

## 重启后 Agent 的记忆没了？

记忆存于本地 `./data`。容器部署必须把 `./data` 挂为持久卷，否则重启丢失。详见 [长期记忆](/wiki/memory)。

## 支持匿名调用吗？

不支持。a2wave 企业级约束优先：不支持匿名调用、不跳过认证。

## 克隆 Agent 后凭证还在吗？

不在。克隆会清空所有 `sensitive` 环境变量与 Provider 凭证（仅保留 `authMode` 提示你重填）。

## 使用手册在哪里打开？

点左下角你的头像，在弹出菜单里选「使用手册」，就会打开当前这份手册（`/wiki`）。这个入口在「关于」的上方，不在左侧导航栏里。

## 退出登录要确认吗？

要。点「退出登录」后会弹出二次确认，避免误触。确认之后当前登录凭证会被吊销，需要重新登录才能继续使用；点「取消」则保持登录状态。

## 如何查看平台版本和更新记录？

点击左下角用户菜单中的「关于」，弹窗会显示产品简介、开发者信息与当前版本号，并提供两个入口：

- **更新日志**：跳转到 [更新记录](/changelog) 页面，查看各版本变更历史。
- **GitHub**：新窗口打开 a2wave 开源仓库。

## 如何获取 a2wave CLI？

点击左下角用户菜单中的「获取 CLI」，安装命令会直接复制到剪贴板，粘贴到终端执行即可：

```bash
npm i -g a2wave
```


## 管理员密码是怎么设置的？

由**部署 a2wave 的运维人员**在安装时设置，有两种途径：

- 用 `a2wave setup` 安装时，在交互式终端里会提示输入两次管理员密码（不回显），装完即可登录。加了 `--yes` 的非交互安装会跳过这一步。
- 跳过或未提示时，首次打开平台地址，页面会引导设置管理员密码，不需要额外的验证码。

密码只在当前终端或浏览器里输入，不会写进配置文件、容器环境变量或命令行参数。注意：管理员密码设置前，初始化接口是不鉴权的，谁先完成初始化谁就是管理员——请部署后立即初始化，或直接用 `ADMIN_PASSWORD` 部署来跳过这个窗口。

## 管理员忘记密码怎么办？

这一步同样由运维人员在服务器上执行，普通用户无需操作，也无法自行处理——请联系管理员按下面的方式恢复：

- 用 `a2wave setup` 命令安装的实例：在能访问该服务器的终端里运行 `a2wave setup --reset-password`，按提示输入两次新密码（不回显），立即生效，无需重启。
- 其他 Docker 部署：`docker exec -it --user appuser <容器名> node /app/apps/api/dist/scripts/set-admin-password.js`。

新密码只在容器内输入，不会经过命令行历史或日志。重置会同时**吊销该管理员所有已登录的会话和 token**，需要重新登录。**不要**通过修改 `ADMIN_PASSWORD` 环境变量来找回密码——它只在 admin 账号从未设置过密码时才生效，管理员已有密码时修改它不会有任何作用。

## 怎么把平台升级到新版本？

这一步由运维人员在服务器上执行，普通用户无需操作。

用 `a2wave setup` 安装的实例，在能访问该服务器的终端里运行：

```bash
a2wave setup --upgrade --image <新镜像>
```

`--image` 可以省略，省略时会升级到与当前 CLI 版本一致的官方镜像（`ghcr.io/lilithgames/a2wave:<CLI 版本>`）——平台与 CLI 共用同一条版本线，所以先 `a2wave update` 再 `a2wave setup --upgrade` 就能把实例升到对应版本。只有在使用自建或私有镜像时才需要显式传入。

它只改写 `.env` 里的 `A2WAVE_IMAGE` 这一行（compose 文件通过变量读取镜像），然后重新拉取并重建 a2wave 服务，等到实例通过健康检查和就绪检查才算成功。命令本身**不会删除数据卷**，`.env` 里除镜像外的内容（`AUTH_SECRET`、`COMPOSE_PROJECT_NAME` 等）逐字节保留，所以登录会话不受影响；`docker-compose.yml` 不会被重新生成，手工加过的挂载、`extra_hosts` 等本地改动原样保留。

如果新镜像起不来或迟迟不就绪，会自动恢复到升级前的镜像并重新启动，确认健康后才结束。

**升级会自动备份数据卷**：开始前会先停容器（避免复制到写了一半的 SQLite 文件），把整个数据卷打包成 `a2wave-data-<时间戳>.tar.gz` 放在安装目录里（文件权限 0600，且只保留最近 3 份 —— 里面是完整数据库，包含凭证和令牌），备份失败会先把容器重新拉起再中止，不会让实例停在停机状态。如果你有自己的快照方案，可以用 `--no-backup` 跳过。

自动回滚不是万能的，所以这份备份很重要：新版本可能已经执行了不可逆的数据库迁移，旧版本读不了迁移后的数据、因而起不来——回滚了**镜像**并不等于回滚了**数据**。这种情况命令会明确提示需要人工处理，而不是假装成功。用备份恢复时**按下面的顺序来**，不要图省事合成一条命令：

**1. 先停服务。** 容器可能还在跑并持有 SQLite，边写边删会直接损坏数据库：

```bash
cd <安装目录> && docker compose stop a2wave
```

**2. 验证备份可读**，确认里面确实有数据库 —— 先删数据再发现压缩包是坏的就没有退路了：

```bash
tar tzf a2wave-data-<时间戳>.tar.gz | grep a2wave.db
```

**3. 恢复到一个新卷**，而不是就地覆盖。原卷保持不动，恢复失败还能退回去：

```bash
docker volume create <项目名>_a2wave-restore
docker run --rm -v <项目名>_a2wave-restore:/data -v "$PWD":/backup alpine \
  tar xzf /backup/a2wave-data-<时间戳>.tar.gz -C /data
```

**4. 让 compose 挂到新卷。** 注意**不要**去改 service 里的 `a2wave-data:/app/data` —— compose 会给逻辑卷名再加一次项目名前缀，直接改名会挂到一个自动新建的空卷。正确做法是保持 service 不动，只把顶层 `volumes:` 的 `a2wave-data` 声明成外部卷：

```yaml
volumes:
  a2wave-data:
    external: true
    name: <项目名>_a2wave-restore
  a2wave-cli-home:
```

**5. 启动并核验**（`-p` / `-f` 都要显式带上，避免解析到别的项目或文件）：

```bash
docker compose -p <项目名> -f <安装目录>/docker-compose.yml up -d --no-deps a2wave
curl -fsS localhost:<端口>/api/health/ready
```

`curl -fsS` 会在非 2xx 时以非零码退出，比只看输出可靠。除了健康检查，**再登录确认业务数据确实回来了**（Agent 列表、运行记录），然后才删除旧卷。

## 能用 PostgreSQL 作为数据库吗？

可以，但**默认且推荐的仍是 SQLite**——单容器、零外部依赖，单实例部署下它就是最优解。PostgreSQL 是**实验性**后端，面向需要多实例部署的场景；注意**没有 SQLite → PostgreSQL 的数据迁移工具**，切换意味着从空数据库开始。

安装时选择（由运维人员执行）：

```bash
# 连接外部 PostgreSQL（9.6 及以上）
a2wave setup --database-url postgres://用户:密码@数据库地址:5432/a2wave

# 或让安装器在 compose 里内置一个 postgres:16-alpine 服务，
# 密码自动生成到安装目录的 .env（权限 0600）
a2wave setup --with-postgres
```

两个参数互斥，也不能与 `--upgrade` 同用。已装好的实例要切换后端，编辑安装目录 `.env` 里的 `DATABASE_URL` 再 `docker compose up -d` 即可（同样从空库开始）。

> [!WARNING]
> 数据库地址不要写 `localhost`——容器里的 localhost 是容器自己。数据库跑在宿主机上时，用 `host.docker.internal`（Docker Desktop）或宿主机 IP。另外，PostgreSQL 实例升级时的自动备份只覆盖数据卷、**不包含数据库本身**，升级前请先自行 `pg_dump`。

## 还有问题？

查站内 API 文档 `/api/docs`（Swagger UI），或联系平台管理员。
