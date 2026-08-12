import { codegraphWorkspaceEntries } from './codegraph-index.js'
import { kbSyncWorkspaceEntries } from '../engine/kb-sync.js'
import { mcpSyncWorkspaceEntries } from '../engine/mcp-sync.js'
import { skillSyncWorkspaceEntries } from '../engine/skill-sync.js'

/**
 * Workspace-root entries the platform itself writes into run workspaces.
 *
 * Each writer registers its own entries, so adding a writer and updating this
 * set are the same edit — the previous shape (one hand-maintained list per
 * consumer) silently missed .codegraph, then .kb, each time wedging workspace
 * removal or pinning a workspace forever.
 *
 * Two consumers share the result: workspace removal treats these as disposable
 * platform output, and the followSource pinning check never counts changes
 * under them as agent work.
 *
 * Known limitation: a per-Agent skillsDir override that matches no Provider
 * preset is not derivable here.
 */
export function platformWorkspaceEntries(): ReadonlySet<string> {
  return new Set([
    ...skillSyncWorkspaceEntries(),
    ...mcpSyncWorkspaceEntries(),
    ...kbSyncWorkspaceEntries(),
    ...codegraphWorkspaceEntries(),
  ])
}
