import { execFile } from 'node:child_process'
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Holds the `rm` that run-end cleanup issues, so a sibling run's sync can be
 * driven into the window the cleanup is mid-flight. Null outside that one test,
 * where every call passes straight through to the real fs.
 */
const rmGate = vi.hoisted(() => ({ current: null as Promise<void> | null }))

/**
 * Holds the FIRST write to an `info/exclude`, so a second sync can be driven
 * into the window between one sync's read of that file and its write back.
 */
const excludeWriteGate = vi.hoisted(() => ({ current: null as Promise<void> | null }))

/** Counts reads of an `info/exclude`, so the race can be sequenced on the real event. */
const excludeReads = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (rmGate.current) await rmGate.current
      return actual.rm(...args)
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (String(args[0]).endsWith('info/exclude')) excludeReads.count++
      return actual.readFile(...args)
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const gate = excludeWriteGate.current
      if (gate && String(args[0]).endsWith('info/exclude')) {
        excludeWriteGate.current = null
        await gate
      }
      return actual.writeFile(...args)
    },
  }
})

import { processInstanceId } from '../../lib/process-instance.js'
import type { ResolvedMcpServer } from '../mcp-sync.js'
import {
  cleanupManagedMcpConfigAsync,
  isPathTrackedByGit,
  syncMcpToWorkspaceAtPathAsync,
} from '../mcp-sync.js'

const execFileAsync = promisify(execFile)

const RELATIVE = '.cursor/mcp.json'
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-async-test-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function readConfig() {
  return JSON.parse(readFileSync(path.join(tmp, RELATIVE), 'utf-8'))
}

function readMarker() {
  return JSON.parse(readFileSync(path.join(tmp, `${RELATIVE}.a2wave-managed`), 'utf-8'))
}

const stdio = (
  name: string,
  command = 'node',
  extras: Partial<ResolvedMcpServer> = {},
): ResolvedMcpServer => ({
  name,
  type: 'stdio',
  command,
  args: ['x'],
  ...extras,
})

describe('syncMcpToWorkspaceAtPathAsync — kimi dialect', () => {
  const KIMI_RELATIVE = '.kimi-code/mcp.json'

  function readKimiConfig() {
    return JSON.parse(readFileSync(path.join(tmp, KIMI_RELATIVE), 'utf-8'))
  }

  it('marks sse servers with transport so kimi does not read them as http', async () => {
    await syncMcpToWorkspaceAtPathAsync(
      tmp,
      KIMI_RELATIVE,
      [{ name: 'legacy', type: 'sse', url: 'https://mcp.example.com/sse' }],
      { dialect: 'kimi' },
    )

    expect(readKimiConfig().mcpServers.legacy).toEqual({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
    })
  })

  it('uses transport rather than type for http servers', async () => {
    await syncMcpToWorkspaceAtPathAsync(
      tmp,
      KIMI_RELATIVE,
      [{ name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp' }],
      { dialect: 'kimi' },
    )

    const entry = readKimiConfig().mcpServers.remote
    expect(entry).toEqual({ transport: 'http', url: 'https://mcp.example.com/mcp' })
    expect(entry.type).toBeUndefined()
  })

  it('leaves stdio entries in the shared shape', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, KIMI_RELATIVE, [stdio('local')], { dialect: 'kimi' })

    expect(readKimiConfig().mcpServers.local).toEqual({ command: 'node', args: ['x'] })
  })

  it('keeps the default dialect byte-identical for other providers', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [
      { name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp' },
      { name: 'legacy', type: 'sse', url: 'https://mcp.example.com/sse' },
    ])

    expect(readConfig().mcpServers).toEqual({
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      legacy: { url: 'https://mcp.example.com/sse' },
    })
  })
})

describe('syncMcpToWorkspaceAtPathAsync', () => {
  // Ported from the deleted synchronous twin's suite: these two were its only
  // assertions for behaviour that still lives in the shared async writer.
  it('writes an empty mcpServers object when there are no servers', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [])

    expect(readConfig()).toEqual({ mcpServers: {} })
  })

  it('honours a custom target path such as Claude/Qoder .mcp.json', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, '.mcp.json', [
      { name: 'claude-mcp', type: 'stdio', command: 'npx', args: ['-y', '@acme/mcp'] },
    ])

    const config = JSON.parse(readFileSync(path.join(tmp, '.mcp.json'), 'utf-8'))
    expect(config).toEqual({
      mcpServers: { 'claude-mcp': { command: 'npx', args: ['-y', '@acme/mcp'] } },
    })
  })

  it('writes a fresh mcp.json with managed entries', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1'), stdio('s2', 'python')])
    const cfg = readConfig()
    expect(cfg.mcpServers.s1).toEqual({ command: 'node', args: ['x'] })
    expect(cfg.mcpServers.s2).toEqual({ command: 'python', args: ['x'] })
    expect(readMarker().managedServers).toHaveProperty('s1')
  })

  it('keeps a user-edited managed entry intact on resync (fingerprint mismatch)', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1')])
    const cfg = readConfig()
    cfg.mcpServers.s1.command = 'edited-by-user'
    writeFileSync(path.join(tmp, RELATIVE), JSON.stringify(cfg))

    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1', 'fresh')])
    const after = readConfig()
    expect(after.mcpServers.s1).toEqual({ command: 'edited-by-user', args: ['x'] })
    expect(after.mcpServers['s1--a2w']).toEqual({ command: 'fresh', args: ['x'] })
  })

  it('replaces managed entry cleanly when fingerprint matches', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1')])
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1', 'updated')])
    const after = readConfig()
    expect(Object.keys(after.mcpServers)).toEqual(['s1'])
    expect(after.mcpServers.s1).toEqual({ command: 'updated', args: ['x'] })
  })

  it('respects user-owned entry by renaming the new managed copy to --a2w', async () => {
    mkdirSync(path.join(tmp, '.cursor'), { recursive: true })
    writeFileSync(
      path.join(tmp, RELATIVE),
      JSON.stringify({ mcpServers: { s1: { command: 'user-cmd', args: [] } } }),
    )
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1')])
    const cfg = readConfig()
    expect(cfg.mcpServers.s1).toEqual({ command: 'user-cmd', args: [] })
    expect(cfg.mcpServers['s1--a2w']).toEqual({ command: 'node', args: ['x'] })
  })

  it('emits sse and http entries with their url/headers and drops invalid ones', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [
      { name: 'sse-srv', type: 'sse', url: 'https://x.example/sse', headers: { 'X-A': '1' } },
      { name: 'http-srv', type: 'http', url: 'https://x.example/http' },
      { name: 'no-cmd', type: 'stdio' },
      { name: 'no-url', type: 'sse' },
    ])
    const cfg = readConfig()
    expect(cfg.mcpServers['sse-srv']).toEqual({
      url: 'https://x.example/sse',
      headers: { 'X-A': '1' },
    })
    expect(cfg.mcpServers['http-srv']).toEqual({
      type: 'http',
      url: 'https://x.example/http',
    })
    expect(cfg.mcpServers).not.toHaveProperty('no-cmd')
    expect(cfg.mcpServers).not.toHaveProperty('no-url')
  })

  it('survives an existing mcp.json that is not valid JSON', async () => {
    mkdirSync(path.join(tmp, '.cursor'), { recursive: true })
    writeFileSync(path.join(tmp, RELATIVE), '{not json')
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('ok')])
    const cfg = readConfig()
    expect(cfg.mcpServers.ok).toEqual({ command: 'node', args: ['x'] })
  })

  it('includes trimmed cwd and env when present', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [
      stdio('s', 'node', { cwd: '   /work   ', env: { TOKEN: 'x' } }),
    ])
    const cfg = readConfig()
    expect(cfg.mcpServers.s).toEqual({
      command: 'node',
      args: ['x'],
      cwd: '/work',
      env: { TOKEN: 'x' },
    })
  })
})

describe('cleanupManagedMcpConfigAsync', () => {
  const configPath = () => path.join(tmp, RELATIVE)
  const markerPath = () => `${path.join(tmp, RELATIVE)}.a2wave-managed`

  /** Resolves as soon as `name` is on disk, or after `budgetMs` if it never is. */
  async function waitForServerEntry(name: string, budgetMs: number) {
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (existsSync(configPath()) && name in (readConfig().mcpServers ?? {})) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  it('removes a config file the platform created, secrets and marker included', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [
      {
        name: 'api',
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer secret-token' },
      },
    ])
    expect(readFileSync(configPath(), 'utf-8')).toContain('secret-token')

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    expect(existsSync(configPath())).toBe(false)
    expect(existsSync(markerPath())).toBe(false)
  })

  it('keeps a user-authored config file and strips only managed entries', async () => {
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(
      configPath(),
      JSON.stringify({ mcpServers: { mine: { command: 'mine' } }, other: true }),
    )

    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])
    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    expect(existsSync(configPath())).toBe(true)
    expect(readConfig()).toEqual({ mcpServers: { mine: { command: 'mine' } }, other: true })
    expect(existsSync(markerPath())).toBe(false)
  })

  it('never touches a config file that predates the run (no marker)', async () => {
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }))

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    expect(readConfig()).toEqual({ mcpServers: { mine: { command: 'mine' } } })
  })

  it('keeps the config alive until the last sibling run in the workspace releases it', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)
    expect(existsSync(configPath())).toBe(true)

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)
    expect(existsSync(configPath())).toBe(false)
  })

  it('is a no-op when nothing was ever written', async () => {
    await expect(cleanupManagedMcpConfigAsync(tmp, RELATIVE)).resolves.toBeUndefined()
  })

  it('does not delete a config a sibling run wrote while the cleanup was in flight', async () => {
    // Same-Agent runs share one worktree (maxConcurrency >= 2), so run B's sync
    // can land while run A's cleanup sits between releasing the reference and
    // touching the file. A must not resume with its stale snapshot and remove
    // the config B is about to execute against.
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('from-a')])

    let releaseRm = () => {}
    rmGate.current = new Promise<void>((resolve) => {
      releaseRm = resolve
    })

    const cleanupA = cleanupManagedMcpConfigAsync(tmp, RELATIVE)
    const syncB = syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('from-b')])
    // Serialised, B cannot write until A's cleanup completes, so this waits out
    // its budget; unserialised, B's write lands inside A's window.
    await waitForServerEntry('from-b', 200)
    releaseRm()
    rmGate.current = null
    await Promise.all([cleanupA, syncB])

    expect(existsSync(configPath())).toBe(true)
    expect(readConfig().mcpServers).toHaveProperty('from-b')

    // B held the only remaining reference; releasing it clears the workspace.
    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)
    expect(existsSync(configPath())).toBe(false)
  })
})

describe('cleanupManagedMcpConfigAsync — cross-replica ownership', () => {
  const configPath = () => path.join(tmp, RELATIVE)
  const markerPath = () => `${path.join(tmp, RELATIVE)}.a2wave-managed`

  /** Rewrite the marker the way a peer replica's own sync would. */
  function markerWrittenByPeer(instanceId: string) {
    const marker = readMarker()
    writeFileSync(markerPath(), JSON.stringify({ ...marker, ownerInstanceId: instanceId }))
  }

  it('stamps the writing instance on the marker', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])

    expect(readMarker().ownerInstanceId).toBe(processInstanceId)
  })

  it('never removes a config the peer replica re-synced', async () => {
    // Two API replicas share one workspace volume, and a per-Agent worktree is
    // reused by every run of that Agent, so this replica's refcount can read
    // "last one out" while the peer's run still executes against the file the
    // peer wrote.
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])
    markerWrittenByPeer('peer-replica')

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    expect(existsSync(configPath())).toBe(true)
    expect(readConfig().mcpServers).toHaveProperty('managed')
    // The peer's marker must survive too: dropping it would leave a credential
    // file that no later cleanup is allowed to touch.
    expect(existsSync(markerPath())).toBe(true)
    expect(readMarker().ownerInstanceId).toBe('peer-replica')
  })

  it('lets the next run on this replica reclaim a config a lost race left behind', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])
    markerWrittenByPeer('peer-replica')
    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])
    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    expect(existsSync(configPath())).toBe(false)
    expect(existsSync(markerPath())).toBe(false)
  })

  it('still cleans up a marker written before instance stamping existed', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])
    const { ownerInstanceId: _dropped, ...legacyMarker } = readMarker()
    writeFileSync(markerPath(), JSON.stringify(legacyMarker))

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    expect(existsSync(configPath())).toBe(false)
    expect(existsSync(markerPath())).toBe(false)
  })
})

describe('syncMcpToWorkspaceAtPathAsync — repository-tracked config files', () => {
  /**
   * `.git/info/exclude` (see `ensurePlatformPathsExcluded`) only ever applies to
   * UNTRACKED files. A repository that legitimately commits its own MCP config
   * — teams share non-secret server definitions that way — gets no cover from
   * it: the platform's write lands as a modification to a tracked file, so
   * `git add -A` stages the resolved bearer tokens and stdio API keys and the
   * next "commit and push my changes" ships the MCP owner's credentials.
   */
  let repo: string

  async function runGit(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: repo })
    return stdout
  }

  async function trackFile(relative: string, contents: string): Promise<void> {
    mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true })
    writeFileSync(path.join(repo, relative), contents)
    await runGit('add', '--', relative)
    await runGit('commit', '-m', `track ${relative}`)
  }

  const secretServer: ResolvedMcpServer = {
    name: 'api',
    type: 'http',
    url: 'https://mcp.example.com',
    headers: { Authorization: 'Bearer tracked-secret-token' },
  }

  beforeEach(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-tracked-test-'))
    await runGit('init', '-b', 'main')
    await runGit('config', 'user.email', 'test@test.com')
    await runGit('config', 'user.name', 'Test')
    writeFileSync(path.join(repo, 'README.md'), '# repo')
    await runGit('add', '.')
    await runGit('commit', '-m', 'init')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  for (const relative of ['.mcp.json', '.cursor/mcp.json']) {
    it(`refuses to write credentials into a tracked ${relative}`, async () => {
      const committed = '{"mcpServers":{"team":{"command":"node","args":["team.js"]}}}'
      await trackFile(relative, committed)

      await expect(syncMcpToWorkspaceAtPathAsync(repo, relative, [secretServer])).rejects.toThrow(
        relative,
      )

      // The committed content is untouched and nothing is staged for commit.
      expect(readFileSync(path.join(repo, relative), 'utf-8')).toBe(committed)
      expect(await runGit('status', '--porcelain')).toBe('')
      await runGit('add', '-A')
      expect(await runGit('diff', '--cached')).toBe('')
      expect(existsSync(path.join(repo, `${relative}.a2wave-managed`))).toBe(false)
    })
  }

  it('names the tracked file and how to untrack it in the error', async () => {
    await trackFile('.mcp.json', '{}')

    await expect(syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer])).rejects.toThrow(
      /git rm --cached/,
    )
  })

  it('leaves a tracked config alone rather than failing when there is nothing to inject', async () => {
    const committed = '{"mcpServers":{}}'
    await trackFile('.mcp.json', committed)

    await expect(syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [])).resolves.toBe(false)

    expect(readFileSync(path.join(repo, '.mcp.json'), 'utf-8')).toBe(committed)
    expect(await runGit('status', '--porcelain')).toBe('')
  })

  it('still writes and takes a reference when the repository does not track the file', async () => {
    expect(await syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer])).toBe(true)

    expect(readFileSync(path.join(repo, '.mcp.json'), 'utf-8')).toContain('tracked-secret-token')
  })

  it('reports tracked, untracked and non-repository paths', async () => {
    await trackFile('.mcp.json', '{}')
    writeFileSync(path.join(repo, 'untracked.json'), '{}')

    expect(await isPathTrackedByGit(repo, '.mcp.json')).toBe(true)
    expect(await isPathTrackedByGit(repo, 'untracked.json')).toBe(false)
    expect(await isPathTrackedByGit(repo, 'never-existed.json')).toBe(false)
    // `tmp` is a bare temp directory, not a checkout.
    expect(await isPathTrackedByGit(tmp, '.mcp.json')).toBe(false)
  })

  it('writes as usual outside a git repository', async () => {
    expect(await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [secretServer])).toBe(true)

    expect(readConfig().mcpServers.api.headers.Authorization).toBe('Bearer tracked-secret-token')
  })
})

/**
 * Whether the filesystem backing the temp directory folds case — the macOS and
 * Windows default, and the reason an exact `git ls-files` query is not enough:
 * git matches pathnames case-sensitively, the filesystem does not.
 *
 * Probed rather than inferred from `process.platform`: a case-sensitive APFS
 * volume and a case-insensitive Linux mount both exist.
 */
function detectCaseInsensitiveFs(): boolean {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-case-probe-'))
  try {
    writeFileSync(path.join(probe, 'a'), '')
    statSync(path.join(probe, 'A'))
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

const CASE_INSENSITIVE_FS = detectCaseInsensitiveFs()

/**
 * The refusal has to be decided against the file the write actually lands on,
 * not the pathname string it was asked about. Case folding and symlinks both
 * make "the repository does not track `.mcp.json`" true while the write still
 * modifies a tracked file — and each one reproduces the original leak in full.
 */
describe('syncMcpToWorkspaceAtPathAsync — target identity, not pathname', () => {
  let repo: string
  let outside: string

  async function runGit(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: repo })
    return stdout
  }

  async function trackFile(relative: string, contents: string): Promise<void> {
    mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true })
    writeFileSync(path.join(repo, relative), contents)
    await runGit('add', '--', relative)
    await runGit('commit', '-m', `track ${relative}`)
  }

  const secretServer: ResolvedMcpServer = {
    name: 'api',
    type: 'http',
    url: 'https://mcp.example.com',
    headers: { Authorization: 'Bearer resolved-secret-token' },
  }

  beforeEach(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-identity-test-'))
    outside = mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-outside-test-'))
    await runGit('init', '-b', 'main')
    await runGit('config', 'user.email', 'test@test.com')
    await runGit('config', 'user.name', 'Test')
    writeFileSync(path.join(repo, 'README.md'), '# repo')
    await runGit('add', '.')
    await runGit('commit', '-m', 'init')
  })

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it.skipIf(!CASE_INSENSITIVE_FS)(
    'refuses when the tracked pathname differs only in case (case-insensitive filesystem only)',
    async () => {
      const committed = '{"mcpServers":{"team":{"command":"node","args":["team.js"]}}}'
      await trackFile('.MCP.JSON', committed)

      await expect(
        syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer]),
      ).rejects.toThrow(/git rm --cached/)

      // Same inode: a write to `.mcp.json` would have landed as a modification
      // to the tracked `.MCP.JSON`.
      expect(readFileSync(path.join(repo, '.MCP.JSON'), 'utf-8')).toBe(committed)
      expect(await runGit('status', '--short')).toBe('')
      await runGit('add', '-A')
      expect(await runGit('diff', '--cached')).toBe('')
    },
  )

  it('refuses when an untracked symlink points at a tracked file', async () => {
    const committed = '{"mcpServers":{"team":{"command":"node","args":["team.js"]}}}'
    await trackFile('config/team-mcp.json', committed)
    symlinkSync(path.join('config', 'team-mcp.json'), path.join(repo, '.mcp.json'))

    await expect(syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer])).rejects.toThrow(
      /git rm --cached/,
    )

    expect(readFileSync(path.join(repo, 'config/team-mcp.json'), 'utf-8')).toBe(committed)
    expect(await runGit('status', '--short', '--', 'config')).toBe('')
  })

  it('refuses when a parent directory is a symlink into a tracked directory', async () => {
    const committed = '{"mcpServers":{"team":{"command":"node","args":["team.js"]}}}'
    await trackFile('shared/mcp.json', committed)
    symlinkSync('shared', path.join(repo, '.cursor'))

    await expect(
      syncMcpToWorkspaceAtPathAsync(repo, '.cursor/mcp.json', [secretServer]),
    ).rejects.toThrow(/git rm --cached/)

    expect(readFileSync(path.join(repo, 'shared/mcp.json'), 'utf-8')).toBe(committed)
    expect(await runGit('status', '--short', '--', 'shared')).toBe('')
  })

  it('refuses when the resolved target escapes the work tree entirely', async () => {
    const foreign = path.join(outside, 'team-mcp.json')
    writeFileSync(foreign, '{}')
    symlinkSync(foreign, path.join(repo, '.mcp.json'))

    await expect(syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer])).rejects.toThrow(
      /outside/i,
    )

    expect(readFileSync(foreign, 'utf-8')).toBe('{}')
  })

  it('still writes when a symlink resolves to an untracked file in the work tree', async () => {
    mkdirSync(path.join(repo, 'config'))
    writeFileSync(path.join(repo, 'config/local-mcp.json'), '{}')
    symlinkSync(path.join('config', 'local-mcp.json'), path.join(repo, '.mcp.json'))

    expect(await syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer])).toBe(true)

    expect(readFileSync(path.join(repo, 'config/local-mcp.json'), 'utf-8')).toContain(
      'resolved-secret-token',
    )
    // The exclude entry only ever named `.mcp.json`; the credentials landed in
    // `config/local-mcp.json`, so that file is what `git add -A` would stage.
    await runGit('add', '-A')
    expect(await runGit('diff', '--cached')).toBe('')
  })

  it('refuses when the resolved target cannot be kept out of the index', async () => {
    mkdirSync(path.join(repo, 'config'))
    // A negated ignore rule beats `info/exclude`, so the resolved target cannot
    // be excluded and the write has nowhere safe to land.
    await trackFile('.gitignore', '!config/local-mcp.json\n')
    symlinkSync(path.join('config', 'local-mcp.json'), path.join(repo, '.mcp.json'))

    await expect(syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer])).rejects.toThrow(
      /config\/local-mcp\.json/,
    )

    expect(existsSync(path.join(repo, 'config/local-mcp.json'))).toBe(false)
  })

  /**
   * A hardlink gives one inode two pathnames, neither of which is a symlink and
   * neither of which shares the other's basename — so a directory listing
   * filtered by name never even compares them. Writing in place through one
   * name modifies the tracked file behind the other.
   */
  it('never modifies a tracked file hardlinked to the target', async () => {
    const committed = '{"mcpServers":{"team":{"command":"node","args":["team.js"]}}}'
    await trackFile('config/team-mcp.json', committed)
    linkSync(path.join(repo, 'config/team-mcp.json'), path.join(repo, '.mcp.json'))

    await syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer])

    expect(readFileSync(path.join(repo, 'config/team-mcp.json'), 'utf-8')).toBe(committed)
    await runGit('add', '-A')
    expect(await runGit('diff', '--cached')).toBe('')
  })
})

/**
 * A multi-repo workspace root is not itself a checkout: `git rev-parse` fails
 * there. That says nothing about where the write lands — a config path that
 * resolves into one of the sub-repositories is as committable as any other
 * tracked file, so the question has to be asked of the repository owning the
 * RESOLVED target, not of the workspace root.
 */
describe('syncMcpToWorkspaceAtPathAsync — multi-repo workspace root', () => {
  let workspace: string
  let frontend: string

  async function runGit(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: frontend })
    return stdout
  }

  const secretServer: ResolvedMcpServer = {
    name: 'api',
    type: 'http',
    url: 'https://mcp.example.com',
    headers: { Authorization: 'Bearer multi-repo-secret-token' },
  }

  beforeEach(async () => {
    workspace = mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-multirepo-test-'))
    frontend = path.join(workspace, 'frontend')
    mkdirSync(frontend)
    await runGit('init', '-b', 'main')
    await runGit('config', 'user.email', 'test@test.com')
    await runGit('config', 'user.name', 'Test')
    writeFileSync(path.join(frontend, 'README.md'), '# frontend')
    await runGit('add', '.')
    await runGit('commit', '-m', 'init')
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  it('refuses when the root config resolves into a file a sub-repository tracks', async () => {
    const committed = '{"mcpServers":{"team":{"command":"node","args":["team.js"]}}}'
    writeFileSync(path.join(frontend, 'team-mcp.json'), committed)
    await runGit('add', '--', 'team-mcp.json')
    await runGit('commit', '-m', 'track team-mcp.json')
    symlinkSync(path.join('frontend', 'team-mcp.json'), path.join(workspace, '.mcp.json'))

    await expect(
      syncMcpToWorkspaceAtPathAsync(workspace, '.mcp.json', [secretServer]),
    ).rejects.toThrow(/git rm --cached/)

    expect(readFileSync(path.join(frontend, 'team-mcp.json'), 'utf-8')).toBe(committed)
    expect(await runGit('status', '--porcelain')).toBe('')
  })

  it('keeps an untracked sub-repository target out of the sub-repository index', async () => {
    symlinkSync(path.join('frontend', 'local-mcp.json'), path.join(workspace, '.mcp.json'))

    expect(await syncMcpToWorkspaceAtPathAsync(workspace, '.mcp.json', [secretServer])).toBe(true)

    expect(readFileSync(path.join(frontend, 'local-mcp.json'), 'utf-8')).toContain(
      'multi-repo-secret-token',
    )
    await runGit('add', '-A')
    expect(await runGit('diff', '--cached')).toBe('')
  })
})

/**
 * Everything the exclusion guarantee still has to survive once the repository
 * is not the simple case: a linked worktree (the layout a2wave itself runs
 * every Agent in), two syncs racing for the same `info/exclude`, a symlink the
 * cleanup has to follow, and a marker write that fails after the config is
 * already on disk.
 */
describe('syncMcpToWorkspaceAtPathAsync — keeping the exclusion guarantee', () => {
  let root: string
  let repo: string

  const secretServer: ResolvedMcpServer = {
    name: 'api',
    type: 'http',
    url: 'https://mcp.example.com',
    headers: { Authorization: 'Bearer exclusion-secret-token' },
  }

  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd })
    return stdout
  }

  beforeEach(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-exclude-test-'))
    repo = path.join(root, 'repo')
    mkdirSync(repo)
    await git(repo, 'init', '-b', 'main')
    await git(repo, 'config', 'user.email', 'test@test.com')
    await git(repo, 'config', 'user.name', 'Test')
    writeFileSync(path.join(repo, 'README.md'), '# repo')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-m', 'init')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * In a linked worktree `git rev-parse --git-path info/exclude` answers with an
   * ABSOLUTE path into the main repository's `.git` — joining it onto the work
   * tree builds a nonsense path, writes the rule where nothing reads it, and
   * then refuses the run. Per-Agent worktrees are how a2wave executes, so this
   * is the ordinary case, not the exotic one.
   */
  it('excludes through a linked worktree, whose git-path is absolute', async () => {
    const worktree = path.join(root, 'agent-wt')
    await git(repo, 'worktree', 'add', worktree)

    expect(await syncMcpToWorkspaceAtPathAsync(worktree, '.mcp.json', [secretServer])).toBe(true)

    expect(readFileSync(path.join(worktree, '.mcp.json'), 'utf-8')).toContain(
      'exclusion-secret-token',
    )
    // No stray directory built from the absolute git-path.
    expect(existsSync(path.join(worktree, 'private'))).toBe(false)
    await git(worktree, 'add', '-A')
    expect(await git(worktree, 'diff', '--cached')).toBe('')
  })

  /**
   * `info/exclude` is one file per repository, and every config path in the
   * workspace appends to it. Two syncs read the same "before" content and the
   * later write drops the earlier rule, so a run that already verified its
   * exclusion ends up unprotected.
   */
  it('keeps every rule when two config paths are synced concurrently', async () => {
    // Sequenced on the reads themselves rather than on elapsed time: the racing
    // build reaches every step in milliseconds, and only the serialised build —
    // where B never gets to read — spends a bounded wait.
    async function waitForExcludeReads(count: number, budgetMs: number): Promise<void> {
      const deadline = Date.now() + budgetMs
      while (excludeReads.count < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }

    excludeReads.count = 0
    let releaseExcludeWrite = () => {}
    excludeWriteGate.current = new Promise<void>((resolve) => {
      releaseExcludeWrite = resolve
    })

    // A reads the (empty) exclude file and stalls holding its content.
    const syncA = syncMcpToWorkspaceAtPathAsync(repo, 'a/mcp.json', [secretServer])
    await waitForExcludeReads(1, 5_000)
    // B enters the same read-modify-write. Serialised, it waits for A; racing,
    // it reads the same empty content and its write drops A's rule.
    const syncB = syncMcpToWorkspaceAtPathAsync(repo, 'b/mcp.json', [secretServer])
    await waitForExcludeReads(2, 1_000)
    releaseExcludeWrite()
    excludeWriteGate.current = null
    await Promise.all([syncA, syncB])

    const exclude = readFileSync(path.join(repo, '.git/info/exclude'), 'utf-8')
    for (const rule of [
      '/a/mcp.json',
      '/a/mcp.json.a2wave-managed',
      '/b/mcp.json',
      '/b/mcp.json.a2wave-managed',
    ]) {
      expect(exclude).toContain(`${rule}\n`)
    }
    await git(repo, 'add', '-A')
    expect(await git(repo, 'diff', '--cached')).toBe('')
  })

  /**
   * `fs.rm` on a symlink unlinks the link, not the file behind it. The sync
   * created the resolved target, so cleaning up the pathname it was asked about
   * leaves the plaintext bearer token on disk for the life of the worktree —
   * exactly what run-end cleanup exists to prevent.
   */
  it('removes the file the write created, not the symlink pointing at it', async () => {
    mkdirSync(path.join(repo, 'config'))
    symlinkSync(path.join('config', 'local-mcp.json'), path.join(repo, '.mcp.json'))

    expect(await syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer])).toBe(true)
    expect(readFileSync(path.join(repo, 'config/local-mcp.json'), 'utf-8')).toContain(
      'exclusion-secret-token',
    )

    await cleanupManagedMcpConfigAsync(repo, '.mcp.json')

    expect(existsSync(path.join(repo, 'config/local-mcp.json'))).toBe(false)
    expect(existsSync(path.join(repo, 'config/local-mcp.json.a2wave-managed'))).toBe(false)
  })

  /**
   * The marker is what run-end cleanup reads to know a file is deletable. If
   * the config lands and the marker does not, the sync reports failure, the run
   * never registers a cleanup — and the credentials stay on disk with nothing
   * left that admits to owning them. Nothing written is the only safe outcome.
   */
  it('leaves no config behind when the marker cannot be written', async () => {
    // A directory where the marker file goes: `writeFile` fails with EISDIR.
    mkdirSync(path.join(repo, '.mcp.json.a2wave-managed'))

    await expect(syncMcpToWorkspaceAtPathAsync(repo, '.mcp.json', [secretServer])).rejects.toThrow()

    expect(existsSync(path.join(repo, '.mcp.json'))).toBe(false)
  })
})
