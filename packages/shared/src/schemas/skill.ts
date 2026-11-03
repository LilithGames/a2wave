import { z } from 'zod'

// ============================================================
// Skill — a reusable Agent capability
// ============================================================

/**
 * Who may discover and bind a Skill.
 *
 * Skills are private to their creator by default. Only an administrator may
 * persist `all-users`, which deliberately publishes the Skill to every signed-in
 * user. The persisted value is the single source of truth; it is not derived from
 * the owner's current role.
 */
export const skillVisibilityEnum = z.enum(['private', 'all-users'])
export type SkillVisibility = z.infer<typeof skillVisibilityEnum>

export const SKILL_DEFAULTS = {
  visibility: 'private' as const,
} as const

export const remoteSkillSourceSchema = z.object({
  provider: z.literal('github'),
  catalog: z.literal('skills_sh').nullable(),
  inputUrl: z.string().url(),
  repository: z.string(),
  repositoryUrl: z.string().url(),
  requestedRef: z.string(),
  path: z.string(),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
})

export type RemoteSkillSource = z.infer<typeof remoteSkillSourceSchema>

export const skillSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  /** Skill instruction content (the body of SKILL.md) */
  content: z.string().nullable().optional(),
  /** Storage path relative to the skills root; null means content-only, no file */
  storagePath: z.string().nullable().optional(),
  /** Owning group id (skg_xxx); null = ungrouped */
  groupId: z.string().nullable().optional(),
  /** Owning user id (usr_xxx); null = unowned */
  userId: z.string().nullable().optional(),
  /** Visibility: creator-only, or explicitly shared with all signed-in users by an admin. */
  visibility: skillVisibilityEnum.default(SKILL_DEFAULTS.visibility),
  /** Author display name, joined from `users` by the API. Display only. */
  authorName: z.string().nullable().optional(),
  /** Remote source provenance for reproducible installs; null for local uploads/manual skills. */
  remoteSource: remoteSkillSourceSchema.nullable().optional(),
  /** True after local content/file edits diverge from the installed remote snapshot. */
  sourceDirty: z.boolean().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type Skill = z.infer<typeof skillSchema>

// ============================================================
// CRUD Input Schemas
// ============================================================

export const createSkillInput = z.object({
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
  visibility: skillVisibilityEnum.default(SKILL_DEFAULTS.visibility),
})

export type CreateSkillInput = z.infer<typeof createSkillInput>

export const updateSkillInput = createSkillInput
  .extend({
    visibility: createSkillInput.shape.visibility.unwrap(),
  })
  .partial()
export type UpdateSkillInput = z.infer<typeof updateSkillInput>

// ============================================================
// Remote Skill installation
// ============================================================

export const remoteSkillCandidateSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  path: z.string(),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  fileCount: z.number().int().positive(),
  totalBytes: z.number().int().nonnegative(),
})

export type RemoteSkillCandidate = z.infer<typeof remoteSkillCandidateSchema>

export const remoteSkillInspectionSchema = z.object({
  inputUrl: z.string().url(),
  repository: z.string(),
  repositoryUrl: z.string().url(),
  requestedRef: z.string(),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  catalog: z.literal('skills_sh').nullable(),
  candidates: z.array(remoteSkillCandidateSchema),
})

export type RemoteSkillInspection = z.infer<typeof remoteSkillInspectionSchema>

export const inspectRemoteSkillsInput = z.object({
  url: z.string().url().max(2048),
})

export type InspectRemoteSkillsInput = z.infer<typeof inspectRemoteSkillsInput>

export const installRemoteSkillsInput = z.object({
  url: z.string().url().max(2048),
  requestedRef: z.string().min(1).max(255),
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  selections: z
    .array(
      z.object({
        path: z.string().min(1).max(1024),
        digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      }),
    )
    .min(1)
    .max(20),
  groupId: z.string().nullable().optional(),
  visibility: skillVisibilityEnum.default(SKILL_DEFAULTS.visibility),
})

export type InstallRemoteSkillsInput = z.infer<typeof installRemoteSkillsInput>

export const remoteSkillFileChangeKindSchema = z.enum(['added', 'modified', 'deleted'])
export type RemoteSkillFileChangeKind = z.infer<typeof remoteSkillFileChangeKindSchema>

export const remoteSkillFileDiffSchema = z.object({
  path: z.string(),
  localChange: remoteSkillFileChangeKindSchema.nullable(),
  remoteChange: remoteSkillFileChangeKindSchema.nullable(),
  conflict: z.boolean(),
})
export type RemoteSkillFileDiff = z.infer<typeof remoteSkillFileDiffSchema>

export const remoteSkillUpdateCheckSchema = z.object({
  skillId: z.string(),
  source: remoteSkillSourceSchema,
  installedRevision: z.string().regex(/^[0-9a-f]{40}$/),
  latestRevision: z.string().regex(/^[0-9a-f]{40}$/),
  installedDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  localDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  latestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  updateAvailable: z.boolean(),
  sourceDirty: z.boolean(),
  files: z.array(remoteSkillFileDiffSchema),
  conflicts: z.array(z.string()),
})
export type RemoteSkillUpdateCheck = z.infer<typeof remoteSkillUpdateCheckSchema>

export const remoteSkillUpdateStrategySchema = z.enum(['abort', 'preserve_local', 'overwrite'])
export type RemoteSkillUpdateStrategy = z.infer<typeof remoteSkillUpdateStrategySchema>

export const updateRemoteSkillInput = z.object({
  revision: z.string().regex(/^[0-9a-f]{40}$/),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  strategy: remoteSkillUpdateStrategySchema.default('abort'),
})
export type UpdateRemoteSkillInput = z.infer<typeof updateRemoteSkillInput>

export const remoteSkillUpdateResultSchema = z.object({
  skill: skillSchema,
  strategy: remoteSkillUpdateStrategySchema,
  preservedLocalChanges: z.boolean(),
})
export type RemoteSkillUpdateResult = z.infer<typeof remoteSkillUpdateResultSchema>
