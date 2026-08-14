/**
 * `src/generated/schemas.json` is committed so that `dev` and `test` need no
 * build step, which means it can go stale. Regenerate it here and compare: a
 * shared-side schema change that nobody re-ran the codegen for fails CI rather
 * than shipping a snapshot that disagrees with the platform.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const generatedPath = join(cliRoot, 'src', 'generated', 'schemas.json')

describe('generated schemas snapshot', () => {
  it('is up to date with @a2wave/shared', () => {
    const before = readFileSync(generatedPath, 'utf-8')
    execFileSync(process.execPath, [join(cliRoot, 'scripts', 'gen-schemas.mjs')], {
      cwd: cliRoot,
      stdio: 'pipe',
    })
    const after = readFileSync(generatedPath, 'utf-8')

    expect(
      after,
      'src/generated/schemas.json is stale. Run: pnpm --filter a2wave gen:schemas',
    ).toBe(before)
  })
})
