import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'

const app = new Hono()

/**
 * CHANGELOG.md lives at the monorepo root, but how far up that is depends on how
 * this file is executed: apps/api/src/routes under tsx (4 levels), apps/api/dist
 * as the tsup bundle in the Docker image (3 levels). Walk upward and take the
 * first hit instead of hardcoding one depth — the hardcoded 4-level walk resolved
 * to /CHANGELOG.md inside the image, where the endpoint silently served empty
 * content while the file sat unread at /app/CHANGELOG.md.
 */
export function resolveChangelogPath(
  startDir: string,
  exists: (path: string) => boolean = existsSync,
): string | null {
  let dir = startDir
  for (;;) {
    const candidate = join(dir, 'CHANGELOG.md')
    if (exists(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const moduleDir = dirname(fileURLToPath(import.meta.url))

app.get('/', (c) => {
  let content = ''
  const changelogPath = resolveChangelogPath(moduleDir)
  if (changelogPath) {
    try {
      content = readFileSync(changelogPath, 'utf-8')
    } catch {
      // fallback to empty on read error
    }
  }
  c.header('Cache-Control', 'no-store')
  return c.json({ content })
})

export default app
