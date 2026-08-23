import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────

const { mockDbInsert, mockDbSelect, mockDbDelete } = vi.hoisted(() => {
  const mockDbInsert = vi.fn()
  const mockDbSelect = vi.fn()
  const mockDbDelete = vi.fn()
  return { mockDbInsert, mockDbSelect, mockDbDelete }
})

vi.mock('../../db/client.js', () => ({
  db: {
    insert: mockDbInsert,
    select: mockDbSelect,
    delete: mockDbDelete,
  },
}))

vi.mock('../../db/schema.js', () => ({
  artifacts: { id: 'id', runId: 'run_id', expiresAt: 'expires_at' },
  artifactShares: {
    id: 'id',
    artifactId: 'artifact_id',
    revokedAt: 'revoked_at',
    expiresAt: 'expires_at',
  },
}))

// 分享服务在 deleteExpiredArtifacts 中被调用，独立单测见 artifact-share.test.ts
vi.mock('../artifact-share.js', () => ({
  deleteStaleShares: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../id.js', () => ({
  createId: vi.fn().mockReturnValue('art_test123'),
}))

let mockStoragePath = ''
let mockRetentionHours = '24'

vi.mock('../settings.js', () => ({
  getSetting: vi.fn((category: string, key: string) => {
    if (category === 'artifacts' && key === 'storagePath') return mockStoragePath
    if (category === 'artifacts' && key === 'retentionHours') return mockRetentionHours
    return undefined
  }),
}))

// drizzle-orm mocks
vi.mock('drizzle-orm', () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'eq' })),
  lt: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'lt' })),
  gt: vi.fn((col: unknown, val: unknown) => ({ col, val, op: 'gt' })),
  and: vi.fn((...args: unknown[]) => ({ args, op: 'and' })),
  isNull: vi.fn((col: unknown) => ({ col, op: 'isNull' })),
  notExists: vi.fn((sub: unknown) => ({ sub, op: 'notExists' })),
}))

// ── Import after mocks ─────────────────────────────────────────────────────

import { asyncQuery } from '../../test/async-query.js'
import { deleteStaleShares } from '../artifact-share.js'
import {
  deleteExpiredArtifacts,
  discardRunArtifactsDir,
  getArtifactDir,
  getArtifactRetentionMs,
  getArtifactsStorageRoot,
  scanAndRegisterArtifacts,
} from '../artifact-storage.js'
import { logger } from '../logger.js'

// ── Test fixtures ──────────────────────────────────────────────────────────

/**
 * Where a run drops its artifacts, spelled out rather than imported: the tests
 * pin the on-disk layout the Agent is pointed at, so a change to it has to be
 * a deliberate edit here and not something the implementation can redefine
 * under them.
 */
function runArtifactsDir(workDir: string, runId: string): string {
  return join(workDir, 'artifacts', runId)
}

let testRoot: string

beforeEach(() => {
  testRoot = join(tmpdir(), `artifact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(testRoot, { recursive: true })
  mockStoragePath = testRoot
  mockRetentionHours = '24'
  vi.clearAllMocks()
  mockDbInsert.mockReturnValue(
    asyncQuery({ values: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }),
  )
  mockDbDelete.mockReturnValue(
    asyncQuery({ where: vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() })) }),
  )
})

afterEach(() => {
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true })
  }
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('getArtifactsStorageRoot', () => {
  it('returns absolute path based on storagePath setting', async () => {
    const root = await getArtifactsStorageRoot()
    expect(root).toBe(resolve(process.cwd(), testRoot))
  })

  it('falls back to ./data/artifacts when setting is empty', async () => {
    mockStoragePath = ''
    const root = await getArtifactsStorageRoot()
    // resolve('') gives cwd, so combined: resolve(cwd, './data/artifacts')
    expect(root).toBe(resolve(process.cwd(), './data/artifacts'))
  })
})

describe('getArtifactRetentionMs', () => {
  it('converts 24 hours to milliseconds', async () => {
    mockRetentionHours = '24'
    expect(getArtifactRetentionMs()).toBe(24 * 60 * 60 * 1000)
  })

  it('converts 1 hour to milliseconds', async () => {
    mockRetentionHours = '1'
    expect(getArtifactRetentionMs()).toBe(60 * 60 * 1000)
  })

  it('returns 0 when retentionHours is 0', async () => {
    mockRetentionHours = '0'
    expect(getArtifactRetentionMs()).toBe(0)
  })

  it('handles decimal hours', async () => {
    mockRetentionHours = '0.5'
    expect(getArtifactRetentionMs()).toBe(0.5 * 60 * 60 * 1000)
  })
})

describe('getArtifactDir', () => {
  it('constructs path as root/agentId/userHash/runId', async () => {
    const agentId = 'agt_abc'
    const userId = 'usr_xyz'
    const runId = 'run_123'

    const dir = await getArtifactDir(agentId, userId, runId)

    const expectedHash = createHash('sha256').update(userId).digest('hex').slice(0, 12)
    const storageRoot = resolve(process.cwd(), testRoot)
    expect(dir).toBe(join(storageRoot, agentId, expectedHash, runId))
  })

  it('produces same hash for same userId (consistent)', async () => {
    const userId = 'usr_consistent'
    const dir1 = await getArtifactDir('agt_1', userId, 'run_1')
    const dir2 = await getArtifactDir('agt_1', userId, 'run_2')

    // Both dirs share the same userHash segment
    const parts1 = (await dir1).split('/')
    const parts2 = (await dir2).split('/')
    const hashIdx1 = parts1.indexOf('agt_1') + 1
    const hashIdx2 = parts2.indexOf('agt_1') + 1
    expect(parts1[hashIdx1]).toBe(parts2[hashIdx2])
    expect(parts1[hashIdx1]).toHaveLength(12)
  })

  it('produces different hash for different userId', async () => {
    const dir1 = await getArtifactDir('agt_1', 'usr_alice', 'run_1')
    const dir2 = await getArtifactDir('agt_1', 'usr_bob', 'run_1')
    expect(dir1).not.toBe(dir2)
  })
})

describe('scanAndRegisterArtifacts', () => {
  it('does nothing when workDir/artifacts does not exist', async () => {
    const workDir = join(testRoot, 'no_artifacts_workdir')
    mkdirSync(workDir, { recursive: true })
    // No artifacts/ subdir

    const result = await scanAndRegisterArtifacts('run_1', 'agt_1', 'usr_1', workDir, 'run_1')
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('does nothing when artifacts dir is empty', async () => {
    const workDir = join(testRoot, 'empty_workdir')
    mkdirSync(runArtifactsDir(workDir, 'run_1'), { recursive: true })

    const result = await scanAndRegisterArtifacts('run_1', 'agt_1', 'usr_1', workDir, 'run_1')
    expect(mockDbInsert).not.toHaveBeenCalled()
    expect(result).toEqual([])
  })

  it('copies files and inserts DB records for each artifact', async () => {
    const workDir = join(testRoot, 'workdir1')
    const artifactsDir = runArtifactsDir(workDir, 'run_1')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'report.md'), '# Report\nHello')
    writeFileSync(join(artifactsDir, 'data.json'), '{"key":"value"}')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts('run_1', 'agt_1', 'usr_1', workDir, 'run_1')

    expect(mockDbInsert).toHaveBeenCalledTimes(2)

    const calls = mockValues.mock.calls
    const filenames = calls.map((c: unknown[]) => (c[0] as { filename: string }).filename).sort()
    expect(filenames).toEqual(['data.json', 'report.md'])

    expect(result).toHaveLength(2)
    const returnedFilenames = result.map((r) => r.filename).sort()
    expect(returnedFilenames).toEqual(['data.json', 'report.md'])
    expect(result.every((r) => r.id === 'art_test123')).toBe(true)
    expect(result.every((r) => typeof r.storagePath === 'string' && r.storagePath.length > 0)).toBe(
      true,
    )
  })

  it('copies file content to storage dir correctly', async () => {
    const workDir = join(testRoot, 'workdir_copy')
    const artifactsDir = runArtifactsDir(workDir, 'run_copy')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'output.txt'), 'artifact content')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_copy', 'agt_1', 'usr_1', workDir, 'run_copy')

    // The stored file should have the same content
    const storedPath = (mockValues.mock.calls[0][0] as { storagePath: string }).storagePath
    expect(existsSync(storedPath)).toBe(true)
    expect(readFileSync(storedPath, 'utf-8')).toBe('artifact content')
  })

  it('sets correct MIME type for known extensions', async () => {
    const workDir = join(testRoot, 'workdir_mime')
    const artifactsDir = runArtifactsDir(workDir, 'run_mime')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(join(artifactsDir, 'doc.json'), '{}')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_mime', 'agt_1', 'usr_1', workDir, 'run_mime')

    const records = mockValues.mock.calls.map(
      (c: unknown[]) => c[0] as { filename: string; mimeType: string },
    )
    const png = records.find((r) => r.filename === 'image.png')
    const json = records.find((r) => r.filename === 'doc.json')
    expect(png?.mimeType).toBe('image/png')
    expect(json?.mimeType).toBe('application/json')
  })

  it('sets expiresAt based on retentionHours', async () => {
    mockRetentionHours = '24'
    const workDir = join(testRoot, 'workdir_expiry')
    const artifactsDir = runArtifactsDir(workDir, 'run_exp')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'file.txt'), 'data')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const before = Date.now()
    await scanAndRegisterArtifacts('run_exp', 'agt_1', 'usr_1', workDir, 'run_exp')
    const after = Date.now()

    const record = mockValues.mock.calls[0][0] as { expiresAt: Date }
    const expiresMs = record.expiresAt.getTime()
    expect(expiresMs).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000)
    expect(expiresMs).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000)
  })

  it('sets null expiresAt when retentionHours is 0', async () => {
    mockRetentionHours = '0'
    const workDir = join(testRoot, 'workdir_noexpiry')
    const artifactsDir = runArtifactsDir(workDir, 'run_0h')
    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, 'file.txt'), 'data')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_0h', 'agt_1', 'usr_1', workDir, 'run_0h')

    const record = mockValues.mock.calls[0][0] as { expiresAt: unknown }
    expect(record.expiresAt).toBeUndefined()
  })

  it('skips empty subdirectories inside artifacts dir', async () => {
    const workDir = join(testRoot, 'workdir_subdir')
    const artifactsDir = runArtifactsDir(workDir, 'run_sub')
    mkdirSync(join(artifactsDir, 'subdir'), { recursive: true })
    writeFileSync(join(artifactsDir, 'file.txt'), 'ok')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_sub', 'agt_1', 'usr_1', workDir, 'run_sub')

    // Only the file should be registered, not the empty subdir
    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    const record = mockValues.mock.calls[0][0] as { filename: string }
    expect(record.filename).toBe('file.txt')
  })

  it('registers a non-empty subdirectory as a directory artifact with recursive size', async () => {
    const workDir = join(testRoot, 'workdir_dir_artifact')
    const artifactsDir = runArtifactsDir(workDir, 'run_dir')
    const siteDir = join(artifactsDir, 'site')
    mkdirSync(join(siteDir, 'assets'), { recursive: true })
    writeFileSync(join(siteDir, 'index.html'), '<html>hi</html>')
    writeFileSync(join(siteDir, 'assets', 'app.css'), 'body{}')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts('run_dir', 'agt_1', 'usr_1', workDir, 'run_dir')

    expect(result).toHaveLength(1)
    expect(result[0].kind).toBe('directory')
    expect(result[0].filename).toBe('site')
    const record = mockValues.mock.calls[0][0] as {
      kind: string
      mimeType: string | null
      size: number
    }
    expect(record.kind).toBe('directory')
    expect(record.mimeType).toBeNull()
    expect(record.size).toBe(Buffer.byteLength('<html>hi</html>') + Buffer.byteLength('body{}'))
    // 嵌套文件被复制到隔离存储
    expect(existsSync(join(result[0].storagePath, 'index.html'))).toBe(true)
    expect(existsSync(join(result[0].storagePath, 'assets', 'app.css'))).toBe(true)
  })

  it('skips symlinks nested inside a directory artifact', async () => {
    const workDir = join(testRoot, 'workdir_dir_symlink')
    const artifactsDir = runArtifactsDir(workDir, 'run_dir_sym')
    const pkgDir = join(artifactsDir, 'pkg')
    mkdirSync(pkgDir, { recursive: true })
    const sensitiveFile = join(testRoot, 'nested-sensitive.txt')
    writeFileSync(sensitiveFile, 'secret data')
    symlinkSync(sensitiveFile, join(pkgDir, 'leak.txt'))
    writeFileSync(join(pkgDir, 'real.txt'), 'real')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts(
      'run_dir_sym',
      'agt_1',
      'usr_1',
      workDir,
      'run_dir_sym',
    )

    expect(result).toHaveLength(1)
    expect(existsSync(join(result[0].storagePath, 'real.txt'))).toBe(true)
    expect(existsSync(join(result[0].storagePath, 'leak.txt'))).toBe(false)
  })

  it('skips symlinks in artifacts dir', async () => {
    const workDir = join(testRoot, 'workdir_symlink')
    const artifactsDir = runArtifactsDir(workDir, 'run_sym')
    mkdirSync(artifactsDir, { recursive: true })
    // Create a real file outside artifacts dir (simulating sensitive file)
    const sensitiveFile = join(testRoot, 'sensitive.txt')
    writeFileSync(sensitiveFile, 'secret data')
    // Create a symlink pointing to the sensitive file
    symlinkSync(sensitiveFile, join(artifactsDir, 'symlink.txt'))
    // Also create a legit file
    writeFileSync(join(artifactsDir, 'legit.txt'), 'legit content')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts('run_sym', 'agt_1', 'usr_1', workDir, 'run_sym')

    // Only the legit file should be registered
    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    const record = mockValues.mock.calls[0][0] as { filename: string }
    expect(record.filename).toBe('legit.txt')
    expect(result.map((r) => r.filename)).not.toContain('symlink.txt')
  })

  it('records correct size for each file', async () => {
    const workDir = join(testRoot, 'workdir_size')
    const artifactsDir = runArtifactsDir(workDir, 'run_size')
    mkdirSync(artifactsDir, { recursive: true })
    const content = 'hello world'
    writeFileSync(join(artifactsDir, 'sized.txt'), content)

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    await scanAndRegisterArtifacts('run_size', 'agt_1', 'usr_1', workDir, 'run_size')

    const record = mockValues.mock.calls[0][0] as { size: number }
    expect(record.size).toBe(Buffer.byteLength(content))
  })

  it('leaves a previous run output in place instead of re-registering it', async () => {
    const workDir = join(testRoot, 'workdir_previous')
    // The run before this one, in the same workspace. Its directory survives
    // only when cleanup could not run (a crashed process); either way it is not
    // this run's to collect, and no timestamp comparison decides that.
    const previousDir = runArtifactsDir(workDir, 'run_previous')
    mkdirSync(previousDir, { recursive: true })
    writeFileSync(join(previousDir, 'old-report.md'), 'previous conversation output')

    const mineDir = runArtifactsDir(workDir, 'run_mine')
    mkdirSync(mineDir, { recursive: true })
    writeFileSync(join(mineDir, 'new-report.md'), 'fresh artifact')

    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts('run_mine', 'agt_1', 'usr_1', workDir, 'run_mine')

    expect(mockDbInsert).toHaveBeenCalledTimes(1)
    const record = mockValues.mock.calls[0][0] as { filename: string }
    expect(record.filename).toBe('new-report.md')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'art_test123', filename: 'new-report.md' })
    expect(result[0].storagePath).toBeTruthy()
    expect(existsSync(join(previousDir, 'old-report.md'))).toBe(true)
  })

  it('ignores what a concurrent run wrote into the shared workspace, however fresh', async () => {
    const workDir = join(testRoot, 'workdir_concurrent')
    // A sibling run — another Feishu conversation, or another Agent bound to the
    // same SCM checkout — producing its report while this run is still open.
    // Its mtime is deliberately *newer* than this run's start: that is exactly
    // the case the old mtime heuristic mis-attributed, handing one
    // conversation's file to another conversation's user.
    const siblingDir = join(workDir, 'artifacts', 'run_sibling')
    mkdirSync(siblingDir, { recursive: true })
    const siblingFile = join(siblingDir, 'price-tiers.csv')
    writeFileSync(siblingFile, 'a different conversation output')
    const runStartedAt = Date.now()
    utimesSync(siblingFile, new Date(runStartedAt + 1_000), new Date(runStartedAt + 1_000))

    const result = await scanAndRegisterArtifacts('run_mine', 'agt_1', 'usr_1', workDir, 'run_mine')

    expect(result).toEqual([])
    expect(mockDbInsert).not.toHaveBeenCalled()
  })

  it('registers only its own directory when two runs share one workspace', async () => {
    const workDir = join(testRoot, 'workdir_two_runs')
    mkdirSync(join(workDir, 'artifacts', 'run_sibling'), { recursive: true })
    writeFileSync(join(workDir, 'artifacts', 'run_sibling', 'theirs.md'), 'theirs')
    mkdirSync(join(workDir, 'artifacts', 'run_mine'), { recursive: true })
    writeFileSync(join(workDir, 'artifacts', 'run_mine', 'mine.md'), 'mine')

    const result = await scanAndRegisterArtifacts('run_mine', 'agt_1', 'usr_1', workDir, 'run_mine')

    expect(result.map((r) => r.filename)).toEqual(['mine.md'])
  })

  it('names files written above the run directory, once per workspace', async () => {
    const workDir = join(testRoot, 'workdir_stray')
    mkdirSync(join(workDir, 'artifacts'), { recursive: true })
    // An Agent that hardcoded a relative `artifacts/`: nothing is collected, and
    // without this warning the author has no way to see why.
    writeFileSync(join(workDir, 'artifacts', 'misplaced.md'), 'written to the wrong level')

    const result = await scanAndRegisterArtifacts('run_mine', 'agt_1', 'usr_1', workDir, 'run_mine')

    expect(result).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ entries: ['misplaced.md'] }),
      expect.stringContaining('workspace artifacts directory'),
    )

    // A workspace holding pre-existing top-level files would otherwise repeat
    // this on every artifact-less run for the rest of the process's life.
    vi.mocked(logger.warn).mockClear()
    await scanAndRegisterArtifacts('run_later', 'agt_1', 'usr_1', workDir, 'run_later')
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('does not mistake another execution scratch directory for a misplaced file', async () => {
    const workDir = join(testRoot, 'workdir_eval_neighbour')
    // Evaluation turns get a taskId of their own (`eval/<task>/<case>/<n>`), so
    // their directory carries no `run_` prefix. On a P4 source, which shares one
    // checkout between evaluations and chat, telling the author to "write to
    // $A2WAVE_ARTIFACTS_DIR" about a directory they wrote there correctly is
    // worse than saying nothing.
    mkdirSync(join(workDir, 'artifacts', 'eval_evt_1_evc_1_1'), { recursive: true })
    writeFileSync(join(workDir, 'artifacts', 'eval_evt_1_evc_1_1', 'replay.md'), 'eval output')

    const result = await scanAndRegisterArtifacts('run_mine', 'agt_1', 'usr_1', workDir, 'run_mine')

    expect(result).toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('reads the directory the engine derived from the task id, not from the run id', async () => {
    // A2A hands the engine the caller's protocol task id as-is — no `run_`
    // segment anywhere in it — so the engine's $A2WAVE_ARTIFACTS_DIR is keyed
    // by that id. The collector must look in the same place, while the
    // registration itself still belongs to the platform run.
    const workDir = join(testRoot, 'workdir_a2a')
    const engineDir = join(workDir, 'artifacts', 'a2a-task-9f1c')
    mkdirSync(engineDir, { recursive: true })
    writeFileSync(join(engineDir, 'report.md'), '# via A2A')
    const mockValues = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbInsert.mockReturnValue(asyncQuery({ values: mockValues }))

    const result = await scanAndRegisterArtifacts(
      'run_a2a',
      'agt_1',
      'usr_1',
      workDir,
      'a2a-task-9f1c',
    )

    expect(result).toHaveLength(1)
    expect(result[0].filename).toBe('report.md')
    const inserted = (mockValues.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(inserted.runId).toBe('run_a2a')
  })

  it('warns once and collects nothing when the workspace artifacts path is a plain file', async () => {
    // A repo that tracks a top-level file named `artifacts`: neither the run
    // directory nor the stray scan can exist under it. That is a zero-artifact
    // run, not a registration failure.
    const workDir = join(testRoot, 'workdir_file')
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(workDir, 'artifacts'), 'not a directory')

    await expect(
      scanAndRegisterArtifacts('run_mine', 'agt_1', 'usr_1', workDir, 'run_mine'),
    ).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceLevelDir: join(workDir, 'artifacts') }),
      expect.stringContaining('not a directory'),
    )
  })

  it('warns and collects nothing when the run directory itself is a plain file', async () => {
    const workDir = join(testRoot, 'workdir_rundir_file')
    mkdirSync(join(workDir, 'artifacts'), { recursive: true })
    writeFileSync(runArtifactsDir(workDir, 'run_mine'), 'I should have been a directory')

    await expect(
      scanAndRegisterArtifacts('run_mine', 'agt_1', 'usr_1', workDir, 'run_mine'),
    ).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDir: runArtifactsDir(workDir, 'run_mine') }),
      expect.stringContaining('not a directory'),
    )
  })

  it('collects what an earlier attempt of the same run produced', async () => {
    const workDir = join(testRoot, 'workdir_resumed')
    // A run interrupted by a restart is requeued under its own runId and
    // resumes its provider session. Its earlier attempt's output is this run's
    // own work, for this same user and request — dropping it would throw away
    // exactly what the resume exists to preserve.
    const mineDir = runArtifactsDir(workDir, 'run_resumed')
    mkdirSync(mineDir, { recursive: true })
    const earlier = join(mineDir, 'from-first-attempt.md')
    writeFileSync(earlier, 'written before the process died')
    utimesSync(earlier, new Date(Date.now() - 600_000), new Date(Date.now() - 600_000))

    const result = await scanAndRegisterArtifacts(
      'run_resumed',
      'agt_1',
      'usr_1',
      workDir,
      'run_resumed',
    )

    expect(result.map((r) => r.filename)).toEqual(['from-first-attempt.md'])
  })
})

describe('discardRunArtifactsDir', () => {
  it('removes only the run own directory, leaving a concurrent run untouched', async () => {
    const workDir = join(testRoot, 'workdir_discard')
    const mine = runArtifactsDir(workDir, 'run_mine')
    const sibling = runArtifactsDir(workDir, 'run_sibling')
    mkdirSync(join(mine, 'nested'), { recursive: true })
    writeFileSync(join(mine, 'nested', 'deep.md'), 'mine')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'theirs.md'), 'theirs')
    writeFileSync(join(workDir, 'artifacts', 'top-level.md'), 'not mine either')

    await discardRunArtifactsDir(workDir, 'run_mine')

    expect(existsSync(mine)).toBe(false)
    expect(existsSync(join(sibling, 'theirs.md'))).toBe(true)
    expect(existsSync(join(workDir, 'artifacts', 'top-level.md'))).toBe(true)
    expect(existsSync(join(workDir, 'artifacts'))).toBe(true)
  })

  it('removes the directory the engine derived from a task id without a run segment', async () => {
    const workDir = join(testRoot, 'workdir_discard_a2a')
    const engineDir = join(workDir, 'artifacts', 'a2a-task-9f1c')
    mkdirSync(engineDir, { recursive: true })
    writeFileSync(join(engineDir, 'report.md'), 'via A2A')

    await discardRunArtifactsDir(workDir, 'a2a-task-9f1c')

    expect(existsSync(engineDir)).toBe(false)
  })

  it('does nothing when the run had no workDir', async () => {
    await expect(discardRunArtifactsDir(undefined, 'run_mine')).resolves.toBeUndefined()
  })
})

describe('deleteExpiredArtifacts', () => {
  it('does nothing when no expired artifacts', async () => {
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue([]) })),
        }),
      }),
    )

    await deleteExpiredArtifacts()
    expect(mockDbDelete).not.toHaveBeenCalled()
  })

  it('deletes file from disk and DB for each expired artifact', async () => {
    const artifactFile = join(testRoot, 'expired_file.txt')
    writeFileSync(artifactFile, 'old data')
    expect(existsSync(artifactFile)).toBe(true)

    const mockWhere = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbDelete.mockReturnValue(asyncQuery({ where: mockWhere }))
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              all: vi.fn().mockReturnValue([{ id: 'art_expired1', storagePath: artifactFile }]),
            }),
          ),
        }),
      }),
    )

    await deleteExpiredArtifacts()

    // File should be removed from disk
    expect(existsSync(artifactFile)).toBe(false)
    // DB delete should be called
    expect(mockDbDelete).toHaveBeenCalledTimes(1)
    expect(mockWhere).toHaveBeenCalledTimes(1)
  })

  it('handles multiple expired artifacts', async () => {
    const file1 = join(testRoot, 'exp1.txt')
    const file2 = join(testRoot, 'exp2.txt')
    writeFileSync(file1, 'a')
    writeFileSync(file2, 'b')

    const mockWhere = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbDelete.mockReturnValue(asyncQuery({ where: mockWhere }))
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              all: vi.fn().mockReturnValue([
                { id: 'art_1', storagePath: file1 },
                { id: 'art_2', storagePath: file2 },
              ]),
            }),
          ),
        }),
      }),
    )

    await deleteExpiredArtifacts()

    expect(existsSync(file1)).toBe(false)
    expect(existsSync(file2)).toBe(false)
    expect(mockDbDelete).toHaveBeenCalledTimes(2)
  })

  // Regression: deleteStaleShares became async during the PostgreSQL migration
  // but the call site kept firing it without await. The notExists(...) exemption
  // in the expired-artifact query reads artifact_shares, so it still saw the
  // stale rows and every expired artifact stayed exempt from collection.
  it('finishes collapsing stale shares before querying expired artifacts', async () => {
    let selectCallsWhenSweepFinished: number | undefined
    vi.mocked(deleteStaleShares).mockImplementationOnce(async () => {
      // Yield so an unawaited caller would have raced ahead to the select.
      await new Promise((resolve) => setTimeout(resolve, 0))
      selectCallsWhenSweepFinished = mockDbSelect.mock.calls.length
    })
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(asyncQuery({ all: vi.fn().mockReturnValue([]) })),
        }),
      }),
    )

    await deleteExpiredArtifacts()

    // The exemption subquery must not have run against un-collapsed share rows.
    expect(selectCallsWhenSweepFinished).toBe(0)
    expect(mockDbSelect).toHaveBeenCalled()
  })

  it('continues cleanup even when a file is missing from disk', async () => {
    const missingPath = join(testRoot, 'nonexistent_file.txt')
    // Do NOT create the file

    const mockWhere = vi.fn().mockReturnValue(asyncQuery({ run: vi.fn() }))
    mockDbDelete.mockReturnValue(asyncQuery({ where: mockWhere }))
    mockDbSelect.mockReturnValue(
      asyncQuery({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue(
            asyncQuery({
              all: vi.fn().mockReturnValue([{ id: 'art_missing', storagePath: missingPath }]),
            }),
          ),
        }),
      }),
    )

    // Should not reject even though file doesn't exist
    await expect(deleteExpiredArtifacts()).resolves.not.toThrow()
    expect(mockDbDelete).toHaveBeenCalledTimes(1)
  })
})
