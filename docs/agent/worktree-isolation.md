# Per-Agent Worktree Isolation

Git SCM Agents run in **per-Agent worktrees** — `agent-<agentId suffix>`,
`persistent`, `followSource`. Companion doc: durable cross-replica arbitration of
those directories lives in [scm-storage-invariants.md](./scm-storage-invariants.md).

## Why the shared checkout is no longer executed in

The shared `localPath` checkout is only **synced into**. Agents sharing one Source
stopped sharing a working directory because a run of Agent B re-mounting
`.claude/skills` deleted the files Agent A's in-flight run was executing.

## Branch contract

- The worktree sits on a branch **named after it**, so `git branch --show-current`
  answers — the contract git-sync keeps for the shared checkout.
- `GIT_BRANCH` keeps meaning the **Source's tracked branch**.
- `A2WAVE_WORKSPACE_BRANCH` is owned by `resolveWorkDir` and set **only when the
  run actually lands in its per-agent worktree** — absent on explicit-worktree,
  evaluation, fallback and P4 runs. A wrong value would send the agent to move a
  checkout it does not own.

## The reserved `agent-` prefix

- Explicit worktree names may not use the reserved `agent-` prefix — rejected at
  the request entry points (**400**), so persisted legacy configs keep replaying.
- Legacy configs are neutralized in **one place**: `normalizeWorktreeParams` drops
  any worktree params whose name has the per-agent shape, so the run lands in the
  Agent's own worktree instead of taking the explicit path. Taking the explicit
  path would write the workspace's state file, switch its branch off
  `agent-<id>` — after which followSource skips it **forever** — and expose it to
  run-end cleanup.
- Guarding each of those ends separately is what made the same legacy branch
  resurface for **three review rounds**. The downstream guards remain as defense
  in depth but no longer carry the case.

## Advancing to the synced HEAD

- On reuse the worktree advances **only through the ancestor guard**
  (`merge-base --is-ancestor`).
- Tracked modifications or unmerged agent commits **pin** it — with a warn log —
  and it unpins by itself once those commits reach the source branch.
- A multi-repo advance is **all-or-nothing**: every sub-repo is decided before any
  of them moves, and one pinned repo pins the workspace. Advancing the rest would
  hand the agent a tree whose repos sit at commits that never coexisted upstream.

## Platform-written paths

- Platform-rewritten paths never count as pinning modifications. The set comes
  from `platformWorkspacePaths()`; each writer — skill-sync, mcp-sync, kb-sync,
  the CodeGraph link — registers its own paths, so adding a writer and updating
  the set are the same edit.
- Registered at **full depth** (`.claude/skills`, not `.claude`): the dirty check
  excludes them verbatim, and exempting a whole shared root would let
  `reset --hard` silently revert a repo-tracked `.claude/settings.json` the agent
  edited.
- **Git must be told too.** Workspace creation *and* reuse append the same set,
  anchored (`/.mcp.json`), to `git rev-parse --git-path info/exclude`,
  idempotently. The dirty check treating these paths as invisible only bound the
  platform; git still offered them to `git add -A`, and the MCP config holds
  Authorization bearer tokens and stdio API keys verbatim — so "commit and push
  my changes" published the MCP owner's credentials. `--git-path` resolves to the
  **common** repository's exclude file, which is intended: the shared checkout is
  a run's fallback workspace and needs the same cover.
- The MCP config is also **deleted at run end** (`cleanupManagedMcpConfigAsync`,
  from the engine's `finally`), so credentials do not sit in a persistent
  worktree between runs. The sidecar marker decides what may go: a file that
  predates any sync is user-authored and only loses the managed entries whose
  fingerprint still matches. Sibling runs sharing the worktree hold references,
  so the last one out removes the file.
- Workspace **removal** needs root names instead and derives them —
  `platformWorkspaceEntries()` = top segment of each path. It deletes the
  registered paths first and **logs by name** anything left in a shared root that
  the platform never wrote (a repo-tracked `settings.json`, the CLI's own
  `settings.local.json`) before removing it. The workspace is going away
  regardless, so refusing would only wedge TTL sweeps — but the deletion must not
  be silent.

## Concurrency within one Agent

- Same-Agent runs share their worktree **without an occupancy check** —
  serializing them would stall concurrent chat.
- The advance is **suppressed while a sibling run is executing**: `reset --hard`
  is not a read-only share.
- The sibling probe, the create and the `runs.workDir` write all happen **inside**
  the per-workspace lock. Probing outside it left a window where a sibling started
  executing between the probe and the reset, and two runs resolving concurrently
  both read an empty table and both advanced.
- Every channel records `runs.workDir` for the runs it executes (queued runs
  record at dequeue), so the workspace-delete route's occupancy check sees
  in-flight runs. That write is the **only** occupancy marker there is, so it is
  retried and then **fails the run** rather than executing unprotected.

## Reclaim paths

- Agent deletion, the workspace-delete route, the TTL sweeper, and a followSource
  rebuild/rollback all reclaim per-agent worktrees with `keepBranches` — the
  branch may hold the only copy of unpushed commits.
- Run-end **ephemeral cleanup skips them entirely**: deleting the directory would
  discard uncommitted work.
- Each reclaim path tests **both** sides:
  - the exact `perAgentWorkspaceName` match keeps a legacy explicit workspace such
    as `agent-refactor` on ordinary delete-branch semantics;
  - the `isPerAgentWorkspaceName` **shape** test still protects an orphan whose
    Agent row is already deleted, another Agent's worktree named by a sticky
    config, and a rebuild or create-rollback reached through the explicit path
    (which never sets `followSource`).
- The shape test is anchored to `createId`'s exact **16 base64url chars**, so a
  hand-typed `agent-payments-refactor` is not mistaken for one and does not leak
  its branch.

## Agent deletion

- Runs in the **background**, probes occupancy inside the per-workspace lock, and
  leaves an occupied worktree in place — but **demotes its state file to `ttl`**
  on the way out, so the sweeper reclaims it once idle.
- Left `persistent` it leaked forever: the Agent row is gone, so no run resolves
  that worktree again and the sweeper skips persistent workspaces.

## Adoption, CodeGraph, P4, degradation

- A legacy **detached** worktree is adopted onto the branch; an existing branch is
  attached **as-is** — never force-moved.
- CodeGraph stays reachable through an idempotent `.codegraph` symlink into the
  shared checkout (allowlisted by workspace removal).
- **P4 keeps the shared checkout** — no isolation possible.
- Worktree creation failure **degrades to `localPath`**, never fails the run.

## Workspace root

`workspacesPath` (SCM create/update) overrides the default worktree root
`SCM_STORAGE_ROOT/workspaces/<sourceIdSuffix>`. Absolute, globally unique. The
historical `~/.a2wave/workspaces` root remains allowed for upgraded sources.
