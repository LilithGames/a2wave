import { accessSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import { count } from 'drizzle-orm'
import { Hono } from 'hono'
import { db } from '../db/client.js'
import { isPostgresUrl } from '../db/dialect.js'
import { runs } from '../db/schema.js'
import { engineRegistry } from '../engine/index.js'
import { env } from '../env.js'
import { isReady } from '../lib/readiness.js'
import { getVersion } from '../lib/version.js'

async function checkDatabase(): Promise<{ ok: boolean; error?: string; tables?: number }> {
  try {
    const result = (await db.select({ count: count() }).from(runs).limit(1))[0]
    return { ok: true, tables: result?.count ?? 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function checkDisk(path: string): { ok: boolean; writable: boolean; error?: string } {
  try {
    const dir = dirname(path)
    accessSync(dir, constants.W_OK)
    return { ok: true, writable: true }
  } catch {
    return { ok: false, writable: false, error: 'Disk check failed' }
  }
}

const app = new Hono()

/**
 * GET /api/health/ready — readiness probe.
 *
 * 503 until boot-time seeding finishes, so a rolling update does not route into
 * the window where settings (SSO config among them) are not yet written. Kept
 * separate from liveness above: a not-ready pod must be withheld from the load
 * balancer, not restarted.
 */
app.get('/ready', (c) => {
  const ready = isReady()
  return c.json(
    { status: ready ? 'ready' : 'starting', uptime: process.uptime() },
    ready ? 200 : 503,
  )
})

app.get('/', async (c) => {
  const engines = await engineRegistry.healthCheckAll()

  const database = await checkDatabase()
  // On PostgreSQL the "data dir" is the server's business, not ours:
  // `dirname('postgres://user:pw@host:5432/db')` is not a path, `accessSync`
  // throws ENOENT, and every PostgreSQL deployment reported `degraded` forever —
  // breaking any probe keyed on `status === 'ok'`. `db-backup.ts` already guards
  // this way; this call site was missed.
  const dataDir = isPostgresUrl(env.DATABASE_URL)
    ? { ok: true, writable: true, skipped: 'managed-by-postgres' as const }
    : checkDisk(env.DATABASE_URL)
  const skillsDir = checkDisk(env.A2WAVE_SKILLS_STORAGE)

  const allOk = database.ok && dataDir.ok && skillsDir.ok

  return c.json({
    status: allOk ? 'ok' : 'degraded',
    version: getVersion(),
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {
      database,
      dataDir,
      skillsDir,
      engines,
    },
  })
})

export default app
