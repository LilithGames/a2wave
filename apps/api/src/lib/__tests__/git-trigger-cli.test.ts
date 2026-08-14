import { describe, expect, it } from 'vitest'
import {
  buildGitLabListPath,
  extractJson,
  isAuthenticatedReport,
  normalizeRequests,
} from '../git-trigger-cli.js'
import {
  GH_AUTH_STATUS_AUTHENTICATED,
  GH_AUTH_STATUS_LOGGED_OUT,
  GH_GRAPHQL_PR_NODE,
  GLAB_AUTH_STATUS_MIXED,
  GLAB_BANNER_WITH_BRACKET,
} from './fixtures/git-trigger-cli-output.js'

/**
 * Captured verbatim from a real `glab auth status` run against a machine with
 * two configured hosts — one authenticated, one not. Both the host scoping and
 * the verdict parsing were wrong against this exact output during development,
 * so it is pinned here rather than paraphrased.
 */

/** Mirrors the production scopeToHost: exact line match, never a prefix. */
function scopeBlock(output: string, host: string): string {
  const lines = output.split('\n')
  const start = lines.findIndex((line) => line.trim() === host)
  if (start < 0) return ''
  const block = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].length > 0 && !/^\s/.test(lines[i])) break
    block.push(lines[i])
  }
  return block.join('\n')
}

describe('isAuthenticatedReport', () => {
  it('treats "No token found" as unauthenticated', () => {
    // Regression: a bare /Token found/ test matches "No token found" as a
    // substring and reports a host with no credential as authenticated.
    expect(isAuthenticatedReport(scopeBlock(GLAB_AUTH_STATUS_MIXED, 'gitlab.com'))).toBe(false)
  })

  it('recognises a genuinely authenticated host block', () => {
    expect(isAuthenticatedReport(scopeBlock(GLAB_AUTH_STATUS_MIXED, 'gitlab.example.com'))).toBe(
      true,
    )
  })

  it('is false for a host absent from the report', () => {
    expect(isAuthenticatedReport(scopeBlock(GLAB_AUTH_STATUS_MIXED, 'nope.example.com'))).toBe(
      false,
    )
  })

  it('handles gh-style reports', () => {
    expect(isAuthenticatedReport('github.com\n  ✓ Logged in to github.com as octocat')).toBe(true)
    expect(isAuthenticatedReport(GH_AUTH_STATUS_LOGGED_OUT)).toBe(false)
  })

  it('recognises the post-2.40 gh wording ("account", not "as")', () => {
    // Regression against real gh 2.97 output: requiring "as" made every modern,
    // correctly authenticated gh report as not authenticated — in the very strip
    // that exists so a missing login is not discovered through failed polls.
    expect(isAuthenticatedReport(GH_AUTH_STATUS_AUTHENTICATED)).toBe(true)
    expect(isAuthenticatedReport(scopeBlock(GH_AUTH_STATUS_AUTHENTICATED, 'github.com'))).toBe(true)
  })

  it('does not let one host satisfy a lookup for a shorter suffix host', () => {
    // "gitlab.company.com".startsWith("gitlab.com") is false, but the reverse
    // prefix trap is real: scoping must be an exact line match, or one host's
    // credentials get reported as another's.
    const twoHosts = `gitlab.company.com
  ✓ Logged in to gitlab.company.com as someone (keyring)
gitlab.com
  ! No token found (checked config file, keyring, and environment variables).
`
    expect(isAuthenticatedReport(scopeBlock(twoHosts, 'gitlab.com'))).toBe(false)
    expect(isAuthenticatedReport(scopeBlock(twoHosts, 'gitlab.company.com'))).toBe(true)
  })

  it('is false for empty output', () => {
    expect(isAuthenticatedReport('   ')).toBe(false)
  })
})

describe('extractJson', () => {
  it('parses JSON preceded by glab warning banners', () => {
    // `glab` prints config warnings to stdout ahead of the payload; a raw
    // JSON.parse fails on a perfectly good response.
    const output = `Warning: Multiple config files found. Only the first one will be used.
  Using: /home/u/.config/glab-cli/config.yml
[{"iid":50,"sha":"abc"}]`
    expect(extractJson(output)).toEqual([{ iid: 50, sha: 'abc' }])
  })

  it('parses JSON followed by a trailing banner', () => {
    expect(extractJson('[{"iid":1}]\nA new version is available!')).toEqual([{ iid: 1 }])
  })

  it('parses JSON after a banner that itself contains a bracket', () => {
    // Regression: slicing from the FIRST bracket landed inside `[0640]`, so both
    // the direct parse and the trim-to-last-bracket fallback failed and a good
    // payload was reported unparsable — stopping the channel with only a log line.
    expect(extractJson(GLAB_BANNER_WITH_BRACKET)).toEqual([{ iid: 50, sha: 'abc' }])
  })

  it('parses an object payload after a bracketed banner', () => {
    const output = `note: using profile [default]
{"data":{"repository":null}}`
    expect(extractJson(output)).toEqual({ data: { repository: null } })
  })

  it('parses JSON despite a TRAILING banner that contains a bracket', () => {
    // Regression: the single trim-to-last-bracket retry used `lastIndexOf` over
    // the whole candidate, so the `]` inside `[v1.4.0]` was found instead of the
    // payload's and every scan attempt failed — the channel stopped firing for
    // as long as the CLI kept printing that notice.
    const output = '[{"iid":1}]\nA new version of glab is available [v1.4.0]'
    expect(extractJson(output)).toEqual([{ iid: 1 }])
  })

  it('parses JSON with bracketed banners on BOTH sides', () => {
    const output = 'WARN config is group-readable [0640]\n[{"iid":7}]\nupdate available [v1.4.0]'
    expect(extractJson(output)).toEqual([{ iid: 7 }])
  })

  it('returns null when there is no JSON at all', () => {
    expect(extractJson('ERROR  Unauthenticated.')).toBeNull()
    expect(extractJson('')).toBeNull()
  })
})

describe('buildGitLabListPath', () => {
  it('addresses one project under the project scope', () => {
    const path = buildGitLabListPath({ scope: 'project', project: 'acme/demo' }, 1)
    // The path must be URL-encoded: GitLab addresses a project by its full path
    // with the slashes escaped, and an unencoded one resolves to a different,
    // usually nonexistent, route.
    expect(path).toContain('projects/acme%2Fdemo/merge_requests')
    expect(path).toContain('state=opened')
  })

  it('addresses a namespace under the group scope', () => {
    const path = buildGitLabListPath({ scope: 'group', project: 'acme/platform/sdk' }, 1)
    // `groups/:id/merge_requests` recurses into subgroups, which is what lets
    // one entry cover a whole product line.
    expect(path).toContain('groups/acme%2Fplatform%2Fsdk/merge_requests')
  })

  it('orders by recent activity so the first page holds what changed', () => {
    // Paging is capped, so the cap must fall on the least recently touched
    // requests rather than an arbitrary slice.
    const path = buildGitLabListPath({ scope: 'group', project: 'g' }, 1)
    expect(path).toContain('order_by=updated_at')
    expect(path).toContain('sort=desc')
  })

  it('requests the page it was asked for', () => {
    expect(buildGitLabListPath({ scope: 'group', project: 'g' }, 3)).toContain('page=3')
  })
})

describe('normalizeRequests', () => {
  it('normalizes a real GitLab merge request payload', () => {
    const payload = [
      {
        iid: 50,
        sha: '1111111111111111111111111111111111111111',
        title: 'fix(cli): repair computer-use',
        web_url: 'https://gitlab.example.com/acme/demo/-/merge_requests/50',
        user_notes_count: 1,
        updated_at: '2026-08-05T00:34:49.548+08:00',
        source_branch: 'fix/computer-use',
        target_branch: 'dev',
        draft: false,
        author: { name: 'Octocat', username: 'octocat' },
      },
    ]

    expect(normalizeRequests('glab', payload)).toEqual([
      {
        number: 50,
        sha: '1111111111111111111111111111111111111111',
        comments: 1,
        title: 'fix(cli): repair computer-use',
        url: 'https://gitlab.example.com/acme/demo/-/merge_requests/50',
        author: 'Octocat',
        sourceBranch: 'fix/computer-use',
        targetBranch: 'dev',
        updatedAt: '2026-08-05T00:34:49.548+08:00',
        isDraft: false,
      },
    ])
  })

  it('carries the owning project path from a group listing', () => {
    // Under a group scope every request comes from a different repository, so
    // the entry itself has to say which one. Without this the intent renders
    // `{{repo}}` as the group and the Agent is told to act on a path that holds
    // no merge request — the whole point of a wide scope is lost at the moment
    // the Run is created.
    const [request] = normalizeRequests(
      'glab',
      [
        {
          iid: 1042,
          sha: 'abc',
          title: 'chore: bump',
          references: { full: 'acme/platform/sdk/core!1042' },
        },
      ],
      true,
    )
    expect(request.project).toBe('acme/platform/sdk/core')
  })

  it('ignores the reference GitLab sends on a single-project listing', () => {
    // GitLab returns `references` on every listing, so the payload alone cannot
    // decide this — only the scope can. Recording it for a single project
    // re-keys state that was written before scopes existed.
    const [request] = normalizeRequests('glab', [
      { iid: 42, sha: 'a', title: 't', references: { full: 'group/repo!42' } },
    ])
    expect(request.project).toBeUndefined()
  })

  it('leaves the project unset when the payload carries no reference', () => {
    // A single-project listing needs no per-entry path: the caller already knows
    // it. Inventing one from `!iid` alone would be a guess.
    const [request] = normalizeRequests('glab', [{ iid: 7, sha: 'a', title: 't' }])
    expect(request.project).toBeUndefined()
  })

  it('treats a GitLab work_in_progress request as a draft', () => {
    const [request] = normalizeRequests('glab', [
      { iid: 1, sha: 'a', title: 't', work_in_progress: true },
    ])
    expect(request.isDraft).toBe(true)
  })

  it('normalizes a real GitHub GraphQL pull request node', () => {
    // Shape captured from a live `gh api graphql` call. The REST list endpoint
    // was replaced because it returns neither `comments` nor `review_comments`
    // (verified against the API), so `commented` could never fire, and it also
    // never carried `head.ref`, leaving {{source_branch}} empty.
    const [request] = normalizeRequests('gh', [
      {
        number: 14082,
        title: 'Create Dependencies license',
        url: 'https://github.com/cli/cli/pull/14082',
        updatedAt: '2026-08-05T20:39:08Z',
        isDraft: true,
        headRefOid: '2222222222222222222222222222222222222222',
        headRefName: 'patch-3',
        baseRefName: 'trunk',
        comments: { totalCount: 1 },
        reviews: { totalCount: 0 },
        reviewThreads: { totalCount: 0 },
        author: { login: 'hubot' },
      },
    ])

    expect(request).toEqual({
      number: 14082,
      sha: '2222222222222222222222222222222222222222',
      comments: 1,
      title: 'Create Dependencies license',
      url: 'https://github.com/cli/cli/pull/14082',
      author: 'hubot',
      sourceBranch: 'patch-3',
      targetBranch: 'trunk',
      updatedAt: '2026-08-05T20:39:08Z',
      isDraft: true,
    })
  })

  it('counts review activity that carries no conversation comment', () => {
    // A PR with reviews but zero conversation comments is real (observed on
    // cli/cli#14077). Tracking only `comments` would miss code review entirely,
    // which is the primary event this channel exists to catch.
    const [request] = normalizeRequests('gh', [
      {
        number: 14077,
        title: 't',
        comments: { totalCount: 0 },
        reviews: { totalCount: 2 },
        reviewThreads: { totalCount: 2 },
      },
    ])
    expect(request.comments).toBe(4)
  })

  it('normalizes a merge request whose title mentions 401 without incident', () => {
    // Guards the auth-detection boundary: response payloads are colleague-authored
    // text, so a title like this must never be read as an authentication failure.
    // The status signal is confined to stderr when no JSON body came back.
    const [request] = normalizeRequests('glab', [
      { iid: 9, sha: 'a', title: 'fix: unauthenticated 401 on login retry' },
    ])
    expect(request.number).toBe(9)
    expect(request.title).toBe('fix: unauthenticated 401 on login retry')
  })

  it('returns an empty list for a non-array payload', () => {
    // NOTE: this is the *normalizer's* local contract, not the poll's behaviour.
    // `callApi` now rejects a non-array payload before it reaches here, because
    // degrading a forge error envelope into "zero open requests" made the diff
    // declare every tracked request closed. See the callApi guard tests below.
    expect(normalizeRequests('glab', { message: '404 Not Found' })).toEqual([])
    expect(normalizeRequests('gh', null)).toEqual([])
  })

  it('tolerates a missing SHA rather than crashing the poll', () => {
    const [request] = normalizeRequests('glab', [{ iid: 1, sha: null, title: 't' }])
    expect(request.sha).toBe('')
  })
})
