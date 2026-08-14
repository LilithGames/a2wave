/**
 * The shipped agent guide must describe the CLI that actually exists.
 *
 * `src/generated/agent-guide.ts` is committed (so `dev` and `test` work with no
 * build step) and its command map is generated from the citty tree — which
 * means it can go stale exactly like the schema snapshot can. Regenerating and
 * comparing turns that into a CI failure rather than a doc that quietly names
 * commands nobody can run.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_GUIDE, guideSections } from '../lib/guide.js'

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const guidePath = join(cliRoot, 'src', 'generated', 'agent-guide.ts')

describe('agent guide', () => {
  it('is up to date with the command tree', { timeout: 120_000 }, () => {
    const before = readFileSync(guidePath, 'utf-8')
    execFileSync(process.execPath, [join(cliRoot, 'scripts', 'gen-guide.mjs')], {
      cwd: cliRoot,
      stdio: 'pipe',
    })
    const after = readFileSync(guidePath, 'utf-8')

    expect(after, 'agent-guide is stale. Run: pnpm --filter a2wave gen:guide').toBe(before)
  })

  it('names every leaf command in its map', { timeout: 120_000 }, () => {
    // The generator derives the map from the tree, so this can only fail when
    // someone edits the generated file by hand or the generator loses a group —
    // both of which produce a guide that omits real commands with no warning.
    const paths: string[] = JSON.parse(
      execFileSync('npx', ['tsx', join(cliRoot, 'src', 'index.ts'), 'schema', '--json'], {
        cwd: cliRoot,
        encoding: 'utf-8',
      }),
    ).commands

    const missing = paths.filter((p) => !AGENT_GUIDE.includes(`a2wave ${p}\n`))
    expect(missing, `Commands absent from the guide:\n${missing.join('\n')}`).toEqual([])
  })

  it('stays under the 400-line budget an agent can afford to read', () => {
    expect(AGENT_GUIDE.split('\n').length).toBeLessThanOrEqual(400)
  })

  it('splits into addressable topics', () => {
    const topics = guideSections().map((s) => s.topic)
    expect(topics).toContain('the-loop')
    expect(topics).toContain('the-output-contract')
    expect(topics).toContain('command-map')
  })
})
