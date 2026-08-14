import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import type { P4Config } from '@a2wave/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Chainable DB mock
const { mockDb, mockNotifyScmSyncError, mockExecuteGitSync, mockRunCodegraphIndex } = vi.hoisted(
  () => {
    const setResult = { run: vi.fn() }
    const whereResult = { get: vi.fn(), all: vi.fn(), run: vi.fn() }
    const setFn = vi.fn(() => whereResult)
    const updateResult = { set: setFn, where: vi.fn(() => setResult) }
    // Make set().where() work as chain
    setFn.mockImplementation((() => ({ where: vi.fn(() => setResult) })) as any)

    const selectChain = {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
        })),
      })),
    }

    const db = {
      select: vi.fn(() => selectChain),
      update: vi.fn(() => updateResult),
      _selectChain: selectChain,
      _updateResult: updateResult,
      _setResult: setResult,
    }

    return {
      mockDb: db,
      mockNotifyScmSyncError: vi.fn().mockResolvedValue(undefined),
      mockExecuteGitSync: vi.fn(),
      mockRunCodegraphIndex: vi.fn().mockResolvedValue({ ok: true, message: 'indexed' }),
    }
  },
)
vi.mock('../../db/client.js', () => ({ db: mockDb }))
vi.mock('../../db/schema.js', () => ({ scmSources: 'scmSources' }))
// `sanitizeCredentials` is deliberately NOT mocked: redaction of p4 error text
// is the behaviour under test, and a stubbed pass-through would make the
// assertion vacuous. Only the side-effecting sync entry point is replaced.
vi.mock('../git-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git-sync.js')>()),
  executeGitSync: mockExecuteGitSync,
}))
vi.mock('../codegraph-index.js', () => ({
  isCodegraphEnabled: (config: unknown) =>
    Boolean((config as { codegraphEnabled?: boolean } | null | undefined)?.codegraphEnabled),
  runCodegraphIndex: mockRunCodegraphIndex,
}))
vi.mock('../webhook-notifier.js', () => ({ notifyScmSyncError: mockNotifyScmSyncError }))

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  realpathSync: vi.fn((p: string) => (p === '/tmp' ? '/private/tmp' : p)),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { asyncQuery } from '../../test/async-query.js'
import {
  checkP4Connection,
  executeP4Sync,
  initAutoSyncSchedulers,
  isCheckoutBusy,
  p4Login,
  releaseCheckout,
  startAutoSync,
  stopAllAutoSync,
  stopAutoSync,
  syncScmSource,
  tryAcquireCheckout,
} from '../p4-sync.js'

// Cast to a loose shape — execFile has multiple overloads, so the typed
// mockImplementation rejects the generic (...args: unknown[]) adapter used
// across these tests. Tests exercise only the callback-style overload.
const mockExecFile = vi.mocked(execFile) as unknown as {
  mockImplementation: (fn: (...args: unknown[]) => void) => void
  mockReset: () => void
  mockClear: () => void
  mock: { calls: unknown[][]; results: unknown[] }
}
const mockSpawn = vi.mocked(spawn)
const mockExistsSync = vi.mocked(existsSync)

/** P4Config zod type requires fields declared with `.default()` in the schema. */
const p4ConfigDefaults = {
  p4passwd: '',
  autoSync: false as boolean,
  syncIntervalMin: 30,
  initialSyncTimeoutMin: 60,
}

function makeSpawnMock(exitCode: number, stderr = '') {
  const stdin = {
    write: vi.fn((_data: string, cb?: () => void) => {
      if (typeof cb === 'function') cb()
    }),
    end: vi.fn(),
  }
  const stderrChunks: Buffer[] = stderr ? [Buffer.from(stderr)] : []
  const stderrStream = {
    on: vi.fn((ev: string, fn: (d: Buffer) => void) => {
      if (ev === 'data') for (const d of stderrChunks) fn(d)
      return stderrStream
    }),
  }
  const mockChild = {
    stdin,
    stderr: stderrStream,
    on: vi.fn((ev: string, fn: (code?: number) => void) => {
      if (ev === 'close') setTimeout(() => fn(exitCode), 0)
      return mockChild
    }),
  }
  mockSpawn.mockReturnValue(mockChild as any)
  return { stdin, mockChild }
}

describe('p4Login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns true when no p4passwd (skips login)', async () => {
    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:host:1666',
      p4user: 'user',
      p4passwd: '',
      p4client: 'client',
    }
    const result = await p4Login(config)
    expect(result).toBe(true)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('spawns p4 login with correct args and writes password to stdin', async () => {
    const { stdin } = makeSpawnMock(0)
    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:host:1666',
      p4user: 'admin',
      p4passwd: 'secret123',
      p4client: 'my-workspace',
    }
    const result = await p4Login(config)
    expect(result).toBe(true)
    expect(mockSpawn).toHaveBeenCalledWith(
      'p4',
      ['-p', 'ssl:host:1666', '-u', 'admin', '-c', 'my-workspace', 'login'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    )
    expect(stdin.write).toHaveBeenCalledWith('secret123', expect.any(Function))
    expect(stdin.end).toHaveBeenCalled()
  })

  it('rejects when p4 login exits non-zero', async () => {
    makeSpawnMock(1, 'Invalid password')
    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:host:1666',
      p4user: 'admin',
      p4passwd: 'wrong',
      p4client: 'client',
    }
    await expect(p4Login(config)).rejects.toThrow('Invalid password')
  })
})

describe('checkP4Connection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls p4Login then p4 info and returns ok', async () => {
    makeSpawnMock(0)
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: null,
        result: { stdout: string; stderr: string },
      ) => void
      cb(null, {
        stdout: 'Server address: x\nServer root: y\nServer version: P4D/LINUX26X86_64/2025.1',
        stderr: '',
      })
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:host:1666',
      p4user: 'admin',
      p4passwd: 'secret',
      p4client: 'client',
    }
    const result = await checkP4Connection(config)
    expect(result.ok).toBe(true)
    expect(result.message).toBe('P4 connection is healthy')
    expect(result.serverVersion).toContain('2025.1')
    expect(mockSpawn).toHaveBeenCalled()
    expect(mockExecFile).toHaveBeenCalled()
    expect(mockExecFile.mock.calls[0][0]).toBe('p4')
    expect(mockExecFile.mock.calls[0][1]).toEqual(['info'])
  })
})

describe('executeP4Sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(true)
  })

  it('calls p4Login then p4 sync and returns ok', async () => {
    makeSpawnMock(0)
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: null,
        result: { stdout: string; stderr: string },
      ) => void
      cb(null, { stdout: '', stderr: '- updating file1\n- added file2' })
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:host:1666',
      p4user: 'admin',
      p4passwd: 'secret',
      p4client: 'client',
    }
    const result = await executeP4Sync(config, '/tmp/p4-work')
    expect(result.ok).toBe(true)
    expect(result.filesUpdated).toBe(2)
    expect(mockSpawn).toHaveBeenCalled()
    expect(mockExecFile).toHaveBeenCalled()
    expect(mockExecFile.mock.calls[0][0]).toBe('p4')
    expect(mockExecFile.mock.calls[0][1]).toEqual(['sync'])
  })

  it('creates localPath directory if it does not exist', async () => {
    mockExistsSync.mockReturnValue(false)
    makeSpawnMock(0)
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: null,
        result: { stdout: string; stderr: string },
      ) => void
      cb(null, { stdout: '', stderr: '' })
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:h:1666',
      p4user: 'u',
      p4passwd: 's',
      p4client: 'c',
    }
    await executeP4Sync(config, '/new/dir')
    expect(mkdirSync).toHaveBeenCalledWith('/new/dir', { recursive: true })
  })

  it('uses depotPath in sync args when provided', async () => {
    makeSpawnMock(0)
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: null,
        result: { stdout: string; stderr: string },
      ) => void
      cb(null, { stdout: '', stderr: '' })
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:h:1666',
      p4user: 'u',
      p4passwd: '',
      p4client: 'c',
      depotPath: '//depot/main/',
    }
    await executeP4Sync(config, '/repo')
    expect(mockExecFile.mock.calls[0][1]).toEqual(['sync', '//depot/main/...'])
  })

  it('returns "Already up-to-date" when no files updated', async () => {
    makeSpawnMock(0)
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: null,
        result: { stdout: string; stderr: string },
      ) => void
      cb(null, { stdout: '', stderr: '' })
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:h:1666',
      p4user: 'u',
      p4passwd: '',
      p4client: 'c',
    }
    const result = await executeP4Sync(config, '/repo')
    expect(result.ok).toBe(true)
    expect(result.message).toBe('Already up-to-date')
    expect(result.filesUpdated).toBe(0)
  })

  it('returns error with stderr on p4 sync failure', async () => {
    makeSpawnMock(0) // p4Login succeeds
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error & { stderr?: string; code?: string }) => void
      const err = new Error('sync failed') as Error & { stderr?: string; code?: string }
      err.stderr = 'Permission denied'
      err.code = '1'
      cb(err)
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:h:1666',
      p4user: 'u',
      p4passwd: '',
      p4client: 'c',
    }
    const result = await executeP4Sync(config, '/repo')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Permission denied')
  })

  it('reports timeout on ETIMEDOUT', async () => {
    makeSpawnMock(0) // p4Login succeeds
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: Error & { code?: string; killed?: boolean; stderr?: string },
      ) => void
      const err = new Error('timed out') as Error & {
        code?: string
        killed?: boolean
        stderr?: string
      }
      err.code = 'ETIMEDOUT'
      err.stderr = ''
      cb(err)
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:h:1666',
      p4user: 'u',
      p4passwd: '',
      p4client: 'c',
    }
    const result = await executeP4Sync(config, '/repo', 30000)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('timed out after 30s')
  })
})

// ============================================================
// DB-dependent tests: helper to create chainable DB mock
// ============================================================

// Shared between select and update mocks: syncScmSource now takes the row
// returned by the atomic acquire UPDATE as its authoritative source snapshot,
// so mockDbUpdate defaults its .returning().get() to whatever row the source
// table was last seeded with — matching real DB behaviour.
let lastSeededSource: unknown

function mockDbSelectGet(row: unknown) {
  lastSeededSource = row
  const getObj = { get: vi.fn(() => row), all: vi.fn(() => (row ? [row] : [])) }
  const whereObj = asyncQuery({ ...getObj })
  const fromObj = asyncQuery({ where: vi.fn(() => whereObj) })
  mockDb.select.mockReturnValue(asyncQuery({ from: vi.fn(() => fromObj) }) as any)
  return { fromObj, whereObj }
}

function mockDbSelectAll(rows: unknown[]) {
  const whereObj = asyncQuery({ get: vi.fn(() => rows[0]), all: vi.fn(() => rows) })
  const fromObj = asyncQuery({ where: vi.fn(() => whereObj) })
  mockDb.select.mockReturnValue(asyncQuery({ from: vi.fn(() => fromObj) }) as any)
  return { fromObj, whereObj }
}

function mockDbUpdate({
  acquired = true,
  acquiredRow,
}: {
  acquired?: boolean
  acquiredRow?: unknown
} = {}) {
  const runFn = vi.fn()
  // The atomic acquire ends in .returning().get() and its result is taken as the
  // authoritative source snapshot; the terminal status write is awaited directly.
  // Support both shapes off the same `where` result.
  const getFn = vi.fn(() =>
    acquired ? (acquiredRow ?? lastSeededSource ?? { id: 's1' }) : undefined,
  )
  // Drizzle's builder is itself awaitable, so the mock is a real resolved promise
  // carrying the chain methods — `Object.assign` rather than a hand-written `then`,
  // which would trip lint/suspicious/noThenProperty.
  const whereFn = vi.fn(() =>
    asyncQuery({
      run: runFn,
      returning: vi.fn(() => asyncQuery({ get: getFn })),
    }),
  )
  const setFn = vi.fn((_values: Record<string, unknown>) => asyncQuery({ where: whereFn }))
  mockDb.update.mockReturnValue(asyncQuery({ set: setFn }) as any)
  return { setFn, whereFn, runFn, getFn }
}

describe('syncScmSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastSeededSource = undefined
    // Ensure no checkout lock leaked from a prior test wedges this one.
    releaseCheckout('s1')
    mockExistsSync.mockReturnValue(true)
  })

  afterEach(() => {
    releaseCheckout('s1')
  })

  it('returns error when source not found', async () => {
    // Acquire finds no row, and the stillExists re-check confirms it is gone.
    mockDbSelectGet(undefined)
    mockDbUpdate({ acquired: false })
    const result = await syncScmSource('non-existent')
    expect(result.ok).toBe(false)
    expect(result.message).toBe('SCM source not found')
  })

  it('dispatches to P4 sync for p4 type', async () => {
    const source = {
      id: 's1',
      name: 'test',
      type: 'p4',
      config: { type: 'p4', p4port: 'ssl:h:1666', p4user: 'u', p4passwd: '', p4client: 'c' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    }
    mockDbSelectGet(source)
    mockDbUpdate()
    // p4Login succeeds
    makeSpawnMock(0)
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: null,
        result: { stdout: string; stderr: string },
      ) => void
      cb(null, { stdout: '', stderr: '- updating file1' })
    })

    const result = await syncScmSource('s1')
    expect(result.ok).toBe(true)
    expect(result.filesUpdated).toBe(1)
  })

  it('dispatches to Git sync for git type', async () => {
    const source = {
      id: 's1',
      name: 'test',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo',
        branch: 'main',
        username: '',
        pat: '',
      },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    }
    mockDbSelectGet(source)
    mockDbUpdate()
    mockExecuteGitSync.mockResolvedValue({ ok: true, message: 'Synced 3 files', filesUpdated: 3 })

    const result = await syncScmSource('s1')
    expect(result.ok).toBe(true)
    expect(mockExecuteGitSync).toHaveBeenCalled()
  })

  it('starts CodeGraph indexing after successful sync when enabled', async () => {
    const source = {
      id: 's1',
      name: 'test',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo',
        branch: 'main',
        codegraphEnabled: true,
      },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    }
    mockDbSelectGet(source)
    mockDbUpdate()
    mockExecuteGitSync.mockResolvedValue({ ok: true, message: 'Synced 1 file', filesUpdated: 1 })

    await syncScmSource('s1')

    expect(mockRunCodegraphIndex).toHaveBeenCalledWith('s1')
  })

  it('does not start CodeGraph indexing when sync fails', async () => {
    const source = {
      id: 's1',
      name: 'test',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo',
        branch: 'main',
        codegraphEnabled: true,
      },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    }
    mockDbSelectGet(source)
    mockDbUpdate()
    mockExecuteGitSync.mockResolvedValue({ ok: false, message: 'auth failed' })

    await syncScmSource('s1')

    expect(mockRunCodegraphIndex).not.toHaveBeenCalled()
  })

  it('refuses to start when the source is already syncing', async () => {
    const source = {
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    }
    mockDbSelectGet(source)
    mockDbUpdate({ acquired: false })

    const result = await syncScmSource('s1')

    expect(result.ok).toBe(false)
    expect(result.alreadyRunning).toBe(true)
    expect(mockExecuteGitSync).not.toHaveBeenCalled()
  })

  it('does not overwrite sync state when the acquire fails', async () => {
    const source = {
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    }
    mockDbSelectGet(source)
    const { setFn } = mockDbUpdate({ acquired: false })

    await syncScmSource('s1')

    // Only the failed acquire attempt — no terminal status write that would
    // clobber the in-flight sync's own bookkeeping.
    expect(setFn).toHaveBeenCalledTimes(1)
  })

  it('releases a pre-acquired status when the source disappears before the sync starts', async () => {
    // The manual-sync route acquires `syncing` and then hands off. If the row is
    // gone by the time we load it, returning early would strand the status at
    // `syncing` forever — every later CAS fails and only a restart clears it.
    mockDbSelectGet(undefined)
    const { setFn } = mockDbUpdate()

    const result = await syncScmSource('s1', { statusAlreadyAcquired: true })

    expect(result.ok).toBe(false)
    expect(setFn).toHaveBeenCalledTimes(1)
    expect(setFn.mock.calls[0]?.[0]).toMatchObject({ syncStatus: 'error' })
  })

  it('acts on the snapshot returned by the acquire, not a pre-acquire read', async () => {
    // Guards against the acquire-after-load race: the worker must use the row
    // the atomic acquire returned (consistent with the lock), never a snapshot
    // read before acquiring that a concurrent PATCH could have made stale.
    const acquiredRow = {
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/NEW', branch: 'main' },
      localPath: '/new/path',
      initialSyncCompletedAt: new Date(),
    }
    // A different, stale row is what a naive pre-acquire select would have seen.
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/OLD', branch: 'main' },
      localPath: '/old/path',
      initialSyncCompletedAt: new Date(),
    })
    mockDbUpdate({ acquiredRow })
    mockExecuteGitSync.mockResolvedValue({ ok: true, message: 'ok', filesUpdated: 0 })

    await syncScmSource('s1')

    expect(mockExecuteGitSync).toHaveBeenCalledWith(
      expect.objectContaining({ repoUrl: 'https://github.com/org/NEW' }),
      '/new/path',
      expect.any(Number),
    )
  })

  it('refuses to start when the checkout is already held by another writer', async () => {
    // Finding #3/#4: the checkout lock is now taken synchronously at entry,
    // before any await — a manual setup/index job holding it blocks the sync
    // from even reaching the DB acquire, closing the pre-add race window.
    expect(tryAcquireCheckout('s1')).toBe(true) // simulate a manual job holding it
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    })
    mockDbUpdate()

    const result = await syncScmSource('s1')

    expect(result.ok).toBe(false)
    expect(result.alreadyRunning).toBe(true)
    expect(mockExecuteGitSync).not.toHaveBeenCalled()
    // The DB acquire was never attempted — the checkout lock gated it first.
    expect(mockDb.update).not.toHaveBeenCalled()

    releaseCheckout('s1')
  })

  it('does not re-acquire the checkout when the caller already holds it', async () => {
    // The manual-sync route acquires the checkout then delegates with
    // checkoutAlreadyAcquired; syncScmSource must run rather than 409.
    expect(tryAcquireCheckout('s1')).toBe(true)
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    })
    mockDbUpdate()
    mockExecuteGitSync.mockResolvedValue({ ok: true, message: 'ok', filesUpdated: 0 })

    const result = await syncScmSource('s1', {
      statusAlreadyAcquired: true,
      checkoutAlreadyAcquired: true,
    })

    expect(result.ok).toBe(true)
    expect(mockExecuteGitSync).toHaveBeenCalled()
    // syncScmSource owns the release from here; it clears the lock after post-sync.
    await vi.waitFor(() => expect(isCheckoutBusy('s1')).toBe(false))
  })

  it('writes no terminal status when the acquire fails and nothing was locked', async () => {
    // Acquire CAS matches no row (source gone / already syncing). The only .set()
    // is that failed CAS attempt — no terminal write that could clobber a
    // concurrent holder's bookkeeping.
    mockDbSelectGet(undefined)
    const { setFn } = mockDbUpdate({ acquired: false })

    const result = await syncScmSource('s1')

    expect(result.ok).toBe(false)
    expect(setFn).toHaveBeenCalledTimes(1)
  })

  it('releases a pre-acquired status when the SCM type is unsupported', async () => {
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'svn',
      config: {},
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    })
    const { setFn } = mockDbUpdate()

    const result = await syncScmSource('s1', { statusAlreadyAcquired: true })

    expect(result.ok).toBe(false)
    // Terminal write must still happen so the lock is not stranded.
    expect(setFn).toHaveBeenCalledTimes(1)
    expect(setFn.mock.calls[0]?.[0]).toMatchObject({ syncStatus: 'error' })
  })

  it('writes a terminal status when the sync engine throws', async () => {
    // A throw escaping before the terminal write would leave the row stuck at
    // 'syncing' forever — the exact lockout this change exists to prevent.
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    })
    const { setFn } = mockDbUpdate()
    mockExecuteGitSync.mockRejectedValue(new Error('git exploded'))

    const result = await syncScmSource('s1', { statusAlreadyAcquired: true })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('git exploded')
    const terminalWrite = setFn.mock.calls.at(-1)?.[0]
    expect(terminalWrite).toMatchObject({ syncStatus: 'error' })
  })

  it('resets syncStatus to error and releases the lock when the terminal write throws', async () => {
    // Finding #1: if the terminal status write itself fails, the row must not be
    // left at 'syncing' (which would 409 every future sync until restart), and
    // the checkout lock must be released.
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    })
    mockExecuteGitSync.mockResolvedValue({ ok: true, message: 'ok', filesUpdated: 0 })

    // Acquire returns the source; the FIRST terminal write throws, the SECOND
    // (the reset to 'error') succeeds.
    const setCalls: Record<string, unknown>[] = []
    let terminalWriteCount = 0
    mockDb.update.mockReturnValue({
      set: vi.fn((values: Record<string, unknown>) => {
        setCalls.push(values)
        const isTerminalWrite = values.syncStatus === 'idle' || values.syncStatus === 'error'
        return {
          where: vi.fn(() => {
            // Awaiting the builder is what surfaces the write failure, so the mock is a
            // real promise (rejected only for that first 'idle' write) with the chain
            // methods attached — a literal `then` would trip noThenProperty.
            const settled =
              isTerminalWrite && values.syncStatus === 'idle' && terminalWriteCount++ === 0
                ? Promise.reject(new Error('SQLITE_BUSY'))
                : Promise.resolve(undefined)
            return Object.assign(settled, {
              run: vi.fn(),
              returning: vi.fn(() => ({ get: vi.fn(() => ({ id: 's1', type: 'git' })) })),
            })
          }),
        }
      }),
    } as any)

    const result = await syncScmSource('s1', { statusAlreadyAcquired: true })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('Failed to persist')
    // The recovery write reset the status to 'error' rather than leaving 'syncing'.
    expect(setCalls.some((v) => v.syncStatus === 'error')).toBe(true)
    // Lock released: a fresh acquire succeeds.
    expect(isCheckoutBusy('s1')).toBe(false)
  })

  it('returns error for unsupported SCM type', async () => {
    const source = {
      id: 's1',
      name: 'test',
      type: 'svn',
      config: {},
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    }
    mockDbSelectGet(source)
    mockDbUpdate()

    const result = await syncScmSource('s1')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Unsupported SCM type')
  })

  it('notifies webhook on sync failure', async () => {
    const source = {
      id: 's1',
      name: 'failsource',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo',
        branch: 'main',
        username: '',
        pat: '',
      },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    }
    mockDbSelectGet(source)
    mockDbUpdate()
    mockExecuteGitSync.mockResolvedValue({ ok: false, message: 'auth failed' })

    await syncScmSource('s1')

    expect(mockNotifyScmSyncError).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 's1',
        sourceName: 'failsource',
        errorMsg: 'auth failed',
      }),
    )
  })

  it('uses longer timeout for initial sync', async () => {
    const source = {
      id: 's1',
      name: 'test',
      type: 'git',
      config: {
        type: 'git',
        repoUrl: 'https://github.com/org/repo',
        branch: 'main',
        username: '',
        pat: '',
        initialSyncTimeoutMin: 120,
      },
      localPath: '/repo',
      initialSyncCompletedAt: null, // initial sync
    }
    mockDbSelectGet(source)
    mockDbUpdate()
    mockExecuteGitSync.mockResolvedValue({ ok: true, message: 'ok', filesUpdated: 5 })

    await syncScmSource('s1')

    // executeGitSync should be called with 120 * 60 * 1000 = 7200000ms timeout
    expect(mockExecuteGitSync).toHaveBeenCalledWith(expect.anything(), '/repo', 120 * 60 * 1000)
  })
})

describe('checkout lock', () => {
  afterEach(() => {
    // Ensure no lock leaks across tests.
    releaseCheckout('lock_s1')
  })

  it('tryAcquireCheckout grants the lock once and reports busy until released', () => {
    expect(isCheckoutBusy('lock_s1')).toBe(false)
    expect(tryAcquireCheckout('lock_s1')).toBe(true)
    expect(isCheckoutBusy('lock_s1')).toBe(true)
    // A second acquire is refused while held.
    expect(tryAcquireCheckout('lock_s1')).toBe(false)

    releaseCheckout('lock_s1')
    expect(isCheckoutBusy('lock_s1')).toBe(false)
    expect(tryAcquireCheckout('lock_s1')).toBe(true)
  })
})

describe('auto-sync scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lastSeededSource = undefined
    vi.useFakeTimers()
    stopAllAutoSync()
  })

  afterEach(() => {
    stopAllAutoSync()
    vi.useRealTimers()
  })

  it('startAutoSync schedules periodic sync', () => {
    mockDbSelectGet({ id: 's1', type: 'git', config: {}, localPath: '/repo' })
    mockDbUpdate()
    mockExecuteGitSync.mockResolvedValue({ ok: true, message: 'ok' })

    startAutoSync('s1', 10) // every 10 minutes

    // Verify interval is set (sync should trigger after interval)
    // Before interval: no calls
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('stopAutoSync clears the timer', () => {
    startAutoSync('s1', 5)
    stopAutoSync('s1')
    // Advancing time should not trigger sync
    mockDb.select.mockClear()
    vi.advanceTimersByTime(10 * 60 * 1000)
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('stopAllAutoSync clears all timers', () => {
    startAutoSync('s1', 5)
    startAutoSync('s2', 10)
    stopAllAutoSync()
    mockDb.select.mockClear()
    vi.advanceTimersByTime(20 * 60 * 1000)
    expect(mockDb.select).not.toHaveBeenCalled()
  })

  it('skips the tick while a manual index job holds the checkout', async () => {
    // A manually-triggered reindex holds the checkout lock; the
    // auto-sync tick must not start a sync that would write the same tree.
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    })
    mockDbUpdate()
    mockExecuteGitSync.mockResolvedValue({ ok: true, message: 'ok', filesUpdated: 0 })

    expect(tryAcquireCheckout('s1')).toBe(true) // manual job takes the checkout
    startAutoSync('s1', 5)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(mockExecuteGitSync).not.toHaveBeenCalled()

    releaseCheckout('s1') // manual job finishes
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(mockExecuteGitSync).toHaveBeenCalledTimes(1)
  })

  it('does not start a second sync while the previous tick is still running', async () => {
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    })
    mockDbUpdate()

    // A sync that never settles within the test — simulates a slow P4/git
    // sync outlasting the auto-sync interval.
    let releaseSync: () => void = () => {}
    mockExecuteGitSync.mockReturnValue(
      new Promise((resolve) => {
        releaseSync = () => resolve({ ok: true, message: 'ok', filesUpdated: 0 })
      }),
    )

    startAutoSync('s1', 5)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(mockExecuteGitSync).toHaveBeenCalledTimes(1)

    // Several more intervals elapse while the first sync is still in flight.
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(mockExecuteGitSync).toHaveBeenCalledTimes(1)

    releaseSync()
    await vi.advanceTimersByTimeAsync(0)

    // Once it settles, the schedule resumes normally.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(mockExecuteGitSync).toHaveBeenCalledTimes(2)
  })

  it('releases the in-flight guard when a sync rejects, so later ticks still run', async () => {
    // Without the `finally`, one poisoned tick would wedge auto-sync for this
    // source until the process restarts.
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    })
    mockDbUpdate()
    mockExecuteGitSync.mockRejectedValue(new Error('transient failure'))

    startAutoSync('s1', 5)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(mockExecuteGitSync).toHaveBeenCalledTimes(1)

    // The next tick must not be blocked by a guard left behind by the failure.
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(mockExecuteGitSync).toHaveBeenCalledTimes(2)
  })

  it('stopAutoSync keeps the in-flight guard so a rescheduled timer cannot stack', async () => {
    // PATCH /:id reschedules via stop+start. If stopAutoSync cleared the guard,
    // the fresh timer would start a second sync on top of the running one.
    mockDbSelectGet({
      id: 's1',
      name: 'test',
      type: 'git',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo', branch: 'main' },
      localPath: '/repo',
      initialSyncCompletedAt: new Date(),
    })
    mockDbUpdate()

    let releaseSync: () => void = () => {}
    mockExecuteGitSync.mockReturnValue(
      new Promise((resolve) => {
        releaseSync = () => resolve({ ok: true, message: 'ok', filesUpdated: 0 })
      }),
    )

    startAutoSync('s1', 5)
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(mockExecuteGitSync).toHaveBeenCalledTimes(1)

    // Reschedule while the first sync is still in flight.
    stopAutoSync('s1')
    startAutoSync('s1', 5)

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
    expect(mockExecuteGitSync).toHaveBeenCalledTimes(1)

    releaseSync()
    await vi.advanceTimersByTimeAsync(0)
  })

  it('startAutoSync replaces existing timer for same sourceId', () => {
    startAutoSync('s1', 5)
    startAutoSync('s1', 15) // should replace
    stopAutoSync('s1')
    // After stop, no timers remain
    mockDb.select.mockClear()
    vi.advanceTimersByTime(20 * 60 * 1000)
    expect(mockDb.select).not.toHaveBeenCalled()
  })
})

describe('initAutoSyncSchedulers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stopAllAutoSync()
  })

  afterEach(() => {
    stopAllAutoSync()
  })

  it('resets stuck syncing sources and CodeGraph index jobs on startup', async () => {
    // First select: stuck syncing sources
    // Second select: stuck CodeGraph indexing sources
    // Third select: enabled sources for auto-sync
    let selectCall = 0
    mockDb.select.mockImplementation(
      () =>
        asyncQuery({
          from: vi.fn(() =>
            asyncQuery({
              where: vi.fn(() => {
                selectCall++
                if (selectCall === 1) {
                  // stuck syncing
                  return asyncQuery({ all: vi.fn(() => [{ id: 'stuck1' }]), get: vi.fn() })
                }
                if (selectCall === 2) {
                  // stuck CodeGraph indexing
                  return asyncQuery({ all: vi.fn(() => [{ id: 'stuck3' }]), get: vi.fn() })
                }
                // enabled sources — none with autoSync
                return asyncQuery({ all: vi.fn(() => []), get: vi.fn() })
              }),
            }),
          ),
        }) as any,
    )

    const { setFn } = mockDbUpdate()

    await initAutoSyncSchedulers()

    // Should have called update for stuck sources
    expect(mockDb.update).toHaveBeenCalled()
    // At least one set call should reset to idle, another to error
    const setCalls = setFn.mock.calls.map((c: unknown[]) => c[0])
    expect(setCalls.some((c: any) => c.syncStatus === 'idle')).toBe(true)
    expect(
      setCalls.some(
        (c: any) =>
          c.codegraphStatus === 'error' && c.codegraphLastError === 'Interrupted by server restart',
      ),
    ).toBe(true)
  })

  it('starts auto-sync for enabled sources with autoSync config', async () => {
    let selectCall = 0
    mockDb.select.mockImplementation(
      () =>
        asyncQuery({
          from: vi.fn(() =>
            asyncQuery({
              where: vi.fn(() => {
                selectCall++
                if (selectCall <= 2) return asyncQuery({ all: vi.fn(() => []), get: vi.fn() })
                // Third call: enabled sources
                return asyncQuery({
                  all: vi.fn(() => [
                    { id: 's1', config: { autoSync: true, syncIntervalMin: 30 } },
                    { id: 's2', config: { autoSync: false } },
                    { id: 's3', config: { autoSync: true, syncIntervalMin: 60 } },
                  ]),
                  get: vi.fn(),
                })
              }),
            }),
          ),
        }) as any,
    )
    mockDbUpdate()

    await initAutoSyncSchedulers()

    // s1 and s3 should have timers, s2 should not
    // We can verify by stopping and checking no errors
    stopAutoSync('s1')
    stopAutoSync('s3')
  })

  it('continues initializing schedulers when one stuck-state reset fails', async () => {
    let selectCall = 0
    mockDb.select.mockImplementation(
      () =>
        asyncQuery({
          from: vi.fn(() =>
            asyncQuery({
              where: vi.fn(() => {
                selectCall++
                if (selectCall === 1) {
                  return asyncQuery({ all: vi.fn(() => [{ id: 'stuck1' }]), get: vi.fn() })
                }
                if (selectCall === 2) return asyncQuery({ all: vi.fn(() => []), get: vi.fn() })
                return asyncQuery({
                  all: vi.fn(() => [{ id: 's1', config: { autoSync: true, syncIntervalMin: 30 } }]),
                  get: vi.fn(),
                })
              }),
            }),
          ),
        }) as any,
    )
    const { setFn } = mockDbUpdate()
    setFn.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY')
    })

    await expect(initAutoSyncSchedulers()).resolves.toBeUndefined()

    stopAutoSync('s1')
  })
})

describe('checkP4Connection — edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns error when p4 info has unexpected output', async () => {
    makeSpawnMock(0) // login ok
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (
        err: null,
        result: { stdout: string; stderr: string },
      ) => void
      cb(null, { stdout: 'Something unexpected', stderr: '' })
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:h:1666',
      p4user: 'u',
      p4passwd: 's',
      p4client: 'c',
    }
    const result = await checkP4Connection(config)
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Unexpected p4 info output')
  })

  /**
   * The git check path already runs its error text through sanitizeCredentials;
   * P4 did not, so a p4d error echoing the connection string could surface a
   * password verbatim in an API response. It reaches further now that the
   * stateless probe returns this message to a caller who never saved the source.
   */
  it('redacts credentials leaked in a p4 error message', async () => {
    makeSpawnMock(0)
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void
      cb(new Error('login failed for P4PASSWD=hunter2 at https://user:tok@p4.example/x'))
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:h:1666',
      p4user: 'u',
      p4passwd: 'hunter2',
      p4client: 'c',
    }
    const result = await checkP4Connection(config)
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('hunter2')
    expect(result.message).not.toContain('tok')
  })

  it('returns connection failed on execFile error', async () => {
    makeSpawnMock(0) // login ok
    mockExecFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error) => void
      cb(new Error('Connection refused'))
    })

    const config: P4Config = {
      ...p4ConfigDefaults,
      p4port: 'ssl:h:1666',
      p4user: 'u',
      p4passwd: 's',
      p4client: 'c',
    }
    const result = await checkP4Connection(config)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('Connection refused')
  })
})
