import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { GitConfig, P4Config } from '@a2wave/shared'
import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm'
import { db, isPostgres } from '../db/client.js'
import { scmSources } from '../db/schema.js'
import { runExclusive } from '../db/transaction.js'
import { env } from '../env.js'
import { writeBackgroundAudit } from './audit.js'
import { scmSourceAuditDetails } from './audit-details.js'
import { isCodegraphEnabled, runCodegraphIndex } from './codegraph-index.js'
import { executeGitSync, sanitizeCredentials } from './git-sync.js'
import { hasLostHeartbeatOwnership } from './instance-heartbeat.js'
import { logger } from './logger.js'
import { verifyP4ClientRootCoverage } from './p4-client-root.js'
import { selectScmPathPeers, withScmPathMutation } from './scm-path-plan.js'
import { legacyScmReclaimRoot, scmReclaimRoot } from './scm-storage.js'
import { isolateManagedScmStorage } from './scm-storage-reclaim.js'
import { filesystemPathsOverlap } from './scm-workspace-safety.js'
import { notifyScmSyncError } from './webhook-notifier.js'

const execFileAsync = promisify(execFile)

/** Execution timeout: 5 minutes. */
const EXEC_TIMEOUT_MS = 5 * 60 * 1000
/** stdout/stderr buffer limit: 200 MB because a full p4 sync can be verbose. */
const EXEC_MAX_BUFFER = 200 * 1024 * 1024

// ============================================================
// P4 environment construction
// ============================================================

function buildP4Env(config: P4Config): Record<string, string> {
  return {
    P4CONFIG: '', // Disable .p4config discovery so it cannot override P4PASSWD.
    P4PORT: config.p4port,
    P4USER: config.p4user,
    P4PASSWD: config.p4passwd || '',
    P4CLIENT: config.p4client,
  }
}

// ============================================================
// P4 login (P4 2025 writes a ticket that subsequent commands consume)
// ============================================================

/**
 * Run p4 login with the password on stdin and write the ticket to $HOME/.p4tickets.
 * This supports P4 2025, which no longer accepts P4PASSWD alone.
 */
export async function p4Login(config: P4Config, signal?: AbortSignal): Promise<boolean> {
  if (!config.p4passwd) {
    logger.debug('p4Login skipped: no p4passwd')
    return true
  }

  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...buildP4Env(config) }
    const child = spawn(
      'p4',
      ['-p', config.p4port, '-u', config.p4user, '-c', config.p4client, 'login'],
      { env, stdio: ['pipe', 'pipe', 'pipe'], signal },
    )

    child.stdin.write(config.p4passwd, () => {
      child.stdin.end()
    })

    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolve(true)
      } else {
        reject(new Error(stderr.trim() || `p4 login failed: exit ${code}`))
      }
    })
    child.on('error', (err) => {
      reject(err)
    })
  })
}

// ============================================================
// Connection checks
// ============================================================

export interface P4CheckResult {
  ok: boolean
  message: string
  serverVersion?: string
  clientRoot?: string
  clientRootWarning?: string
}

async function readP4ClientSpec(config: P4Config, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync('p4', ['client', '-o', config.p4client], {
    env: { ...process.env, ...buildP4Env(config) },
    timeout: 15_000,
    signal,
  })
  return stdout
}

/**
 * Check whether the P4 connection is healthy.
 * Login first, then execute and validate `p4 info`.
 */
export async function checkP4Connection(
  config: P4Config,
  localPath?: string,
): Promise<P4CheckResult> {
  try {
    await p4Login(config)
    const { stdout } = await execFileAsync('p4', ['info'], {
      env: { ...process.env, ...buildP4Env(config) },
      timeout: 15_000,
    })

    // Extract the server version from p4 info.
    const versionMatch = stdout.match(/Server version:\s*(.+)/i)
    const serverVersion = versionMatch?.[1]?.trim()
    // Confirm that the output describes a real server connection.
    if (stdout.includes('Server address:') || stdout.includes('Server root:')) {
      // Same verifier the sync path uses, so a Root the check flags red can
      // never be silently accepted by the sync that follows.
      const verdict = await verifyP4ClientRootCoverage({
        localPath: localPath ?? '',
        infoOutput: stdout,
        readClientSpec: () => readP4ClientSpec(config),
        clientName: config.p4client,
      })

      if (verdict.outcome === 'client-missing') {
        return {
          ok: true,
          message: 'P4 connection is healthy',
          serverVersion,
          clientRootWarning: `${verdict.detail} Create it before syncing.`,
        }
      }
      if (verdict.outcome === 'indeterminate') {
        return {
          ok: true,
          message: 'P4 connection is healthy',
          serverVersion,
          clientRootWarning: `P4 client Root could not be verified: ${verdict.detail}`,
        }
      }
      // With no localPath to test (the stateless probe), coverage is not a
      // verdict about this connection — report the detected Root and stop.
      if (localPath && verdict.outcome === 'not-covered') {
        return {
          ok: false,
          message: `P4 client Root does not cover local path "${localPath}". Configure Root or AltRoots to include it.`,
          serverVersion,
          clientRoot: verdict.clientRoot,
        }
      }
      return {
        ok: true,
        message: 'P4 connection is healthy',
        serverVersion,
        clientRoot: verdict.clientRoot,
      }
    }

    return { ok: false, message: 'Unexpected p4 info output' }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    // Same redaction the git check applies: a p4d error can echo back the
    // connection string, and this message is returned to the caller (including
    // from the stateless probe, whose caller may not own the source).
    return { ok: false, message: `P4 connection failed: ${sanitizeCredentials(msg)}` }
  }
}

// ============================================================
// Sync execution
// ============================================================

export interface P4SyncResult {
  ok: boolean
  message: string
  filesUpdated?: number
}

/**
 * Execute a P4 sync.
 * @param config P4 configuration
 * @param localPath Local working directory
 * @param depotPath Optional depot path; all files are synced by default
 */
export async function executeP4Sync(
  config: P4Config,
  localPath: string,
  timeoutMs: number = EXEC_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<P4SyncResult> {
  // Verified for EVERY P4 source, not just managed paths: syncing into a
  // directory the client Root does not cover makes p4 write the depot into the
  // client's real Root instead, and the run then opens an empty checkout while
  // the source reports success.
  try {
    await p4Login(config, signal)
    const { stdout: infoOutput } = await execFileAsync('p4', ['info'], {
      env: { ...process.env, ...buildP4Env(config) },
      timeout: 15_000,
      signal,
    })
    const verdict = await verifyP4ClientRootCoverage({
      localPath,
      infoOutput,
      readClientSpec: () => readP4ClientSpec(config, signal),
      clientName: config.p4client,
    })
    if (verdict.outcome === 'client-missing') {
      return { ok: false, message: `P4 sync failed: ${verdict.detail}` }
    }
    if (verdict.outcome === 'not-covered') {
      return {
        ok: false,
        message: `P4 sync failed: client Root does not cover local path "${localPath}". Configure Root or AltRoots to include it.`,
      }
    }
    // 'indeterminate' is not evidence of a mismatch — same degradation as the
    // connection check, so a transient p4d hiccup cannot block the sync.
    if (verdict.outcome === 'indeterminate') {
      logger.warn(
        { localPath, detail: verdict.detail },
        'P4 client Root could not be verified before sync; continuing with p4 sync',
      )
    }
  } catch (error) {
    if (signal?.aborted) {
      return { ok: false, message: 'P4 sync cancelled' }
    }
    logger.warn(
      {
        localPath,
        error: sanitizeCredentials(error instanceof Error ? error.message : String(error)),
      },
      'P4 client Root could not be verified before sync; continuing with p4 sync',
    )
  }

  // Ensure the local directory exists.
  if (!existsSync(localPath)) {
    mkdirSync(localPath, { recursive: true })
  }

  const syncArgs = config.depotPath ? ['sync', `${config.depotPath}...`] : ['sync']

  try {
    await p4Login(config, signal)
    const { stdout, stderr } = await execFileAsync('p4', syncArgs, {
      env: { ...process.env, ...buildP4Env(config) },
      cwd: localPath,
      timeout: timeoutMs,
      maxBuffer: EXEC_MAX_BUFFER,
      signal,
    })

    const output = stdout + stderr

    // Count updated files.
    const updateMatches = output.match(/- (updating|added|deleted|refreshing)/gi)
    const filesUpdated = updateMatches?.length ?? 0

    return {
      ok: true,
      message: filesUpdated > 0 ? `Synced ${filesUpdated} files` : 'Already up-to-date',
      filesUpdated,
    }
  } catch (error) {
    const execErr = error as Error & {
      stderr?: string
      stdout?: string
      code?: string
      killed?: boolean
    }
    const parts: string[] = []

    if (execErr.killed || execErr.code === 'ETIMEDOUT') {
      parts.push(`timed out after ${timeoutMs / 1000}s`)
    } else if (execErr.code !== undefined) {
      parts.push(`exit code ${execErr.code}`)
    }

    const stderr = execErr.stderr?.trim()
    const stdout = execErr.stdout?.trim()
    if (stderr) parts.push(stderr)
    else if (stdout) parts.push(stdout)
    else if (parts.length === 0) parts.push(error instanceof Error ? error.message : String(error))

    // Same redaction the connection check applies: p4d can echo the connection
    // string (including P4PASSWD) back on failure, and this message is persisted
    // to scmSources.lastSyncError and shipped to the sync-error webhook.
    return { ok: false, message: `P4 sync failed: ${sanitizeCredentials(parts.join(' — '))}` }
  }
}

// ============================================================
// Sync state management
// ============================================================

/** Shared synchronization result for P4 and Git. */
export interface ScmSyncResult {
  ok: boolean
  message: string
  filesUpdated?: number
  /** A sync was already running for this source; this call started nothing. */
  alreadyRunning?: boolean
}

/**
 * Sources whose working directory is actively being written — held from the
 * moment a sync acquires the lock until optional CodeGraph indexing settles,
 * and also held for the whole duration of a manual CodeGraph reindex.
 *
 * `syncStatus` returns to `idle` before post-sync work finishes (so the UI shows
 * "synced" promptly), leaving a window where the checkout is still being
 * indexed. EVERY entry point that writes the checkout — the auto-sync timer,
 * POST /:id/sync, and POST /:id/codegraph/reindex — acquires this lock so two writers can never run
 * against the same localPath at once. In-process only, which suffices: the
 * deployment is a single container, and the per-status DB CAS
 * remains the authoritative cross-restart lock.
 *
 * Single-threaded Node means has()+add() has no await between them, so the
 * try-acquire is atomic without extra synchronisation.
 */
const busyCheckouts = new Set<string>()
const activeInitialSyncs = new Map<
  string,
  { controller: AbortController; promise: Promise<ScmSyncResult> }
>()
const INITIAL_SYNC_RECOVERY_CONCURRENCY = 2
let initialSyncRecoveryGeneration = 0

/** Start one cancellable background initial checkout for create/update/recovery. */
export function startInitialScmSync(sourceId: string): Promise<ScmSyncResult> {
  const active = activeInitialSyncs.get(sourceId)
  if (active) return active.promise

  const controller = new AbortController()
  const promise = syncScmSource(sourceId, { signal: controller.signal }).finally(() => {
    if (activeInitialSyncs.get(sourceId)?.promise === promise) activeInitialSyncs.delete(sourceId)
  })
  activeInitialSyncs.set(sourceId, { controller, promise })
  return promise
}

/** Cancel only the automatic initial checkout, never a manual or recurring sync. */
export async function cancelInitialScmSync(sourceId: string): Promise<boolean> {
  const active = activeInitialSyncs.get(sourceId)
  if (!active) return false
  active.controller.abort()
  await active.promise
  return true
}

/** Queue restart recovery without launching every incomplete clone at once. */
export function startInitialSyncRecovery(
  sourceIds: readonly string[],
  startSync: (sourceId: string) => Promise<ScmSyncResult> = startInitialScmSync,
): void {
  const generation = initialSyncRecoveryGeneration
  let nextIndex = 0
  let activeCount = 0

  const startNext = (): void => {
    if (generation !== initialSyncRecoveryGeneration) return
    while (activeCount < INITIAL_SYNC_RECOVERY_CONCURRENCY && nextIndex < sourceIds.length) {
      const sourceId = sourceIds[nextIndex++]
      activeCount++
      void startSync(sourceId)
        .catch((error) => {
          logger.error({ sourceId, error }, 'Recovered initial SCM sync failed')
        })
        .finally(() => {
          activeCount--
          startNext()
        })
    }
  }

  startNext()
}

/** Whether a sync or its post-sync work is currently writing this checkout. */
export function isCheckoutBusy(sourceId: string): boolean {
  return busyCheckouts.has(sourceId)
}

/**
 * Atomically take the per-source checkout lock. Returns false if another writer
 * already holds it. Callers that succeed MUST pair this with releaseCheckout()
 * once their work settles (use try/finally).
 */
export function tryAcquireCheckout(sourceId: string): boolean {
  if (busyCheckouts.has(sourceId)) return false
  busyCheckouts.add(sourceId)
  return true
}

/** Release a checkout lock taken by tryAcquireCheckout(). */
export function releaseCheckout(sourceId: string): void {
  busyCheckouts.delete(sourceId)
}

/**
 * Release a `syncing` status that a caller acquired before delegating here.
 *
 * Mirrors `finalizePreAcquiredIndex` in codegraph-index.ts: any early return on
 * the pre-acquired path must still write a terminal status, otherwise the row
 * stays `syncing` and every later check-and-set — timer and manual alike —
 * fails until the process restarts.
 */
async function releasePreAcquiredSync(sourceId: string, message: string): Promise<void> {
  await runExclusive(async () => {
    await db
      .update(scmSources)
      .set({
        syncStatus: 'error',
        lastSyncAt: new Date(),
        lastSyncError: message,
        updatedAt: new Date(),
      })
      .where(eq(scmSources.id, sourceId))
  })
}

/**
 * Execute a sync and update database state, dispatching by source type.
 *
 * Only one sync may run per source at a time: concurrent syncs write the same
 * working directory and corrupt each other, and whichever finishes first writes
 * syncStatus back to 'idle', making the DB claim the sync is done while another
 * is still running. An atomic check-and-set on the `syncing` status is the one
 * gate shared by every caller (auto-sync timer, manual trigger).
 */
export async function syncScmSource(
  sourceId: string,
  options: {
    statusAlreadyAcquired?: boolean
    checkoutAlreadyAcquired?: boolean
    signal?: AbortSignal
  } = {},
): Promise<ScmSyncResult> {
  // Take the ONE per-source checkout lock first, synchronously, before any
  // await. This is the single authoritative gate shared by every writer — the
  // auto-sync timer, POST /:id/sync, and the manual CodeGraph reindex
  // routes all go through tryAcquireCheckout. Acquiring before the first await
  // closes the window where a manual job could slip in between the DB status
  // CAS and a later add(). Held until post-sync work settles.
  //
  // A caller that already holds the checkout (the manual-sync route, which must
  // acquire under its ownership filter before this fire-and-forget call) passes
  // checkoutAlreadyAcquired so we do not double-acquire — but we still own the
  // release from here on.
  // Liveness gate, checked here because this is the one authoritative entry
  // every writer passes through. A fenced instance is one whose peers are
  // entitled to reclaim its checkouts, and sync writes to the shared checkout
  // for as long as a full clone takes — far past the point where a peer may
  // have taken over. Refusing here is what makes the fail-stop promise
  // ("an expired owner has stopped touching the workspace") true for sync.
  if (hasLostHeartbeatOwnership()) {
    logger.warn({ sourceId }, 'Skipping SCM sync: this instance lost its liveness lease')
    return { ok: false, message: 'This instance is shutting down after losing its liveness lease' }
  }
  if (!options.checkoutAlreadyAcquired && !tryAcquireCheckout(sourceId)) {
    logger.info({ sourceId }, 'Skipping SCM sync: checkout already in use')
    return { ok: false, message: 'Sync already in progress', alreadyRunning: true }
  }

  try {
    return await runSyncUnderCheckoutLock(sourceId, options)
  } catch (error) {
    // Any unexpected throw before the post-sync handoff must release the lock
    // here; the normal path hands release off to the post-sync jobs' finally.
    releaseCheckout(sourceId)
    const message = error instanceof Error ? error.message : String(error)
    logger.error({ sourceId, error }, 'SCM sync aborted before handoff')
    return { ok: false, message: `SCM sync failed: ${message}` }
  }
}

/**
 * Body of syncScmSource, run with the checkout lock already held. On every
 * return path that does NOT hand the lock to post-sync jobs, it releases the
 * lock itself; the one path that schedules post-sync work transfers ownership
 * of the release to that work's finally (see the end of the function).
 */
async function runSyncUnderCheckoutLock(
  sourceId: string,
  options: { statusAlreadyAcquired?: boolean; signal?: AbortSignal },
): Promise<ScmSyncResult> {
  // Acquire the DB status lock BEFORE reading the config the worker will act on,
  // so the snapshot is consistent with the acquired row. Reading first would let
  // a PATCH commit a new localPath/config in the gap between load and acquire,
  // and the worker would then run against a stale checkout while the terminal
  // write stamps initialSyncCompletedAt onto the new configuration.
  let source: typeof scmSources.$inferSelect | undefined
  if (options.statusAlreadyAcquired) {
    // The caller already flipped the row to 'syncing'. Load a snapshot now that
    // the lock is held — no concurrent sync can be mutating the checkout.
    source = await (
      await db.select().from(scmSources).where(eq(scmSources.id, sourceId)).limit(1)
    )[0]
    if (!source) {
      // Returning without a terminal write would strand the row at 'syncing'
      // until the next process restart.
      releaseCheckout(sourceId)
      await releasePreAcquiredSync(sourceId, 'SCM source not found')
      return { ok: false, message: 'SCM source not found' }
    }
  } else {
    // Atomic acquire: flip to 'syncing' only if it is not already 'syncing',
    // and take the row returned by the UPDATE as the authoritative snapshot.
    source = await runExclusive(async () => {
      return (
        await db
          .update(scmSources)
          .set({ syncStatus: 'syncing', updatedAt: new Date() })
          .where(
            and(
              eq(scmSources.id, sourceId),
              ne(scmSources.syncStatus, 'syncing'),
              ne(scmSources.codegraphStatus, 'indexing'),
              isNull(scmSources.deletionRequestedAt),
            ),
          )
          .returning()
      )[0]
    })
    if (!source) {
      // Either the row is gone or a sync already holds it. Distinguish so a
      // missing source is not misreported as a conflict.
      releaseCheckout(sourceId)
      const stillExists = await (
        await db
          .select({ id: scmSources.id })
          .from(scmSources)
          .where(eq(scmSources.id, sourceId))
          .limit(1)
      )[0]
      if (!stillExists) {
        return { ok: false, message: 'SCM source not found' }
      }
      logger.info({ sourceId }, 'Skipping SCM sync: already in progress')
      return { ok: false, message: 'Sync already in progress', alreadyRunning: true }
    }
  }

  if (source.deletionRequestedAt) {
    releaseCheckout(sourceId)
    await releasePreAcquiredSync(sourceId, 'SCM source deletion is pending')
    return { ok: false, message: 'SCM source deletion is pending' }
  }

  if (
    [scmReclaimRoot(), legacyScmReclaimRoot()].some((root) =>
      filesystemPathsOverlap(source.localPath, root),
    )
  ) {
    releaseCheckout(sourceId)
    await releasePreAcquiredSync(sourceId, 'SCM localPath overlaps the private reclaim root')
    return { ok: false, message: 'SCM localPath overlaps the private reclaim root' }
  }

  logger.info({ sourceId, name: source.name, type: source.type }, 'Starting SCM sync')

  let result: ScmSyncResult

  const isInitialSync = source.initialSyncCompletedAt == null
  const timeoutMs = isInitialSync
    ? ((source.config as unknown as { initialSyncTimeoutMin?: number }).initialSyncTimeoutMin ??
        60) *
      60 *
      1000
    : EXEC_TIMEOUT_MS

  // Sampled BEFORE the sync runs, and again only to confirm the failure was
  // caused by the abort. Reading `signal.aborted` after the body returned made
  // an abort that merely raced a genuine failure erase it: the row settled to a
  // clean 'idle' with no lastSyncError and no webhook, leaving a
  // healthy-looking source that agents cannot use.
  const abortedBeforeSync = options.signal?.aborted === true

  // Once the status is held, no throw may escape before the terminal write
  // below — an escaping error would leave the row stuck at 'syncing'.
  try {
    if (source.type === 'p4') {
      const config = source.config as unknown as P4Config
      result = options.signal
        ? await executeP4Sync(config, source.localPath, timeoutMs, options.signal)
        : await executeP4Sync(config, source.localPath, timeoutMs)
    } else if (source.type === 'git') {
      const config = source.config as unknown as GitConfig
      result = options.signal
        ? await executeGitSync(config, source.localPath, timeoutMs, options.signal)
        : await executeGitSync(config, source.localPath, timeoutMs)
    } else {
      result = { ok: false, message: `Unsupported SCM type: ${source.type}` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    result = { ok: false, message: `SCM sync failed: ${message}` }
  }
  // A cancellation is only credited when the abort actually produced this
  // result — it was already aborted when the sync started, or the sync itself
  // reported that it stopped because of the abort. An abort landing after a
  // real error leaves that error intact, status and webhook included.
  const cancelled =
    !result.ok &&
    options.signal?.aborted === true &&
    (abortedBeforeSync || /cancel|abort/i.test(result.message))

  const handsOffToCodegraph = result.ok && isCodegraphEnabled(source.config)
  // Persist terminal state and stamp initialSyncCompletedAt on the first success.
  // When CodeGraph follows, keep syncStatus at syncing: it is the durable
  // checkout-writer lease seen by every replica until indexing settles.
  try {
    await runExclusive(async () => {
      await db
        .update(scmSources)
        .set({
          syncStatus: handsOffToCodegraph ? 'syncing' : result.ok || cancelled ? 'idle' : 'error',
          lastSyncAt: new Date(),
          lastSyncError: result.ok || cancelled ? null : result.message,
          updatedAt: new Date(),
          ...(result.ok && source.initialSyncCompletedAt == null
            ? { initialSyncCompletedAt: new Date() }
            : {}),
          ...(handsOffToCodegraph
            ? { codegraphStatus: 'indexing' as const, codegraphLastError: null }
            : {}),
        })
        .where(eq(scmSources.id, sourceId))
    })
  } catch (error) {
    // The status write itself failed (SQLITE_BUSY/IO). The row would otherwise
    // stay 'syncing' forever and every later CAS would 409 until restart. Best-
    // effort reset it to 'error' with the same predicate-free write, then
    // release the checkout lock regardless.
    logger.error({ sourceId, error }, 'Failed to write terminal SCM sync status')
    try {
      await runExclusive(async () => {
        await db
          .update(scmSources)
          .set({
            syncStatus: 'error',
            lastSyncError: 'Failed to persist sync result',
            updatedAt: new Date(),
          })
          .where(eq(scmSources.id, sourceId))
      })
    } catch (resetError) {
      logger.error({ sourceId, resetError }, 'Failed to reset stranded syncing status')
    }
    releaseCheckout(sourceId)
    return { ok: false, message: 'Failed to persist sync result' }
  }

  // A successful sync may trigger CodeGraph indexing without delaying the sync
  // response. Keep the checkout lock until indexing settles so another sync
  // cannot mutate the same directory underneath it.
  if (handsOffToCodegraph) {
    void runCodegraphIndex(sourceId, { alreadyAcquired: true })
      .catch((err) => logger.error({ sourceId, err }, 'CodeGraph indexing unexpected error'))
      .finally(async () => {
        try {
          await runExclusive(async () => {
            await db
              .update(scmSources)
              .set({ syncStatus: 'idle', updatedAt: new Date() })
              .where(and(eq(scmSources.id, sourceId), eq(scmSources.syncStatus, 'syncing')))
          })
        } finally {
          releaseCheckout(sourceId)
        }
      })
  } else {
    releaseCheckout(sourceId)
  }

  if (result.ok) {
    logger.info(
      { sourceId, name: source.name, type: source.type, filesUpdated: result.filesUpdated },
      'SCM sync completed',
    )
  } else if (cancelled) {
    logger.info({ sourceId, name: source.name, type: source.type }, 'SCM sync cancelled')
  } else {
    logger.error(
      { sourceId, name: source.name, type: source.type, error: result.message },
      'SCM sync failed',
    )
    notifyScmSyncError({
      sourceId,
      sourceName: source.name,
      errorMsg: result.message,
      errorTime: new Date(),
    }).catch((err) => logger.warn({ sourceId, err }, 'Failed to send SCM sync error webhook'))
  }

  return result
}

// ============================================================
// Recurring sync scheduler
// ============================================================

const syncTimers = new Map<string, ReturnType<typeof setInterval>>()
/** Auto-syncs currently executing, so a tick cannot stack on an unfinished one. */
const inFlightAutoSyncs = new Set<string>()

/**
 * Start recurring synchronization for one SCM source.
 *
 * A single sync can far outlast the interval (the P4 initial-sync timeout alone
 * allows 60 minutes), so each tick checks whether the previous round is still
 * running and skips its turn instead of stacking concurrent syncs.
 */
export function startAutoSync(sourceId: string, intervalMin: number): void {
  // Stop the existing timer first.
  stopAutoSync(sourceId)

  const intervalMs = intervalMin * 60 * 1000
  logger.info({ sourceId, intervalMin }, 'Starting auto-sync scheduler')

  const timer = setInterval(async () => {
    // Skip if the previous tick's sync is still running, or if CodeGraph indexing
    // is still reading the checkout even
    // though syncStatus has already returned to 'idle'.
    if (inFlightAutoSyncs.has(sourceId) || busyCheckouts.has(sourceId)) {
      logger.warn({ sourceId }, 'Skipping auto-sync tick: previous sync still running')
      return
    }
    inFlightAutoSyncs.add(sourceId)
    try {
      await syncScmSource(sourceId)
    } catch (error) {
      logger.error({ sourceId, error }, 'Auto-sync error')
    } finally {
      inFlightAutoSyncs.delete(sourceId)
    }
  }, intervalMs)

  syncTimers.set(sourceId, timer)
}

/**
 * Stop recurring synchronization for one SCM source.
 */
export function stopAutoSync(sourceId: string): void {
  // Deliberately does NOT clear inFlightAutoSyncs: a sync started by the old
  // timer may still be running, and PATCH /:id calls stop+start to reschedule.
  // Clearing here would let the new timer stack a second sync on top of it.
  // The in-flight entry is removed by the running tick's own `finally`.
  const timer = syncTimers.get(sourceId)
  if (timer) {
    clearInterval(timer)
    syncTimers.delete(sourceId)
    logger.info({ sourceId }, 'Stopped auto-sync scheduler')
  }
}

/**
 * Stop all recurring synchronization.
 */
export function stopAllAutoSync(): void {
  for (const [sourceId, timer] of syncTimers) {
    clearInterval(timer)
    logger.info({ sourceId }, 'Stopped auto-sync scheduler')
  }
  syncTimers.clear()
  inFlightAutoSyncs.clear()
  initialSyncRecoveryGeneration++
  for (const sync of activeInitialSyncs.values()) sync.controller.abort()
  activeInitialSyncs.clear()
  busyCheckouts.clear()
}

async function resetStuckScmSource(
  id: string,
  payload: Partial<typeof scmSources.$inferInsert>,
  successMessage: string,
): Promise<void> {
  try {
    await runExclusive(async () => {
      await db
        .update(scmSources)
        .set({ ...payload, updatedAt: new Date() })
        .where(eq(scmSources.id, id))
    })
    logger.warn({ id }, successMessage)
  } catch (error) {
    logger.error({ id, error }, 'Failed to reset stuck SCM source state on startup')
  }
}

/**
 * Initialize enabled SCM source schedulers for both P4 and Git at startup.
 */
export async function initAutoSyncSchedulers(): Promise<void> {
  // SQLite has one API process, so every in-progress row belongs to the process
  // that just died. PostgreSQL may have healthy peer replicas using the shared
  // checkout, so a starting replica must never clear their durable writer
  // status. Safety wins over automatic recovery there; an interrupted PG writer
  // remains visibly stuck for operator recovery instead of risking corruption.
  const stuckSyncing = await db
    .select({ id: scmSources.id })
    .from(scmSources)
    .where(eq(scmSources.syncStatus, 'syncing'))
  // Awaited: sync acquisition is an atomic UPDATE guarded by
  // `syncStatus <> 'syncing'`, so a source still carrying the previous
  // process's 'syncing' has every sync refused as a conflict — and nothing
  // else clears it, so the source stays wedged until the next restart. The
  // reset must therefore land before the schedulers below are armed (and
  // before the manual-sync route can be reached).
  if (isPostgres && stuckSyncing.length > 0) {
    logger.warn(
      { sourceIds: stuckSyncing.map(({ id }) => id) },
      'Preserving in-progress SCM sync state owned by another PostgreSQL replica',
    )
  } else {
    for (const { id } of stuckSyncing) {
      await resetStuckScmSource(
        id,
        { syncStatus: 'idle' },
        'Reset stuck syncing SCM source to idle on startup',
      )
    }
  }

  const stuckCodegraph = await db
    .select({ id: scmSources.id })
    .from(scmSources)
    .where(eq(scmSources.codegraphStatus, 'indexing'))
  // Same reasoning: the indexing guard reads `codegraphStatus`, and callers
  // observe this status the moment the API answers, so it must be settled
  // before initialisation reports done.
  if (isPostgres && stuckCodegraph.length > 0) {
    logger.warn(
      { sourceIds: stuckCodegraph.map(({ id }) => id) },
      'Preserving in-progress CodeGraph state owned by another PostgreSQL replica',
    )
  } else {
    for (const { id } of stuckCodegraph) {
      await resetStuckScmSource(
        id,
        {
          codegraphStatus: 'error',
          codegraphLastError: 'Interrupted by server restart',
        },
        'Reset stuck CodeGraph indexing source to error on startup',
      )
    }
  }

  // Only a durable deletion reservation authorizes reclaim. Never sweep the
  // isolation directory by filename: an older bind mount may already contain
  // operator data there, and a crash before COMMIT must restore the live row.
  const pendingDeletions = await db
    .select()
    .from(scmSources)
    .where(isNotNull(scmSources.deletionRequestedAt))
  for (const source of pendingDeletions) {
    try {
      const peers = await selectScmPathPeers()
      const isolated = await isolateManagedScmStorage(source, { peers })
      // Same rule as the DELETE route: a peer-blocked path keeps the durable
      // reservation. Finalizing the row now would orphan the id-derived
      // directory with nothing left able to name or retry it.
      if (isolated.blocked.length > 0) {
        logger.warn(
          { sourceId: source.id, blocked: isolated.blocked },
          'SCM source deletion stays reserved: managed path still overlaps a surviving source',
        )
        continue
      }
      await isolated.commit()
      const deleted = await withScmPathMutation(async (tx) => {
        const row = (
          await tx
            .delete(scmSources)
            .where(and(eq(scmSources.id, source.id), isNotNull(scmSources.deletionRequestedAt)))
            .returning()
        )[0]
        if (!row) return undefined
        await writeBackgroundAudit(
          {
            action: 'scm_source.delete',
            resource: 'scm_source',
            resourceId: source.id,
            userId: source.deletionRequestedBy ?? undefined,
            details: scmSourceAuditDetails(source),
          },
          tx,
        )
        return row
      })
      if (deleted) {
        logger.info({ sourceId: source.id }, 'Completed interrupted SCM source deletion')
      }
    } catch (error) {
      logger.error({ sourceId: source.id, error }, 'Failed to resume SCM source deletion')
    }
  }

  const sources = await db.select().from(scmSources).where(eq(scmSources.isEnabled, true))
  const incompleteSourceIds: string[] = []

  for (const source of sources) {
    const config = source.config as unknown as { autoSync?: boolean; syncIntervalMin?: number }
    if (config.autoSync && config.syncIntervalMin) {
      startAutoSync(source.id, config.syncIntervalMin)
    }
    if (source.initialSyncCompletedAt == null) {
      incompleteSourceIds.push(source.id)
    }
  }
  startInitialSyncRecovery(incompleteSourceIds)

  logger.info({ count: syncTimers.size }, 'Auto-sync schedulers initialized')
}
