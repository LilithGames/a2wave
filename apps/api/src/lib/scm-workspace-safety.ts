import { existsSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { SETTINGS_DEFAULTS } from '@a2wave/shared'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { scmSources, users } from '../db/schema.js'
import { env } from '../env.js'
import { defaultWorkspacesPath } from './git-workspace.js'
import { legacyScmReclaimRoot, scmReclaimRoot } from './scm-storage.js'

interface ValidationOptions {
  protectedPaths?: string[]
  allowOutsideConfiguredRoots?: boolean
  platform?: NodeJS.Platform
}

/**
 * Case folding here is deliberately narrow — win32 only — because this
 * normalizer serves *containment* checks (allowed roots, protected paths),
 * where folding case can only ever WIDEN what is accepted: `/srv/Allowed` would
 * clear a `/srv/allowed` allowlist it was never granted. Refusing to fold keeps
 * that boundary tight even on a case-insensitive volume, at the cost of asking
 * an operator to match the case they configured.
 *
 * `pathsOverlap` below needs the opposite polarity and takes its own rule — see
 * the note there.
 */
function normalizeForComparison(value: string, platform: NodeJS.Platform): string {
  const resolved = resolve(value)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Case folding for *collision* checks, where the polarity is reversed: two
 * sources must never end up sharing one directory, so on a case-insensitive
 * volume (win32, and a default APFS/HFS+ macOS) `/srv/Repo` and `/srv/repo`
 * have to compare equal. Linux is case-sensitive and folding there would
 * instead reject a legitimate second directory — the bug this separation fixes.
 */
function normalizeForCollision(value: string, platform: NodeJS.Platform): string {
  const resolved = resolve(value)
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved
}

export function isSameOrDescendantForCollision(
  parent: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedParent = normalizeForCollision(parent, platform)
  const normalizedCandidate = normalizeForCollision(candidate, platform)
  const parentPrefix = normalizedParent.endsWith(sep)
    ? normalizedParent
    : `${normalizedParent}${sep}`
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(parentPrefix)
}

export function isSameOrDescendant(
  parent: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  const normalizedParent = normalizeForComparison(parent, platform)
  const normalizedCandidate = normalizeForComparison(candidate, platform)
  const parentPrefix = normalizedParent.endsWith(sep)
    ? normalizedParent
    : `${normalizedParent}${sep}`
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(parentPrefix)
}

/**
 * Equal, or one is an ancestor of the other, judged under the platform's own
 * case rule. `platform` is a parameter rather than a read of `process.platform`
 * so path decisions stay testable on any host — and so the planner and this
 * module cannot drift apart, which is exactly what happened when each kept its
 * own copy: this one honoured the platform while the planner folded case
 * unconditionally, rejecting `/srv/Repo` against `/srv/repo` on Linux where
 * they are two genuinely distinct directories.
 */
export function pathsOverlap(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    isSameOrDescendantForCollision(a, b, platform) || isSameOrDescendantForCollision(b, a, platform)
  )
}

/**
 * Resolve every existing ancestor through realpath, then append the missing
 * suffix. This catches a symlink in the approved path even before the final
 * per-source workspaces directory has been created.
 */
export function canonicalizeThroughExistingAncestor(value: string): string {
  const suffix: string[] = []
  let cursor = resolve(value)

  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(basename(cursor))
    cursor = parent
  }

  try {
    return resolve(realpathSync(cursor), ...suffix)
  } catch {
    return resolve(value)
  }
}

interface FilesystemIdentityDeps {
  existsSync: (path: string) => boolean
  realpathSync: (path: string) => string
  statSync: (path: string) => { dev: number | bigint; ino: number | bigint }
}

const filesystemIdentityDeps: FilesystemIdentityDeps = { existsSync, realpathSync, statSync }

function nearestExistingAncestor(value: string, deps: FilesystemIdentityDeps): string {
  let cursor = resolve(value)
  while (!deps.existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return cursor
}

function alternateCase(value: string): string | null {
  const index = value.search(/[a-z]/i)
  if (index < 0) return null
  const character = value[index]
  const toggled =
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase()
  return `${value.slice(0, index)}${toggled}${value.slice(index + 1)}`
}

/** Detect the lookup semantics of the actual mounted filesystem, not the container OS. */
export function detectFilesystemCaseInsensitive(
  value: string,
  platform: NodeJS.Platform = process.platform,
  deps: FilesystemIdentityDeps = filesystemIdentityDeps,
): boolean {
  let cursor = nearestExistingAncestor(value, deps)
  while (true) {
    const parent = dirname(cursor)
    const alternateName = alternateCase(basename(cursor))
    if (alternateName) {
      const alternatePath = join(parent, alternateName)
      if (!deps.existsSync(alternatePath)) return false
      try {
        const actual = deps.statSync(cursor)
        const alternate = deps.statSync(alternatePath)
        return actual.dev === alternate.dev && actual.ino === alternate.ino
      } catch {
        break
      }
    }
    if (parent === cursor) break
    cursor = parent
  }
  return platform === 'win32' || platform === 'darwin'
}

/** Canonical path identity used when two SCM-owned directories must not alias. */
export function filesystemCollisionKey(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const canonical = canonicalizeThroughExistingAncestor(value)
  return detectFilesystemCaseInsensitive(value, platform) ? canonical.toLowerCase() : canonical
}

export function filesystemPathsOverlap(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const keyA = filesystemCollisionKey(a, platform)
  const keyB = filesystemCollisionKey(b, platform)
  const overlaps = (parent: string, candidate: string) => {
    const prefix = parent.endsWith(sep) ? parent : `${parent}${sep}`
    return candidate === parent || candidate.startsWith(prefix)
  }
  return overlaps(keyA, keyB) || overlaps(keyB, keyA)
}

export function isSameFilesystemPath(
  a: string,
  b: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return filesystemCollisionKey(a, platform) === filesystemCollisionKey(b, platform)
}

export function getDefaultScmWorkspacesAllowedRoot(): string {
  return join(env.SCM_STORAGE_ROOT, 'workspaces')
}

/**
 * Roots that earlier releases approved and that must keep working across an
 * upgrade. `validateStoredScmWorkspacesRoot` re-runs on every use, so dropping
 * one does not merely block new sources — it retroactively bricks existing
 * ones, down to rejecting an unrelated rename, with no in-UI repair for a
 * non-admin owner.
 *
 * - `~/.a2wave/workspaces` was the built-in default before managed storage.
 * - `SCM_STORAGE_ROOT` itself was the shipped Compose default for
 *   SCM_WORKSPACES_ALLOWED_ROOTS before it narrowed to the `workspaces` child.
 *
 * The managed checkout subtree stays rejected by its own rule below, so
 * honouring the wider historical root cannot expose one source's checkout.
 */
function getLegacyScmWorkspacesAllowedRoots(): string[] {
  return [join(homedir(), '.a2wave', 'workspaces'), env.SCM_STORAGE_ROOT]
}

function getProtectedPlatformPaths(): string[] {
  return [
    env.DATABASE_URL,
    env.A2WAVE_SKILLS_STORAGE,
    env.A2WAVE_KB_STORAGE,
    env.A2WAVE_MEMORY_STORAGE,
    env.LOG_FILE_PATH,
    SETTINGS_DEFAULTS.artifacts.storagePath,
    SETTINGS_DEFAULTS.attachments.stagingPath,
  ].map((value) => canonicalizeThroughExistingAncestor(value))
}

/**
 * Validate a per-source workspaces root against operator-approved roots and
 * platform-owned storage. Returns a user-facing error, or null when safe.
 */
export function validateScmWorkspacesRoot(
  candidate: string,
  configuredAllowedRoots: string = env.SCM_WORKSPACES_ALLOWED_ROOTS,
  options: ValidationOptions = {},
): string | null {
  if (!isAbsolute(candidate)) return 'workspacesPath must be an absolute path'

  const candidatePath = canonicalizeThroughExistingAncestor(candidate)
  const platform = options.platform ?? process.platform
  const configuredRoots = configuredAllowedRoots
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const allowedRoots = [
    getDefaultScmWorkspacesAllowedRoot(),
    ...getLegacyScmWorkspacesAllowedRoots(),
    ...configuredRoots,
  ]
    .filter(isAbsolute)
    .map((root) => canonicalizeThroughExistingAncestor(root))

  if (
    !options.allowOutsideConfiguredRoots &&
    !allowedRoots.some((root) => isSameOrDescendant(root, candidatePath, platform))
  ) {
    return 'workspacesPath must be inside the default a2wave workspaces directory or a root listed in SCM_WORKSPACES_ALLOWED_ROOTS'
  }

  const protectedPaths = (options.protectedPaths ?? getProtectedPlatformPaths()).map((value) =>
    canonicalizeThroughExistingAncestor(value),
  )
  if (
    protectedPaths.some((protectedPath) =>
      filesystemPathsOverlap(protectedPath, candidatePath, platform),
    )
  ) {
    return 'workspacesPath must not overlap protected platform storage'
  }

  const managedCheckoutRoot = canonicalizeThroughExistingAncestor(
    join(env.SCM_STORAGE_ROOT, 'sources'),
  )
  if (filesystemPathsOverlap(managedCheckoutRoot, candidatePath, platform)) {
    return 'workspacesPath must not overlap managed SCM checkout storage'
  }

  if (
    [scmReclaimRoot(), legacyScmReclaimRoot()].some((root) =>
      filesystemPathsOverlap(canonicalizeThroughExistingAncestor(root), candidatePath, platform),
    )
  ) {
    return 'workspacesPath must not overlap the SCM reclaim root'
  }

  return null
}

export interface StoredScmSourceWorkspace {
  id: string
  workspacesPath?: string | null
  userId?: string | null
}

/**
 * A peer row, as the runtime overlap scan needs to see it. Structurally the same
 * as the planner's `ScmPathPeer`, but declared here so this module stays free of
 * an import cycle — `scm-path-plan` already depends on this one.
 */
export interface StoredScmPeer {
  id: string
  name: string
  localPath: string
  workspacesPath: string | null
}

/**
 * The directories a peer occupies, matching what the runtime actually resolves:
 * a NULL worktree root falls back to the default, so a migrated row still
 * defends the directory it will really use.
 */
function peerOccupiedPaths(peer: StoredScmPeer): string[] {
  const paths: string[] = []
  if (peer.localPath) paths.push(peer.localPath)
  // Only expand the implicit root when the row can name one. `defaultWorkspacesPath`
  // derives it from the id, so a row without one has no resolvable root to defend.
  if (peer.workspacesPath) paths.push(peer.workspacesPath)
  else if (peer.id) paths.push(defaultWorkspacesPath(peer.id))
  return paths
}

/**
 * Runtime backstop for rows created before workspace-root validation existed.
 * The owner id is resolved to a live role on every use; a persisted admin bit
 * would keep arbitrary-root access after demotion or disable.
 *
 * `peers` defaults to every other source. The cross-source scan is not just a
 * mirror of the write path: `SCM_STORAGE_ROOT` itself remains a legacy allowed
 * root, and the managed-checkout rule only excludes `SCM_STORAGE_ROOT/sources`,
 * so a pre-planner row can hold a worktree root sitting on top of an
 * operator-chosen checkout (a P4 `localPath`, typically) that no other rule
 * covers. Worktree cleanup on one source would then delete the other's tree.
 */
export async function validateStoredScmWorkspacesRoot(
  source: StoredScmSourceWorkspace,
  ownerIsActiveAdmin?: boolean,
  peers?: ReadonlyArray<StoredScmPeer>,
): Promise<string | null> {
  let allowOutsideConfiguredRoots = ownerIsActiveAdmin
  if (allowOutsideConfiguredRoots === undefined) {
    const owner = source.userId
      ? (
          await db
            .select({ role: users.role, isActive: users.isActive })
            .from(users)
            .where(eq(users.id, source.userId))
            .limit(1)
        )[0]
      : undefined
    allowOutsideConfiguredRoots = owner?.role === 'admin' && owner.isActive === true
  }

  const effectiveRoot = source.workspacesPath ?? defaultWorkspacesPath(source.id)
  const error = validateScmWorkspacesRoot(effectiveRoot, undefined, {
    allowOutsideConfiguredRoots,
  })
  if (error) {
    return `Unsafe saved workspacesPath: ${error}. Update this SCM source to an approved dedicated root before using workspaces`
  }

  const scanned = peers ?? (await selectStoredScmPeers())
  // Defensive: this is a backstop check on a read path, so an unreadable peer
  // list degrades to "no overlap found" rather than failing the request. The
  // write path (resolveScmPathPlan) is what authoritatively rejects overlap.
  // A deletion reservation deliberately remains a path reservation until the
  // row is finally removed. Filesystem isolation happens after that reservation
  // commits and may fail, so treating a pending row as already vacated would let
  // another source operate inside storage that still exists in place.
  const otherSources = Array.isArray(scanned) ? scanned.filter((peer) => peer.id !== source.id) : []
  for (const peer of otherSources) {
    const collision = peerOccupiedPaths(peer).find((path) =>
      filesystemPathsOverlap(path, effectiveRoot),
    )
    if (collision) {
      return `Unsafe saved workspacesPath: it overlaps storage used by source "${peer.name}" (${collision}). Update this SCM source to an approved dedicated root before using workspaces`
    }
  }

  return null
}

/** Every source row the runtime overlap scan compares against. */
async function selectStoredScmPeers(): Promise<StoredScmPeer[]> {
  return db
    .select({
      id: scmSources.id,
      name: scmSources.name,
      localPath: scmSources.localPath,
      workspacesPath: scmSources.workspacesPath,
    })
    .from(scmSources)
}

export class UnsafeScmWorkspacesRootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeScmWorkspacesRootError'
  }
}

export async function assertStoredScmWorkspacesRoot(
  source: StoredScmSourceWorkspace,
  ownerIsActiveAdmin?: boolean,
): Promise<void> {
  const error = await validateStoredScmWorkspacesRoot(source, ownerIsActiveAdmin)
  if (error) throw new UnsafeScmWorkspacesRootError(error)
}
