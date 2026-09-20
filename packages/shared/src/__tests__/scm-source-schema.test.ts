import { describe, expect, it } from 'vitest'
import { gitConfigSchema, MAX_GIT_REPOS } from '../schemas/scm-source.js'

function repoEntry(index: number) {
  return {
    repoUrl: `https://gitlab.com/org/r${index}.git`,
    branch: 'main',
    directory: `r${index}`,
  }
}

function gitConfig(repoCount: number) {
  return {
    repoUrl: '',
    branch: 'main',
    repos: Array.from({ length: repoCount }, (_, i) => repoEntry(i)),
  }
}

describe('gitConfigSchema — repos bound', () => {
  /**
   * `MAX_GIT_REPOS` bounds a *probe* request (see `probeScmSourceInput`), which
   * fans out to one concurrent subprocess per entry. It is deliberately NOT a
   * constraint of this schema: `gitConfigSchema` also validates `PATCH /:id`,
   * and the form resubmits the whole config for any edit — so capping here
   * would make a stored source that predates the limit unrenamable, locking
   * existing data out of its own settings page.
   */
  it('accepts a stored config above the probe bound', () => {
    expect(gitConfigSchema.safeParse(gitConfig(MAX_GIT_REPOS + 1)).success).toBe(true)
  })

  it('accepts a repo list at the probe bound', () => {
    expect(gitConfigSchema.safeParse(gitConfig(MAX_GIT_REPOS)).success).toBe(true)
  })

  it('still accepts a config with no repos (single-repo shape)', () => {
    const result = gitConfigSchema.safeParse({
      repoUrl: 'https://gitlab.com/org/only.git',
      branch: 'main',
    })
    expect(result.success).toBe(true)
  })

  it('exposes a bound well above any plausible layout', () => {
    expect(MAX_GIT_REPOS).toBeGreaterThanOrEqual(20)
  })
})
