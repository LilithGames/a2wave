import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstallerModule } from '../cli-installer.js'

import { asyncQuery } from '../../test/async-query.js'

/**
 * The installer service is the runtime half of the "image ships no CLI" model, so
 * these tests pin the behaviours that make it safe to expose as a button:
 * install state is probed rather than trusted from the DB, a failed install
 * cleans up after itself, and a crashed install cannot wedge a CLI forever.
 */

// `upsertRow` is async but the claim helpers do not await it, so the row write
// lands a microtask after the call returns.
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

const rows: Array<{
  kind: string
  status: string
  installedVersion: string | null
  lastError: string | null
  lastOutput: string | null
}> = []

const insertValues = vi.fn()
const updateSets: unknown[] = []

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () =>
        asyncQuery({
          all: () => [...rows],
          where: () =>
            asyncQuery({
              all: () =>
                rows.filter((r) => r.status === 'installing' || r.status === 'uninstalling'),
            }),
        }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertValues(v)
        return {
          onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) =>
            asyncQuery({
              run: () => {
                const existing = rows.find((r) => r.kind === v.kind)
                if (existing) Object.assign(existing, set)
                else
                  rows.push({
                    kind: String(v.kind),
                    status: 'idle',
                    installedVersion: null,
                    lastError: null,
                    lastOutput: null,
                    ...(v as object),
                  } as (typeof rows)[number])
              },
            }),
        }
      },
    }),
    update: () => ({
      set: (values: unknown) => {
        updateSets.push(values)
        return {
          where: () =>
            asyncQuery({
              run: () => {
                for (const row of rows.filter(
                  (r) => r.status === 'installing' || r.status === 'uninstalling',
                )) {
                  Object.assign(row, values)
                }
              },
            }),
        }
      },
    }),
  },
}))

vi.mock('../../db/schema.js', () => ({
  cliInstallations: { kind: 'cliInstallations.kind', status: 'cliInstallations.status' },
}))

const probeCliVersion = vi.fn()
vi.mock('../../engine/login-status-helper.js', () => ({
  probeCliVersion: (...args: unknown[]) => probeCliVersion(...args),
}))

vi.mock('../../env.js', () => ({
  env: { A2WAVE_CLI_INSTALL_ROOT: '/tmp/a2wave-cli-root', A2WAVE_CLI_LOCK_DIR: '' },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const installProvider = vi.fn()
const uninstallProvider = vi.fn()
const LOCK = {
  // A non-Provider tool is included on purpose: CodeGraph is removed from the
  // image with the rest, so it has to be installable through the same path.
  tools: [
    {
      kind: 'codegraph',
      version: '1.1.0',
      binary: 'codegraph',
      versionArgs: ['--version'],
      expectedVersionOutput: '1.1.0',
      install: {
        type: 'npm' as const,
        package: '@colbymchenry/codegraph',
        tarball: 'https://registry.npmjs.org/@colbymchenry/codegraph/-/codegraph-1.1.0.tgz',
        integrity: 'sha512-test',
        allowScripts: false,
      },
    },
  ],
  providers: [
    {
      kind: 'claude-code',
      version: '2.1.212',
      binary: 'claude',
      versionArgs: ['--version'],
      expectedVersionOutput: '2.1.212',
      install: {
        type: 'npm' as const,
        package: '@anthropic-ai/claude-code',
        tarball: 'https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.212.tgz',
        integrity: 'sha512-test',
        allowScripts: true,
      },
    },
  ],
}

const {
  CliInstallError,
  installCli,
  listInstallStates,
  recoverInterruptedInstalls,
  resolveInstallRoot,
  uninstallCli,
  _resetCliInstallerCaches,
  _setInstallerForTest,
  claimInstallSlot,
  ensureLockLoaded,
  claimUninstallSlot,
  versionOutputMatches,
  ensureInstallRootOnPath,
} = await import('../cli-installer.js')

beforeEach(async () => {
  rows.length = 0
  updateSets.length = 0
  insertValues.mockReset()
  installProvider.mockReset()
  uninstallProvider.mockReset()
  probeCliVersion.mockReset()
  _resetCliInstallerCaches()
  _setInstallerForTest({
    loadAndValidateLock: () => LOCK,
    allLockEntries: (lock) => [...lock.providers, ...(lock.tools ?? [])],
    installProviderAsync: async (...args: Parameters<InstallerModule['installProviderAsync']>) =>
      installProvider(...args),
    uninstallProviderAsync: async (
      ...args: Parameters<InstallerModule['uninstallProviderAsync']>
    ) => uninstallProvider(...args),
  })
  // claimInstallSlot is deliberately synchronous, so it reads an already-loaded
  // lock rather than awaiting one; prime it the way the route does.
  await ensureLockLoaded()
})

describe('install state', () => {
  it('reports not-installed when the binary does not resolve on PATH', async () => {
    probeCliVersion.mockResolvedValue(null)

    const [state] = await listInstallStates()

    expect(state.installed).toBe(false)
    expect(state.installedVersion).toBeNull()
    // Null rather than false: "does the build match the lock" is unanswerable
    // when nothing is installed, and false would render as a spurious mismatch.
    expect(state.matchesLock).toBeNull()
  })

  it('flags a version that no longer matches the lock as a mismatch', async () => {
    probeCliVersion.mockResolvedValue('2.0.1')

    const [state] = await listInstallStates()

    expect(state.installed).toBe(true)
    expect(state.matchesLock).toBe(false)
  })

  it('treats a version line containing the locked version as a match', async () => {
    // Some CLIs print extra tokens, e.g. "codex-cli 0.144.5".
    probeCliVersion.mockResolvedValue('claude 2.1.212 (build abc)')

    const [state] = await listInstallStates()

    expect(state.matchesLock).toBe(true)
    expect(state.lockDrift).toBe('match')
  })

  /**
   * The lock pins an exact version, but a mismatch was previously reported as a
   * single boolean and rendered as "updatable". A build *newer* than the pin then
   * read as out of date, and the offered "update" silently downgraded it — while
   * the engine, which gates on the separate minVersion floor, ran it happily.
   * Direction is therefore part of the state, not something the UI can infer.
   */
  describe('lock drift direction', () => {
    it('reports no drift direction when nothing is installed', async () => {
      probeCliVersion.mockResolvedValue(null)

      const [state] = await listInstallStates()

      expect(state.lockDrift).toBeNull()
    })

    it('flags a build older than the pin as below it', async () => {
      probeCliVersion.mockResolvedValue('2.0.1')

      const [state] = await listInstallStates()

      expect(state.matchesLock).toBe(false)
      expect(state.lockDrift).toBe('below')
    })

    it('flags a build newer than the pin as above it, not as outdated', async () => {
      // The regression: 2.1.300 > the pinned 2.1.212, so offering an "update"
      // here would downgrade a CLI that satisfies every requirement it has.
      probeCliVersion.mockResolvedValue('2.1.300')

      const [state] = await listInstallStates()

      expect(state.matchesLock).toBe(false)
      expect(state.lockDrift).toBe('above')
    })

    /**
     * `isVersionAtLeast` compares only the leading numeric run, so a build
     * suffix (cursor pins `2026.07.16-899851b`) is invisible to it. Two builds
     * of the same date then compare equal, and "equal but not a match" was
     * being reported as 'above' — telling the operator their *older* build was
     * merely unmanaged and hiding the update.
     */
    it('does not call a different build of the same version newer', async () => {
      probeCliVersion.mockResolvedValue('2.1.212-alpha')

      const [state] = await listInstallStates()

      expect(state.matchesLock).toBe(false)
      expect(state.lockDrift).not.toBe('above')
      expect(state.lockDrift).toBe('unknown')
    })

    it('falls back to unknown when the reported version has no comparable token', async () => {
      // An unparsable version must not be guessed into a direction: claiming
      // "below" would offer a downgrade, "above" would suppress a real update.
      probeCliVersion.mockResolvedValue('nightly-build')

      const [state] = await listInstallStates()

      expect(state.matchesLock).toBe(false)
      expect(state.lockDrift).toBe('unknown')
    })
  })

  /**
   * The pin and the `minVersion` floor answer different questions, so the state
   * has to carry both. Reporting only the pin left the UI unable to express the
   * one case the product explicitly supports — a build below the pin that still
   * clears the floor — and every such operator was told their working CLI was
   * stale.
   */
  describe('minimum version floor', () => {
    // qoder's preset floor is 1.0.0; codex declares none, and codegraph is
    // a non-Provider tool that has no preset at all.
    const FLOOR_LOCK = {
      providers: [
        {
          kind: 'qoder',
          version: '1.5.0',
          binary: 'qodercli',
          versionArgs: ['--version'],
          expectedVersionOutput: '1.5.0',
          install: {
            type: 'npm' as const,
            package: '@qoder-ai/qodercli',
            tarball: 'https://registry.npmjs.org/@qoder-ai/qodercli/-/qodercli-1.5.0.tgz',
            integrity: 'sha512-test',
            allowScripts: true,
          },
        },
        {
          kind: 'codex',
          version: '0.144.5',
          binary: 'codex',
          versionArgs: ['--version'],
          expectedVersionOutput: '0.144.5',
          install: {
            type: 'npm' as const,
            package: '@openai/codex',
            tarball: 'https://registry.npmjs.org/@openai/codex/-/codex-0.144.5.tgz',
            integrity: 'sha512-test',
            allowScripts: false,
          },
        },
        ...LOCK.providers,
      ],
      tools: LOCK.tools,
    }

    beforeEach(() => {
      _resetCliInstallerCaches()
      _setInstallerForTest({
        loadAndValidateLock: () => FLOOR_LOCK,
        allLockEntries: (lock) => [...lock.providers, ...(lock.tools ?? [])],
        installProviderAsync: async (
          ...args: Parameters<InstallerModule['installProviderAsync']>
        ) => installProvider(...args),
        uninstallProviderAsync: async (
          ...args: Parameters<InstallerModule['uninstallProviderAsync']>
        ) => uninstallProvider(...args),
      })
    })

    async function stateOf(kind: string, installedVersion: string | null) {
      probeCliVersion.mockResolvedValue(installedVersion)
      const state = (await listInstallStates()).find((candidate) => candidate.kind === kind)
      if (!state) throw new Error(`no install state for ${kind}`)
      return state
    }

    it('passes the floor verdict for a build at or above it', async () => {
      const state = await stateOf('qoder', '1.5.0')

      expect(state.minVersion).toBe('1.0.0')
      expect(state.meetsMinimum).toBe(true)
    })

    it('fails the floor verdict for a build below it', async () => {
      const state = await stateOf('qoder', '0.9.0')

      expect(state.minVersion).toBe('1.0.0')
      expect(state.meetsMinimum).toBe(false)
    })

    /**
     * The case the whole field exists for: older than the pin, yet above the
     * floor the engine actually gates on. Nothing is wrong with this install.
     */
    it('reports a build below the pin but above the floor as meeting the minimum', async () => {
      const state = await stateOf('qoder', '1.2.0')

      expect(state.lockDrift).toBe('below')
      expect(state.meetsMinimum).toBe(true)
    })

    it('leaves the verdict undecidable when the version cannot be parsed', async () => {
      const state = await stateOf('qoder', 'nightly-build')

      // The floor is still declared, but nothing can be concluded about it —
      // guessing false here would flag a working CLI as too old.
      expect(state.minVersion).toBe('1.0.0')
      expect(state.meetsMinimum).toBeNull()
    })

    it('reports no floor for a Provider that declares none', async () => {
      const state = await stateOf('codex', '0.144.5')

      expect(state.minVersion).toBeNull()
      expect(state.meetsMinimum).toBeNull()
    })

    it('reports no floor for a non-Provider tool', async () => {
      // CodeGraph is a lock `tools[]` entry with no Provider record, so there is
      // no preset to read a floor from.
      const state = await stateOf('codegraph', '1.1.0')

      expect(state.minVersion).toBeNull()
      expect(state.meetsMinimum).toBeNull()
    })

    it('leaves the verdict undecidable when nothing is installed', async () => {
      const state = await stateOf('qoder', null)

      // The floor is a property of the lock entry, not of the install, so it is
      // still reported; only the verdict is unanswerable.
      expect(state.minVersion).toBe('1.0.0')
      expect(state.meetsMinimum).toBeNull()
    })
  })

  it('probes PATH instead of trusting a stale DB row', async () => {
    // A CLI can be removed outside a2wave, or installed by another container into
    // the shared volume, so the row must never be the source of truth.
    rows.push({
      kind: 'claude-code',
      status: 'idle',
      installedVersion: '2.1.212',
      lastError: null,
      lastOutput: null,
    })
    probeCliVersion.mockResolvedValue(null)

    const [state] = await listInstallStates()

    expect(state.installed).toBe(false)
  })

  it('lists non-Provider tools too, so CodeGraph is installable', async () => {
    // Regression: CodeGraph was dropped from the image but absent from the
    // managed catalog, so every enabled SCM index failed with ENOENT and the
    // install endpoint answered 404.
    probeCliVersion.mockResolvedValue(null)

    const states = await listInstallStates()

    expect(states.map((s) => s.kind)).toContain('codegraph')
  })

  it('caches version probes so a polling UI does not spawn a process per read', async () => {
    probeCliVersion.mockResolvedValue('2.1.212')

    await listInstallStates()
    await listInstallStates()

    // One probe per managed CLI for the first read, none for the second.
    expect(probeCliVersion).toHaveBeenCalledTimes(2)
  })
})

describe('installCli', () => {
  it('records the locked version after the binary verifies on PATH', async () => {
    probeCliVersion.mockResolvedValue('2.1.212')

    await installCli('claude-code')

    expect(installProvider).toHaveBeenCalledTimes(1)
    const row = rows.find((r) => r.kind === 'claude-code')
    expect(row?.status).toBe('idle')
    expect(row?.installedVersion).toBe('2.1.212')
    expect(row?.lastError).toBeNull()
  })

  it('passes the configured install root to the installer', async () => {
    probeCliVersion.mockResolvedValue('2.1.212')

    await installCli('claude-code')

    expect(installProvider).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'claude-code' }),
      expect.objectContaining({ installRoot: '/tmp/a2wave-cli-root' }),
    )
  })

  it('fails the job when the installer succeeds but the binary is unreachable', async () => {
    // Reporting success here would leave the UI green while every run dies at
    // spawn time — the exact failure this feature has to avoid.
    probeCliVersion.mockResolvedValue(null)

    await expect(installCli('claude-code')).rejects.toThrow(CliInstallError)

    const row = rows.find((r) => r.kind === 'claude-code')
    expect(row?.status).toBe('error')
    expect(row?.lastError).toMatch(/does not resolve on PATH/)
  })

  it('cleans up a partial install so no dangling binary is left behind', async () => {
    // Nothing installed beforehand, so a half-extracted archive is pure garbage.
    probeCliVersion.mockResolvedValue(null)
    installProvider.mockImplementation(() => {
      throw new Error('checksum mismatch')
    })

    await expect(installCli('claude-code')).rejects.toThrow(/checksum mismatch/)

    expect(uninstallProvider).toHaveBeenCalledTimes(1)
    expect(rows.find((r) => r.kind === 'claude-code')?.status).toBe('error')
  })

  it('keeps the working copy when an update over a healthy CLI fails', async () => {
    // Regression: cleanup used to run unconditionally, so a failed update — a
    // dropped connection mid-download — deleted a CLI that worked a moment ago
    // and took every Agent bound to it offline.
    probeCliVersion.mockResolvedValue('2.1.212')
    installProvider.mockImplementation(() => {
      throw new Error('network unreachable')
    })

    await expect(installCli('claude-code')).rejects.toThrow(/network unreachable/)

    expect(uninstallProvider).not.toHaveBeenCalled()
    expect(rows.find((r) => r.kind === 'claude-code')?.status).toBe('error')
  })

  it('rejects an unknown kind rather than shelling out', async () => {
    await expect(installCli('not-a-cli')).rejects.toThrow(CliInstallError)
    expect(installProvider).not.toHaveBeenCalled()
  })

  it('rejects claiming a slot that is already installing', async () => {
    rows.push({
      kind: 'claude-code',
      status: 'installing',
      installedVersion: null,
      lastError: null,
      lastOutput: null,
    })

    await expect(claimInstallSlot('claude-code')).rejects.toThrow(CliInstallError)
  })

  it('marks the row installing synchronously when claiming', async () => {
    // Synchronous on purpose: any await between reading the status and writing it
    // lets a second request slip through and be accepted as well.
    await claimInstallSlot('claude-code')
    await flush()

    expect(rows.find((r) => r.kind === 'claude-code')?.status).toBe('installing')
  })

  it('lets a claim through once a previous attempt has failed', async () => {
    rows.push({
      kind: 'claude-code',
      status: 'error',
      installedVersion: null,
      lastError: 'boom',
      lastOutput: null,
    })

    await expect(claimInstallSlot('claude-code')).resolves.not.toThrow()
  })

  it('stores installer output truncated so a noisy build cannot bloat the row', async () => {
    probeCliVersion.mockResolvedValue('2.1.212')
    installProvider.mockImplementation((_provider, options: { onLog: (l: string) => void }) => {
      options.onLog('x'.repeat(20_000))
    })

    await installCli('claude-code')

    const output = rows.find((r) => r.kind === 'claude-code')?.lastOutput ?? ''
    expect(output.length).toBeLessThan(11_000)
    expect(output.endsWith('...')).toBe(true)
  })
})

describe('versionOutputMatches', () => {
  it('rejects a longer alphanumeric build suffix', async () => {
    // Regression: the boundary only excluded digits/dots, so an extra letter
    // suffix on a git short-SHA build id was accepted. Cursor's locked version
    // is exactly this shape (2026.07.16-899851b) — a build reporting
    // 2026.07.16-899851bad would have been recorded as a successful install.
    expect(versionOutputMatches('cursor-agent 2026.07.16-899851bad', '2026.07.16-899851b')).toBe(
      false,
    )
    expect(versionOutputMatches('cursor-agent 2026.07.16-899851b', '2026.07.16-899851b')).toBe(true)
  })

  it('accepts real CLI output with trailing sentence punctuation', async () => {
    // Regression caught in a live container: Copilot prints
    // `GitHub Copilot CLI 1.0.71.`, and a character-class boundary read the
    // trailing period as part of the version and rejected a correct install.
    expect(versionOutputMatches('GitHub Copilot CLI 1.0.71.', '1.0.71')).toBe(true)
    expect(versionOutputMatches('claude 1.0.71.5', '1.0.71')).toBe(false)
    expect(versionOutputMatches('claude 1.2.1.212', '2.1.212')).toBe(false)
  })

  it('still matches legitimate extra tokens separated by whitespace', async () => {
    expect(versionOutputMatches('claude 2.1.212 (build abc)', '2.1.212')).toBe(true)
    expect(versionOutputMatches('codex-cli 0.144.5', '0.144.5')).toBe(true)
  })

  it('rejects a longer numeric prefix or suffix', async () => {
    expect(versionOutputMatches('claude 12.1.212', '2.1.212')).toBe(false)
    expect(versionOutputMatches('claude 2.1.2120', '2.1.212')).toBe(false)
  })
})

describe('installCli version verification', () => {
  it('fails when the installed build does not report the locked version', async () => {
    // Regression: the row used to record provider.version after only a null
    // check, so a lock URL/checksum pointing at the wrong build, or an install
    // script producing an unexpected binary, was reported as success and the
    // mismatch only surfaced passively as matchesLock:false in a later list.
    probeCliVersion.mockResolvedValue('1.2.3')

    await expect(installCli('claude-code')).rejects.toThrow(/lock pins 2\.1\.212/)

    const row = rows.find((r) => r.kind === 'claude-code')
    expect(row?.status).toBe('error')
  })

  it('records the probed version rather than the lock value', async () => {
    // The probe is ground truth; the lock is only what was requested.
    probeCliVersion.mockResolvedValue('claude 2.1.212 (build abc)')

    await installCli('claude-code')

    expect(rows.find((r) => r.kind === 'claude-code')?.installedVersion).toBe(
      'claude 2.1.212 (build abc)',
    )
  })
})

describe('uninstallCli', () => {
  it('clears the recorded version so the UI stops showing it as installed', async () => {
    rows.push({
      kind: 'claude-code',
      status: 'idle',
      installedVersion: '2.1.212',
      lastError: null,
      lastOutput: null,
    })

    await uninstallCli('claude-code')

    expect(uninstallProvider).toHaveBeenCalledTimes(1)
    expect(rows.find((r) => r.kind === 'claude-code')?.installedVersion).toBeNull()
  })

  it('will not uninstall underneath a running install', async () => {
    rows.push({
      kind: 'claude-code',
      status: 'installing',
      installedVersion: null,
      lastError: null,
      lastOutput: null,
    })

    await expect(uninstallCli('claude-code')).rejects.toMatchObject({ code: 'already_running' })
    expect(uninstallProvider).not.toHaveBeenCalled()
  })

  it('rejects a conflicting uninstall synchronously, before queueing on the lock', async () => {
    // Regression: the check used to live inside withKeyedLock, so a concurrent
    // uninstall queued behind the install, saw the post-install `idle` status,
    // and deleted the CLI that had just been installed instead of returning 409.
    rows.push({
      kind: 'claude-code',
      status: 'installing',
      installedVersion: null,
      lastError: null,
      lastOutput: null,
    })

    await expect(claimUninstallSlot('claude-code')).rejects.toThrow(CliInstallError)
  })

  it('claims the slot so a later install cannot start alongside it', async () => {
    // A read-only check left a window: uninstall checked, then awaited
    // findProvider, and an install claimed the slot during that gap. The claim
    // must be written in the same synchronous step that reads it.
    await claimUninstallSlot('claude-code')
    await flush()

    expect(rows.find((r) => r.kind === 'claude-code')?.status).toBe('uninstalling')
    await expect(claimInstallSlot('claude-code')).rejects.toThrow(CliInstallError)
  })

  it('releases the slot when the kind turns out to be unknown', async () => {
    await expect(uninstallCli('not-a-cli')).rejects.toMatchObject({ code: 'unknown_kind' })

    // A bad request must not leave the slot claimed forever.
    expect(rows.find((r) => r.kind === 'not-a-cli')?.status).toBe('idle')
  })

  it('allows an uninstall when nothing else holds the slot', async () => {
    await expect(claimUninstallSlot('claude-code')).resolves.not.toThrow()
  })
})

describe('recoverInterruptedInstalls', () => {
  it('fails rows stranded mid-install so the CLI is not wedged forever', async () => {
    // Status is persisted to survive a reload, which means a killed process
    // leaves a row claiming to install and blocking every later attempt.
    rows.push({
      kind: 'claude-code',
      status: 'installing',
      installedVersion: null,
      lastError: null,
      lastOutput: null,
    })

    await recoverInterruptedInstalls()

    expect(updateSets[0]).toMatchObject({
      status: 'error',
      lastError: 'Interrupted by a server restart',
    })
  })

  it('settles a stranded uninstall as well as a stranded install', async () => {
    // A crash during uninstall would otherwise leave the slot claimed forever,
    // blocking every later operation on that CLI.
    rows.push({
      kind: 'claude-code',
      status: 'uninstalling',
      installedVersion: null,
      lastError: null,
      lastOutput: null,
    })

    await recoverInterruptedInstalls()

    expect(updateSets[0]).toMatchObject({ status: 'error' })
  })

  it('does nothing when no install was interrupted', async () => {
    await recoverInterruptedInstalls()

    expect(updateSets).toHaveLength(0)
  })
})

describe('ensureInstallRootOnPath', () => {
  const originalPath = process.env.PATH

  afterEach(() => {
    process.env.PATH = originalPath
  })

  it('adds only the shared bin dir, since that is where both install types link', async () => {
    // npm packages live in per-kind prefixes under <root>/npm/<kind> that are
    // deliberately NOT on PATH — one PATH entry per CLI would not scale, and the
    // per-kind split exists so promoting one CLI cannot delete another.
    process.env.PATH = '/usr/bin:/bin'

    ensureInstallRootOnPath()

    const entries = (process.env.PATH ?? '').split(':')
    expect(entries).toContain('/tmp/a2wave-cli-root/bin')
    expect(entries.some((e) => e.includes('/npm/bin'))).toBe(false)
  })

  it('does not duplicate the entry when it is already present', async () => {
    process.env.PATH = '/tmp/a2wave-cli-root/bin:/usr/bin'

    ensureInstallRootOnPath()

    const occurrences = (process.env.PATH ?? '')
      .split(':')
      .filter((e) => e === '/tmp/a2wave-cli-root/bin')
    expect(occurrences).toHaveLength(1)
  })
})

describe('resolveInstallRoot', () => {
  it('returns an absolute path so installs do not depend on subprocess cwd', async () => {
    expect(resolveInstallRoot()).toBe('/tmp/a2wave-cli-root')
  })
})
