import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveMigrationDir, resolveRepoRoot } from '../migration-directory.js'

/**
 * These resolvers exist because `process.cwd()` differs between the two ways
 * the suite is launched: `pnpm test` from the repo root, and `pnpm test` inside
 * `apps/api`. Tests that hardcoded one of them failed in the other.
 */
describe('resolveMigrationDir', () => {
  it('finds the SQLite migrations from wherever the suite was launched', () => {
    expect(existsSync(resolve(resolveMigrationDir('drizzle'), 'meta/_journal.json'))).toBe(true)
  })

  it('finds the PostgreSQL migrations too, since they keep a separate lineage', () => {
    expect(existsSync(resolve(resolveMigrationDir('drizzle-pg'), 'meta/_journal.json'))).toBe(true)
  })

  it('fails loudly rather than returning a path that does not exist', () => {
    expect(() => resolveMigrationDir('drizzle-nonexistent')).toThrow(/drizzle-nonexistent/)
  })
})

describe('resolveRepoRoot', () => {
  it('locates the monorepo root by a marker that only the root has', () => {
    expect(existsSync(resolve(resolveRepoRoot(), 'pnpm-workspace.yaml'))).toBe(true)
  })

  it('resolves repo-relative paths across both launch directories', () => {
    expect(existsSync(resolve(resolveRepoRoot(), 'apps/api/src/lib/bootstrap.ts'))).toBe(true)
  })
})
