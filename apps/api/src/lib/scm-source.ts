/**
 * SCM Source abstraction — one instance per SCM Source row, wrapping its
 * config / localPath / wsRoot so callers need not know the implementation.
 *
 * Only workspace-related methods are abstracted for now; sync / check follow.
 */
import { join } from 'node:path'
import type { GitConfig } from '@a2wave/shared'
import {
  type CleanupOptions,
  cleanupStaleWorkspaces,
  createGitWorkspace,
  defaultWorkspacesPath,
  listGitWorkspaces,
  type RemoveGitWorkspaceOptions,
  removeGitWorkspace,
  type WorkspaceInfo,
  type WorkspaceState,
  writeWorkspaceState,
} from './git-workspace.js'
import { assertStoredScmWorkspacesRoot } from './scm-workspace-safety.js'

// ============================================================
// Interface
// ============================================================

export interface CreateWorkspaceResult {
  path: string
  created: boolean
}

export interface ScmSource {
  readonly type: 'git' | 'p4'
  readonly localPath: string
  readonly wsRoot: string

  createWorkspace(
    name: string,
    options?: { branch?: string; followSource?: boolean; advance?: boolean },
  ): Promise<CreateWorkspaceResult>
  /**
   * `beforeRemove` runs inside the workspace mutex; throw from it to abort.
   * `keepBranches` preserves the worktree's branch — mandatory for a per-Agent
   * worktree, whose branch can hold unpushed commits.
   */
  removeWorkspace(name: string, options?: RemoveGitWorkspaceOptions): Promise<void>
  listWorkspaces(): Promise<WorkspaceInfo[]>
  writeWorkspaceState(name: string, state: WorkspaceState): Promise<void>
  cleanupStale(opts: CleanupOptions): Promise<string[]>
}

// ============================================================
// Source row type (matches DB select shape)
// ============================================================

export interface ScmSourceRow {
  id: string
  type: string
  localPath: string
  name: string
  config: Record<string, unknown>
  workspacesPath?: string | null
}

// ============================================================
// Git implementation
// ============================================================

class GitScmSource implements ScmSource {
  readonly type = 'git' as const
  readonly localPath: string
  readonly wsRoot: string
  private readonly config: GitConfig

  constructor(source: ScmSourceRow) {
    this.localPath = source.localPath
    this.config = source.config as unknown as GitConfig
    this.wsRoot = source.workspacesPath || defaultWorkspacesPath(source.id)
  }

  createWorkspace(
    name: string,
    options?: { branch?: string; followSource?: boolean; advance?: boolean },
  ): Promise<CreateWorkspaceResult> {
    return createGitWorkspace(this.localPath, this.wsRoot, name, this.config, options)
  }

  removeWorkspace(name: string, options?: RemoveGitWorkspaceOptions): Promise<void> {
    return removeGitWorkspace(this.localPath, this.wsRoot, name, this.config, options)
  }

  listWorkspaces(): Promise<WorkspaceInfo[]> {
    return listGitWorkspaces(this.localPath, this.wsRoot, this.config)
  }

  writeWorkspaceState(name: string, state: WorkspaceState): Promise<void> {
    return writeWorkspaceState(join(this.wsRoot, name), state)
  }

  cleanupStale(opts: CleanupOptions): Promise<string[]> {
    return cleanupStaleWorkspaces(this.localPath, this.wsRoot, this.config, opts)
  }
}

// ============================================================
// Factory
// ============================================================

/**
 * Build an instance from an SCM Source row.
 * Returns null when the type does not support workspaces.
 *
 * Async because the git branch asserts the stored workspaces root first, and
 * that check reads the owner's live role plus every peer source's paths from
 * the database. Two small reads on a hot path (every run that mounts a git
 * workspace lands here): accepted because the `scm_sources` table holds tens of
 * rows, and skipping the check is what let one source's worktree root sit on
 * top of another's checkout.
 */
export async function createScmSource(source: ScmSourceRow): Promise<ScmSource | null> {
  if (source.type === 'git') {
    // Every git workspace operation flows through this factory. Validate legacy
    // rows here as a runtime backstop, not only when a route happens to edit the
    // workspacesPath field. The assertion resolves the owner's live role from the
    // DB, so it must be awaited — an unawaited Promise is truthy and would let
    // every unsafe root through while the rejection escaped unhandled.
    await assertStoredScmWorkspacesRoot(source)
    return new GitScmSource(source)
  }
  // P4 does not support workspaces yet
  return null
}
