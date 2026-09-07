import type { GroupConfig } from '@a2wave/shared'
/**
 * Clone-time resource scoping.
 *
 * A clone belongs to the caller, not to the source Agent's owner, so it must not
 * carry bindings the caller could not have created themselves — otherwise the
 * copy outlives a membership revoke and becomes a durable privilege escalation.
 * These helpers therefore reuse the *same* predicates as the create/update bind
 * checks rather than reimplementing them, and none of them carries a secret over.
 *
 * Extracted from routes/agents.ts, which the async conversion pushed past the
 * file-lines gate. They are the most self-contained group in that file: they take
 * a Context plus the source Agent's values and return what the clone may keep,
 * touching no route state.
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import { kbDocuments, mcpServers, scmSources, skillGroups, skills } from '../db/schema.js'
import { canNonAdminUseMcp } from '../lib/mcp-stdio.js'
import { getCurrentUserId, getOwnerFilter } from '../lib/owner-filter.js'
import { canNonAdminUseSkill } from '../lib/skill-access.js'
import { isAdmin } from '../middleware/auth-middleware.js'

/** A clone's workspace binding: what `workspaceType` / `scmSourceId` it is written with. */
export type CloneWorkspaceBinding = {
  workspaceType: 'scm' | 'temp'
  scmSourceId: string | null
}

/**
 * Strip secrets from the cloned env — clone hands the new Agent's ownership to the
 * caller, so an `editor` could otherwise walk away with the source Agent's sensitive
 * env values and re-share them to anyone they invite. Once the original owner revokes
 * editor membership those copies remain — irreversible. Mirrors `sanitizeAgent` in
 * agent-export.ts; the route drops the provider* secrets alongside it and keeps
 * `authMode`, so the caller knows which credential to refill.
 */
export function sanitizeEnvForClone<T extends { sensitive?: boolean | null; value: string }>(
  env: Record<string, T> | null,
): Record<string, T> | null {
  if (!env) return null
  return Object.fromEntries(
    Object.entries(env).map(([key, entry]) => [
      key,
      entry.sensitive ? { ...entry, value: '' } : entry,
    ]),
  )
}

/**
 * Project KB document ids onto the clone's new owner, using the same visibility
 * rule `validateKbDocumentIds` enforces on create/update — otherwise an editor
 * clones a shared Agent and walks away with a readable copy of the owner's
 * private documents, which survives a membership revoke.
 */
export async function projectBindableKbDocumentIdsForClone(
  c: import('hono').Context,
  kbDocumentIds: string[] | null | undefined,
): Promise<{ kept: string[]; dropped: string[] }> {
  const sourceIds = kbDocumentIds ?? []
  const ownerFilter = getOwnerFilter(c, kbDocuments.userId)
  if (!ownerFilter || sourceIds.length === 0) return { kept: sourceIds, dropped: [] }
  const visibleDocs = await db
    .select({ id: kbDocuments.id })
    .from(kbDocuments)
    .where(and(inArray(kbDocuments.id, sourceIds), ownerFilter))
  const visibleIds = new Set(visibleDocs.map((doc) => doc.id))
  return {
    kept: sourceIds.filter((id) => visibleIds.has(id)),
    dropped: sourceIds.filter((id) => !visibleIds.has(id)),
  }
}

/**
 * Decide the clone's SCM binding from an authoritative read of the source.
 *
 * An SCM source is mounted as a working checkout cloned with that source's stored
 * credentials, so the clone may keep the binding only if its new owner could have
 * created it — the rule create/update apply. Caller runs this inside the SCM
 * lifecycle lock, so one query settles both ownership and the deletion race.
 * An unbindable source is dropped (the clone falls back to a temp workspace)
 * rather than failing the whole clone; a source under deletion keeps the existing
 * 409, because the caller can bind it and it is simply going away. A non-`scm`
 * Agent is checked too: a copied-over id is inert only until a later PATCH
 * switches `workspaceType` without restating `scmSourceId`.
 */
export async function resolveScmBindingForClone(
  c: import('hono').Context,
  tx: typeof db,
  sourceBinding: CloneWorkspaceBinding,
): Promise<
  | { unavailable: true; binding?: undefined; droppedScmSourceId?: undefined }
  | { unavailable: false; binding: CloneWorkspaceBinding; droppedScmSourceId: string | null }
> {
  const kept = { unavailable: false as const, binding: sourceBinding, droppedScmSourceId: null }
  const { scmSourceId } = sourceBinding
  if (!scmSourceId) return kept
  const source = (
    await tx
      .select({ id: scmSources.id, userId: scmSources.userId })
      .from(scmSources)
      .where(and(eq(scmSources.id, scmSourceId), isNull(scmSources.deletionRequestedAt)))
      .limit(1)
  )[0]
  if (!source && sourceBinding.workspaceType === 'scm') return { unavailable: true }
  if (source && (isAdmin(c) || source.userId === getCurrentUserId(c))) return kept
  return {
    unavailable: false,
    binding: { workspaceType: 'temp', scmSourceId: null },
    droppedScmSourceId: scmSourceId,
  }
}

/**
 * Audit `details` for what the clone projection dropped: the clone is silently
 * narrower than its source, and only the trail explains why a binding vanished.
 * Ids only — never the source's config or credentials.
 */
export function buildCloneDropDetails(
  droppedScmSourceId: string | null,
  droppedKbDocumentIds: string[],
): Record<string, unknown> | null {
  const details = {
    ...(droppedScmSourceId ? { droppedScmSourceId } : {}),
    ...(droppedKbDocumentIds.length > 0 ? { droppedKbDocumentIds } : {}),
  }
  return Object.keys(details).length > 0 ? details : null
}

export async function filterBindableMcpIdsForClone(
  c: import('hono').Context,
  mcpServerIds: string[] | null | undefined,
): Promise<string[]> {
  if (!mcpServerIds?.length) return []
  if (isAdmin(c)) return mcpServerIds
  const me = getCurrentUserId(c)
  const rows = await db
    .select({
      id: mcpServers.id,
      type: mcpServers.type,
      groupConfig: mcpServers.groupConfig,
      usageScope: mcpServers.usageScope,
      userId: mcpServers.userId,
    })
    .from(mcpServers)
    .where(inArray(mcpServers.id, mcpServerIds))
  // Keep only rows the caller may bind — same single predicate as the bind check.
  const allowed = new Set(
    rows
      .filter((s) =>
        canNonAdminUseMcp(
          {
            type: s.type,
            groupConfig: s.groupConfig as GroupConfig | null,
            usageScope: s.usageScope,
            userId: s.userId,
          },
          me,
        ),
      )
      .map((s) => s.id),
  )
  return mcpServerIds.filter((id) => allowed.has(id))
}

export async function projectBindableSkillReferencesForClone(
  c: import('hono').Context,
  skillIds: string[] | null | undefined,
  groupIds: string[] | null | undefined,
): Promise<{ skillIds: string[]; skillGroupIds: string[] }> {
  const directSkillIds = skillIds ?? []
  const sourceGroupIds = groupIds ?? []
  if (isAdmin(c)) {
    return { skillIds: directSkillIds, skillGroupIds: sourceGroupIds }
  }

  const callerId = getCurrentUserId(c)
  const ownedGroupIds = new Set(
    sourceGroupIds.length > 0
      ? (
          await db
            .select({ id: skillGroups.id })
            .from(skillGroups)
            .where(and(inArray(skillGroups.id, sourceGroupIds), eq(skillGroups.userId, callerId)))
        ).map((row) => row.id)
      : [],
  )
  if (directSkillIds.length === 0 && sourceGroupIds.length === 0) {
    return { skillIds: [], skillGroupIds: [] }
  }

  const candidateCondition =
    directSkillIds.length > 0 && sourceGroupIds.length > 0
      ? or(inArray(skills.id, directSkillIds), inArray(skills.groupId, sourceGroupIds))
      : directSkillIds.length > 0
        ? inArray(skills.id, directSkillIds)
        : inArray(skills.groupId, sourceGroupIds)
  const rows = await db
    .select({
      id: skills.id,
      groupId: skills.groupId,
      userId: skills.userId,
      visibility: skills.visibility,
    })
    .from(skills)
    .where(candidateCondition)
  const unsafeOwnedGroupIds = new Set(
    rows
      .filter(
        (row) =>
          row.groupId !== null &&
          ownedGroupIds.has(row.groupId) &&
          !canNonAdminUseSkill(row, callerId),
      )
      .flatMap((row) => (row.groupId === null ? [] : [row.groupId])),
  )
  const retainedGroupIds = [
    ...new Set(
      sourceGroupIds.filter((id) => ownedGroupIds.has(id) && !unsafeOwnedGroupIds.has(id)),
    ),
  ]
  const retainedGroupIdSet = new Set(retainedGroupIds)
  const droppedGroupIds = [...new Set(sourceGroupIds.filter((id) => !retainedGroupIdSet.has(id)))]
  const droppedGroupIdSet = new Set(droppedGroupIds)
  const allowedRows = rows.filter((row) => canNonAdminUseSkill(row, callerId))
  const allowedIds = new Set(allowedRows.map((row) => row.id))
  const flattenedIds = allowedRows
    .filter((row) => row.groupId !== null && droppedGroupIdSet.has(row.groupId))
    .map((row) => row.id)

  return {
    skillIds: [...new Set([...directSkillIds.filter((id) => allowedIds.has(id)), ...flattenedIds])],
    skillGroupIds: retainedGroupIds,
  }
}
