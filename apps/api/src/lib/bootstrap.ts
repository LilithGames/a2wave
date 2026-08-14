import { and, eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { scmSources, settings } from '../db/schema.js'
import { env } from '../env.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import { getOidcEnv, oauthChannelAudiences } from './oidc.js'

const ADMIN_USER_ID = 'usr_admin'

/** 将 SETTINGS_GENERAL_WORKSPACE_PATH 解析为 { category: 'general', key: 'workspacePath' }（导出供测试） */
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

/** 从 process.env 扫描 SETTINGS_* 并 upsert 到 settings 表 */
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

/** 从环境变量 upsert P4 代码源（name='env:p4'） */
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

  const existing = (
    await db.select().from(scmSources).where(eq(scmSources.name, 'env:p4')).limit(1)
  )[0]

  const localPath = env.SCM_P4_LOCAL_PATH
  const now = new Date()

  if (existing) {
    const localPathConflict =
      localPath !== existing.localPath
        ? (
            await db.select().from(scmSources).where(eq(scmSources.localPath, localPath)).limit(1)
          )[0]
        : null
    if (localPathConflict && localPathConflict.id !== existing.id) {
      logger.warn({ path: localPath }, 'SCM_P4_LOCAL_PATH conflict, skipping P4 bootstrap')
      return
    }

    await db
      .update(scmSources)
      .set({
        config: { ...config },
        localPath,
        syncStatus: 'idle',
        lastSyncAt: null,
        lastSyncError: null,
        initialSyncCompletedAt: null,
        updatedAt: now,
      })
      .where(eq(scmSources.id, existing.id))
    logger.info({ id: existing.id }, 'Updated P4 SCM source from env')
  } else {
    const conflict = (
      await db.select().from(scmSources).where(eq(scmSources.localPath, localPath)).limit(1)
    )[0]
    if (conflict) {
      logger.warn({ path: localPath }, 'SCM_P4_LOCAL_PATH already in use, skipping P4 bootstrap')
      return
    }

    const id = createId('scm')
    await db.insert(scmSources).values({
      id,
      name: 'env:p4',
      type: 'p4',
      description: 'P4 source from environment variables',
      config: { ...config },
      localPath,
      isEnabled: true,
      userId: ADMIN_USER_ID,
      createdAt: now,
      updatedAt: now,
    })
    logger.info({ id }, 'Created P4 SCM source from env')
  }
}

/** 从环境变量 upsert Git 代码源（name='env:git'） */
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

  const existing = (
    await db.select().from(scmSources).where(eq(scmSources.name, 'env:git')).limit(1)
  )[0]

  const localPath = env.SCM_GIT_LOCAL_PATH
  const now = new Date()

  if (existing) {
    const localPathConflict =
      localPath !== existing.localPath
        ? (
            await db.select().from(scmSources).where(eq(scmSources.localPath, localPath)).limit(1)
          )[0]
        : null
    if (localPathConflict && localPathConflict.id !== existing.id) {
      logger.warn({ path: localPath }, 'SCM_GIT_LOCAL_PATH conflict, skipping Git bootstrap')
      return
    }

    await db
      .update(scmSources)
      .set({
        config: { ...config },
        localPath,
        syncStatus: 'idle',
        lastSyncAt: null,
        lastSyncError: null,
        initialSyncCompletedAt: null,
        updatedAt: now,
      })
      .where(eq(scmSources.id, existing.id))
    logger.info({ id: existing.id }, 'Updated Git SCM source from env')
  } else {
    const conflict = (
      await db.select().from(scmSources).where(eq(scmSources.localPath, localPath)).limit(1)
    )[0]
    if (conflict) {
      logger.warn({ path: localPath }, 'SCM_GIT_LOCAL_PATH already in use, skipping Git bootstrap')
      return
    }

    const id = createId('scm')
    await db.insert(scmSources).values({
      id,
      name: 'env:git',
      type: 'git',
      description: 'Git source from environment variables',
      config: { ...config },
      localPath,
      isEnabled: true,
      userId: ADMIN_USER_ID,
      createdAt: now,
      updatedAt: now,
    })
    logger.info({ id }, 'Created Git SCM source from env')
  }
}

/**
 * 升级告警：存量部署曾用 `A2WAVE_OAUTH_IDAAS_*`（静态 JWK）驱动 OAuth 发布渠道，
 * 该方式已移除，渠道改由企业 OIDC 验签。只配了旧变量、没配 OIDC 的部署升级后，
 * 所有 oauth 渠道调用会静默变成 503——进程照常启动，第一处信号是线上调用方报错。
 *
 * 这里在启动时点名，并把「配了 OIDC 但没配受众白名单」一并纳入：那同样让渠道不可用
 * （fail closed 是刻意的，见 isOauthChannelConfigured）。仅告警不阻断启动——登录、其它
 * 发布渠道都不受影响，把整个实例拒起会造成更大的故障面。
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
        'channel is disabled (fail closed). Configure one or more a2wave resource audience ' +
        'identifiers in Settings → Enterprise login → OIDC, or use ' +
        'A2WAVE_OIDC_CHANNEL_AUDIENCES when the environment is the active fallback. Callers ' +
        'must request tokens issued for that configured audience; do not trust an arbitrary ' +
        '`aud` merely because it appears in a rejected token.',
    )
  }
}

/**
 * 从环境变量初始化 SCM 代码源和 Settings。
 * 在 ensureAdminExists() 和 seedPresetProviders() 之间调用。
 */
export async function bootstrapFromEnv(): Promise<void> {
  await bootstrapScmP4()
  await bootstrapScmGit()
  await bootstrapSettings()
  await warnOauthChannelUnavailable()
}
