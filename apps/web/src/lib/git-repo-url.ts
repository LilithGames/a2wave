/**
 * Repository URL ⇄ `{ host, project }` conversion for the git trigger channels.
 *
 * The stored config keeps host and project separate because that is what the
 * CLIs consume: the host goes into `GITLAB_HOST`/`GH_HOST` and the project into
 * the API path. But nobody *has* a host and a project — they have the URL in
 * their browser's address bar, and splitting it by hand was the single most
 * error-prone field in the form (a host typed with `https://`, a project typed
 * with a leading slash, both silently producing a poll that 404s forever).
 *
 * So the form collects one URL and this module does the splitting, tolerantly:
 * scheme optional, `.git` optional, and the deep paths a real browser URL
 * carries (`/-/merge_requests/42`, `/pull/7`, `/tree/main/...`) trimmed back to
 * the repository. Parsing is deliberately string-based rather than `new URL()`
 * so a scheme-less input needs no speculative prefixing, and so an scp-style
 * remote (`git@host:group/repo.git`) — which `URL` cannot parse at all — is
 * handled by the same code path.
 */

/**
 * Which forge the URL belongs to, taken from the channel being configured.
 *
 * Optional so a caller without channel context (a stored `owner/repo`
 * round-trip) still works, but the form always knows and should always pass it.
 */
export type GitRepoProvider = 'glab' | 'gh'

export interface GitRepoLocation {
  /** Forge host, possibly with a port. Empty means the CLI's default host. */
  host: string
  /** Full project path, e.g. `group/sub/repo`. Empty when unparseable. */
  project: string
}

const EMPTY: GitRepoLocation = { host: '', project: '' }

/**
 * GitHub's flat routes, which always sit directly after `owner/repo`.
 *
 * GitLab needs no such list: it separates routing with an explicit `/-/`, so
 * the marker words below are only ever consulted at the one depth GitHub can
 * put them at. That distinction is load-bearing — see `toProject`.
 */
const GITHUB_ROUTE_SEGMENTS = new Set([
  'pull',
  'pulls',
  'tree',
  'blob',
  'issues',
  'commits',
  'releases',
  'actions',
  'wiki',
])

/** GitLab's explicit separator between a project path and its routing. */
const GITLAB_ROUTE_SEPARATOR = '-'

/**
 * Heuristic for a scheme-less input: is the first segment a host or a project
 * namespace? A dot, a port, or `localhost` says host. With a scheme present the
 * authority is unambiguous and this is not consulted at all.
 */
function looksLikeHost(segment: string): boolean {
  return segment.includes('.') || segment.includes(':') || segment === 'localhost'
}

function stripGitSuffix(project: string): string {
  return project.endsWith('.git') ? project.slice(0, -4) : project
}

/** A project needs at least `owner/repo`; one segment is a namespace. */
const MIN_PROJECT_SEGMENTS = 2

/**
 * Last-resort guess at the forge when the caller supplies no provider.
 *
 * Only a fallback. A GitHub Enterprise install may be reachable at any
 * hostname — `git.internal.com` is as ordinary a name as `github.internal.com`
 * — so this cannot be the primary signal; pass `provider` instead.
 */
function looksLikeGitHubHost(host: string): boolean {
  const bare = host.toLowerCase().split(':')[0] ?? ''
  return bare === 'github.com' || bare.startsWith('github.')
}

/** Resolves how to cut the path: the caller's channel wins over the hostname. */
function resolveIsGitHub(provider: GitRepoProvider | undefined, host: string): boolean {
  if (provider) return provider === 'gh'
  return looksLikeGitHubHost(host)
}

/**
 * Reduces a path to the project part, cutting where forge routing begins.
 *
 * The two forges have to be told apart, because they disagree about how deep a
 * project can be and that is exactly what makes a shared marker list wrong:
 *
 * - **GitLab** nests namespaces arbitrarily, so `org/platform/tree/service` is
 *   a real project whose namespace is literally called `tree`. Cutting at a
 *   bare marker word truncated it to `org/platform` and the form then polled a
 *   project that does not exist. GitLab always writes `/-/` before routing, so
 *   that separator is the only reliable cut — and it is never a project name.
 * - **GitHub** is always exactly `owner/repo`, so anything from the third
 *   segment on is routing. Matching those words at *any* depth was the earlier
 *   bug: `github.com/owner/issues` is a real repository.
 */
function toProject(segments: string[], isGitHub: boolean): string {
  // A path that opens with GitLab's separator (`/-/profile`, `/-/snippets`)
  // names no repository at all.
  if (segments[0] === GITLAB_ROUTE_SEPARATOR) return ''

  const separatorIndex = segments.indexOf(GITLAB_ROUTE_SEPARATOR)
  const projectSegments =
    separatorIndex !== -1
      ? // GitLab: everything before `/-/`, however deeply nested.
        segments.slice(0, separatorIndex)
      : // No separator. On GitHub a project is always exactly `owner/repo`, so
        // a known route word in the third segment is routing. Anywhere else the
        // path may be a nested GitLab namespace and is kept whole — guessing
        // here is what truncated `org/platform/tree/service`.
        isGitHub && GITHUB_ROUTE_SEGMENTS.has(segments[MIN_PROJECT_SEGMENTS] ?? '')
        ? segments.slice(0, MIN_PROJECT_SEGMENTS)
        : segments

  if (projectSegments.length < MIN_PROJECT_SEGMENTS) return ''
  return stripGitSuffix(projectSegments.join('/'))
}

/** Parses a repository URL, remote or bare `owner/repo` path into its parts. */
export function parseGitRepoUrl(input: string, provider?: GitRepoProvider): GitRepoLocation {
  const trimmed = input.trim()
  if (!trimmed) return EMPTY

  // Drop query and fragment before anything else — both may contain slashes
  // that would otherwise be read as path segments.
  const withoutSuffix = trimmed.split(/[?#]/)[0] ?? ''
  if (!withoutSuffix) return EMPTY

  // scp-style remote: `git@host:group/repo.git`. Detected before scheme
  // stripping because it has no scheme, and its `:` is a path separator rather
  // than a port.
  const scpMatch = withoutSuffix.match(/^(?:[^@/]+@)([^/:]+):(.+)$/)
  if (scpMatch?.[1] && scpMatch[2]) {
    return {
      host: scpMatch[1],
      project: toProject(
        scpMatch[2].split('/').filter(Boolean),
        resolveIsGitHub(provider, scpMatch[1]),
      ),
    }
  }

  // Strip scheme and any userinfo (`ssh://git@host/...`). Whether a scheme was
  // present decides how the first segment is read, so remember it.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(withoutSuffix)
  const withoutScheme = withoutSuffix.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const withoutUserInfo = withoutScheme.replace(/^[^@/]+@/, '')

  const segments = withoutUserInfo.split('/').filter(Boolean)
  if (segments.length === 0) return EMPTY

  const [first, ...rest] = segments
  if (!first) return EMPTY

  // A scheme makes the authority unambiguous, so take it as the host even when
  // it is a single label. Internal forges are commonly reachable as a bare
  // name, and `https://gitlab/group/repo` previously parsed as the *project*
  // `gitlab/group/repo` on the CLI's default host — a poll that never resolves.
  // Without a scheme there is no authority to trust, so the heuristic decides,
  // which is what keeps a bare `owner/repo` working.
  if (hasScheme || looksLikeHost(first))
    return { host: first, project: toProject(rest, resolveIsGitHub(provider, first)) }

  // No host, so the provider is the only signal available.
  return { host: '', project: toProject(segments, resolveIsGitHub(provider, '')) }
}

/**
 * Parses a **namespace** URL — a GitLab group or subgroup — into its parts.
 *
 * Separate from `parseGitRepoUrl` because the two have genuinely different
 * shapes, not merely different validation. A project needs at least
 * `owner/repo`; a namespace may be a single segment (`acme` is a real
 * top-level group), so running it through the project parser rejects the most
 * ordinary group path there is. The routing rules are shared, though: a user is
 * most likely to copy the URL of a group's merge request list, which carries
 * GitLab's `/-/` separator and everything after it.
 */
export function parseGitNamespaceUrl(input: string): GitRepoLocation {
  const trimmed = input.trim()
  if (!trimmed) return EMPTY

  const withoutSuffix = trimmed.split(/[?#]/)[0] ?? ''
  if (!withoutSuffix) return EMPTY

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(withoutSuffix)
  const withoutScheme = withoutSuffix.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '')
  const withoutUserInfo = withoutScheme.replace(/^[^@/]+@/, '')

  const segments = withoutUserInfo.split('/').filter(Boolean)
  if (segments.length === 0) return EMPTY

  const [first, ...rest] = segments
  if (!first) return EMPTY

  const isHost = hasScheme || looksLikeHost(first)
  const rawPath = isHost ? rest : segments
  const host = isHost ? first : ''

  /**
   * GitLab routes a *group* under `/groups/`, a project under nothing.
   *
   * This is the URL a user actually copies — the API's own `web_url` for a group
   * is `https://host/groups/acme/platform`. Keeping the prefix yields the path
   * `groups/acme/platform`, which contains a slash and so passes every
   * validation, publishes green, and then 404s on every poll. Stripped only in
   * the leading position, so a namespace genuinely called `groups` deeper in the
   * path survives.
   */
  const pathSegments = rawPath[0] === 'groups' ? rawPath.slice(1) : rawPath

  // Everything before GitLab's routing separator; a namespace never contains it.
  const separatorIndex = pathSegments.indexOf(GITLAB_ROUTE_SEPARATOR)
  const namespace = separatorIndex === -1 ? pathSegments : pathSegments.slice(0, separatorIndex)

  // A host with no path names no namespace. Falling back to the host alone would
  // quietly turn "this group" into "this entire instance".
  if (namespace.length === 0) return EMPTY

  return { host, project: stripGitSuffix(namespace.join('/')) }
}

/** Renders stored parts back into the URL the form displays. */
export function formatGitRepoUrl({ host, project }: GitRepoLocation): string {
  if (!project) return host ? `https://${host}` : ''
  if (!host) return project
  return `https://${host}/${project}`
}
