import { isAbsolute, resolve, sep } from 'node:path'
import {
  MAX_GIT_REPOS,
  createScmSourceInput,
  scmSourceConfigSchema,
  scmSourceTypeEnum,
  updateScmSourceInput,
} from '@a2wave/shared'
import type { GitConfig, P4Config, ScmSourceConfig } from '@a2wave/shared'
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { agents, runs, scmSources } from '../db/schema.js'
import { scmSourceAuditDetails } from '../lib/audit-details.js'
import { logAudit } from '../lib/audit.js'
import { isCodegraphEnabled, runCodegraphIndex } from '../lib/codegraph-index.js'
import { checkGitConnection } from '../lib/git-sync.js'
import { WORKTREE_NAME_REGEX, defaultWorkspacesPath } from '../lib/git-workspace.js'
import { createId } from '../lib/id.js'
import { logger } from '../lib/logger.js'
import { getCurrentUserId, getOwnerFilter } from '../lib/owner-filter.js'
import {
  cancelInitialScmSync,
  checkP4Connection,
  isCheckoutBusy,
  releaseCheckout,
  startAutoSync,
  startInitialScmSync,
  stopAutoSync,
  syncScmSource,
  tryAcquireCheckout,
} from '../lib/p4-sync.js'
import type { ScmPathPeer } from '../lib/scm-path-plan.js'
import { resolveScmPathPlan } from '../lib/scm-path-plan.js'
import {
  maskScmSourceRow,
  redactRepoUrlCredential,
  rehydrateScmConfigSecrets,
  scmConfigEquals,
} from '../lib/scm-secret-mask.js'
import { createScmSource } from '../lib/scm-source.js'
import { validateStoredScmWorkspacesRoot } from '../lib/scm-workspace-safety.js'
import { isAdmin } from '../middleware/auth-middleware.js'
import { rateLimit } from '../middleware/rate-limit.js'

const app = new Hono()

/**
 * Probing spawns subprocesses and dials a caller-supplied host, so it is rate
 * limited per user the same way provider model probing is (`providers.ts`):
 * without a cap it is a convenient amplifier — each request can fan out to
 * MAX_GIT_REPOS outbound connections and needs no stored row to do it.
 */
const probeScmRateLimit = rateLimit({
  windowMs: 60_000,
  max: 20,
  keyFn: (c) => String(c.get('userId' as never) ?? 'anonymous'),
})

const RETIRED_SETUP_SCRIPT_ERROR = 'setupScript is no longer supported'

function hasRetiredSetupScriptField(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    Object.prototype.hasOwnProperty.call(body, 'setupScript')
  )
}

/**
 * Every row's path fields, for cross-source conflict checks.
 *
 * Pulled in full rather than filtered in SQL: overlap is an ancestor/descendant
 * relation that `eq` cannot express, and the table is small (tens of rows).
 */
async function selectScmPathPeers(): Promise<ScmPathPeer[]> {
  return db
    .select({
      id: scmSources.id,
      name: scmSources.name,
      localPath: scmSources.localPath,
      workspacesPath: scmSources.workspacesPath,
    })
    .from(scmSources)
}

// ============================================================
// CRUD Routes
// ============================================================

/** GET / - 列出所有代码源 */
app.get('/', async (c) => {
  const { page = '1', pageSize = '50' } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const totalResult = (
    await db.select({ count: count() }).from(scmSources).where(ownerFilter).limit(1)
  )[0]
  const data = await db
    .select()
    .from(scmSources)
    .where(ownerFilter)
    .orderBy(desc(scmSources.createdAt))
    .limit(limit)
    .offset(offset)
  const total = totalResult?.count ?? 0

  return c.json({
    // Mask stored credentials (P4 p4passwd / Git pat / repoUrl userinfo) on every
    // read: an admin list would otherwise dump every user's SCM secrets in plaintext.
    data: data.map(maskScmSourceRow),
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

/** GET /:id - 获取单个代码源 */
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
  }
  return c.json({ data: maskScmSourceRow(source) })
})

/** POST / - 创建代码源 */
app.post('/', async (c) => {
  const body = await c.req.json()
  if (hasRetiredSetupScriptField(body)) {
    return c.json({ error: RETIRED_SETUP_SCRIPT_ERROR }, 400)
  }
  const parsed = createScmSourceInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  // The `type` column and the config are separate inputs; letting them disagree
  // writes a row that lies about its own shape, and `POST /:id/check` would then
  // hand a P4 config to `checkGitConnection`. `/probe` already checks this.
  if (parsed.data.config.type !== parsed.data.type) {
    return c.json({ error: 'Source type does not match config type' }, 400)
  }

  const id = createId('scm')

  // Create and PATCH resolve paths through the same planner: every rule
  // (absolute, no overlap with any other source's checkout OR worktree root,
  // approved workspaces root, P4 needs an explicit path) applies to both.
  const plan = resolveScmPathPlan({
    sourceId: id,
    type: parsed.data.type,
    localPath: parsed.data.localPath,
    workspacesPath: parsed.data.workspacesPath,
    existingSources: await selectScmPathPeers(),
    isAdmin: isAdmin(c),
  })
  if (!plan.ok) {
    return c.json({ error: plan.error }, plan.status)
  }
  const { localPath, workspacesPath: finalWorkspacesPath } = plan

  const now = new Date()
  const userId = getCurrentUserId(c)

  // Normalize before persisting, with no stored row to restore from: create has
  // nothing to rehydrate, but it must still refuse to store the mask sentinel as
  // a real credential. The first-party form starts blank and would not produce
  // one, but the route is a public API surface that a legacy or hand-rolled
  // client can reach directly.
  const rehydratedCreate = rehydrateScmConfigSecrets(parsed.data.config, undefined)
  if (!rehydratedCreate.ok) {
    return c.json({ error: rehydratedCreate.error }, 400)
  }
  // 将 discriminated union config 序列化为 plain object
  const configData = { ...rehydratedCreate.config }

  const newSource = (
    await db
      .insert(scmSources)
      .values({
        id,
        name: parsed.data.name,
        type: parsed.data.type,
        description: parsed.data.description ?? null,
        config: configData,
        localPath,
        workspacesPath: finalWorkspacesPath,
        isEnabled: parsed.data.isEnabled ?? true,
        userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
  )[0]

  // Initial checkout and periodic refresh are separate lifecycle concerns. An
  // enabled source must become usable once even when recurring auto-sync is
  // disabled; autoSync controls only subsequent interval ticks.
  const syncConfig = parsed.data.config as { autoSync?: boolean; syncIntervalMin?: number }
  if (newSource.isEnabled) {
    if (syncConfig.autoSync && syncConfig.syncIntervalMin) {
      startAutoSync(id, syncConfig.syncIntervalMin)
    }
    void startInitialScmSync(id).catch((error) => {
      logger.error({ sourceId: id, error }, 'Initial SCM sync failed')
    })
  }

  logAudit(c, {
    action: 'scm_source.create',
    resource: 'scm_source',
    resourceId: id,
    details: scmSourceAuditDetails(newSource),
  })

  logger.info({ id, name: parsed.data.name, type: parsed.data.type }, 'Created SCM source')
  // Uniform contract: no create/update read path ever returns plaintext secrets.
  return c.json({ data: maskScmSourceRow(newSource) }, 201)
})

/** PATCH /:id - 更新代码源 */
app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  let existing = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!existing) {
    return c.json({ error: 'SCM source not found' }, 404)
  }

  const body = await c.req.json()
  if (hasRetiredSetupScriptField(body)) {
    return c.json({ error: RETIRED_SETUP_SCRIPT_ERROR }, 400)
  }
  const parsed = updateScmSourceInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  // 取更新后的有效值（未更新则沿用现有），任一方变化都需要重新校验。
  // Same planner as create — see resolveScmPathPlan for why both routes share it.
  const rawWsPath =
    parsed.data.workspacesPath !== undefined ? parsed.data.workspacesPath : existing.workspacesPath
  const plan = resolveScmPathPlan({
    sourceId: id,
    type: existing.type,
    localPath: parsed.data.localPath ?? existing.localPath,
    workspacesPath: rawWsPath,
    existingSources: await selectScmPathPeers(),
    excludeId: id,
    isAdmin: isAdmin(c),
  })
  if (!plan.ok) {
    return c.json({ error: plan.error }, plan.status)
  }
  const effectiveWsPath = plan.workspacesPath

  // Validate the effective root on EVERY update, including unrelated name/config
  // changes. This is the migration backstop for unsafe rows created by older
  // versions; editing another field must not reactivate their workspace access.
  // Distinct from the planner's check: this one resolves the OWNER's live admin
  // role, so a demoted owner loses arbitrary-root access without an edit.
  const workspacesRootError = await validateStoredScmWorkspacesRoot({
    ...existing,
    workspacesPath: effectiveWsPath,
  })
  if (workspacesRootError) {
    return c.json({ error: workspacesRootError }, 400)
  }

  const payload: Record<string, unknown> = { updatedAt: new Date() }
  if (parsed.data.name !== undefined) payload.name = parsed.data.name
  if (parsed.data.description !== undefined) payload.description = parsed.data.description
  if (parsed.data.localPath !== undefined) payload.localPath = parsed.data.localPath
  if (parsed.data.workspacesPath !== undefined) payload.workspacesPath = parsed.data.workspacesPath
  if (parsed.data.isEnabled !== undefined) payload.isEnabled = parsed.data.isEnabled
  if (parsed.data.config !== undefined) {
    // `updateScmSourceInput` carries no `type`, so nothing else stops a git
    // config from being written onto a P4 row. Beyond the shape mismatch, that
    // is the one first-party route into the sentinel bypass: rehydration ignores
    // a stored config of a different type, so a submitted mask would resolve
    // against nothing. Changing an existing source's type is not a supported
    // edit — delete and recreate instead.
    //
    // Compared against the stored config's own discriminant rather than the
    // `type` column: that is the value rehydration keys on, so this rejects
    // exactly the mismatches that would silently skip restoration. A row whose
    // column and config disagree is unreachable now that create validates both.
    const storedType = (existing.config as ScmSourceConfig | undefined)?.type ?? existing.type
    if (parsed.data.config.type !== storedType) {
      return c.json({ error: 'Config type does not match the source type' }, 400)
    }
    const rehydrated = rehydrateScmConfigSecrets(
      parsed.data.config,
      existing.config as ScmSourceConfig | undefined,
    )
    // A masked URL that matched no stored URL cannot be recovered; refuse rather
    // than persist `********@host` (which would drop the real credential and
    // break clone). The user must re-enter the full URL.
    if (!rehydrated.ok) {
      return c.json({ error: rehydrated.error }, 400)
    }
    payload.config = rehydrated.config
  }

  const localPathChanged =
    parsed.data.localPath !== undefined && parsed.data.localPath !== existing.localPath
  // Compare the rehydrated config (masked secrets already restored to their stored
  // values), not the raw request: a pure masked round-trip must NOT read as a config
  // change, or it would needlessly reset sync bookkeeping on every no-op edit.
  const configChanged =
    parsed.data.config !== undefined && !scmConfigEquals(payload.config, existing.config)
  // A reset of sync bookkeeping while a sync holds the row would release a lock
  // this request does not own: the manual-sync route could then acquire cleanly
  // and start a second sync against the same working directory, and the running
  // sync would later resurrect the initialSyncCompletedAt we null out here.
  const resetsSyncState = localPathChanged || configChanged
  // Disabling a source must stop its background checkout too. Cancelling only
  // for localPath/config edits left the clone running against a source the
  // operator believes is off — and the restart below would then start another.
  const disablesSource = parsed.data.isEnabled === false && existing.isEnabled
  if (resetsSyncState || disablesSource) {
    // The create/update/recovery initial checkout is cancellable so a bad URL
    // cannot lock its own repair form for the entire clone timeout. Manual and
    // recurring syncs remain non-cancellable here and retain the 409 guard.
    if (existing.initialSyncCompletedAt == null && (await cancelInitialScmSync(id))) {
      existing = (await db.select().from(scmSources).where(conditions).limit(1))[0]
      if (!existing) return c.json({ error: 'SCM source not found' }, 404)
    }
  }
  if (resetsSyncState) {
    // The checkout stays busy after syncStatus returns to 'idle' while post-sync
    // indexing runs against the old localPath. Changing localPath/config
    // then would let that job finish writing the wrong tree and resurrect the
    // initialSyncCompletedAt we null out below. The ne('syncing') predicate on
    // the UPDATE only covers the in-progress phase, not this post-sync window.
    if (isCheckoutBusy(id)) {
      return c.json(
        { error: 'Cannot change localPath or config while a sync or indexing job is running' },
        409,
      )
    }
    // `existing` was read before `await c.req.json()`, so this snapshot check is
    // only a fast-path 409; the authoritative guard is the ne('syncing')
    // predicate on the UPDATE below, which closes the read-to-write TOCTOU.
    if (existing.syncStatus === 'syncing') {
      return c.json({ error: 'Cannot change localPath or config while a sync is in progress' }, 409)
    }
    payload.initialSyncCompletedAt = null
    payload.syncStatus = 'idle'
    payload.lastSyncAt = null
    payload.lastSyncError = null
  }

  // When resetting sync state, refuse atomically if a sync grabbed the row in
  // the meantime (returning().get() yields undefined on no match).
  const updateWhere = resetsSyncState
    ? and(eq(scmSources.id, id), ne(scmSources.syncStatus, 'syncing'))
    : eq(scmSources.id, id)
  const updated = (await db.update(scmSources).set(payload).where(updateWhere).returning())[0]
  if (!updated) {
    return c.json({ error: 'Cannot change localPath or config while a sync is in progress' }, 409)
  }

  // 重新调度自动同步（P4 和 Git 通用）
  stopAutoSync(id)
  if (updated.isEnabled) {
    const syncConfig = updated.config as unknown as { autoSync?: boolean; syncIntervalMin?: number }
    if (syncConfig.autoSync && syncConfig.syncIntervalMin) {
      startAutoSync(id, syncConfig.syncIntervalMin)
    }
    if (updated.initialSyncCompletedAt == null) {
      void startInitialScmSync(id).catch((error) => {
        logger.error({ sourceId: id, error }, 'Initial SCM sync after update failed')
      })
    }
  }

  logAudit(c, {
    action: 'scm_source.update',
    resource: 'scm_source',
    resourceId: id,
    details: scmSourceAuditDetails(updated),
  })

  logger.info({ id, name: updated.name }, 'Updated SCM source')
  // Mask before returning: `updated` is the freshly-written row whose config holds
  // the rehydrated plaintext secret. Without masking, PATCH becomes a plaintext
  // exfiltration path (submit the masked value back, read the real one in the reply).
  return c.json({ data: maskScmSourceRow(updated) })
})

/** DELETE /:id - 删除代码源（检查 Agent 引用） */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
  }

  // 检查是否有 Agent 引用
  const referencingAgents = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(eq(agents.scmSourceId, id))

  if (referencingAgents.length > 0) {
    const names = referencingAgents.map((a) => a.name).join(', ')
    return c.json({ error: `Cannot delete: referenced by agents: ${names}` }, 409)
  }

  // Automatic initial checkouts are owned by this process and are safe to
  // cancel before deletion. Manual/recurring syncs and indexing jobs remain
  // protected by the busy and atomic DB guards below.
  await cancelInitialScmSync(id)

  if (isCheckoutBusy(id)) {
    return c.json({ error: 'Cannot delete an SCM source while its checkout is in use' }, 409)
  }

  // Close the gap after the in-memory check: a sync or index may acquire its DB
  // status before DELETE reaches the database. If it does, delete no row.
  const deleteConditions = ownerFilter
    ? and(
        eq(scmSources.id, id),
        ownerFilter,
        ne(scmSources.syncStatus, 'syncing'),
        ne(scmSources.codegraphStatus, 'indexing'),
      )
    : and(
        eq(scmSources.id, id),
        ne(scmSources.syncStatus, 'syncing'),
        ne(scmSources.codegraphStatus, 'indexing'),
      )
  const deleted = (await db.delete(scmSources).where(deleteConditions).returning())[0]
  if (!deleted) {
    return c.json({ error: 'Cannot delete an SCM source while its checkout is in use' }, 409)
  }

  stopAutoSync(id)

  // Record the shape of what was removed: after a delete the row is gone, so the
  // audit entry is the only remaining answer to "what did that source point at".
  logAudit(c, {
    action: 'scm_source.delete',
    resource: 'scm_source',
    resourceId: id,
    details: scmSourceAuditDetails(source),
  })

  logger.info({ id, name: source.name }, 'Deleted SCM source')
  return c.json({ data: maskScmSourceRow(deleted) })
})

// ============================================================
// Sync & Check Routes
// ============================================================

const probeScmSourceInput = z.object({
  type: scmSourceTypeEnum,
  localPath: z.string().refine(isAbsolute, { message: 'localPath must be absolute' }).optional(),
  /**
   * Bounded to MAX_GIT_REPOS here rather than in `scmSourceConfigSchema`: this
   * is the path where an uncapped list turns into that many concurrent
   * subprocesses on request, and it is the only one with no stored row behind
   * it. Capping the shared schema instead would also gate `PATCH /:id` and lock
   * a pre-existing oversized source out of its own settings page.
   */
  config: scmSourceConfigSchema.refine(
    (config) => config.type !== 'git' || (config.repos?.length ?? 0) <= MAX_GIT_REPOS,
    { message: `A probe may cover at most ${MAX_GIT_REPOS} repositories` },
  ),
  /**
   * Optional id of the source the form was loaded from. Only used to resolve
   * masked credentials the form round-tripped; every other field is taken from
   * `config`. Absent in create mode.
   */
  sourceId: z.string().optional(),
})

/**
 * The endpoint a probe dialed, in a form safe to persist in an audit log:
 * scheme + host + path only, and just the address for P4 (never `p4passwd`).
 * Multi-repo probes record every URL so the trail shows which hosts were
 * contacted.
 *
 * Query and fragment are dropped rather than redacted. `redactRepoUrlCredential`
 * alone is not enough here — it strips userinfo, but a token can also ride in a
 * query string (`?access_token=...`, which git hosts accept), and enumerating
 * every secret-bearing parameter name is a losing game. The address is all an
 * audit entry needs, so anything that could carry a secret is discarded instead.
 */
function probeEndpointForAudit(config: ScmSourceConfig): string {
  if (config.type === 'p4') return config.p4port
  const urls = [config.repoUrl, ...(config.repos ?? []).map((r) => r.repoUrl)].filter(Boolean)
  return urls.map(auditSafeRepoUrl).join(', ')
}

/** True when a repo URL embeds an inline password — the only secret a URL carries. */
function repoUrlCarriesSecret(repoUrl: string | undefined): boolean {
  if (!repoUrl) return false
  try {
    return Boolean(new URL(repoUrl).password)
  } catch {
    return false // scp-style `git@host:org/repo` has no inline password
  }
}

/**
 * True when rehydration actually pulled a secret out of the stored row — i.e.
 * the resolved config carries a credential the caller did not submit.
 *
 * "Differs from what was submitted" is necessary but not sufficient: resolving
 * the mask sentinel against a row that holds NO credential also changes the
 * value (`'********'` → empty), and that is a strip, not a pull.
 *
 * The URL arm additionally has to ask what the restored URL *carries*, not just
 * that it changed. `redactRepoUrlCredential` masks userinfo whether or not a
 * password is present, so a stored `https://alice@host/r` round-trips as
 * `https://********@host/r` and restores to a different string carrying no
 * secret at all — and both that helper and `storedHasGitSecret` explicitly hold
 * that a bare username is not a credential. Reporting a pull there would point
 * an auditor at something this codebase elsewhere denies is a secret.
 */
function resolvedFromStoredSecret(submitted: ScmSourceConfig, resolved: ScmSourceConfig): boolean {
  if (submitted.type === 'p4' || resolved.type === 'p4') {
    return submitted.type === 'p4' && resolved.type === 'p4'
      ? Boolean(resolved.p4passwd) && submitted.p4passwd !== resolved.p4passwd
      : false
  }
  if (resolved.pat && submitted.pat !== resolved.pat) return true
  const submittedUrls = [submitted.repoUrl, ...(submitted.repos ?? []).map((r) => r.repoUrl)]
  const resolvedUrls = [resolved.repoUrl, ...(resolved.repos ?? []).map((r) => r.repoUrl)]
  return submittedUrls.some(
    (url, i) => repoUrlCarriesSecret(resolvedUrls[i]) && url !== resolvedUrls[i],
  )
}

function auditSafeRepoUrl(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    // Not a parseable URL (scp-style `git@host:org/repo`): no query to strip,
    // and redaction still handles any userinfo the form may carry.
    return redactRepoUrlCredential(repoUrl)
  }
}

/**
 * POST /probe - 探测连接（无状态，不落库）
 *
 * Validates the config in the request body rather than a stored row, so a user
 * can test credentials *before* saving — and re-test after editing without
 * persisting a config that may be wrong.
 *
 * Declared before `/:id/*` so the literal path is not captured as an `:id`.
 */
app.post('/probe', probeScmRateLimit, async (c) => {
  const body = await c.req.json().catch(() => null)
  const parsed = probeScmSourceInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid probe input', details: parsed.error.flatten() }, 400)
  }

  const { type, config, sourceId } = parsed.data
  if (config.type !== type) {
    return c.json({ error: 'Probe type does not match config type' }, 400)
  }

  // Resolve masked credentials against the stored row. The ownership filter is
  // what makes passing a `sourceId` safe: without it, any authenticated user
  // could probe an arbitrary id with `pat: '********'` and use the pass/fail
  // answer as an oracle for someone else's credentials.
  let stored: ScmSourceConfig | undefined
  if (sourceId) {
    const ownerFilter = getOwnerFilter(c, scmSources.userId)
    const conditions = ownerFilter
      ? and(eq(scmSources.id, sourceId), ownerFilter)
      : eq(scmSources.id, sourceId)
    const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
    if (!source) {
      return c.json({ error: 'SCM source not found' }, 404)
    }
    stored = source.config as ScmSourceConfig | undefined
  }

  // `requireSameEndpoint` is what separates this from the save path: probe DIALS
  // OUT with whatever it resolves, and the caller picks the credential (by
  // sourceId) and the destination (by body) independently. Without the binding,
  // a stored PAT / P4 password could be aimed at an arbitrary host — and since
  // getOwnerFilter is undefined for admins while the mask deliberately hides
  // secrets from admins too, that would hand any admin every user's credential
  // through a request that writes no row.
  const rehydrated = rehydrateScmConfigSecrets(config, stored, { requireSameEndpoint: true })
  if (!rehydrated.ok) {
    return c.json({ error: rehydrated.error }, 400)
  }

  // The result carries only pass/fail plus messages that ran through
  // sanitizeCredentials / redactRepoUrlCredential, so a resolved secret is never
  // reflected back to the caller.
  const result =
    rehydrated.config.type === 'p4'
      ? await checkP4Connection(rehydrated.config as P4Config, parsed.data.localPath)
      : await checkGitConnection(rehydrated.config as GitConfig)

  // Probe writes no row and no run record, so this entry is the only trace an
  // outbound connection — possibly made with a stored credential — ever happened
  // (Iron Rule 5). The endpoint is recorded redacted: an audit log must not
  // become one more place a credential is written down.
  logAudit(c, {
    action: 'scm_source.probe',
    resource: 'scm_source',
    resourceId: sourceId,
    details: {
      type,
      endpoint: probeEndpointForAudit(rehydrated.config),
      // Whether a secret was actually pulled from the row, not merely whether a
      // sourceId was supplied: in edit mode the user may have typed a fresh
      // credential, and an audit entry claiming otherwise misdirects anyone
      // later asking "whose credential left this instance".
      usedStoredCredential: resolvedFromStoredSecret(config, rehydrated.config),
      ok: result.ok,
    },
  })

  return c.json({ data: result })
})

/** POST /:id/sync - 手动触发同步（fire-and-forget，后台异步执行） */
app.post('/:id/sync', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
  }

  // Atomic check-and-set: only update if not already syncing (prevents TOCTOU race).
  // Acquired here so the ownership filter applies; syncScmSource is then told the
  // status is already held so it does not try to acquire a second time.
  const atomicConditions = ownerFilter
    ? and(eq(scmSources.id, id), ownerFilter, ne(scmSources.syncStatus, 'syncing'))
    : and(eq(scmSources.id, id), ne(scmSources.syncStatus, 'syncing'))
  const acquired = (
    await db
      .update(scmSources)
      .set({ syncStatus: 'syncing', updatedAt: new Date() })
      .where(atomicConditions)
      .returning()
  )[0]
  if (!acquired) {
    return c.json({ error: 'Sync already in progress' }, 409)
  }

  // Take the checkout lock synchronously, atomically with the status CAS above
  // (no await between them). If post-sync indexing from a prior sync still
  // holds the checkout, roll the status back and 409 rather than running a sync
  // over a tree that is still being written.
  if (!tryAcquireCheckout(id)) {
    await db
      .update(scmSources)
      .set({ syncStatus: 'idle', updatedAt: new Date() })
      .where(eq(scmSources.id, id))
    return c.json({ error: 'Sync already in progress' }, 409)
  }

  syncScmSource(id, { statusAlreadyAcquired: true, checkoutAlreadyAcquired: true }).catch((err) => {
    logger.error({ sourceId: id, error: err }, 'Background sync failed')
  })

  return c.json({ data: { message: 'Sync started' } }, 202)
})

/** POST /:id/check - 检测连接状态 */
app.post('/:id/check', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
  }

  if (source.type === 'p4') {
    const config = source.config as unknown as P4Config
    const result = await checkP4Connection(config, source.localPath)
    return c.json({ data: result })
  }

  if (source.type === 'git') {
    const config = source.config as unknown as GitConfig
    const result = await checkGitConnection(config)
    return c.json({ data: result })
  }

  return c.json({ error: `Unsupported SCM type: ${source.type}` }, 400)
})

/** GET /:id/status - 获取同步状态 */
app.get('/:id/status', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
  }

  const workspaceRootError = await validateStoredScmWorkspacesRoot(source)
  if (workspaceRootError) {
    return c.json({ error: workspaceRootError }, 400)
  }

  return c.json({
    data: {
      syncStatus: source.syncStatus,
      lastSyncAt: source.lastSyncAt,
      lastSyncError: source.lastSyncError,
      initialSyncCompletedAt: source.initialSyncCompletedAt,
      codegraphStatus: source.codegraphStatus,
      codegraphLastIndexedAt: source.codegraphLastIndexedAt,
      codegraphLastError: source.codegraphLastError,
    },
  })
})

/** POST /:id/codegraph/reindex - 手动触发 CodeGraph 索引（fire-and-forget） */
app.post('/:id/codegraph/reindex', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
  }

  if (!isCodegraphEnabled(source.config)) {
    return c.json({ error: 'CodeGraph is not enabled for this source' }, 400)
  }

  // A sync or its post-sync work may still be writing the checkout even though
  // codegraphStatus is idle. Refuse so indexing does not run over a tree that
  // git/P4 is moving under it.
  if (isCheckoutBusy(id)) {
    return c.json({ error: 'A sync job is currently using this checkout' }, 409)
  }

  const atomicConditions = ownerFilter
    ? and(eq(scmSources.id, id), ownerFilter, ne(scmSources.codegraphStatus, 'indexing'))
    : and(eq(scmSources.id, id), ne(scmSources.codegraphStatus, 'indexing'))
  const acquired = (
    await db
      .update(scmSources)
      .set({ codegraphStatus: 'indexing', codegraphLastError: null, updatedAt: new Date() })
      .where(atomicConditions)
      .returning()
  )[0]
  if (!acquired) {
    return c.json({ error: 'CodeGraph indexing already in progress' }, 409)
  }

  // Hold the checkout lock for the whole index so a sync cannot start against
  // the same tree. Bail out (releasing the DB CAS) if another writer grabbed the
  // checkout between the two acquires.
  if (!tryAcquireCheckout(id)) {
    await db
      .update(scmSources)
      .set({ codegraphStatus: 'idle', updatedAt: new Date() })
      .where(eq(scmSources.id, id))
    return c.json({ error: 'A sync job is currently using this checkout' }, 409)
  }

  // A throw from logAudit (synchronous insert) after the checkout is held must
  // release it and reset the status, not strand
  // the source in busyCheckouts until restart.
  try {
    logAudit(c, {
      action: 'scm_source.codegraph.reindex',
      resource: 'scm_source',
      resourceId: id,
    })

    runCodegraphIndex(id, { alreadyAcquired: true })
      .catch((err) => {
        logger.error({ sourceId: id, error: err }, 'CodeGraph indexing unexpected error')
      })
      .finally(() => {
        releaseCheckout(id)
      })
  } catch (err) {
    releaseCheckout(id)
    await db
      .update(scmSources)
      .set({ codegraphStatus: 'idle', updatedAt: new Date() })
      .where(eq(scmSources.id, id))
    logger.error({ sourceId: id, error: err }, 'Failed to start CodeGraph indexing')
    return c.json({ error: 'Failed to start CodeGraph indexing' }, 500)
  }

  return c.json({ data: { message: 'CodeGraph indexing started' } }, 202)
})

// ============================================================
// Workspace Management
// ============================================================

/** GET /:id/workspaces - 列出代码源的所有 worktree */
app.get('/:id/workspaces', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) return c.json({ error: 'Source not found' }, 404)

  const workspacesRootError = await validateStoredScmWorkspacesRoot(source)
  if (workspacesRootError) return c.json({ error: workspacesRootError }, 400)

  const scm = await createScmSource(source)
  if (!scm) return c.json({ error: 'Source type does not support workspaces' }, 400)

  const workspaces = await scm.listWorkspaces()

  // 附加 occupied 状态
  const result = await Promise.all(
    workspaces.map(async (ws) => {
      const occupied = (
        await db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(eq(runs.workDir, ws.path), inArray(runs.status, ['running', 'pending', 'queued'])),
          )
          .limit(1)
      )[0]
      return { ...ws, occupied: !!occupied }
    }),
  )

  return c.json({ data: result })
})

/** DELETE /:id/workspaces/:name - 删除 worktree */
app.delete('/:id/workspaces/:name', async (c) => {
  const { id, name } = c.req.param()
  if (!WORKTREE_NAME_REGEX.test(name)) {
    return c.json({ error: 'Invalid workspace name' }, 400)
  }
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) return c.json({ error: 'Source not found' }, 404)

  const workspacesRootError = await validateStoredScmWorkspacesRoot(source)
  if (workspacesRootError) return c.json({ error: workspacesRootError }, 400)

  const scm = await createScmSource(source)
  if (!scm) return c.json({ error: 'Source type does not support workspaces' }, 400)

  const { join } = await import('node:path')
  const wsPath = join(scm.wsRoot, name)

  // 检查占用
  const occupied = (
    await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.workDir, wsPath), inArray(runs.status, ['running', 'pending', 'queued'])))
      .limit(1)
  )[0]
  if (occupied) {
    return c.json({ error: 'Workspace is occupied by a running or pending run' }, 409)
  }

  await scm.removeWorkspace(name)
  return c.json({ data: { message: 'Workspace removed' } })
})

export default app
