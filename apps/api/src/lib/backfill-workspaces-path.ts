import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { scmSources } from '../db/schema.js'
import { runExclusive } from '../db/transaction.js'
import { logger } from './logger.js'
import { defaultScmWorkspacesPath, scmSourceIdSuffix } from './scm-storage.js'

/**
 * Pin the worktree root of every migrated source that never stored one.
 *
 * A NULL `workspaces_path` is resolved at call time, preferring the legacy
 * `~/.a2wave/workspaces/<suffix>` directory while it still exists on disk. That
 * makes the effective root depend on the filesystem: the moment the legacy
 * directory goes away (`docker compose down -v`, an image rebuild that drops
 * the volume, or cleanup of the empty root after the last worktree is removed)
 * the same row silently starts resolving somewhere else. Cross-source
 * uniqueness and overlap checks then compare against a path the runtime is no
 * longer using, so a second source can be created overlapping the first's
 * now-active root and worktree cleanup on one deletes the other's worktrees.
 *
 * Writing the resolved value once removes the ambiguity: afterwards the column
 * is authoritative and nothing depends on what happens to exist. This runs at
 * boot rather than as a SQL migration because the decision needs a filesystem
 * probe, which SQL cannot perform.
 */

export interface BackfillCandidate {
  id: string
  workspacesPath: string | null
}

export interface BackfillResolvers {
  legacyRootFor: (sourceId: string) => string
  managedRootFor: (sourceId: string) => string
  pathExists: (path: string) => boolean
}

export interface BackfillAssignment {
  id: string
  workspacesPath: string
}

function legacyWorkspacesRootFor(sourceId: string): string {
  return join(homedir(), '.a2wave', 'workspaces', scmSourceIdSuffix(sourceId))
}

/**
 * Pure decision step: which rows get which path. Probed per row, not once for
 * the table — a deployment can hold both migrated and freshly created sources.
 */
export function planWorkspacesPathBackfill(
  candidates: ReadonlyArray<BackfillCandidate>,
  resolvers: BackfillResolvers,
): BackfillAssignment[] {
  const assignments: BackfillAssignment[] = []
  for (const candidate of candidates) {
    if (candidate.workspacesPath) continue
    const legacyRoot = resolvers.legacyRootFor(candidate.id)
    assignments.push({
      id: candidate.id,
      workspacesPath: resolvers.pathExists(legacyRoot)
        ? legacyRoot
        : resolvers.managedRootFor(candidate.id),
    })
  }
  return assignments
}

/** Idempotent: once a row carries a path it is never a candidate again. */
export async function backfillWorkspacesPaths(): Promise<number> {
  const candidates = await db
    .select({ id: scmSources.id, workspacesPath: scmSources.workspacesPath })
    .from(scmSources)
    .where(isNull(scmSources.workspacesPath))

  const assignments = planWorkspacesPathBackfill(candidates, {
    legacyRootFor: legacyWorkspacesRootFor,
    managedRootFor: defaultScmWorkspacesPath,
    pathExists: existsSync,
  })

  for (const assignment of assignments) {
    // `runExclusive` because this runs at boot with the HTTP port already open,
    // so a request may be mid-transaction. On SQLite one shared connection means
    // a bare update issued inside another request's `BEGIN` joins that
    // transaction and is erased by its ROLLBACK — after this loop already
    // counted the row as pinned. See apps/api/CLAUDE.md and db/transaction.ts.
    //
    // Scoped to the row AND still-NULL, so an operator setting an explicit path
    // between the read and this write wins over the back-fill instead of being
    // overwritten by it.
    await runExclusive(async () =>
      db
        .update(scmSources)
        .set({ workspacesPath: assignment.workspacesPath })
        .where(and(eq(scmSources.id, assignment.id), isNull(scmSources.workspacesPath)))
        .returning(),
    )
  }

  if (assignments.length > 0) {
    logger.info({ count: assignments.length }, 'Pinned workspacesPath for migrated SCM sources')
  }
  return assignments.length
}
