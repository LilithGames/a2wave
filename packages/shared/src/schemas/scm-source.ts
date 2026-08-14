import { z } from 'zod'

// ============================================================
// SCM Source Type
// ============================================================

export const scmSourceTypeEnum = z.enum(['p4', 'git'])
export type ScmSourceType = z.infer<typeof scmSourceTypeEnum>

// ============================================================
// P4 Config Schema
// ============================================================

export const p4ConfigSchema = z.object({
  p4port: z.string().min(1),
  p4user: z.string().min(1),
  p4passwd: z.string().default(''),
  p4client: z.string().min(1),
  /** Optional: the depot path to track */
  depotPath: z.string().optional(),
  /** Whether to sync automatically */
  autoSync: z.boolean().default(false),
  /** Sync interval, in minutes */
  syncIntervalMin: z.number().min(1).default(30),
  /** Initial-sync timeout, in minutes */
  initialSyncTimeoutMin: z.number().min(1).default(60),
  /** Whether to maintain a CodeGraph index for this source */
  codegraphEnabled: z.boolean().optional(),
})

export type P4Config = z.infer<typeof p4ConfigSchema>

// ============================================================
// Git Repo Entry (multi-repo support)
// ============================================================

export const gitRepoEntrySchema = z.object({
  repoUrl: z.string().min(1),
  branch: z.string().default('main'),
  directory: z
    .string()
    .min(1)
    .refine(
      (v) => !v.includes('/') && !v.includes('..'),
      'Directory name must not contain "/" or ".."',
    ),
})

export type GitRepoEntry = z.infer<typeof gitRepoEntrySchema>

// ============================================================
// Git Config Schema
// ============================================================

/**
 * Upper bound on repositories a single **probe** request may fan out to.
 *
 * Each entry costs a concurrent `git ls-remote` subprocess, and a probe's
 * `repos` arrives straight from a request body with no stored row behind it —
 * so the count is bounded before any process is spawned.
 *
 * Deliberately NOT applied to `gitConfigSchema` itself: that schema also
 * validates `PATCH /:id`, and the form resubmits the whole config for any edit,
 * so a stored source that predates this limit would become unrenamable (400) —
 * a tightened contract silently locking existing data out of its own settings
 * page. Sync is a serial background job, so an oversized stored source is not
 * the resource risk a probe is. See `probeScmSourceInput`.
 */
export const MAX_GIT_REPOS = 50

export const gitConfigSchema = z.object({
  repoUrl: z.string(),
  branch: z.string().default('main'),
  username: z.string().optional(),
  pat: z.string().optional(),
  autoSync: z.boolean().default(false),
  syncIntervalMin: z.number().min(1).default(30),
  initialSyncTimeoutMin: z.number().min(1).default(60),
  codegraphEnabled: z.boolean().optional(),
  repos: z.array(gitRepoEntrySchema).optional(),
})

export type GitConfig = z.infer<typeof gitConfigSchema>

// ============================================================
// SCM Source Config (union by type)
// ============================================================

export const scmSourceConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('p4'), ...p4ConfigSchema.shape }),
  z.object({ type: z.literal('git'), ...gitConfigSchema.shape }),
])

export type ScmSourceConfig = z.infer<typeof scmSourceConfigSchema>

// ============================================================
// Sync Status
// ============================================================

export const syncStatusEnum = z.enum(['idle', 'syncing', 'error'])
export type SyncStatus = z.infer<typeof syncStatusEnum>

export const codegraphStatusEnum = z.enum(['idle', 'indexing', 'error'])
export type CodegraphStatus = z.infer<typeof codegraphStatusEnum>

// ============================================================
// SCM Source Schema
// ============================================================

export const scmSourceSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  type: scmSourceTypeEnum,
  description: z.string().nullable().optional(),
  /** SCM-specific configuration, discriminated by `type` */
  config: scmSourceConfigSchema,
  /** Local working directory — absolute, globally unique */
  localPath: z.string().min(1),
  /** Worktree root — absolute, optional. Defaults under SCM_STORAGE_ROOT when empty. */
  workspacesPath: z.string().nullable().optional(),
  /** Sync status */
  syncStatus: syncStatusEnum.default('idle'),
  lastSyncAt: z.coerce.date().nullable().optional(),
  lastSyncError: z.string().nullable().optional(),
  /** Written on the first successful sync; a source is only selectable by an Agent once it is set. */
  initialSyncCompletedAt: z.coerce.date().nullable().optional(),
  /** CodeGraph index status */
  codegraphStatus: codegraphStatusEnum.default('idle'),
  codegraphLastIndexedAt: z.coerce.date().nullable().optional(),
  codegraphLastError: z.string().nullable().optional(),
  isEnabled: z.boolean().default(true),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type ScmSource = z.infer<typeof scmSourceSchema>

// ============================================================
// CRUD Input Schemas
// ============================================================

// Normalize empty/whitespace-only to null. Otherwise "" slips past the route's
// `if (workspacesPath)` absolute-path and overlap checks and is stored as "",
// while at runtime `source.workspacesPath || defaultWorkspacesPath(id)` falls
// back to the default path — so the path that was validated is not the path that
// is used, and the cross-source overlap check stops working.
const optionalWorkspacesPath = z
  .string()
  .nullable()
  .optional()
  .transform((v) => {
    // Preserve PATCH "field absent" semantics; collapsing it would wrongly clear the value.
    if (v === undefined) return undefined
    return v && v.trim() !== '' ? v : null
  })

export const createScmSourceInput = z.object({
  name: z.string().min(1).max(100),
  type: scmSourceTypeEnum,
  description: z.string().nullable().optional(),
  config: scmSourceConfigSchema,
  /** Omit to let the server allocate a managed persistent path. */
  localPath: z.string().min(1).optional(),
  workspacesPath: optionalWorkspacesPath,
  isEnabled: z.boolean().optional(),
})

export type CreateScmSourceInput = z.infer<typeof createScmSourceInput>

export const updateScmSourceInput = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  config: scmSourceConfigSchema.optional(),
  localPath: z.string().min(1).optional(),
  workspacesPath: optionalWorkspacesPath,
  isEnabled: z.boolean().optional(),
})

export type UpdateScmSourceInput = z.infer<typeof updateScmSourceInput>
