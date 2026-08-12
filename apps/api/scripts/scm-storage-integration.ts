import assert from 'node:assert/strict'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const testRoot = process.env.SCM_INTEGRATION_ROOT
assert(testRoot, 'SCM_INTEGRATION_ROOT is required')

const legacyHome = join(testRoot, 'legacy-home')
process.env.HOME = legacyHome
process.env.SCM_STORAGE_ROOT = join(testRoot, 'managed')
process.env.SCM_WORKSPACES_ALLOWED_ROOTS = join(testRoot, 'managed', 'workspaces')
process.env.A2WAVE_DB_BACKUP_SKIP = 'true'

const [
  { eq, inArray },
  { db, closeDatabaseConnection },
  { scmSources },
  migration,
  paths,
  backfill,
] = await Promise.all([
  import('drizzle-orm'),
  import('../src/db/client.js'),
  import('../src/db/schema.js'),
  import('../src/db/migrate-runtime.js'),
  import('../src/lib/scm-path-plan.js'),
  import('../src/lib/backfill-workspaces-path.js'),
])

const testIds = ['scm_concurrency_parent', 'scm_concurrency_child', 'scm_legacy_fixture']

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function reservePath(
  id: string,
  localPath: string,
  workspacesPath: string,
): Promise<boolean> {
  return paths.withScmPathMutation(async (tx) => {
    const plan = paths.resolveScmPathPlan({
      sourceId: id,
      type: 'git',
      localPath,
      workspacesPath,
      existingSources: await paths.selectScmPathPeers(tx),
      isAdmin: true,
    })
    if (!plan.ok) return false

    // Keep the race window open long enough that an implementation which scans
    // outside the mutation lock lets both requests observe the empty slot.
    await delay(75)
    await tx.insert(scmSources).values({
      id,
      name: id,
      type: 'git',
      config: { type: 'git', repoUrl: 'https://example.invalid/repo.git' },
      localPath: plan.localPath,
      workspacesPath: plan.workspacesPath,
    })
    return true
  })
}

async function verifyConcurrentAllocation(): Promise<void> {
  const checkout = join(testRoot, 'concurrent-checkout')
  const results = await Promise.all([
    reservePath(testIds[0], checkout, join(testRoot, 'worktrees-parent')),
    reservePath(testIds[1], join(checkout, 'child'), join(testRoot, 'worktrees-child')),
  ])

  assert.equal(results.filter(Boolean).length, 1, 'exactly one overlapping allocation must win')
  const rows = await db
    .select({ id: scmSources.id })
    .from(scmSources)
    .where(inArray(scmSources.id, testIds.slice(0, 2)))
  assert.equal(rows.length, 1, 'the database must contain only the winning allocation')
}

async function verifyLegacyUpgradeFixture(): Promise<void> {
  const id = testIds[2]
  const legacyPath = join(legacyHome, '.a2wave', 'workspaces', 'legacy_fixture')
  await mkdir(legacyPath, { recursive: true })
  await db.insert(scmSources).values({
    id,
    name: id,
    type: 'git',
    config: { type: 'git', repoUrl: 'https://example.invalid/legacy.git' },
    localPath: join(testRoot, 'legacy-checkout'),
    workspacesPath: null,
  })

  assert.equal(await backfill.backfillWorkspacesPaths(), 1)
  const saved = (
    await db
      .select({ workspacesPath: scmSources.workspacesPath })
      .from(scmSources)
      .where(eq(scmSources.id, id))
      .limit(1)
  )[0]
  assert.equal(saved?.workspacesPath, legacyPath)
}

let schemaReady = false
try {
  await mkdir(process.env.SCM_STORAGE_ROOT, { recursive: true })
  await migration.runMigrations()
  schemaReady = true
  await db.delete(scmSources).where(inArray(scmSources.id, testIds))
  await verifyConcurrentAllocation()
  await verifyLegacyUpgradeFixture()
  console.log(
    `SCM storage database integration passed (${process.env.DATABASE_URL?.startsWith('postgres') ? 'PostgreSQL' : 'SQLite'})`,
  )
} finally {
  if (schemaReady) {
    await db.delete(scmSources).where(inArray(scmSources.id, testIds))
  }
  await closeDatabaseConnection()
  await rm(testRoot, { recursive: true, force: true })
}
