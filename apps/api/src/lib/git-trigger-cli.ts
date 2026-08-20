import {
  GIT_TRIGGER_MAX_PAGES,
  type GitTriggerCliStatus,
  type GitTriggerProvider,
  type GitTriggerScope,
} from '@a2wave/shared'
/**
 * `glab` / `gh` CLI adapter for the git repository trigger channels.
 *
 * All forge access goes through the vendor CLI rather than raw HTTP, which is
 * the whole reason these channels can exist without new credential storage: the
 * CLIs already hold the operator's token in their own keyring/config, so a2wave
 * never sees, persists, or masks a forge PAT. That also means auth is managed
 * where operators expect (`glab auth login`), not in a settings page we would
 * have to keep in sync.
 *
 * Both CLIs expose a generic REST passthrough (`glab api` / `gh api`), so a
 * single JSON-shaped call replaces per-CLI output parsing. The two forges'
 * field names differ, and normalizing both into `ObservedRequest` here keeps
 * that vocabulary difference out of the diff engine and the scheduler.
 */
import { runStatusProbe } from '../engine/login-status-helper.js'
import type { ObservedRequest } from './git-trigger-diff.js'
import { logger } from './logger.js'

/** Binary name per provider — spawned bare so PATH resolution stays the single source of truth. */
const CLI_BINARY: Record<GitTriggerProvider, string> = {
  glab: 'glab',
  gh: 'gh',
}

/**
 * Host is passed via env rather than a flag: `glab` accepts `--hostname` only on
 * some subcommands, while `GITLAB_HOST` / `GH_HOST` are honoured uniformly by
 * both `auth status` and `api`.
 */
const HOST_ENV: Record<GitTriggerProvider, string> = {
  glab: 'GITLAB_HOST',
  gh: 'GH_HOST',
}

/** Poll timeout. Generous enough for a slow self-hosted forge, short enough not to overlap ticks. */
const POLL_TIMEOUT_MS = 20_000
const STATUS_TIMEOUT_MS = 15_000

/**
 * Token variables each CLI reads for non-interactive authentication.
 *
 * `runStatusProbe` builds the child environment from
 * `buildSafeAgentProcessEnv()`, an allowlist that deliberately drops unknown
 * variables — including these. That allowlist is shared with the Agent CLIs, so
 * it is not widened here; the tokens are forwarded explicitly for the forge
 * CLIs that actually need them.
 *
 * Without this, the documented container auth path silently fails: there is no
 * keyring in the image and `glab auth login` is interactive, so `GITLAB_TOKEN`
 * in the compose env is the only option — and it was being stripped, making the
 * status strip report "Not authenticated" while the operator can prove the same
 * credential works by running the CLI by hand in that container.
 */
const TOKEN_ENV: Record<GitTriggerProvider, readonly string[]> = {
  glab: ['GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN'],
  gh: ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'],
}

function hostEnv(provider: GitTriggerProvider, host?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    // Both CLIs colourise and paginate when they think they're on a TTY; a
    // pager would hang the poll forever waiting for a keypress that never comes.
    NO_COLOR: '1',
    CLICOLOR: '0',
    PAGER: 'cat',
    GLAMOUR_STYLE: 'notty',
  }
  if (host?.trim()) env[HOST_ENV[provider]] = host.trim()
  for (const name of TOKEN_ENV[provider]) {
    const value = process.env[name]
    if (value) env[name] = value
  }
  return env
}

/** Upper bound on structural openers tried before declaring output unparsable. */
const MAX_JSON_SCAN_ATTEMPTS = 20

/** Closing positions tried per opener, for output with a trailing banner. */
const MAX_JSON_CLOSE_ATTEMPTS = 20

/**
 * Extract the JSON body from CLI output.
 *
 * `glab` prefixes unrelated warnings (multiple config files, update notices) to
 * stdout, so `JSON.parse` on the raw buffer fails on a perfectly good response.
 * Scanning forward through the structural characters is what makes the parse
 * robust against banner noise we do not control — including banners that
 * themselves contain a bracket.
 */
export function extractJson(output: string): unknown {
  const trimmed = output.trim()
  if (!trimmed) return null

  /**
   * Scan forward through structural openers and, at each one, try progressively
   * shorter suffixes ending at a closing bracket.
   *
   * Two shapes broke simpler approaches, both of them real CLI behaviour:
   * a *leading* banner containing a bracket (`... is group-readable [0640]`)
   * makes the first opener the wrong one, and a *trailing* banner containing a
   * bracket (`A new version is available [v1.4.0]`) defeats a single
   * trim-to-last-bracket retry because `lastIndexOf` finds the banner's bracket
   * rather than the payload's. Trying each closing position from the end
   * handles both without assuming where the noise sits.
   *
   * Bounded on both axes so pathological output cannot make this quadratic.
   */
  for (let attempt = 0, from = 0; attempt < MAX_JSON_SCAN_ATTEMPTS; attempt++) {
    const start = trimmed.slice(from).search(/[[{]/)
    if (start < 0) return null
    const index = from + start
    const candidate = trimmed.slice(index)

    let end = candidate.length
    for (let close = 0; close < MAX_JSON_CLOSE_ATTEMPTS && end > 0; close++) {
      try {
        return JSON.parse(candidate.slice(0, end))
      } catch {
        // Step back to the previous closing bracket and try again.
        const nextEnd = Math.max(
          candidate.lastIndexOf(']', end - 2),
          candidate.lastIndexOf('}', end - 2),
        )
        if (nextEnd <= 0) break
        end = nextEnd + 1
      }
    }
    from = index + 1
  }
  return null
}

/**
 * Whether the CLI is installed and holds a usable credential for `host`.
 *
 * Reported to the config UI so an operator sees "not authenticated" in the
 * dialog instead of discovering it as a stream of failed polls in the log.
 * Never throws: an unusable CLI is a status to display, not an exception.
 */
export async function probeGitTriggerCli(
  provider: GitTriggerProvider,
  host?: string,
): Promise<GitTriggerCliStatus> {
  const binary = CLI_BINARY[provider]
  const result = await runStatusProbe(binary, ['auth', 'status'], {
    timeoutMs: STATUS_TIMEOUT_MS,
    logTag: `git-trigger:${provider}`,
    env: hostEnv(provider, host),
  })

  const base = { provider, ...(host?.trim() ? { host: host.trim() } : {}) }

  if (result.notFound) {
    return {
      ...base,
      installed: false,
      authenticated: false,
      detail: `${binary} is not installed or not on PATH`,
    }
  }
  if (result.timedOut) {
    return {
      ...base,
      installed: true,
      authenticated: false,
      detail: `${binary} auth status timed out`,
    }
  }

  // Both CLIs print the auth report to stderr, and `glab` exits 0 even when a
  // configured host is unauthenticated — so the exit code alone cannot decide
  // this. The text is what carries the verdict.
  const combined = `${result.stdout}\n${result.stderr}`
  const scoped = host?.trim() ? scopeToHost(combined, host.trim()) : combined
  const authenticated = isAuthenticatedReport(scoped)

  if (!authenticated) {
    return {
      ...base,
      installed: true,
      authenticated: false,
      detail: `Not authenticated. Run \`${binary} auth login\`${
        host?.trim() ? ` --hostname ${host.trim()}` : ''
      }.`,
    }
  }

  return {
    ...base,
    installed: true,
    authenticated: true,
    ...(parseAccount(scoped) ? { account: parseAccount(scoped) } : {}),
  }
}

/**
 * Narrow the auth report to the block describing `host`.
 *
 * `glab auth status` reports every configured host in one output, so a naive
 * regex over the whole text says "authenticated" whenever *any* host is — the
 * exact false-green that would let a misconfigured channel publish and then
 * fail every poll.
 */
function scopeToHost(output: string, host: string): string {
  // Exact match, not startsWith: a host block header is the bare hostname on its
  // own line, and prefix matching makes `gitlab.company.com` satisfy a lookup for
  // `gitlab.com` — reporting one host's credentials as another's, the same
  // false-green this scoping was introduced to prevent.
  const lines = output.split('\n')
  const startIndex = lines.findIndex((line) => line.trim() === host)
  if (startIndex < 0) return ''
  const block: string[] = [lines[startIndex]]
  for (let i = startIndex + 1; i < lines.length; i++) {
    // A new host block starts at column 0; indented lines belong to this host.
    if (lines[i].length > 0 && !/^\s/.test(lines[i])) break
    block.push(lines[i])
  }
  return block.join('\n')
}

/**
 * Decide the verdict from an auth report block.
 *
 * Reads the *positive* marker ("Logged in to <host> as <user>") and then vetoes
 * on explicit failure markers. A naive keyword match is not safe here: `glab`
 * prints "No token found (checked config file, keyring, and environment
 * variables)" for an unauthenticated host, and a bare /Token found/ test
 * matches that string as a substring — reporting a host with no credential at
 * all as authenticated. That false green is the worst possible answer for this
 * probe, since it lets a channel publish and then fail every single poll.
 */
export function isAuthenticatedReport(output: string): boolean {
  if (!output.trim()) return false
  if (/No token found|not logged in|401 Unauthorized|API call failed/i.test(output)) return false
  // `gh` changed its wording in 2.40: pre-2.40 says "Logged in to github.com as
  // octocat", 2.40+ says "... account octocat". Matching only `as` reported every
  // modern, correctly logged-in gh as unauthenticated — and this status strip is
  // the very thing that exists so a missing login is not discovered through a
  // stream of failed polls. Accept both spellings.
  return /Logged in to \S+ (?:as|account) \S+/i.test(output) || /(?<!No )Token found/i.test(output)
}

function parseAccount(output: string): string | undefined {
  // Both wordings, same reason as isAuthenticatedReport.
  const match = output.match(/Logged in to \S+ (?:as|account) ([^\s(]+)/i)
  return match?.[1]
}

export class GitTriggerCliError extends Error {
  constructor(
    message: string,
    readonly kind: 'not_installed' | 'unauthenticated' | 'failed',
  ) {
    super(message)
    this.name = 'GitTriggerCliError'
  }
}

/**
 * Shared spawn-failure guard for both the REST and GraphQL fetch paths.
 *
 * The exit code is checked BEFORE any body inspection, because a forge error
 * carries a perfectly parsable JSON body: `glab api` on a renamed or archived
 * project exits 1 while printing `{"message":"404 Project Not Found"}` to
 * stdout. Letting that through degrades into "this repository has zero open
 * requests", which the diff reads as every tracked request having closed.
 */
function assertProbeUsable(
  binary: string,
  result: {
    exitCode: number | null
    stdout: string
    stderr: string
    timedOut: boolean
    notFound: boolean
  },
): void {
  if (result.notFound) {
    throw new GitTriggerCliError(`${binary} is not installed or not on PATH`, 'not_installed')
  }
  if (result.timedOut) {
    throw new GitTriggerCliError(`${binary} api timed out after ${POLL_TIMEOUT_MS}ms`, 'failed')
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 200)
    const unauthenticated = /unauthenticated|401|not logged in/i.test(result.stderr)
    throw new GitTriggerCliError(
      `${binary} api exited ${result.exitCode}: ${detail}`,
      unauthenticated ? 'unauthenticated' : 'failed',
    )
  }
}

/** Raw `glab`/`gh` REST passthrough returning parsed JSON. */
async function callApi(
  provider: GitTriggerProvider,
  path: string,
  host?: string,
): Promise<unknown> {
  const binary = CLI_BINARY[provider]
  // Both CLIs spell the REST passthrough the same way; only the host env var differs.
  const result = await runStatusProbe(binary, ['api', path], {
    timeoutMs: POLL_TIMEOUT_MS,
    logTag: `git-trigger:${provider}`,
    env: hostEnv(provider, host),
  })

  assertProbeUsable(binary, result)

  const parsed = extractJson(result.stdout)

  // Auth failures are matched against stderr ONLY, and only when no JSON body
  // came back. Scanning stdout too would let a merge request titled "fix 401 on
  // login" abort a perfectly good poll — the response payload is attacker- and
  // colleague-controlled text, so it must never be read as a status signal.
  if (parsed === null && /unauthenticated|401|not logged in/i.test(result.stderr)) {
    throw new GitTriggerCliError(`${binary} is not authenticated for this host`, 'unauthenticated')
  }

  if (parsed === null) {
    throw new GitTriggerCliError(
      `${binary} returned no parsable JSON: ${result.stderr.trim().slice(0, 200)}`,
      'failed',
    )
  }

  /**
   * The listing endpoints return an array. Anything else is an error envelope
   * that happened to exit 0 — treating it as "no open requests" is the same
   * silent-closure failure as above, so it fails loudly instead.
   */
  if (!Array.isArray(parsed)) {
    const message =
      typeof (parsed as { message?: unknown })?.message === 'string'
        ? (parsed as { message: string }).message
        : 'unexpected non-array response'
    throw new GitTriggerCliError(`${binary} api returned ${message}`, 'failed')
  }

  /**
   * Being an array is not enough — the elements must look like merge requests.
   *
   * `extractJson` returns the first structurally valid JSON it finds, so a
   * banner that itself contains an array (`note: retrying [1,2]`) would satisfy
   * the check above. Those elements normalise to `number: undefined`, and the
   * real requests are then absent from the "listing", which the diff reads as
   * every tracked request having closed — a storm of bogus `closed` Runs plus
   * deletion of the fingerprints that would have prevented them re-firing.
   * Requiring the identifying key makes such a payload a loud failure instead.
   */
  const identifier = provider === 'glab' ? 'iid' : 'number'
  const shaped = parsed.every(
    (item) => typeof item === 'object' && item !== null && identifier in item,
  )
  if (!shaped) {
    throw new GitTriggerCliError(
      `${binary} api returned an array without \`${identifier}\` entries; treating as a failed poll`,
      'failed',
    )
  }

  return parsed
}

/**
 * Page size for the open-request listing. 100 is the maximum both forges accept;
 * a response of exactly this length is therefore possibly truncated.
 */
const LIST_PAGE_SIZE = 100

/**
 * A listing plus whether it is known to be exhaustive. `complete: false` means
 * the page was full, so absence from `requests` does not prove closure.
 */
export interface ListOpenRequestsResult {
  requests: ObservedRequest[]
  complete: boolean
  /**
   * List pages this call actually fetched, so the caller can charge them
   * against the tick-wide budget. Always at least 1.
   */
  pagesFetched: number
}

/** GitLab merge request as returned by `/projects/:id/merge_requests`. */
interface GitLabMergeRequest {
  iid: number
  sha: string | null
  title: string
  web_url?: string
  user_notes_count?: number
  updated_at?: string
  source_branch?: string
  target_branch?: string
  draft?: boolean
  work_in_progress?: boolean
  author?: { name?: string; username?: string }
  /**
   * Present on every listing. `full` reads `group/sub/repo!42`, which is the
   * only field naming the owning repository — the group and instance listings
   * span many, and `web_url` would have to be parsed to recover it.
   */
  references?: { full?: string }
}

/**
 * The repository path out of `references.full` (`group/sub/repo!42`).
 *
 * Returns undefined rather than guessing when the shape is unfamiliar: a wrong
 * path here silently sends the Agent at a repository that holds no such merge
 * request, whereas an absent one degrades to the watch entry's own path.
 */
function projectFromReference(reference: string | undefined): string | undefined {
  if (!reference) return undefined
  const [path] = reference.split('!')
  return path?.includes('/') ? path : undefined
}

/**
 * GitHub pull request node as returned by the GraphQL query below.
 *
 * The REST list endpoint (`/repos/:owner/:repo/pulls`) is deliberately NOT used:
 * it omits `comments` and `review_comments` entirely (only the single-PR GET
 * carries them), so a REST-based poll reported a comment count of 0 forever and
 * the `commented` event could never fire. Verified against the live API — those
 * keys are absent from every element of the list response. Fetching them per PR
 * would turn one cheap call into an N+1 sweep, which is exactly what this
 * channel exists to avoid, so the listing moves to GraphQL where head SHA, both
 * branch names and both comment counters arrive in the same single request.
 */
interface GitHubPullRequestNode {
  number: number
  title?: string
  url?: string
  updatedAt?: string
  isDraft?: boolean
  headRefOid?: string
  headRefName?: string
  baseRefName?: string
  comments?: { totalCount?: number }
  reviews?: { totalCount?: number }
  reviewThreads?: { totalCount?: number }
  author?: { login?: string }
}

/**
 * `spansRepositories` decides whether the per-request path is recorded at all.
 *
 * GitLab sends `references` on **every** listing, the single-project one
 * included, so attaching it unconditionally re-keyed ordinary single-repository
 * entries from `42` to `group/repo!42`. Fingerprints written before scopes
 * existed use the bare number, so the first poll after an upgrade matched none
 * of them: every open request fired `opened` and every stored key fired
 * `closed`. `repoStateKey` is carefully written to keep the project scope's key
 * stable across that upgrade, and this is the same invariant one layer down —
 * the path is recorded only when the listing genuinely spans repositories and
 * the number alone is therefore ambiguous.
 */
function normalizeGitLab(mr: GitLabMergeRequest, spansRepositories: boolean): ObservedRequest {
  const project = spansRepositories ? projectFromReference(mr.references?.full) : undefined
  return {
    number: mr.iid,
    sha: mr.sha ?? '',
    comments: mr.user_notes_count ?? 0,
    title: mr.title ?? '',
    ...(mr.web_url ? { url: mr.web_url } : {}),
    ...(mr.author?.name || mr.author?.username
      ? { author: mr.author.name || mr.author.username }
      : {}),
    ...(mr.source_branch ? { sourceBranch: mr.source_branch } : {}),
    ...(mr.target_branch ? { targetBranch: mr.target_branch } : {}),
    ...(mr.updated_at ? { updatedAt: mr.updated_at } : {}),
    isDraft: Boolean(mr.draft ?? mr.work_in_progress),
    ...(project ? { project } : {}),
  }
}

function normalizeGitHub(pr: GitHubPullRequestNode): ObservedRequest {
  return {
    number: pr.number,
    sha: pr.headRefOid ?? '',
    // GitHub splits discussion across conversation comments and review threads;
    // a review comment is exactly the kind of event this channel exists to
    // catch, so both are summed rather than tracking only the conversation
    // count. `reviews` is included too so an approval with no inline comment
    // still registers as activity.
    comments:
      (pr.comments?.totalCount ?? 0) +
      (pr.reviews?.totalCount ?? 0) +
      (pr.reviewThreads?.totalCount ?? 0),
    title: pr.title ?? '',
    ...(pr.url ? { url: pr.url } : {}),
    ...(pr.author?.login ? { author: pr.author.login } : {}),
    // headRefName was missing entirely before, so the {{source_branch}}
    // placeholder the UI advertises always rendered as an empty string on gh.
    ...(pr.headRefName ? { sourceBranch: pr.headRefName } : {}),
    ...(pr.baseRefName ? { targetBranch: pr.baseRefName } : {}),
    ...(pr.updatedAt ? { updatedAt: pr.updatedAt } : {}),
    isDraft: Boolean(pr.isDraft),
  }
}

export function normalizeRequests(
  provider: GitTriggerProvider,
  payload: unknown,
  /**
   * Whether this payload can contain more than one repository. Defaults to
   * false, so a caller that does not say keeps the historical single-project
   * shape rather than silently re-keying its state.
   */
  spansRepositories = false,
): ObservedRequest[] {
  if (!Array.isArray(payload)) return []
  return provider === 'glab'
    ? payload.map((item) => normalizeGitLab(item as GitLabMergeRequest, spansRepositories))
    : payload.map((item) => normalizeGitHub(item as GitHubPullRequestNode))
}

/**
 * GraphQL query for the GitHub listing.
 *
 * One request returns everything the diff needs — head SHA, both branch names,
 * conversation/review counts, draft state and author — so the poll stays at one
 * call per repository per tick, the property the whole channel depends on.
 */
const GH_PR_QUERY = `query($owner:String!,$name:String!,$first:Int!){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:$first,orderBy:{field:UPDATED_AT,direction:DESC}){
      nodes{number title url updatedAt isDraft headRefOid headRefName baseRefName
            comments{totalCount} reviews{totalCount} reviewThreads{totalCount}
            author{login}}}}}`

/** Splits `owner/repo` for the GraphQL variables; rejects anything else. */
function splitGitHubProject(project: string): { owner: string; name: string } {
  const parts = project.split('/').filter(Boolean)
  if (parts.length !== 2) {
    throw new GitTriggerCliError(`GitHub project must be "owner/repo", got "${project}"`, 'failed')
  }
  return { owner: parts[0], name: parts[1] }
}

/** Runs the GitHub GraphQL listing and returns the raw nodes array. */
async function fetchGitHubNodes(project: string, host?: string): Promise<unknown[]> {
  const { owner, name } = splitGitHubProject(project)
  const result = await runStatusProbe(
    CLI_BINARY.gh,
    [
      'api',
      'graphql',
      // `-f` (raw-field) for the string variables, `-F` (field) only for the
      // Int. `-F` applies JSON type inference, so a numeric owner or repo name
      // — `gabrielecirulli/2048` is a real, well-known example — is sent as an
      // Int and GraphQL rejects it with "Could not coerce value 2048 to
      // String". The repository would then fail every poll while the config
      // dialog, CLI status strip and channel state all looked healthy.
      '-f',
      `query=${GH_PR_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `first=${LIST_PAGE_SIZE}`,
    ],
    { timeoutMs: POLL_TIMEOUT_MS, logTag: 'git-trigger:gh', env: hostEnv('gh', host) },
  )

  assertProbeUsable('gh', result)

  const parsed = extractJson(result.stdout)
  if (parsed === null) {
    throw new GitTriggerCliError(
      `gh api graphql returned no parsable JSON: ${result.stderr.trim().slice(0, 200)}`,
      'failed',
    )
  }

  // GraphQL reports errors in-band with HTTP 200, so a body alone is not
  // success. Surfacing them keeps a bad repo path or a scope problem from
  // degrading into "zero open pull requests", which the diff would read as
  // every tracked request having closed.
  const body = parsed as {
    errors?: { message?: string }[]
    data?: { repository?: { pullRequests?: { nodes?: unknown[] } } | null }
  }
  if (Array.isArray(body.errors) && body.errors.length > 0) {
    throw new GitTriggerCliError(
      `gh api graphql returned ${body.errors[0]?.message ?? 'an error'}`,
      'failed',
    )
  }
  const nodes = body.data?.repository?.pullRequests?.nodes
  if (!Array.isArray(nodes)) {
    throw new GitTriggerCliError('gh api graphql returned no pull request nodes', 'failed')
  }
  return nodes
}

/**
 * Live state of one merge/pull request, as reported by the forge right now.
 *
 * `unknown` is the deliberate answer to every failure shape — CLI missing,
 * timeout, non-zero exit, unparsable output, an unrecognised state value
 * (GitLab's transient `locked` included). The one caller uses this to decide
 * whether a queued Run may be skipped, and a transient forge error must fail
 * open into "run it" rather than silently cancelling legitimate work.
 */
export type GitTriggerRequestLiveState = 'open' | 'merged' | 'closed' | 'unknown'

/**
 * Fetch the current state of a single merge/pull request. Never throws.
 *
 * Exists for the pre-execution staleness check: a trigger fires while the
 * request is open, but the Run may leave the queue minutes later, after the
 * request was already merged. One cheap CLI call here is what lets execution
 * decline before any tokens are spent.
 */
export async function fetchRequestState(
  provider: GitTriggerProvider,
  project: string,
  number: number,
  host?: string,
): Promise<GitTriggerRequestLiveState> {
  const binary = CLI_BINARY[provider]
  const path =
    provider === 'glab'
      ? `projects/${encodeURIComponent(project)}/merge_requests/${number}`
      : `repos/${project}/pulls/${number}`
  try {
    const result = await runStatusProbe(binary, ['api', path], {
      timeoutMs: POLL_TIMEOUT_MS,
      logTag: `git-trigger:${provider}`,
      env: hostEnv(provider, host),
    })
    if (result.notFound || result.timedOut || result.exitCode !== 0) return 'unknown'

    const parsed = extractJson(result.stdout) as { state?: unknown; merged?: unknown } | null
    if (!parsed || typeof parsed !== 'object' || typeof parsed.state !== 'string') return 'unknown'

    if (provider === 'glab') {
      if (parsed.state === 'opened') return 'open'
      if (parsed.state === 'merged') return 'merged'
      if (parsed.state === 'closed') return 'closed'
      return 'unknown'
    }
    // GitHub reports merged PRs as state=closed; `merged` carries the distinction.
    if (parsed.state === 'open') return 'open'
    if (parsed.state === 'closed') return parsed.merged === true ? 'merged' : 'closed'
    return 'unknown'
  } catch (err) {
    logger.warn({ err, provider, project, number, host }, 'git-trigger: request state probe threw')
    return 'unknown'
  }
}

/**
 * Build the GitLab listing path for one watch entry and page.
 *
 * The three scopes are three collections, not three filters — GitLab exposes a
 * project's requests, a group's (recursing into subgroups), and the caller's
 * whole visible set as separate endpoints returning the identical record shape.
 * That sameness is what lets one normalizer and one diff engine serve all three.
 *
 * Ordering is always most-recently-updated first because paging is capped: the
 * cap has to fall on the requests least likely to have moved, or a wide scope
 * would miss exactly the activity it was configured to catch.
 */
export function buildGitLabListPath(
  entry: { scope: GitTriggerScope; project: string },
  page: number,
): string {
  const query = `state=opened&per_page=${LIST_PAGE_SIZE}&order_by=updated_at&sort=desc&page=${page}`
  const collection = entry.scope === 'group' ? 'groups' : 'projects'
  return `${collection}/${encodeURIComponent(entry.project)}/merge_requests?${query}`
}

/**
 * Fetch a GitLab listing, following pages until the scope is exhausted.
 *
 * A project fits in one page and stops after it. A group need not, and paging is
 * what makes `closed` inference possible there at all: absence proves closure
 * only when the whole open set was seen. The cap bounds the cost — beyond it the
 * result is reported incomplete and the diff suspends closure inference rather
 * than firing `closed` on evidence it does not have.
 */
async function fetchGitLabPages(
  entry: { scope: GitTriggerScope; project: string },
  host: string | undefined,
  pageBudget: number,
): Promise<{ payload: unknown[]; complete: boolean; pagesFetched: number }> {
  /**
   * A single project stays at exactly one call, as it always has.
   *
   * Paging exists for namespaces, whose size is a property of the organisation
   * rather than the config. One repository holding more than a page of open
   * merge requests is pathological, and paying five calls per tick on every
   * ordinary repository to cover it would tax the common case for the rare one —
   * the existing "full page ⇒ treat as truncated" rule already handles it
   * safely by suspending closure inference.
   */
  // Bounded by the per-entry cap AND whatever the tick has left, so five group
  // entries cannot multiply into 25 serial calls.
  const maxPages =
    entry.scope === 'project' ? 1 : Math.max(1, Math.min(GIT_TRIGGER_MAX_PAGES, pageBudget))
  const payload: unknown[] = []

  for (let page = 1; page <= maxPages; page++) {
    const batch = (await callApi('glab', buildGitLabListPath(entry, page), host)) as unknown[]
    payload.push(...batch)
    // A short page is the forge saying there is nothing after it. This is the
    // only proof of completeness available, since the page-count headers are not
    // exposed through the CLI's JSON passthrough.
    if (batch.length < LIST_PAGE_SIZE) return { payload, complete: true, pagesFetched: page }
  }

  // Every page came back full, so there is at least one more the budget refused
  // to fetch. Completeness is unprovable and closure must not be inferred.
  return { payload, complete: false, pagesFetched: maxPages }
}

/**
 * List open merge/pull requests for one watch entry.
 *
 * A project scope stays at one call per tick, the property the whole channel
 * depends on. The wider scopes trade a bounded number of extra calls for
 * covering a namespace whose membership changes without a config edit — still
 * far cheaper than one call per repository, and everything the diff needs
 * arrives in the same responses, so no per-request follow-up is ever issued.
 */
export async function listOpenRequests(
  provider: GitTriggerProvider,
  project: string,
  host?: string,
  scope: GitTriggerScope = 'project',
  /**
   * Pages this entry may still spend from the tick's shared allowance. Defaults
   * to the per-entry cap for callers that do not track a tick.
   */
  pageBudget: number = GIT_TRIGGER_MAX_PAGES,
): Promise<ListOpenRequestsResult> {
  if (provider === 'gh') {
    const requests = normalizeRequests('gh', await fetchGitHubNodes(project, host))
    const complete = requests.length < LIST_PAGE_SIZE
    if (!complete) {
      logger.warn(
        { provider, project, host, pageSize: LIST_PAGE_SIZE },
        'git-trigger: open request listing is a full page; closed-event detection is suspended for this repository until it fits one page',
      )
    }
    return { requests, complete, pagesFetched: 1 }
  }

  const { payload, complete, pagesFetched } = await fetchGitLabPages(
    { scope, project },
    host,
    pageBudget,
  )
  const requests = normalizeRequests('glab', payload, scope !== 'project')

  if (!complete) {
    logger.warn(
      { provider, project, host, scope, pages: pagesFetched, count: requests.length },
      'git-trigger: scope exceeds the page budget; closed-event detection is suspended for it until it fits — narrow the scope to restore it',
    )
  }
  logger.debug(
    { provider, project, host, scope, count: requests.length, complete, pagesFetched },
    'git-trigger: listed open requests',
  )
  return { requests, complete, pagesFetched }
}
