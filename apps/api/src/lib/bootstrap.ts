import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { scmSources, settings } from '../db/schema.js'
import type { TransactionHandle } from '../db/transaction.js'
import { env } from '../env.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import { getOidcEnv, oauthChannelAudiences } from './oidc.js'
import { resolveScmPathPlan, selectScmPathPeers, withScmPathMutation } from './scm-path-plan.js'

const ADMIN_USER_ID = 'usr_admin'

/** Parse SETTINGS_GENERAL_WORKSPACE_PATH into { category: 'general', key: 'workspacePath' } (exported for tests) */
export function parseSettingsEnvKey(envKey: string): { category: string; key: string } | null {
  if (!envKey.startsWith('SETTINGS_') || envKey.length <= 'SETTINGS_'.length) return null
  const rest = envKey.slice('SETTINGS_'.length)
  const [head, ...tail] = rest.split('_')
  if (!head || tail.length === 0) return null
  const category = head.toLowerCase()
  const keyParts = tail.map((p) => p.toLowerCase())
  const key = keyParts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('')
  return { category, key }
}

/** Scan process.env for SETTINGS_* and upsert each into the settings table */
async function bootstrapSettings(): Promise<void> {
  const now = new Date()
  for (const [envKey, value] of Object.entries(process.env)) {
    if (!value || !envKey.startsWith('SETTINGS_')) continue
    const parsed = parseSettingsEnvKey(envKey)
    if (!parsed) continue

    const { category, key } = parsed
    const existing = (
      await db
        .select()
        .from(settings)
        .where(and(eq(settings.category, category), eq(settings.key, key)))
        .limit(1)
    )[0]

    if (existing) {
      await db
        .update(settings)
        .set({ value, updatedAt: now })
        .where(and(eq(settings.category, category), eq(settings.key, key)))
    } else {
      await db.insert(settings).values({ category, key, value, updatedAt: now })
    }
  }
}

/**
 * Resolve an env-driven source's paths through the same planner the HTTP routes
 * use, and log why a rejected one was skipped.
 *
 * Env bootstrap used to check `localPath` for exact string equality against
 * other rows and nothing else, so it could persist what `POST /api/scm-sources`
 * refuses: a relative path, the shared storage root itself, or a checkout nested
 * inside another source's tree (a different string, same directory — which the
 * next `git checkout -f` force-discards). Sharing the planner means a rule added
 * for the routes covers env too, instead of the two drifting apart again.
 *
 * `isAdmin` is true because these rows are owned by the platform admin and an
 * operator setting the env var is choosing the path deliberately; the peer,
 * absolute-path and shared-root rules still apply.
 */
async function planEnvScmPaths(
  id: string,
  type: 'git' | 'p4',
  localPath: string | undefined,
  envVar: string,
  /**
   * The row's stored worktree root on the update path. It must be passed, not
   * left to default: the update keeps this value, so planning against a freshly
   * allocated default would validate the checkout path against a root the write
   * never uses — letting a new `SCM_*_LOCAL_PATH` land inside the root the row
   * actually keeps, where the next sync force-discards its worktrees.
   */
  workspacesPath?: string | null,
  executor: TransactionHandle = db,
): Promise<{ localPath: string; workspacesPath: string } | null> {
  const plan = resolveScmPathPlan({
    sourceId: id,
    type,
    localPath,
    workspacesPath,
    existingSources: await selectScmPathPeers(executor),
    excludeId: id,
    isAdmin: true,
  })
  if (!plan.ok) {
    logger.warn(
      { path: localPath, reason: plan.error },
      `${envVar} is not a usable checkout path, skipping ${type} bootstrap`,
    )
    return null
  }
  return { localPath: plan.localPath, workspacesPath: plan.workspacesPath }
}

/** Upsert the env-driven P4 SCM source (name='env:p4') */
async function bootstrapScmP4(): Promise<void> {
  if (!env.SCM_P4_PORT || !env.SCM_P4_USER || !env.SCM_P4_CLIENT) return

  const config = {
    p4port: env.SCM_P4_PORT,
    p4user: env.SCM_P4_USER,
    p4passwd: env.SCM_P4_PASSWD,
    p4client: env.SCM_P4_CLIENT,
    depotPath: env.SCM_P4_DEPOT_PATH || undefined,
    autoSync: env.SCM_P4_AUTO_SYNC,
    syncIntervalMin: env.SCM_P4_SYNC_INTERVAL,
    initialSyncTimeoutMin: 60,
  }

  const now = new Date()
  await withScmPathMutation(async (tx) => {
    const existing = (
      await tx.select().from(scmSources).where(eq(scmSources.name, 'env:p4')).limit(1)
    )[0]

    if (existing) {
      const localPath = env.SCM_P4_LOCAL_PATH || existing.localPath
      const planned = await planEnvScmPaths(
        existing.id,
        'p4',
        localPath,
        'SCM_P4_LOCAL_PATH',
        existing.workspacesPath,
        tx,
      )
      if (!planned) return

      await tx
        .update(scmSources)
        .set({
          config: { ...config },
          localPath: planned.localPath,
          workspacesPath: planned.workspacesPath,
          syncStatus: 'idle',
          lastSyncAt: null,
          lastSyncError: null,
          initialSyncCompletedAt: null,
          updatedAt: now,
        })
        .where(eq(scmSources.id, existing.id))
      logger.info({ id: existing.id }, 'Updated P4 SCM source from env')
      return
    }

    if (!env.SCM_P4_LOCAL_PATH) {
      logger.warn(
        'SCM_P4_LOCAL_PATH is required to create env:p4 because it must be covered by the P4 client Root or AltRoots',
      )
      return
    }
    const id = createId('scm')
    const planned = await planEnvScmPaths(
      id,
      'p4',
      env.SCM_P4_LOCAL_PATH,
      'SCM_P4_LOCAL_PATH',
      undefined,
      tx,
    )
    if (!planned) return

    await tx.insert(scmSources).values({
      id,
      name: 'env:p4',
      type: 'p4',
      description: 'P4 source from environment variables',
      config: { ...config },
      localPath: planned.localPath,
      workspacesPath: planned.workspacesPath,
      isEnabled: true,
      userId: ADMIN_USER_ID,
      createdAt: now,
      updatedAt: now,
    })
    logger.info({ id }, 'Created P4 SCM source from env')
  })
}

/** Upsert the env-driven Git SCM source (name='env:git') */
async function bootstrapScmGit(): Promise<void> {
  if (!env.SCM_GIT_REPO_URL) return

  const config = {
    repoUrl: env.SCM_GIT_REPO_URL,
    branch: env.SCM_GIT_BRANCH,
    username: env.SCM_GIT_USERNAME || undefined,
    pat: env.SCM_GIT_PAT || undefined,
    autoSync: env.SCM_GIT_AUTO_SYNC,
    syncIntervalMin: env.SCM_GIT_SYNC_INTERVAL,
    initialSyncTimeoutMin: 60,
  }

  const now = new Date()
  await withScmPathMutation(async (tx) => {
    const existing = (
      await tx.select().from(scmSources).where(eq(scmSources.name, 'env:git')).limit(1)
    )[0]

    if (existing) {
      const localPath = env.SCM_GIT_LOCAL_PATH || existing.localPath
      const planned = await planEnvScmPaths(
        existing.id,
        'git',
        localPath,
        'SCM_GIT_LOCAL_PATH',
        existing.workspacesPath,
        tx,
      )
      if (!planned) return

      await tx
        .update(scmSources)
        .set({
          config: { ...config },
          localPath: planned.localPath,
          workspacesPath: planned.workspacesPath,
          syncStatus: 'idle',
          lastSyncAt: null,
          lastSyncError: null,
          initialSyncCompletedAt: null,
          updatedAt: now,
        })
        .where(eq(scmSources.id, existing.id))
      logger.info({ id: existing.id }, 'Updated Git SCM source from env')
      return
    }

    const id = createId('scm')
    const planned = await planEnvScmPaths(
      id,
      'git',
      env.SCM_GIT_LOCAL_PATH || undefined,
      'SCM_GIT_LOCAL_PATH',
      undefined,
      tx,
    )
    if (!planned) return

    await tx.insert(scmSources).values({
      id,
      name: 'env:git',
      type: 'git',
      description: 'Git source from environment variables',
      config: { ...config },
      localPath: planned.localPath,
      workspacesPath: planned.workspacesPath,
      isEnabled: true,
      userId: ADMIN_USER_ID,
      createdAt: now,
      updatedAt: now,
    })
    logger.info({ id }, 'Created Git SCM source from env')
  })
}

/**
 * Upgrade warning. Existing deployments once drove the OAuth publish channel
 * with `A2WAVE_OAUTH_IDAAS_*` (a static JWK). That mechanism is gone — the
 * channel now verifies caller tokens against enterprise OIDC — so a deployment
 * carrying only the old variables silently answers 503 on every oauth call
 * after an upgrade: the process starts normally and the first signal is a
 * caller reporting the error in production.
 *
 * Naming it at boot turns that into a log line. "OIDC configured but the
 * audience allowlist is empty" is covered too, because it disables the channel
 * just as completely (failing closed is deliberate — see
 * isOauthChannelConfigured). This warns without blocking startup: login and
 * every other publish channel still work, and refusing to start the whole
 * instance would be the larger outage.
 */
async function warnOauthChannelUnavailable(): Promise<void> {
  const legacyIdaasConfigured = ['A2WAVE_OAUTH_IDAAS_ISSUER', 'A2WAVE_OAUTH_IDAAS_PUBLIC_KEY'].some(
    (key) => !!(process.env[key] ?? '').trim(),
  )
  const oidc = await getOidcEnv()

  if (!oidc) {
    if (legacyIdaasConfigured) {
      logger.warn(
        { hadLegacyIdaasEnv: true },
        'A2WAVE_OAUTH_IDAAS_* is set but no longer supported — the OAuth publish channel now ' +
          'verifies caller tokens against enterprise OIDC. Every oauth-published Agent will ' +
          'return 503 until A2WAVE_OIDC_ISSUER + A2WAVE_OIDC_CLIENT_ID (or Settings → ' +
          'Enterprise login → OIDC) are configured.',
      )
    }
    return
  }

  if ((await oauthChannelAudiences()).length === 0) {
    logger.warn(
      { issuer: oidc.issuer, source: oidc.source },
      'Enterprise OIDC is configured but the OAuth channel audience allowlist is empty, so the ' +
        'channel is disabled (fail closed). Set A2WAVE_OIDC_CHANNEL_AUDIENCES (or oidcConfig.' +
        'channelAudiences) to the `aud` values your callers present.',
    )
  }
}

/**
 * Initialise SCM sources and Settings from environment variables.
 * Called between ensureAdminExists() and seedPresetProviders().
 */
export async function bootstrapFromEnv(): Promise<void> {
  await bootstrapScmP4()
  await bootstrapScmGit()
  await bootstrapSettings()
  await warnOauthChannelUnavailable()
}
