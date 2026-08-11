# SCM Source

An SCM Source lets an Agent read and write code repositories. Both **Git** and **Perforce (P4)** are supported.

A Git source can create an independent **worktree (workspace)** per execution, so parallel tasks do not interfere with each other. **P4 does not support worktrees**: every execution on the same source shares a single checkout (see "P4 Source" below).

## Git Source

Key fields:

- `repoUrl`: the repository address.
- `branch`: the branch, default `main`.
- `username` / `pat`: the username and Personal Access Token for private repositories.
- `autoSync` / `syncIntervalMin`: whether to auto-sync, and the interval (minutes, default 30).
- `initialSyncTimeoutMin`: the initial sync timeout (minutes, default 60).
- `codegraphEnabled`: enable CodeGraph indexing. After a successful sync, `.codegraph/` is maintained automatically to improve code Q&A and call-chain localization.
- `repos`: multi-repository support, each item `{repoUrl, branch, directory}` (`directory` cannot contain `/` or `..`).

When mounted onto an Agent for execution, the `GIT_BRANCH` environment variable is injected.

## P4 Source

Key fields: `p4port`, `p4user`, `p4passwd`, `p4client`, optional `depotPath`, plus the same `autoSync` / `syncIntervalMin` / `initialSyncTimeoutMin` / `codegraphEnabled` as above. On execution, environment variables such as `P4PORT` / `P4USER` / `P4PASSWD` / `P4CLIENT` are injected.

> ⚠️ **P4 has no workspace isolation.** `p4client` points at a client that already exists on the P4 server, and that client's `Root` is server-side and singular, so a2wave cannot open a second checkout for one execution. Every execution on the same P4 source therefore **shares one working directory**: chat, evaluations and scheduled syncs interfere with each other when they overlap.
>
> **Evaluations** are hit hardest — their value lies in comparable results, and anything else running against the shared directory can change what is being measured. The UI warns when you start one; prefer a window when the source is idle. Git sources are not subject to this limit.

## Creating and Connecting

1. Go to the "SCM Sources" page, click "Create source", and choose Git or P4 in the dialog.
2. Enter the repository address and authentication information on the "Config" tab.
3. Once the connection fields are filled in, click **Test Connection** below that section (**Test All Repos** in multi-repo mode) to verify connectivity. It probes using the values **currently in the form** and saves nothing, so you can test before creating the source; multi-repo results list each repository's pass/fail with its own reason.
4. After saving, reopen the source: the dialog gains a "Sync & Workspaces" tab where you use **Check connection** to re-verify the **saved** configuration and trigger a **sync** (the workspaces/worktree list is managed on that tab too).

> When editing an existing source, the PAT / P4 password are shown masked. As long as you leave them untouched, Test Connection probes with the real stored credential.

## CodeGraph Indexing

Once CodeGraph is enabled, a2wave maintains the index automatically after the SCM Source syncs successfully:

- When `localPath/.codegraph` does not exist, it runs `codegraph init <localPath>`.
- When it already exists, it runs `codegraph sync <localPath>`.
- An indexing failure only updates the CodeGraph status and last error; it does not mark the code sync as failed.
- For an existing SCM Source in production, after enabling it you can click **Index now**, without waiting for the next Git / P4 sync.

> The runtime environment needs the `codegraph` CLI, but **the image does not preinstall it** — like every Agent CLI, it is installed on demand. It backs code indexing rather than a Provider, so it has no UI entry: an administrator installs it once via `POST /api/provider-clis/codegraph/install`. The install lives on a persistent volume and survives image upgrades. For custom deployments, confirm that `codegraph --version` can run in the API process environment.

## Sync and Initial-Sync Constraints

- **Manual sync / sync status**: `idle` / `syncing` / `error`.
- ⚠️ **Important constraint**: an SCM Source can only be selected by an Agent **after its initial sync succeeds** (writing `initialSyncCompletedAt`). Before that, creating/updating an Agent bound to the source is rejected.
- **Cannot change the repo path/config mid-sync**: changing `localPath` or `config` while a sync is in progress returns **409**. Those fields reset the sync bookkeeping, and resetting during a running sync would corrupt it. Wait for the sync to finish first.

## Workspace (worktree) Management

> [!NOTE]
> Every Agent bound to a Git source automatically gets its **own workspace** (named `agent-<Agent ID suffix>`, visible in the workspace list). All of an Agent's executions happen inside its own workspace, so Agents never interfere with each other; the source directory itself is only used for syncing code. The workspace follows the source's latest code before each execution; if the Agent has uncommitted changes or commits that have not been merged yet, following pauses to protect that work and resumes automatically once those commits reach the source branch. The Agent's commits land on a branch named after the workspace (exposed to the execution environment as `A2WAVE_WORKSPACE_BRANCH`); deleting the Agent reclaims its workspace.

- **List workspaces**: view all worktrees under the source and whether each is in use (`occupied`).
- **Delete a workspace**: delete a specified worktree; if it is in use, it returns **409** and must be released first.
- **Custom root directory workspacesPath**: an optional absolute path that overrides the default `~/.a2wave/workspaces/<sourceIdSuffix>`. It must be globally unique. Non-admin users must choose a path under a root approved by the deployment operator through `SCM_WORKSPACES_ALLOWED_ROOTS`; admins may select another dedicated absolute root. The Docker Compose deployment approves its dedicated `/data/workspace` mount by default. Database, Skill, knowledge base, memory, log, attachment, and artifact storage cannot be used as workspace roots for any role. A legacy row saved before these checks remains visible for migration, but source updates/status and workspace resolution/list/create/delete are rejected until its path is moved to an approved dedicated root. The owner's current admin and active status is rechecked on every workspace use.

> The worktree cleanup policy for a single invocation (ephemeral / ttl / persistent) is determined by the `worktree` parameter at trigger time; see [Trigger Methods](/wiki/triggers) and [Runs](/wiki/runs).

## Troubleshooting

| Symptom | Possible Cause | Fix |
|------|---------|------|
| Agent can't select the SCM Source | Initial sync not completed | Sync successfully once first |
| Sync error | Credentials/network/branch doesn't exist | Investigate with "Check connection", confirm the PAT and branch |
| Deleting a worktree returns 409 | It is in use | Wait for the corresponding Run to finish or release it, then delete |
| workspacesPath not taking effect | Not absolute, outside `SCM_WORKSPACES_ALLOWED_ROOTS`, overlaps protected platform storage, or conflicts with another source | Use a unique path under the default workspaces directory or ask the operator to approve a dedicated worktree volume |
| `Unsafe saved workspacesPath` on an upgraded source | A legacy custom root is no longer authorized for its current owner | Update the source to the default directory or an operator-approved dedicated root before using workspaces |

## Related

- [Agent Management](/wiki/agents) (workspaceType=scm) · [Runs](/wiki/runs) · [Trigger Methods](/wiki/triggers)
