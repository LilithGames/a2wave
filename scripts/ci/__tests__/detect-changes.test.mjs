import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LANES, allOn, classify, toOutputs } from '../detect-changes.mjs'

/**
 * The classifier decides which CI lanes a PR may SKIP, so every wrong answer
 * here is a suite that silently never ran. The tests pin two properties above
 * all: fail-open on anything unrecognised, and pipeline-touching paths turning
 * every lane on.
 */

const on = (result, ...lanes) => {
  for (const lane of LANES) {
    assert.equal(
      result.lanes[lane],
      lanes.includes(lane),
      `lane ${lane}: expected ${lanes.includes(lane)}, got ${result.lanes[lane]}`,
    )
  }
}

describe('detect-changes classifier — per-area mapping', () => {
  it('api source → api lane only', () => {
    on(classify(['apps/api/src/routes/agents.ts']), 'api')
  })

  it('api db source → api + pgschema (generated schema must be re-verified)', () => {
    on(classify(['apps/api/src/db/schema.ts']), 'api', 'pgschema')
    on(classify(['apps/api/src/db/schema.pg.ts']), 'api', 'pgschema')
  })

  it('drizzle migrations and configs → api + pgschema', () => {
    on(classify(['apps/api/drizzle/0100_x.sql']), 'api', 'pgschema')
    on(classify(['apps/api/drizzle-pg/0001_x.sql']), 'api', 'pgschema')
    on(classify(['apps/api/drizzle.pg.config.ts']), 'api', 'pgschema')
  })

  it('web source → web lane only', () => {
    on(classify(['apps/web/src/pages/agent-detail/index.tsx']), 'web')
  })

  it('in-app manual content is web content, not prose', () => {
    // Regression guard: a global "*.md is docs" rule would skip the web lane
    // for files that ship in the web bundle.
    on(classify(['apps/web/src/content/manual/zh/agents.md']), 'web')
  })

  it('cli source → cli lane only', () => {
    on(classify(['apps/cli/src/index.ts']), 'cli')
  })

  it('shared package → api + web + cli + pgschema', () => {
    on(classify(['packages/shared/src/schemas/agent.ts']), 'api', 'web', 'cli', 'pgschema')
  })

  it('scripts (deploy, provider-clis…) → cli lane, where their tests run', () => {
    on(classify(['scripts/deploy/deploy-remote.sh']), 'cli')
    on(classify(['scripts/provider-clis/install.mjs']), 'cli')
  })

  it('a per-app package.json adds the license lane to its own lane', () => {
    on(classify(['apps/api/package.json']), 'api', 'licenses')
    on(classify(['apps/web/package.json']), 'web', 'licenses')
    on(classify(['apps/cli/package.json']), 'cli', 'licenses')
    on(classify(['packages/shared/package.json']), 'api', 'web', 'cli', 'licenses')
  })

  it('lanes accumulate across files', () => {
    on(classify(['apps/api/src/a.ts', 'apps/web/src/b.tsx']), 'api', 'web')
  })
})

describe('detect-changes classifier — run-all paths', () => {
  for (const file of [
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'biome.json',
    'scripts/gates/check-api-tests.mjs',
    'scripts/ci/detect-changes.mjs',
    '.husky/pre-push',
  ]) {
    it(`${file} turns every lane on`, () => {
      on(classify([file]), ...LANES)
    })
  }
})

describe('detect-changes classifier — fail open', () => {
  it('an unrecognised file turns every lane on and is reported', () => {
    const result = classify(['mystery/new-thing.ts'])
    on(result, ...LANES)
    assert.deepEqual(result.failOpen, ['mystery/new-thing.ts'])
  })

  it('a known no-lane file alongside an api file does not mask the api lane', () => {
    on(classify(['docs/PRODUCT.md', 'apps/api/src/a.ts']), 'api')
  })

  it('--all (push to main) turns every lane on', () => {
    on(allOn(), ...LANES)
  })
})

describe('detect-changes classifier — known-irrelevant paths', () => {
  for (const file of [
    'docs/agent/e2e.md',
    'README.md',
    'CHANGELOG.md',
    'apps/api/AGENTS.md',
    'LICENSE',
    '.gitignore',
    'e2e/agents.spec.ts',
    'playwright.config.ts',
  ]) {
    it(`${file} enables no lane`, () => {
      on(classify([file]))
    })
  }
})

describe('detect-changes classifier — ci_review (label gate)', () => {
  it('workflow and gate-script changes require human sign-off', () => {
    for (const file of [
      '.github/workflows/ci.yml',
      'scripts/gates/check-api-tests.mjs',
      'scripts/ci/detect-changes.mjs',
      'provider-cli-lock.json',
      'apps/api/vitest.config.ts',
      'apps/api/drizzle/0100_x.sql',
      'apps/api/drizzle-pg/0001_x.sql',
      '.husky/pre-commit',
    ]) {
      const result = classify([file])
      assert.equal(result.ciReview, true, `${file} should require ci review`)
      assert.deepEqual(result.ciReviewFiles, [file])
    }
  })

  it('ordinary source changes do not', () => {
    const result = classify(['apps/api/src/routes/agents.ts', 'apps/web/src/x.tsx'])
    assert.equal(result.ciReview, false)
    assert.deepEqual(result.ciReviewFiles, [])
  })
})

describe('detect-changes outputs', () => {
  it('emits one line per lane plus the review outputs', () => {
    const lines = toOutputs(classify(['apps/api/src/a.ts']))
    assert.deepEqual(lines, [
      'api=true',
      'web=false',
      'cli=false',
      'licenses=false',
      'pgschema=false',
      'ci_review=false',
      'ci_review_files=',
    ])
  })

  it('joins review files with commas', () => {
    const lines = toOutputs(classify(['.github/workflows/ci.yml', 'scripts/gates/x.mjs']))
    assert.ok(lines.includes('ci_review=true'))
    assert.ok(lines.includes('ci_review_files=.github/workflows/ci.yml,scripts/gates/x.mjs'))
  })
})
