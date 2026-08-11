# SCM 代码源

SCM 代码源让 Agent 能读写代码仓库。支持 **Git** 与 **Perforce（P4）** 两类。

Git 代码源可以为执行创建独立的 **worktree（工作区）**，从而让并行任务互不干扰；**P4 不支持 worktree**，同一代码源上的所有执行共用一份 checkout（见下方「P4 代码源」）。

## Git 代码源

关键字段：

- `repoUrl`：仓库地址。
- `branch`：分支，默认 `main`。
- `username` / `pat`：私有仓库的用户名与 Personal Access Token。
- `autoSync` / `syncIntervalMin`：是否自动同步、间隔（分钟，默认 30）。
- `initialSyncTimeoutMin`：初次同步超时（分钟，默认 60）。
- `codegraphEnabled`：启用 CodeGraph 索引。同步成功后自动维护 `.codegraph/`，用于提升代码问答与调用链定位。
- `repos`：多仓库支持，每项 `{repoUrl, branch, directory}`（`directory` 不能含 `/` 或 `..`）。

挂到 Agent 执行时会注入 `GIT_BRANCH` 环境变量。

## P4 代码源

关键字段：`p4port`、`p4user`、`p4passwd`、`p4client`、可选 `depotPath`，以及同上的 `autoSync` / `syncIntervalMin` / `initialSyncTimeoutMin` / `codegraphEnabled`。执行时注入 `P4PORT` / `P4USER` / `P4PASSWD` / `P4CLIENT` 等环境变量。

> ⚠️ **P4 没有工作区隔离**。`p4client` 指向 P4 服务端已有的 client，而 client 的 `Root` 由服务端决定、只有一个，因此 a2wave 无法为单次执行另开一份 checkout。这意味着同一 P4 代码源上的**所有执行共用一份工作目录**：在线对话、评测、定时同步同时进行时会互相影响。
>
> 影响最大的是**评测** —— 评测的价值在于结果可比，而共用工作目录期间的任何其他执行都可能改变被测对象。发起评测时页面会给出提示，建议在该代码源空闲时进行。Git 代码源不受此限制。

## 创建与连接

1. 进入「代码源」页面，点击「创建代码源」，在弹窗里选 Git 或 P4。
2. 在「配置」标签页填仓库地址与认证信息。
3. 填完连接信息后，点该区块下方的 **测试连接**（多仓库模式为 **测试所有仓库**）验证连通性。它使用**当前表单里的值**探测、不会保存配置，因此新建时也能先测再存；多仓库会逐个列出每个仓库的成功/失败与失败原因。
4. 保存后再次打开该代码源，弹窗会出现「同步与工作区」标签页：用 **检测连接** 复核**已保存**的配置，并触发一次 **同步**（工作区/worktree 列表也在此标签页管理）。

> 编辑已有代码源时，PAT / P4 密码在界面上显示为掩码。只要你没有改动它们，测试连接会自动使用已保存的真实凭据。

## CodeGraph 索引

开启 CodeGraph 后，a2wave 会在代码源同步成功后自动维护索引：

- `localPath/.codegraph` 不存在时执行 `codegraph init <localPath>`。
- 已存在时执行 `codegraph sync <localPath>`。
- 索引失败只更新 CodeGraph 状态与最近错误，不会把代码同步标记为失败。
- 对线上已有代码源，开启后可点击 **立即索引**，无需等待下一次 Git / P4 同步。

> 运行环境需要 `codegraph` CLI，但**镜像不预装它**（和各个 Agent CLI 一样都是按需安装）。它服务于代码索引而非某个 Provider，因此界面上没有安装入口，需由管理员调用 `POST /api/provider-clis/codegraph/install` 安装一次；安装结果保存在持久卷里，升级镜像不会丢失。自定义部署请确认 `codegraph --version` 可在 API 进程环境中执行。

## 同步与初次同步约束

- **手动同步 / 同步状态**：`idle` / `syncing` / `error`。
- ⚠️ **重要约束**：代码源**只有在初次同步成功后**（写入 `initialSyncCompletedAt`）才能被 Agent 选用。在此之前创建/更新绑定该源的 Agent 会被拒绝。
- **同步进行中不可改仓库路径/配置**：当一次同步正在进行时，修改 `localPath` 或 `config` 会返回 **409**。这些字段会重置同步记录，若在同步运行中重置会破坏正在进行的同步。请等同步结束后再改。

## 工作区（worktree）管理

> [!NOTE]
> 每个绑定 Git 代码源的 Agent 会自动获得一个**专属工作区**（名为 `agent-<Agent ID 后缀>`，在工作区列表中可见）。Agent 的所有执行都发生在自己的工作区里，不同 Agent 互不干扰；源目录本身只用于同步代码。专属工作区在每次执行前自动跟进源的最新代码；如果 Agent 在里面留有未提交的改动或尚未合并的提交，会暂停跟进以保护现场，等这些提交合入源分支后自动恢复。Agent 的提交落在与工作区同名的分支上（执行环境中通过 `A2WAVE_WORKSPACE_BRANCH` 可读到分支名）；删除 Agent 时其专属工作区一并回收。

- **列出工作区**：查看该源下所有 worktree，并标识是否被占用（`occupied`）。
- **删除工作区**：删除指定 worktree；被占用时返回 **409**，需先释放。
- **自定义根目录 workspacesPath**：可选绝对路径，覆盖默认 `~/.a2wave/workspaces/<sourceIdSuffix>`，且必须全局唯一。普通用户必须选择部署管理员通过 `SCM_WORKSPACES_ALLOWED_ROOTS` 批准的根目录；管理员可选择其他专用绝对路径。Docker Compose 默认批准专用挂载 `/data/workspace`。任何角色都不能把数据库、Skill、知识库、记忆、日志、附件或产物目录作为 workspace 根目录。在这些检查上线前保存的旧记录仍可查看和迁移，但更新/状态查询以及 workspace 的解析、列出、创建、删除都会被拒绝，直到改为批准的专用根目录；每次使用 workspace 时都会重新检查属主当前是否仍是启用状态的管理员。

> 单次调用的 worktree 清理策略（ephemeral / ttl / persistent）由触发时的 `worktree` 参数决定，详见 [触发方式](/wiki/triggers) 与 [运行记录](/wiki/runs)。

## 排错

| 症状 | 可能原因 | 解决 |
|------|---------|------|
| Agent 选不到代码源 | 未完成初次同步 | 先成功 sync 一次 |
| 同步报错 | 凭证/网络/分支不存在 | 用「检测连接」排查，确认 PAT 与分支 |
| 删 worktree 返回 409 | 正被占用 | 等对应 Run 结束或释放后再删 |
| workspacesPath 不生效 | 非绝对路径、超出 `SCM_WORKSPACES_ALLOWED_ROOTS`、与平台受保护存储重叠，或与别的源冲突 | 使用默认 workspace 目录下的唯一路径，或请部署管理员批准专用 worktree 卷 |
| 升级后的代码源提示 `Unsafe saved workspacesPath` | 旧自定义根目录对当前属主不再授权 | 先把代码源改为默认目录或部署管理员批准的专用根目录，再使用 workspace |

## 相关

- [Agent 管理](/wiki/agents)（workspaceType=scm） · [运行记录](/wiki/runs) · [触发方式](/wiki/triggers)
