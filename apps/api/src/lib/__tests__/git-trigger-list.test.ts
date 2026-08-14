/**
 * `listOpenRequests` against real CLI failure shapes.
 *
 * These live apart from git-trigger-cli.test.ts because they need
 * `runStatusProbe` mocked. The cases matter more than the usual error-path test:
 * a poll that *silently* reports "zero open requests" is far worse than one that
 * throws, because the diff reads an empty listing as "every tracked request was
 * closed" — firing bogus Runs and deleting the fingerprints that would have
 * prevented them from re-firing as `opened` afterwards.
 */
import { GIT_TRIGGER_MAX_PAGES } from '@a2wave/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runStatusProbe = vi.fn()
vi.mock('../../engine/login-status-helper.js', () => ({
  runStatusProbe: (...args: unknown[]) => runStatusProbe(...args),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { GitTriggerCliError, listOpenRequests } from '../git-trigger-cli.js'
import {
  GH_GRAPHQL_NOT_FOUND,
  GLAB_API_404,
  GLAB_API_UNAUTHENTICATED,
  ghGraphqlEnvelope,
} from './fixtures/git-trigger-cli-output.js'

function probeResult(overrides: Record<string, unknown> = {}) {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, notFound: false, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('listOpenRequests — forge error handling', () => {
  it('throws on a 404 that exits non-zero with a JSON body on stdout', async () => {
    // Captured from a real `glab api` call against a nonexistent project:
    //   exit=1, stdout={"message":"404 Project Not Found"}
    // The body parses cleanly, so without an exit-code check it flows on, fails
    // the array check, and degrades into "zero open merge requests".
    runStatusProbe.mockResolvedValue(probeResult(GLAB_API_404))

    await expect(listOpenRequests('glab', 'group/gone')).rejects.toBeInstanceOf(GitTriggerCliError)
  })

  it('classifies a non-zero exit whose stderr shows auth failure as unauthenticated', async () => {
    runStatusProbe.mockResolvedValue(probeResult(GLAB_API_UNAUTHENTICATED))

    await expect(listOpenRequests('glab', 'group/repo')).rejects.toMatchObject({
      kind: 'unauthenticated',
    })
  })

  it('throws on an error envelope that exits zero', async () => {
    // Belt-and-braces: some failures return 200 with an error body. Reporting
    // that as an empty listing has the same closed-storm consequence.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: '{"message":"403 Forbidden"}' }))

    await expect(listOpenRequests('glab', 'group/repo')).rejects.toMatchObject({ kind: 'failed' })
  })

  it('throws on a GraphQL in-band error even though the call exits zero', async () => {
    // GraphQL reports NOT_FOUND with HTTP 200 and a `data.repository: null`
    // body, so a body alone is not success. Degrading it into an empty listing
    // would make the diff declare every tracked request closed.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: JSON.stringify(GH_GRAPHQL_NOT_FOUND) }))

    await expect(listOpenRequests('gh', 'owner/gone')).rejects.toMatchObject({ kind: 'failed' })
  })

  it('passes a numeric repository name as a string, not an Int', async () => {
    // `gh -F` applies JSON type inference, so `-F name=2048` sends an Int and
    // GraphQL rejects it with "Could not coerce value 2048 to String".
    // `gabrielecirulli/2048` is a real repository, and the failure mode was
    // silent: first poll fails, no state row is written, the UI stays green.
    runStatusProbe.mockResolvedValue(
      probeResult({
        stdout: ghGraphqlEnvelope([]),
      }),
    )

    await listOpenRequests('gh', 'gabrielecirulli/2048')

    const args = runStatusProbe.mock.calls[0][1] as string[]
    // The string variables must use -f; only `first` may use -F.
    expect(args[args.indexOf('name=2048') - 1]).toBe('-f')
    expect(args[args.indexOf('owner=gabrielecirulli') - 1]).toBe('-f')
    expect(args[args.indexOf('first=100') - 1]).toBe('-F')
  })

  it('rejects an array whose elements are not merge requests', async () => {
    // A banner containing its own array (`note: retrying [1,2]`) parses as valid
    // JSON and passes an `Array.isArray` check, but normalises to entries with
    // no number — which the diff reads as every tracked request having closed.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: 'note: retrying [1,2]' }))

    await expect(listOpenRequests('glab', 'group/repo')).rejects.toMatchObject({ kind: 'failed' })
  })

  it('rejects a GitHub project that is not owner/repo', async () => {
    await expect(listOpenRequests('gh', 'just-a-name')).rejects.toMatchObject({ kind: 'failed' })
    expect(runStatusProbe).not.toHaveBeenCalled()
  })

  it('throws rather than returning empty when the CLI is missing', async () => {
    runStatusProbe.mockResolvedValue(probeResult({ notFound: true }))

    await expect(listOpenRequests('gh', 'owner/repo')).rejects.toMatchObject({
      kind: 'not_installed',
    })
  })

  it('throws on timeout', async () => {
    runStatusProbe.mockResolvedValue(probeResult({ timedOut: true }))

    await expect(listOpenRequests('glab', 'group/repo')).rejects.toMatchObject({ kind: 'failed' })
  })
})

describe('listOpenRequests — listing completeness', () => {
  it('reports a short page as complete', async () => {
    runStatusProbe.mockResolvedValue(
      probeResult({ stdout: JSON.stringify([{ iid: 1, sha: 'a', title: 't' }]) }),
    )

    const result = await listOpenRequests('glab', 'group/repo')
    expect(result.requests).toHaveLength(1)
    expect(result.complete).toBe(true)
  })

  it('reports an empty page as complete', async () => {
    // A genuinely empty repository must still allow closed-detection, otherwise
    // closing the last open request would never be reported.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: '[]' }))

    const result = await listOpenRequests('glab', 'group/repo')
    expect(result.complete).toBe(true)
  })

  it('reports a full page as possibly truncated, without paging a project', async () => {
    // 100 is the forges' page cap, so exactly 100 means "there may be more" —
    // and absence from a truncated page must not be read as closure.
    //
    // A single project deliberately does NOT page past it. One repository with
    // more than a page of open merge requests is pathological, and paying the
    // extra calls on every ordinary repository to cover it would tax the common
    // case for the rare one; suspending closure inference already handles it.
    const full = Array.from({ length: 100 }, (_, i) => ({ iid: i + 1, sha: 'a', title: 't' }))
    runStatusProbe.mockResolvedValue(probeResult({ stdout: JSON.stringify(full) }))

    const result = await listOpenRequests('glab', 'group/repo')
    expect(result.requests).toHaveLength(100)
    expect(result.complete).toBe(false)
    expect(runStatusProbe).toHaveBeenCalledTimes(1)
  })
})

describe('listOpenRequests — wide scopes', () => {
  /** A page of `count` requests, numbered from `start`, each in its own repo. */
  function page(start: number, count: number) {
    return Array.from({ length: count }, (_, i) => ({
      iid: start + i,
      sha: 'a',
      title: 't',
      references: { full: `group/repo-${start + i}!${start + i}` },
    }))
  }

  it('follows pages until the group is exhausted', async () => {
    // A namespace's size is a property of the organisation, not the config, so a
    // group listing must page — otherwise the least recently updated requests
    // are invisible and closure can never be proven for the group at all.
    runStatusProbe
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify(page(1, 100)) }))
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify(page(101, 57)) }))

    const result = await listOpenRequests('glab', 'acme', undefined, 'group')
    expect(result.requests).toHaveLength(157)
    expect(result.complete).toBe(true)
    expect(runStatusProbe).toHaveBeenCalledTimes(2)
  })

  it('spends a caller-supplied page budget and reports what is left', async () => {
    // The per-entry cap and the entry cap would otherwise multiply: five group
    // entries at five pages each is 25 serial CLI calls, ~500s against a 30s
    // minimum interval — silently invalidating the worst-case tick that
    // GIT_TRIGGER_MAX_REPOS was chosen to satisfy.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: JSON.stringify(page(1, 100)) }))

    const result = await listOpenRequests('glab', 'acme', undefined, 'group', 2)
    expect(runStatusProbe).toHaveBeenCalledTimes(2)
    expect(result.complete).toBe(false)
    expect(result.pagesFetched).toBe(2)
  })

  it('reports pages fetched so the caller can charge the tick budget', async () => {
    runStatusProbe.mockResolvedValueOnce(probeResult({ stdout: JSON.stringify(page(1, 3)) }))

    const result = await listOpenRequests('glab', 'acme', undefined, 'group')
    expect(result.pagesFetched).toBe(1)
    expect(result.complete).toBe(true)
  })

  it('stops at the page budget and reports the listing incomplete', async () => {
    // Beyond the budget the open set is unproven, so `closed` must not fire on
    // absence. Reporting incomplete is what makes the diff suspend it.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: JSON.stringify(page(1, 100)) }))

    const result = await listOpenRequests('glab', 'acme', undefined, 'group')
    expect(result.complete).toBe(false)
    expect(runStatusProbe).toHaveBeenCalledTimes(GIT_TRIGGER_MAX_PAGES)
  })

  it('asks for the group collection rather than a project', async () => {
    runStatusProbe.mockResolvedValue(probeResult({ stdout: '[]' }))

    await listOpenRequests('glab', 'acme/platform', undefined, 'group')
    const [, argv] = runStatusProbe.mock.calls[0] as [string, string[]]
    expect(argv[1]).toContain('groups/acme%2Fplatform/merge_requests')
  })

  it('leaves the project unset under the project scope, even though GitLab sends it', async () => {
    // GitLab returns `references` on the PROJECT listing too, not only the group
    // one. Attaching it unconditionally re-keyed every single-repository entry
    // from `42` to `group/repo!42`, so the first poll after an upgrade matched
    // none of the fingerprints written before it: every open request fired
    // `opened` and every stored key fired `closed`. That is precisely the
    // migration break `repoStateKey` is written to avoid, undone one layer down.
    runStatusProbe.mockResolvedValue(
      probeResult({
        stdout: JSON.stringify([
          { iid: 42, sha: 'a', title: 't', references: { full: 'group/repo!42' } },
        ]),
      }),
    )

    const result = await listOpenRequests('glab', 'group/repo')
    expect(result.requests[0].project).toBeUndefined()
  })

  it('carries each request back with its own repository path', async () => {
    // Under a group scope the entry names a namespace, so the per-request path
    // is the only thing that can tell the Agent where to act.
    runStatusProbe.mockResolvedValue(probeResult({ stdout: JSON.stringify(page(42, 1)) }))

    const result = await listOpenRequests('glab', 'group', undefined, 'group')
    expect(result.requests[0].project).toBe('group/repo-42')
  })

  it('reads the GitHub GraphQL envelope', async () => {
    const nodes = [{ number: 7, headRefOid: 'abc', title: 't', headRefName: 'feat' }]
    runStatusProbe.mockResolvedValue(
      probeResult({
        stdout: ghGraphqlEnvelope(nodes),
      }),
    )

    const result = await listOpenRequests('gh', 'owner/repo')
    expect(result.requests).toEqual([
      expect.objectContaining({ number: 7, sha: 'abc', sourceBranch: 'feat' }),
    ])
    expect(result.complete).toBe(true)
  })
})
