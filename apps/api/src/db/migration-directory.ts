import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Locate migration folders and the monorepo root without depending on `cwd`.
 *
 * The suite is launched two ways — `pnpm test` at the repo root and `pnpm test`
 * inside `apps/api` — so `process.cwd()` is not a fixed point. Tests that
 * resolved against it passed under one launch and failed under the other.
 * Walking up from this module's own path is stable under both.
 */

const THIS_DIR = dirname(fileURLToPath(import.meta.url))

/** `pnpm-workspace.yaml` marks the monorepo root and appears nowhere else. */
const REPO_ROOT_MARKER = 'pnpm-workspace.yaml'

function findAncestorContaining(marker: string): string | null {
  let dir = THIS_DIR
  while (true) {
    if (existsSync(resolve(dir, marker))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Absolute path of the monorepo root. */
export function resolveRepoRoot(): string {
  const root = findAncestorContaining(REPO_ROOT_MARKER)
  if (!root) {
    throw new Error(`Could not locate the repo root: no ${REPO_ROOT_MARKER} above ${THIS_DIR}`)
  }
  return root
}

/**
 * Absolute path of a migration folder, e.g. `drizzle` or `drizzle-pg`.
 *
 * Throws rather than returning a non-existent path: a silently wrong folder
 * makes a migration test read as passing when it never ran the migration.
 */
export function resolveMigrationDir(folder: string): string {
  const candidate = resolve(resolveRepoRoot(), 'apps/api', folder)
  if (!existsSync(candidate)) {
    throw new Error(`Migration folder not found: ${folder} (looked in ${candidate})`)
  }
  return candidate
}
