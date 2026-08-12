import { kbSyncWorkspacePaths } from '../engine/kb-sync.js'
import { mcpSyncWorkspacePaths } from '../engine/mcp-sync.js'
import { skillSyncWorkspacePaths } from '../engine/skill-sync.js'
import { codegraphWorkspacePaths } from './codegraph-index.js'

/**
 * Workspace paths the platform itself writes into run workspaces, at full
 * depth (".claude/skills", ".cursor/mcp.json").
 *
 * Each writer registers its own paths, so adding a writer and updating this set
 * are the same edit — the previous shape (one hand-maintained list per
 * consumer) silently missed .codegraph, then .kb, each time wedging workspace
 * removal or pinning a workspace forever.
 *
 * Known limitation: a per-Agent skillsDir override that matches no Provider
 * preset is not derivable here.
 */
export function platformWorkspacePaths(): ReadonlySet<string> {
  return new Set([
    ...skillSyncWorkspacePaths(),
    ...mcpSyncWorkspacePaths(),
    ...kbSyncWorkspacePaths(),
    ...codegraphWorkspacePaths(),
  ])
}

/**
 * Workspace-root entries derived from `platformWorkspacePaths()` — the top
 * segment of each (".claude/skills" -> ".claude").
 *
 * Removal needs root names: it walks `readdir(workspace)` and deletes whole
 * entries. The dirty check must NOT use these — excluding all of `.claude`
 * there would let `reset --hard` silently revert a repo-tracked
 * `.claude/settings.json`, so it uses the full-depth paths instead.
 */
export function platformWorkspaceEntries(): ReadonlySet<string> {
  return new Set([...platformWorkspacePaths()].map((path) => path.split('/')[0]))
}
