import { isAbsolute, resolve, sep } from 'node:path'
import type { GitConfig, P4Config, ScmSourceConfig } from '@a2wave/shared'
import {
  createScmSourceInput,
  MAX_GIT_REPOS,
  scmSourceConfigSchema,
  scmSourceTypeEnum,
  updateScmSourceInput,
} from '@a2wave/shared'
import { and, count, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { db } from '../db/client.js'
import { agents, runs, scmSources, scmWorkloadLeases } from '../db/schema.js'
import { runExclusive } from '../db/transaction.js'
import { logAudit, writeAudit } from '../lib/audit.js'
import { scmSourceAuditDetails } from '../lib/audit-details.js'
import { isCodegraphEnabled, runCodegraphIndex } from '../lib/codegraph-index.js'
import { checkGitConnection } from '../lib/git-sync.js'
import {
  defaultWorkspacesPath,
  isPerAgentWorkspaceName,
  perAgentWorkspaceName,
  WORKTREE_NAME_REGEX,
} from '../lib/git-workspace.js'
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
import {
  resolveScmPathPlan,
  selectScmPathPeers,
  withScmPathMutation,
} from '../lib/scm-path-plan.js'
import {
  maskScmSourceRow,
  redactRepoUrlCredential,
  rehydrateScmConfigSecrets,
  scmConfigEquals,
} from '../lib/scm-secret-mask.js'
import { createScmSource } from '../lib/scm-source.js'
import { isolateManagedScmStorage } from '../lib/scm-storage-reclaim.js'
import { findDurableScmSourceWorkload } from '../lib/scm-workload-lifecycle.js'
import {
  findPendingWorkspaceRemoval,
  removeSourceWorkspaceGuarded,
  WorkspaceRemovalBlockedError,
} from '../lib/scm-workspace-removal.js'
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
  return typeof body === 'object' && body !== null && Object.hasOwn(body, 'setupScript')
}

// ============================================================
// CRUD Routes
// ============================================================

/** GET / - List all SCM sources */
app.get('/', async (c) => {
  const { page = '1', pageSize = '50' } = c.req.query()
  const pageNum = Math.max(1, Number.parseInt(page) || 1)
  const limit = Math.min(100, Math.max(1, Number.parseInt(pageSize) || 50))
  const offset = (pageNum - 1) * limit

  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const visibleFilter = and(ownerFilter, isNull(scmSources.deletionRequestedAt))
  const totalResult = (
    await db.select({ count: count() }).from(scmSources).where(visibleFilter).limit(1)
  )[0]
  const data = await db
    .select()
    .from(scmSources)
    .where(visibleFilter)
    .orderBy(desc(scmSources.createdAt))
    .limit(limit)
    .offset(offset)
  const total = totalResult?.count ?? 0

  return c.json({
    // Mask stored credentials (P4 p4passwd / Git pat / repoUrl userinfo) on every
    // read: an admin list would otherwise dump every user's SCM secrets in plaintext.
    data: data.filter((source) => !source.deletionRequestedAt).map(maskScmSourceRow),
    pagination: { total, page: pageNum, pageSize: limit, totalPages: Math.ceil(total / limit) },
  })
})

/** GET /:id - Fetch a single SCM source */
app.get('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  // Same visibility rule as the list: a source with a committed deletion
  // reservation is on its way out and rejects every write, so serving it by id
  // would present a live source that 409s on the next edit.
  const visible = and(eq(scmSources.id, id), isNull(scmSources.deletionRequestedAt))
  const conditions = ownerFilter ? and(visible, ownerFilter) : visible
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
  }
  return c.json({ data: maskScmSourceRow(source) })
})

/** POST / - Create an SCM source */
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
  // Serialize the discriminated-union config into a plain object
  const configData = { ...rehydratedCreate.config }

  // The peer scan and insert share one mutation lock. Without it, two requests
  // can both observe an empty slot and persist ancestor/descendant paths that a
  // UNIQUE constraint cannot represent as conflicting.
  const createResult = await withScmPathMutation(async (tx) => {
    const plan = resolveScmPathPlan({
      sourceId: id,
      type: parsed.data.type,
      localPath: parsed.data.localPath,
      workspacesPath: parsed.data.workspacesPath,
      existingSources: await selectScmPathPeers(tx),
      isAdmin: isAdmin(c),
    })
    if (!plan.ok) return { ok: false, error: plan } as const

    const source = (
      await tx
        .insert(scmSources)
        .values({
          id,
          name: parsed.data.name,
          type: parsed.data.type,
          description: parsed.data.description ?? null,
          config: configData,
          localPath: plan.localPath,
          workspacesPath: plan.workspacesPath,
          isEnabled: parsed.data.isEnabled ?? true,
          userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
    )[0]
    return { ok: true, source } as const
  })
  if (!createResult.ok) {
    return c.json({ error: createResult.error.error }, createResult.error.status)
  }
  const newSource = createResult.source

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

/** PATCH /:id - Update an SCM source */
app.patch('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  let existing = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!existing) {
    return c.json({ error: 'SCM source not found' }, 404)
  }
  if (existing.deletionRequestedAt) {
    return c.json({ error: 'SCM source deletion is pending' }, 409)
  }

  const body = await c.req.json()
  if (hasRetiredSetupScriptField(body)) {
    return c.json({ error: RETIRED_SETUP_SCRIPT_ERROR }, 400)
  }
  const parsed = updateScmSourceInput.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: parsed.error.flatten() }, 400)
  }

  // The effective post-update values (falling back to the stored ones when a
  // field is omitted). A change to either side requires re-validation.
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
  // The planner's resolved value, never the raw submitted one. Clearing the
  // field (`workspacesPath: null`) means "go back to the default" — but storing
  // NULL makes the root re-resolve on every use, preferring the legacy
  // directory only while it happens to exist on disk. Writing the resolved path
  // pins it, which is the same invariant the boot back-fill establishes.
  if (parsed.data.workspacesPath !== undefined) payload.workspacesPath = effectiveWsPath
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

  // When resetting sync state, refuse atomically if a sync or index grabbed the
  // row in the meantime (returning().get() yields undefined on no match).
  // `codegraphStatus` is checked alongside `syncStatus` for the same reason
  // DELETE checks both: `isCheckoutBusy` is per-process in-memory state, so on a
  // second replica this predicate is all that stops localPath being rewritten
  // while an indexer is still reading the old tree.
  const updateWhere = resetsSyncState
    ? and(
        eq(scmSources.id, id),
        ne(scmSources.syncStatus, 'syncing'),
        ne(scmSources.codegraphStatus, 'indexing'),
        isNull(scmSources.deletionRequestedAt),
      )
    : and(eq(scmSources.id, id), isNull(scmSources.deletionRequestedAt))
  const mutatesWorkspaceLifecycle =
    configChanged || parsed.data.localPath !== undefined || parsed.data.workspacesPath !== undefined
  const updateResult = mutatesWorkspaceLifecycle
    ? await withScmPathMutation(async (tx) => {
        // A durable lease is the authority for "a workload has this checkout
        // as cwd" — including the terminal-status-to-process-exit cleanup
        // window, where the busy/sync guards below no longer see the run.
        // Moving localPath or the worktree root under it would re-point the
        // next sync at a fresh path while the process still writes the old one.
        const activeWorkload = await findDurableScmSourceWorkload(tx, id)
        if (activeWorkload) {
          return {
            ok: false,
            error: {
              status: 409 as const,
              error: `Cannot change paths or config while ${activeWorkload.type} "${activeWorkload.id}" uses this source`,
            },
          } as const
        }
        // A pending worktree removal pinned this source's paths when it
        // committed its reservation; moving them now would misdirect the
        // removal's re-check window. Removals are seconds long — retry.
        const pendingRemoval = await findPendingWorkspaceRemoval(tx, id)
        if (pendingRemoval) {
          return {
            ok: false,
            error: {
              status: 409 as const,
              error: `Cannot change paths while workspace "${pendingRemoval.workspaceName}" is being removed`,
            },
          } as const
        }
        const peers = await selectScmPathPeers(tx)
        const currentPeer = peers.find((peer) => peer.id === id)
        const lockedPlan = resolveScmPathPlan({
          sourceId: id,
          type: existing.type,
          localPath: parsed.data.localPath ?? currentPeer?.localPath ?? existing.localPath,
          workspacesPath:
            parsed.data.workspacesPath !== undefined
              ? parsed.data.workspacesPath
              : (currentPeer?.workspacesPath ?? existing.workspacesPath),
          existingSources: peers,
          excludeId: id,
          isAdmin: isAdmin(c),
        })
        if (!lockedPlan.ok) return { ok: false, error: lockedPlan } as const
        if (parsed.data.workspacesPath !== undefined) {
          payload.workspacesPath = lockedPlan.workspacesPath
        }
        const source = (await tx.update(scmSources).set(payload).where(updateWhere).returning())[0]
        return { ok: true, source } as const
      })
    : await runExclusive(async () => ({
        ok: true as const,
        source: (await db.update(scmSources).set(payload).where(updateWhere).returning())[0],
      }))
  if (!updateResult.ok) {
    return c.json({ error: updateResult.error.error }, updateResult.error.status)
  }
  const updated = updateResult.source
  if (!updated) {
    return c.json(
      { error: 'Cannot change localPath or config while a sync or indexing job is running' },
      409,
    )
  }

  // Reschedule auto-sync (shared by P4 and Git)
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

/** DELETE /:id - Delete an SCM source (rejected while an Agent references it) */
app.delete('/:id', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter ? and(eq(scmSources.id, id), ownerFilter) : eq(scmSources.id, id)
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
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
  // Phase one is durable before the filesystem changes: the row remains as a
  // path reservation while deletionRequestedAt records the recovery decision.
  // A rollback therefore leaves both the row and checkout untouched. Startup
  // can finish any request that committed but did not reach phase two.
  const reservation = await withScmPathMutation(async (tx) => {
    const lockedReferences = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.scmSourceId, id))
    if (lockedReferences.length > 0) {
      return {
        referencedBy: lockedReferences,
        activeWorkload: undefined,
        pendingRemoval: undefined,
        row: undefined,
        peers: undefined,
      } as const
    }
    // The Agent-reference scan above is row state; the durable lease is the
    // workload authority. They can disagree in exactly the window that
    // matters — a workload admitted under an Agent whose binding was since
    // released cannot be re-derived from `agents.scmSourceId`, yet its process
    // still has this checkout as cwd.
    const activeWorkload = await findDurableScmSourceWorkload(tx, id)
    if (activeWorkload) {
      return {
        referencedBy: [],
        activeWorkload,
        pendingRemoval: undefined,
        row: undefined,
        peers: undefined,
      } as const
    }
    // An in-flight worktree removal both reads this row (its re-check) and
    // holds an FK reference to it; finalizing the source now would fail on
    // that constraint mid-protocol. Removals are seconds long — retry.
    const pendingRemoval = await findPendingWorkspaceRemoval(tx, id)
    if (pendingRemoval) {
      return {
        referencedBy: [],
        activeWorkload: undefined,
        pendingRemoval,
        row: undefined,
        peers: undefined,
      } as const
    }
    const peers = await selectScmPathPeers(tx)
    const row = (
      await tx
        .update(scmSources)
        .set({
          deletionRequestedAt: new Date(),
          deletionRequestedBy: getCurrentUserId(c),
          isEnabled: false,
          updatedAt: new Date(),
        })
        .where(and(deleteConditions, isNull(scmSources.deletionRequestedAt)))
        .returning()
    )[0]
    if (!row) {
      return {
        referencedBy: [],
        activeWorkload: undefined,
        pendingRemoval: undefined,
        row: undefined,
        peers: undefined,
      } as const
    }
    // The reservation is what actually commits here, so that is what this entry
    // records. Reclaim can still fail and leave the row in place; claiming the
    // deletion now would make the trail assert something that never happened.
    // The terminal `scm_source.delete` entry follows the row delete below.
    await writeAudit(
      c,
      {
        action: 'scm_source.request_deletion',
        resource: 'scm_source',
        resourceId: id,
        details: scmSourceAuditDetails(source),
      },
      tx,
    )
    return {
      referencedBy: [],
      activeWorkload: undefined,
      pendingRemoval: undefined,
      row,
      peers,
    } as const
  })
  if (reservation.referencedBy.length > 0) {
    const names = reservation.referencedBy.map((agent) => agent.name).join(', ')
    return c.json({ error: `Cannot delete: referenced by agents: ${names}` }, 409)
  }
  if (reservation.activeWorkload) {
    const { type, id: workloadId } = reservation.activeWorkload
    return c.json({ error: `Cannot delete: source is in use by ${type} "${workloadId}"` }, 409)
  }
  if (reservation.pendingRemoval) {
    return c.json(
      {
        error: `Cannot delete: workspace "${reservation.pendingRemoval.workspaceName}" is being removed; retry`,
      },
      409,
    )
  }
  const pendingSource = reservation?.row ?? source
  if (!reservation.row && !source.deletionRequestedAt) {
    return c.json({ error: 'Cannot reserve the SCM source for deletion' }, 409)
  }

  stopAutoSync(id)

  let reclaimedPaths: string[]
  try {
    const peers = reservation.peers ?? (await selectScmPathPeers())
    const isolatedStorage = await isolateManagedScmStorage(pendingSource, { peers })
    // A peer-blocked path must keep the row: the id-derived directory has no
    // other name, so finalizing now would orphan it with nothing able to
    // retry. The reservation stays, the peer's removal unblocks the retry.
    if (isolatedStorage.blocked.length > 0) {
      const blockedBy = isolatedStorage.blocked.map((entry) => entry.peerId).join(', ')
      logger.warn(
        { sourceId: id, blocked: isolatedStorage.blocked },
        'SCM source deletion remains pending: managed path still overlaps a surviving source',
      )
      return c.json(
        {
          error: `SCM source deletion is pending: its storage overlaps surviving source(s) ${blockedBy}; delete those first, then retry`,
          retryable: true,
        },
        503,
      )
    }
    reclaimedPaths = await isolatedStorage.commit()
  } catch (error) {
    logger.error({ sourceId: id, error }, 'SCM source deletion remains pending for retry')
    return c.json(
      {
        error: 'SCM source deletion is pending; retry deletion later',
        retryable: true,
      },
      503,
    )
  }

  const deleted = await withScmPathMutation(async (tx) => {
    const row = (
      await tx
        .delete(scmSources)
        .where(and(eq(scmSources.id, id), isNotNull(scmSources.deletionRequestedAt)))
        .returning()
    )[0]
    if (!row) return undefined
    await writeAudit(
      c,
      {
        action: 'scm_source.delete',
        resource: 'scm_source',
        resourceId: id,
        userId: pendingSource.deletionRequestedBy ?? getCurrentUserId(c),
        details: scmSourceAuditDetails(source),
      },
      tx,
    )
    return row
  })
  if (!deleted) return c.json({ error: 'SCM deletion reservation was lost' }, 409)

  // Only worth an entry when a2wave actually removed something: an
  // operator-chosen path is never reclaimed, and an empty list would add a row
  // saying nothing happened.
  if (reclaimedPaths.length > 0) {
    logAudit(c, {
      action: 'scm_source.reclaim_storage',
      resource: 'scm_source',
      resourceId: id,
      details: { reclaimedPaths },
    })
  }

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
 * POST /probe - Probe connectivity (stateless; writes no row)
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

  // A P4 probe exists to answer "will a sync into this directory work", and the
  // Root/AltRoots coverage check that answers it needs the path. An absent one
  // reached the verifier as `''`, which it cannot compare against any Root — so
  // the probe returned a confident green for a path it never looked at, and the
  // failure surfaced later at `p4 sync`. Git has no such requirement: it probes
  // the remote, not the checkout directory.
  if (type === 'p4' && !parsed.data.localPath) {
    return c.json({ error: 'localPath is required to probe a P4 source' }, 400)
  }

  // Resolve masked credentials against the stored row. The ownership filter is
  // what makes passing a `sourceId` safe: without it, any authenticated user
  // could probe an arbitrary id with `pat: '********'` and use the pass/fail
  // answer as an oracle for someone else's credentials.
  let stored: ScmSourceConfig | undefined
  if (sourceId) {
    const ownerFilter = getOwnerFilter(c, scmSources.userId)
    const conditions = ownerFilter
      ? and(eq(scmSources.id, sourceId), ownerFilter, isNull(scmSources.deletionRequestedAt))
      : and(eq(scmSources.id, sourceId), isNull(scmSources.deletionRequestedAt))
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

/** POST /:id/sync - Trigger a sync manually (fire-and-forget, runs in the background) */
app.post('/:id/sync', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter
    ? and(eq(scmSources.id, id), ownerFilter, isNull(scmSources.deletionRequestedAt))
    : and(eq(scmSources.id, id), isNull(scmSources.deletionRequestedAt))
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
  }

  // Atomic check-and-set: only update if not already syncing (prevents TOCTOU race).
  // Acquired here so the ownership filter applies; syncScmSource is then told the
  // status is already held so it does not try to acquire a second time.
  const atomicConditions = ownerFilter
    ? and(
        eq(scmSources.id, id),
        ownerFilter,
        ne(scmSources.syncStatus, 'syncing'),
        ne(scmSources.codegraphStatus, 'indexing'),
        isNull(scmSources.deletionRequestedAt),
      )
    : and(
        eq(scmSources.id, id),
        ne(scmSources.syncStatus, 'syncing'),
        ne(scmSources.codegraphStatus, 'indexing'),
        isNull(scmSources.deletionRequestedAt),
      )
  const acquired = await runExclusive(async () => {
    return (
      await db
        .update(scmSources)
        .set({ syncStatus: 'syncing', updatedAt: new Date() })
        .where(atomicConditions)
        .returning()
    )[0]
  })
  if (!acquired) {
    return c.json({ error: 'Sync already in progress' }, 409)
  }

  // Take the checkout lock synchronously, atomically with the status CAS above
  // (no await between them). If post-sync indexing from a prior sync still
  // holds the checkout, roll the status back and 409 rather than running a sync
  // over a tree that is still being written.
  if (!tryAcquireCheckout(id)) {
    await runExclusive(async () => {
      await db
        .update(scmSources)
        .set({ syncStatus: 'idle', updatedAt: new Date() })
        .where(eq(scmSources.id, id))
    })
    return c.json({ error: 'Sync already in progress' }, 409)
  }

  // Audited after the status CAS and the checkout lock both won, so a request
  // rejected with 409 leaves no entry claiming a sync that never started. The
  // background job dials an external host with the row's stored credential and
  // carries no actor of its own, so this is the only record of who triggered it.
  logAudit(c, {
    action: 'scm_source.sync',
    resource: 'scm_source',
    resourceId: id,
    details: { type: source.type },
  })

  syncScmSource(id, { statusAlreadyAcquired: true, checkoutAlreadyAcquired: true }).catch((err) => {
    logger.error({ sourceId: id, error: err }, 'Background sync failed')
  })

  return c.json({ data: { message: 'Sync started' } }, 202)
})

/** POST /:id/check - Check the connection status of the stored config */
app.post('/:id/check', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter
    ? and(eq(scmSources.id, id), ownerFilter, isNull(scmSources.deletionRequestedAt))
    : and(eq(scmSources.id, id), isNull(scmSources.deletionRequestedAt))
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) {
    return c.json({ error: 'SCM source not found' }, 404)
  }

  // Same reasoning as POST /probe: this makes an outbound connection with the
  // row's stored credential and writes no other record, so the audit entry is
  // the only trace it happened (Iron Rule 5). Endpoint recorded redacted.
  const auditCheck = (ok: boolean) =>
    logAudit(c, {
      action: 'scm_source.check',
      resource: 'scm_source',
      resourceId: id,
      details: {
        type: source.type,
        endpoint: probeEndpointForAudit({
          ...(source.config as unknown as P4Config | GitConfig),
          type: source.type,
        } as Parameters<typeof probeEndpointForAudit>[0]),
        ok,
      },
    })

  if (source.type === 'p4') {
    const config = source.config as unknown as P4Config
    const result = await checkP4Connection(config, source.localPath)
    auditCheck(result.ok)
    return c.json({ data: result })
  }

  if (source.type === 'git') {
    const config = source.config as unknown as GitConfig
    const result = await checkGitConnection(config)
    auditCheck(result.ok)
    return c.json({ data: result })
  }

  return c.json({ error: `Unsupported SCM type: ${source.type}` }, 400)
})

/** GET /:id/status - Fetch the current sync status */
app.get('/:id/status', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter
    ? and(eq(scmSources.id, id), ownerFilter, isNull(scmSources.deletionRequestedAt))
    : and(eq(scmSources.id, id), isNull(scmSources.deletionRequestedAt))
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

/** POST /:id/codegraph/reindex - Trigger CodeGraph indexing manually (fire-and-forget) */
app.post('/:id/codegraph/reindex', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter
    ? and(eq(scmSources.id, id), ownerFilter, isNull(scmSources.deletionRequestedAt))
    : and(eq(scmSources.id, id), isNull(scmSources.deletionRequestedAt))
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
    ? and(
        eq(scmSources.id, id),
        ownerFilter,
        ne(scmSources.codegraphStatus, 'indexing'),
        ne(scmSources.syncStatus, 'syncing'),
        isNull(scmSources.deletionRequestedAt),
      )
    : and(
        eq(scmSources.id, id),
        ne(scmSources.codegraphStatus, 'indexing'),
        ne(scmSources.syncStatus, 'syncing'),
        isNull(scmSources.deletionRequestedAt),
      )
  const acquired = await runExclusive(async () => {
    return (
      await db
        .update(scmSources)
        .set({ codegraphStatus: 'indexing', codegraphLastError: null, updatedAt: new Date() })
        .where(atomicConditions)
        .returning()
    )[0]
  })
  if (!acquired) {
    return c.json({ error: 'CodeGraph indexing already in progress' }, 409)
  }

  // Hold the checkout lock for the whole index so a sync cannot start against
  // the same tree. Bail out (releasing the DB CAS) if another writer grabbed the
  // checkout between the two acquires.
  if (!tryAcquireCheckout(id)) {
    await runExclusive(async () => {
      await db
        .update(scmSources)
        .set({ codegraphStatus: 'idle', updatedAt: new Date() })
        .where(eq(scmSources.id, id))
    })
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
    await runExclusive(async () => {
      await db
        .update(scmSources)
        .set({ codegraphStatus: 'idle', updatedAt: new Date() })
        .where(eq(scmSources.id, id))
    })
    logger.error({ sourceId: id, error: err }, 'Failed to start CodeGraph indexing')
    return c.json({ error: 'Failed to start CodeGraph indexing' }, 500)
  }

  return c.json({ data: { message: 'CodeGraph indexing started' } }, 202)
})

// ============================================================
// Workspace Management
// ============================================================

/** GET /:id/workspaces - List every worktree of an SCM source */
app.get('/:id/workspaces', async (c) => {
  const { id } = c.req.param()
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter
    ? and(eq(scmSources.id, id), ownerFilter, isNull(scmSources.deletionRequestedAt))
    : and(eq(scmSources.id, id), isNull(scmSources.deletionRequestedAt))
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) return c.json({ error: 'Source not found' }, 404)

  const workspacesRootError = await validateStoredScmWorkspacesRoot(source)
  if (workspacesRootError) return c.json({ error: workspacesRootError }, 400)

  const scm = await createScmSource(source)
  if (!scm) return c.json({ error: 'Source type does not support workspaces' }, 400)

  const workspaces = await scm.listWorkspaces()

  // Attach the occupied flag to each workspace
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

/** DELETE /:id/workspaces/:name - Remove a worktree */
app.delete('/:id/workspaces/:name', async (c) => {
  const { id, name } = c.req.param()
  if (!WORKTREE_NAME_REGEX.test(name)) {
    return c.json({ error: 'Invalid workspace name' }, 400)
  }
  const ownerFilter = getOwnerFilter(c, scmSources.userId)
  const conditions = ownerFilter
    ? and(eq(scmSources.id, id), ownerFilter, isNull(scmSources.deletionRequestedAt))
    : and(eq(scmSources.id, id), isNull(scmSources.deletionRequestedAt))

  // Permission, root safety, and target construction. The removal protocol
  // itself (occupancy decision, durable reservation, re-check, mutex) lives in
  // removeSourceWorkspaceGuarded — the same protocol TTL cleanup uses — and
  // re-reads the row under the SCM mutation lock, so a stale read here can
  // only produce a 409, never a misdirected removal.
  const source = (await db.select().from(scmSources).where(conditions).limit(1))[0]
  if (!source) return c.json({ error: 'Source not found' }, 404)
  const workspacesRootError = await validateStoredScmWorkspacesRoot(source)
  if (workspacesRootError) return c.json({ error: workspacesRootError }, 400)
  const scm = await createScmSource(source)
  if (!scm) return c.json({ error: 'Source type does not support workspaces' }, 400)

  // Per-agent worktrees carry a long-lived branch that may hold unmerged agent
  // commits; deleting the directory reclaims disk, but the branch must survive
  // (the next run re-attaches it). Two tests, because each covers a case the
  // other misses: the exact match against a bound Agent keeps a legacy explicit
  // workspace named e.g. `agent-refactor` on ordinary delete-branch semantics,
  // and the shape test still recognizes an orphan whose Agent row is already
  // gone (Agent deletion leaves an occupied worktree behind on purpose).
  const boundAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.scmSourceId, id))
  const keepBranches =
    boundAgents.some((a) => perAgentWorkspaceName(a.id) === name) || isPerAgentWorkspaceName(name)

  try {
    // One removal, through the guarded protocol — the branch-preserving flag
    // rides along rather than becoming a second, unreserved delete.
    await removeSourceWorkspaceGuarded({ sourceId: id, name, scm, keepBranches })
  } catch (error) {
    if (error instanceof WorkspaceRemovalBlockedError) {
      return c.json({ error: error.message }, 409)
    }
    throw error
  }
  logAudit(c, {
    action: 'scm_source.workspace.delete',
    resource: 'scm_source',
    resourceId: id,
    details: { workspaceName: name },
  })
  return c.json({ data: { message: 'Workspace removed' } })
})

export default app
