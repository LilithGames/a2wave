/**
 * SCM Source 抽象 — 每个 SCM Source 记录对应一个实例，
 * 封装 config / localPath / wsRoot 等状态，调用方无需关心实现细节。
 *
 * 本期只抽象 workspace 相关方法，sync / check 等后续迁入。
 */
import { join } from 'node:path'
import type { GitConfig } from '@a2wave/shared'
import {
  type CleanupOptions,
  type WorkspaceInfo,
  type WorkspaceState,
  cleanupStaleWorkspaces,
  createGitWorkspace,
  defaultWorkspacesPath,
  listGitWorkspaces,
  removeGitWorkspace,
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
  removeWorkspace(name: string, options?: { keepBranches?: boolean }): Promise<void>
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

  removeWorkspace(name: string, options?: { keepBranches?: boolean }): Promise<void> {
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
 * 根据 SCM Source 记录创建实例。
 * 如果类型不支持 workspace，返回 null。
 *
 * Async because the git branch asserts the stored workspaces root first, and
 * that check reads the owner's live role from the database.
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
  // P4 暂不支持 workspace
  return null
}
