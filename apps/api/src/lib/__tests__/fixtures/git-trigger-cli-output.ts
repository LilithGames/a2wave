/**
 * Verbatim output captured from the real `glab` / `gh` binaries.
 *
 * Five defects on this branch came from the same mistake: a test built its
 * input from what the code *expected* the CLI to return, so it passed while the
 * real command behaved differently. Those were not edge cases —
 * `commented` never fired on GitHub at all, and every authenticated `gh` was
 * reported as logged out.
 *
 * Anything parsing forge output belongs here, captured by running the command
 * and pasting the result. The rule: **if a test constructs CLI output by hand,
 * it proves nothing about the CLI.** Each entry records the binary version it
 * came from, because both vendors have changed these shapes before.
 */

/**
 * `glab auth status` — glab 1.x, two configured hosts, one authenticated.
 *
 * Pins two traps: the report covers every host at once (so a naive match says
 * "authenticated" whenever *any* host is), and an unauthenticated host prints
 * "No token found", which a bare /Token found/ test matches as a substring.
 */
export const GLAB_AUTH_STATUS_MIXED = `gitlab.com
  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 {message: 401 Unauthorized}
  ✓ Git operations for gitlab.com configured to use ssh protocol.
  ! No token found (checked config file, keyring, and environment variables).
gitlab.example.com
  ✓ Logged in to gitlab.example.com as octocat (keyring)
  ✓ Git operations for gitlab.example.com configured to use ssh protocol.
  ✓ Token found: **************************
`

/**
 * `gh auth status` — gh 2.97.0.
 *
 * gh changed this wording in 2.40: pre-2.40 said "Logged in to github.com as
 * octocat", 2.40+ says "... account octocat", and the token line became
 * "Token:" rather than "Token found". Matching only the old spelling reported
 * every modern, correctly authenticated gh as logged out.
 */
export const GH_AUTH_STATUS_AUTHENTICATED = `github.com
  ✓ Logged in to github.com account octocat (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
`

/** `gh auth status` with no credential at all. */
export const GH_AUTH_STATUS_LOGGED_OUT = 'You are not logged into any GitHub hosts.'

/**
 * `glab api projects/<missing>/merge_requests` — exit code 1, JSON on stdout.
 *
 * The body parses cleanly, so a parser that checks the payload before the exit
 * code reads this as a valid response, finds no array, and degrades into "zero
 * open merge requests" — which the diff then treats as every tracked request
 * having closed.
 */
export const GLAB_API_404 = {
  exitCode: 1,
  stdout: '{"message":"404 Project Not Found"}',
  stderr: 'glab: 404 Project Not Found (HTTP 404)',
}

/** `glab api` when the host has no usable token. */
export const GLAB_API_UNAUTHENTICATED = {
  exitCode: 1,
  stdout: '',
  stderr: 'ERROR  Unauthenticated.',
}

/**
 * A `glab` stdout banner containing a bracket, ahead of the real payload.
 *
 * Slicing from the first `[` lands inside `[0640]`, so both the direct parse and
 * the trim-to-last-bracket fallback fail on a perfectly good response.
 */
export const GLAB_BANNER_WITH_BRACKET = `WARNING: config file /home/appuser/.config/glab-cli/config.yml is group-readable [0640]
[{"iid":50,"sha":"abc"}]`

/**
 * One node from `gh api graphql` — the shape the GitHub listing actually uses.
 *
 * The REST list endpoint (`/repos/:owner/:repo/pulls`) is deliberately not used:
 * verified against the live API, it returns neither `comments` nor
 * `review_comments` (only the single-PR GET does) and never carried the head
 * branch name, so `commented` could not fire and `{{source_branch}}` rendered
 * empty. GraphQL returns all of it in one request.
 */
export const GH_GRAPHQL_PR_NODE = {
  number: 14082,
  title: 'Create Dependencies license',
  url: 'https://github.com/cli/cli/pull/14082',
  updatedAt: '2026-08-05T20:39:08Z',
  isDraft: true,
  headRefOid: '2222222222222222222222222222222222222222',
  headRefName: 'patch-3',
  baseRefName: 'trunk',
  comments: {
    totalCount: 1,
    nodes: [{ createdAt: '2026-08-05T20:39:08Z', author: { login: 'hubot' } }],
  },
  reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { totalCount: 0, nodes: [] },
  author: { login: 'hubot' },
}

/**
 * A `gh` PR node whose newest activity is a review comment, not a conversation
 * comment.
 *
 * GitHub splits discussion across three collections and `commented` sums all
 * three, so "who wrote the newest comment" cannot be read off `comments` alone —
 * a review posted after the last conversation comment is the newer one.
 */
export const GH_GRAPHQL_PR_NODE_REVIEW_LAST = {
  number: 14083,
  title: 'Bump deps',
  url: 'https://github.com/cli/cli/pull/14083',
  updatedAt: '2026-08-06T09:00:00Z',
  isDraft: false,
  headRefOid: '3333333333333333333333333333333333333333',
  headRefName: 'deps',
  baseRefName: 'trunk',
  comments: {
    totalCount: 1,
    nodes: [{ createdAt: '2026-08-06T08:00:00Z', author: { login: 'human' } }],
  },
  reviews: {
    totalCount: 1,
    nodes: [{ createdAt: '2026-08-06T09:00:00Z', author: { login: 'a2wave-bot' } }],
  },
  reviewThreads: { totalCount: 0, nodes: [] },
  author: { login: 'human' },
}

/**
 * `glab api projects/:id/merge_requests/:iid/notes?sort=desc` — glab 1.x.
 *
 * The newest entry is a **system** note ("added 1 commit"), which is exactly why
 * the newest row cannot be taken at face value: system notes are excluded from
 * `user_notes_count`, so the note that moved the counter is the newest one with
 * `system: false`.
 */
export const GLAB_MR_NOTES_SYSTEM_FIRST = [
  {
    id: 3,
    system: true,
    body: 'added 1 commit',
    created_at: '2026-08-06T10:00:00Z',
    author: { username: 'a2wave-bot' },
  },
  {
    id: 2,
    system: false,
    body: 'Reviewed: looks good.',
    created_at: '2026-08-06T09:59:00Z',
    author: { username: 'a2wave-bot' },
  },
  {
    id: 1,
    system: false,
    body: 'Please take a look.',
    created_at: '2026-08-06T09:00:00Z',
    author: { username: 'human' },
  },
]

/** `gh api graphql` reporting a missing repository in-band, with HTTP 200. */
export const GH_GRAPHQL_NOT_FOUND = {
  data: { repository: null },
  errors: [
    { type: 'NOT_FOUND', message: "Could not resolve to a Repository with the name 'x/y'." },
  ],
}

/** Wraps nodes in the GraphQL envelope the CLI returns. */
export function ghGraphqlEnvelope(nodes: unknown[]): string {
  return JSON.stringify({ data: { repository: { pullRequests: { nodes } } } })
}
