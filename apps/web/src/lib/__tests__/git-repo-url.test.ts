import { describe, expect, it } from 'vitest'
import { formatGitRepoUrl, parseGitNamespaceUrl, parseGitRepoUrl } from '../git-repo-url'

describe('parseGitRepoUrl', () => {
  it('parses a full https URL into host and project', () => {
    expect(parseGitRepoUrl('https://gitlab.example.com/acme/demo')).toEqual({
      host: 'gitlab.example.com',
      project: 'acme/demo',
    })
  })

  it('accepts a URL without a scheme — the most common paste shape', () => {
    expect(parseGitRepoUrl('gitlab.example.com/group/sub/repo')).toEqual({
      host: 'gitlab.example.com',
      project: 'group/sub/repo',
    })
  })

  it('accepts http and strips a trailing slash', () => {
    expect(parseGitRepoUrl('http://gitlab.example.com/group/repo/')).toEqual({
      host: 'gitlab.example.com',
      project: 'group/repo',
    })
  })

  it('strips a .git suffix so a clone URL pastes cleanly', () => {
    expect(parseGitRepoUrl('https://github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      project: 'owner/repo',
    })
  })

  it('parses an scp-style ssh remote', () => {
    expect(parseGitRepoUrl('git@gitlab.example.com:group/sub/repo.git')).toEqual({
      host: 'gitlab.example.com',
      project: 'group/sub/repo',
    })
  })

  it('parses an ssh:// remote', () => {
    expect(parseGitRepoUrl('ssh://git@github.com/owner/repo.git')).toEqual({
      host: 'github.com',
      project: 'owner/repo',
    })
  })

  it('drops a GitLab MR path so a browser URL can be pasted as-is', () => {
    expect(parseGitRepoUrl('https://gitlab.example.com/group/repo/-/merge_requests/42')).toEqual({
      host: 'gitlab.example.com',
      project: 'group/repo',
    })
  })

  it('drops a GitLab tree/blob path', () => {
    expect(parseGitRepoUrl('https://gitlab.example.com/group/repo/-/tree/main/src')).toEqual({
      host: 'gitlab.example.com',
      project: 'group/repo',
    })
  })

  it('drops a GitHub pull request path', () => {
    expect(parseGitRepoUrl('https://github.com/owner/repo/pull/7')).toEqual({
      host: 'github.com',
      project: 'owner/repo',
    })
  })

  it('drops a GitHub tree path', () => {
    expect(parseGitRepoUrl('https://github.com/owner/repo/tree/main/docs')).toEqual({
      host: 'github.com',
      project: 'owner/repo',
    })
  })

  it('ignores query strings and fragments', () => {
    expect(parseGitRepoUrl('https://github.com/owner/repo?tab=readme#top')).toEqual({
      host: 'github.com',
      project: 'owner/repo',
    })
  })

  it('keeps an explicit port on the host', () => {
    expect(parseGitRepoUrl('https://gitlab.example.com:8443/group/repo')).toEqual({
      host: 'gitlab.example.com:8443',
      project: 'group/repo',
    })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseGitRepoUrl('  https://github.com/owner/repo  ')).toEqual({
      host: 'github.com',
      project: 'owner/repo',
    })
  })

  it('treats a bare owner/repo as a project on the CLI default host', () => {
    // Backwards compatible with configs saved before the field became a URL.
    expect(parseGitRepoUrl('owner/repo')).toEqual({ host: '', project: 'owner/repo' })
  })

  it('returns null project for input with no repository path', () => {
    expect(parseGitRepoUrl('https://github.com')).toEqual({ host: 'github.com', project: '' })
  })

  it('returns empty fields for blank input', () => {
    expect(parseGitRepoUrl('   ')).toEqual({ host: '', project: '' })
  })

  it('does not mistake a single path segment for a project', () => {
    // `github.com/owner` names no repository; a host-only value must not be
    // silently saved as the project `owner`, which would poll a path that
    // cannot exist.
    expect(parseGitRepoUrl('https://github.com/owner')).toEqual({
      host: 'github.com',
      project: '',
    })
  })
})

describe('repositories whose own name collides with a routing marker', () => {
  /**
   * The markers that end a project path (`tree`, `blob`, `issues`, `pull`, …)
   * are ordinary words, and a real repository or group may be named one. They
   * only mean "routing starts here" *after* an `owner/repo` pair, so matching
   * them anywhere made `gitlab.com/mygroup/tree` parse to an empty project —
   * the row showed "unrecognised URL" and could never be saved.
   */
  it('keeps a repository named after a marker', () => {
    expect(parseGitRepoUrl('https://gitlab.com/mygroup/tree')).toEqual({
      host: 'gitlab.com',
      project: 'mygroup/tree',
    })
    expect(parseGitRepoUrl('https://github.com/owner/issues')).toEqual({
      host: 'github.com',
      project: 'owner/issues',
    })
  })

  it('keeps a group named after a marker', () => {
    expect(parseGitRepoUrl('https://gitlab.com/blob/myrepo')).toEqual({
      host: 'gitlab.com',
      project: 'blob/myrepo',
    })
  })

  it('still trims routing that follows a complete project path', () => {
    expect(parseGitRepoUrl('https://github.com/facebook/react/issues/123')).toEqual({
      host: 'github.com',
      project: 'facebook/react',
    })
    expect(parseGitRepoUrl('https://gitlab.com/group/tree/-/merge_requests/7')).toEqual({
      host: 'gitlab.com',
      project: 'group/tree',
    })
  })

  it('does not read a leading marker as a project', () => {
    // `gitlab.com/-/profile` is a user page, not a repository.
    expect(parseGitRepoUrl('https://gitlab.com/-/profile')).toEqual({
      host: 'gitlab.com',
      project: '',
    })
  })
})

describe('provider-directed parsing', () => {
  /**
   * The form knows which channel the user is configuring, so the parser should
   * be told rather than left to guess from the hostname.
   *
   * Guessing broke GitHub Enterprise: a host was treated as GitHub only if it
   * was `github.com` or began with `github.`, so `github.internal.com` worked
   * while `git.internal.com` — an equally ordinary GHE name — kept the routing
   * segments and produced the project `owner/repo/pull/7`. The row validated
   * and saved, then every poll failed in `splitGitHubProject`, which requires
   * exactly `owner/repo`. Self-hosted GitHub is a supported path here (the
   * backend sets `GH_HOST` and forwards `GH_ENTERPRISE_TOKEN`), so the naming
   * assumption was the whole bug.
   */
  it('reduces a GHE URL on any hostname to owner/repo', () => {
    expect(parseGitRepoUrl('https://git.internal.com/owner/repo/pull/7', 'gh')).toEqual({
      host: 'git.internal.com',
      project: 'owner/repo',
    })
    expect(parseGitRepoUrl('https://git.internal.com/owner/repo/tree/main/docs', 'gh')).toEqual({
      host: 'git.internal.com',
      project: 'owner/repo',
    })
  })

  it('keeps a nested GitLab namespace on a host that looks nothing like GitLab', () => {
    expect(parseGitRepoUrl('https://code.internal.com/org/platform/tree/service', 'glab')).toEqual({
      host: 'code.internal.com',
      project: 'org/platform/tree/service',
    })
  })

  it('cuts a GitLab URL only at its explicit /-/ separator', () => {
    expect(
      parseGitRepoUrl(
        'https://code.internal.com/org/platform/tree/service/-/merge_requests/7',
        'glab',
      ),
    ).toEqual({ host: 'code.internal.com', project: 'org/platform/tree/service' })
  })

  it('falls back to the hostname when no provider is supplied', () => {
    // Callers that genuinely have no channel context (a bare `owner/repo`
    // round-trip, for instance) keep the previous behaviour.
    expect(parseGitRepoUrl('https://github.com/owner/repo/pull/7')).toEqual({
      host: 'github.com',
      project: 'owner/repo',
    })
  })
})

describe('deeply nested GitLab namespaces', () => {
  /**
   * GitLab namespaces nest arbitrarily, so "no repository sits that deep" is
   * not a safe assumption — `org/platform/tree/service` is a real project whose
   * *namespace* is called `tree`. Cutting at a bare marker word truncated it to
   * `org/platform`, and the form then saved and polled a project that does not
   * exist. GitLab always separates routing with an explicit `/-/`, so that is
   * the only reliable cut.
   */
  it('keeps a namespace segment that happens to be a marker word', () => {
    expect(parseGitRepoUrl('https://gitlab.com/org/platform/tree/service')).toEqual({
      host: 'gitlab.com',
      project: 'org/platform/tree/service',
    })
  })

  it('cuts a nested project at the explicit /-/ separator', () => {
    expect(
      parseGitRepoUrl('https://gitlab.com/org/platform/tree/service/-/merge_requests/7'),
    ).toEqual({ host: 'gitlab.com', project: 'org/platform/tree/service' })
  })

  it('still trims GitHub routing, which is always exactly owner/repo deep', () => {
    expect(parseGitRepoUrl('https://github.com/facebook/react/issues/123')).toEqual({
      host: 'github.com',
      project: 'facebook/react',
    })
    expect(parseGitRepoUrl('https://github.com/owner/repo/tree/main/docs')).toEqual({
      host: 'github.com',
      project: 'owner/repo',
    })
  })
})

describe('single-label hosts', () => {
  /**
   * An internal forge is often reachable as a bare hostname. When the input
   * carries a scheme the authority is unambiguous, but the host heuristic only
   * accepted a dot, a port or `localhost` — so `https://gitlab/group/repo`
   * parsed as the project `gitlab/group/repo` on the CLI's default host, and
   * polled a project that does not exist.
   */
  it('trusts the authority when a scheme is present', () => {
    expect(parseGitRepoUrl('https://gitlab/group/repo')).toEqual({
      host: 'gitlab',
      project: 'group/repo',
    })
  })

  it('still treats a scheme-less owner/repo as a bare project path', () => {
    // No scheme means no authority to trust, so the heuristic stays in charge.
    expect(parseGitRepoUrl('owner/repo')).toEqual({ host: '', project: 'owner/repo' })
  })
})

describe('incremental typing', () => {
  it('parses every prefix of a URL without corrupting the final result', () => {
    // Regression: the field first re-rendered itself from the parsed parts on
    // every keystroke. Halfway through `https://git.example.com/group/repo`
    // that re-inserted a scheme and dropped the separators, so the input
    // mangled itself into `https://:git.example.comgrouprepo` and the row never
    // became valid. The raw text is now the source of truth; parsing only ever
    // reads it.
    const target = 'https://git.example.com/group/repo'
    for (let i = 1; i <= target.length; i++) {
      expect(() => parseGitRepoUrl(target.slice(0, i))).not.toThrow()
    }
    expect(parseGitRepoUrl(target)).toEqual({
      host: 'git.example.com',
      project: 'group/repo',
    })
  })
})

describe('parseGitNamespaceUrl', () => {
  it('accepts a single-segment group, which is not a valid project', () => {
    // A namespace has no `owner/repo` minimum — `acme` is a real,
    // top-level group. Reusing the project parser here rejected it as too short
    // and the field could never be filled in.
    expect(parseGitNamespaceUrl('https://gitlab.example.com/acme')).toEqual({
      host: 'gitlab.example.com',
      project: 'acme',
    })
  })

  it('keeps a deeply nested subgroup path whole', () => {
    expect(parseGitNamespaceUrl('https://gitlab.example.com/acme/platform/sdk')).toEqual({
      host: 'gitlab.example.com',
      project: 'acme/platform/sdk',
    })
  })

  it('cuts GitLab routing off a namespace URL', () => {
    // A browser URL for a group's merge requests carries `/-/merge_requests`,
    // and that is exactly the URL a user is most likely to copy.
    expect(
      parseGitNamespaceUrl('https://gitlab.example.com/acme/platform/-/merge_requests'),
    ).toEqual({ host: 'gitlab.example.com', project: 'acme/platform' })
  })

  it('drops the /groups/ prefix GitLab puts in every real group URL', () => {
    // This is THE url a user copies: GitLab serves a group at
    // `https://host/groups/acme/platform` (verified against a live instance —
    // the API's own `web_url` for a group has the prefix), while a project has
    // no such prefix. Keeping it yields the project path `groups/acme/platform`,
    // which contains a slash and therefore passes every validation, publishes
    // green, and then 404s on every single poll.
    expect(parseGitNamespaceUrl('https://gitlab.example.com/groups/acme/platform')).toEqual({
      host: 'gitlab.example.com',
      project: 'acme/platform',
    })
  })

  it('drops the prefix on a group merge-request list URL too', () => {
    expect(
      parseGitNamespaceUrl('https://gitlab.example.com/groups/acme/platform/-/merge_requests'),
    ).toEqual({ host: 'gitlab.example.com', project: 'acme/platform' })
  })

  it('keeps a project named "groups" that is not a prefix', () => {
    // The prefix only exists directly after the host. A namespace legitimately
    // called `groups` deeper in the path must survive.
    expect(parseGitNamespaceUrl('https://gitlab.example.com/acme/groups')).toEqual({
      host: 'gitlab.example.com',
      project: 'acme/groups',
    })
  })

  it('accepts a bare namespace with no host', () => {
    expect(parseGitNamespaceUrl('acme/platform')).toEqual({
      host: '',
      project: 'acme/platform',
    })
  })

  it('returns nothing for a host-only URL', () => {
    // There is no namespace in it, and defaulting to "everything on this host"
    // would silently widen the watch to the whole instance.
    expect(parseGitNamespaceUrl('https://gitlab.example.com')).toEqual({ host: '', project: '' })
  })

  it('returns nothing for empty input', () => {
    expect(parseGitNamespaceUrl('   ')).toEqual({ host: '', project: '' })
  })
})

describe('formatGitRepoUrl', () => {
  it('renders host + project as an https URL', () => {
    expect(formatGitRepoUrl({ host: 'gitlab.example.com', project: 'group/repo' })).toBe(
      'https://gitlab.example.com/group/repo',
    )
  })

  it('falls back to the bare project when no host is stored', () => {
    expect(formatGitRepoUrl({ host: '', project: 'owner/repo' })).toBe('owner/repo')
  })

  it('round-trips every parsed URL', () => {
    const url = 'https://gitlab.example.com/group/sub/repo'
    expect(formatGitRepoUrl(parseGitRepoUrl(url))).toBe(url)
  })

  it('renders nothing for an empty repo', () => {
    expect(formatGitRepoUrl({ host: '', project: '' })).toBe('')
  })
})
