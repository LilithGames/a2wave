import { existsSync } from 'node:fs'
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest'

const mockExecCli = vi.hoisted(() => vi.fn())
vi.mock('../../engine/cli-spawn.js', () => ({ execCli: mockExecCli }))
vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), update: vi.fn() },
}))
vi.mock('../../db/schema.js', () => ({
  scmSources: { id: 'scmSources.id', codegraphStatus: 'scmSources.codegraphStatus' },
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { db } from '../../db/client.js'
import { runCodegraphForPath, runCodegraphIndex } from '../codegraph-index.js'

import { asyncQuery } from '../../test/async-query.js'

const mockExistsSync = vi.mocked(existsSync)

function mockCodegraphSuccess(stdout = 'ok') {
  mockExecCli.mockResolvedValue({ stdout, stderr: '' })
}

function mockSource(source: unknown) {
  ;(db.select as Mock).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(
        asyncQuery({
          get: vi.fn().mockReturnValue(source),
        }),
      ),
    }),
  })
}

function mockAcquire(result: unknown) {
  return mockUpdates([result])
}

function mockUpdates(results: unknown[]) {
  const setCalls: unknown[] = []
  let index = 0
  ;(db.update as Mock).mockImplementation(() => ({
    set: vi.fn((payload: unknown) => {
      setCalls.push(payload)
      return {
        where: vi.fn().mockReturnValue(
          asyncQuery({
            returning: vi.fn().mockReturnValue(
              asyncQuery({
                get: vi.fn().mockReturnValue(results[index++]),
              }),
            ),
            run: vi.fn(),
          }),
        ),
      }
    }),
  }))
  return { setCalls }
}

describe('runCodegraphForPath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecCli.mockReset()
  })

  it('initializes CodeGraph when the index directory is missing', async () => {
    mockExistsSync.mockReturnValue(false)
    mockCodegraphSuccess('initialized')

    const result = await runCodegraphForPath('/repo')

    expect(result).toEqual({ ok: true, message: 'initialized', mode: 'init' })
    expect(mockExecCli.mock.calls[0][0]).toBe('codegraph')
    expect(mockExecCli.mock.calls[0][1]).toEqual(['init', '/repo'])
  })

  it('syncs CodeGraph when an index already exists', async () => {
    mockExistsSync.mockReturnValue(true)
    mockCodegraphSuccess('synced')

    const result = await runCodegraphForPath('/repo')

    expect(result).toEqual({ ok: true, message: 'synced', mode: 'sync' })
    expect(mockExecCli.mock.calls[0][1]).toEqual(['sync', '/repo'])
  })

  it('sanitizes successful CodeGraph output before returning it', async () => {
    mockExistsSync.mockReturnValue(false)
    mockCodegraphSuccess(
      'indexed http://user:secret@example.com/repo.git?access_token=abc&P4PASSWD=hunter2',
    )

    const result = await runCodegraphForPath('/repo')

    expect(result.ok).toBe(true)
    expect(result.message).toContain('http://***@example.com')
    expect(result.message).toContain('access_token=***')
    expect(result.message).toContain('P4PASSWD=***')
    expect(result.message).not.toContain('secret')
    expect(result.message).not.toContain('hunter2')
  })

  it('returns a sanitized failure without throwing', async () => {
    mockExistsSync.mockReturnValue(true)
    mockExecCli.mockRejectedValue(
      Object.assign(new Error('Command failed: codegraph sync /repo'), {
        stderr: 'bad token https://user:secret@example.com/repo.git?token=abc P4PASSWD=hunter2',
      }),
    )

    const result = await runCodegraphForPath('/repo')

    expect(result.ok).toBe(false)
    expect(result.mode).toBe('sync')
    expect(result.message).toContain('bad token')
    expect(result.message).toContain('https://***@example.com')
    expect(result.message).toContain('token=***')
    expect(result.message).toContain('P4PASSWD=***')
    expect(result.message).not.toContain('secret')
    expect(result.message).not.toContain('hunter2')
  })

  it('returns a default failure message when CodeGraph produces no diagnostic output', async () => {
    mockExistsSync.mockReturnValue(false)
    mockExecCli.mockRejectedValue(new Error(''))

    const result = await runCodegraphForPath('/repo')

    expect(result).toEqual({ ok: false, message: 'CodeGraph init failed', mode: 'init' })
  })
})

describe('runCodegraphIndex', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockExecCli.mockReset()
  })

  it('returns not found without updating state', async () => {
    mockSource(undefined)

    const result = await runCodegraphIndex('missing')

    expect(result).toEqual({ ok: false, message: 'SCM source not found' })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('finalizes the pre-acquired lock when the source disappears before indexing starts', async () => {
    mockSource(undefined)
    const { setCalls } = mockUpdates([{ id: 'scm_1' }])

    const result = await runCodegraphIndex('scm_1', { alreadyAcquired: true })

    expect(result).toEqual({ ok: false, message: 'SCM source not found' })
    expect(setCalls[0]).toMatchObject({
      codegraphStatus: 'error',
      codegraphLastError: 'SCM source not found',
    })
  })

  it('skips disabled sources without acquiring a lock', async () => {
    mockSource({
      id: 'scm_1',
      localPath: '/repo',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git' },
    })

    const result = await runCodegraphIndex('scm_1')

    expect(result).toEqual({ ok: true, message: 'CodeGraph disabled', skipped: true })
    expect(db.update).not.toHaveBeenCalled()
  })

  it('finalizes the pre-acquired lock when CodeGraph is disabled before indexing starts', async () => {
    mockSource({
      id: 'scm_1',
      localPath: '/repo',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git' },
    })
    const { setCalls } = mockUpdates([{ id: 'scm_1' }])

    const result = await runCodegraphIndex('scm_1', { alreadyAcquired: true })

    expect(result).toEqual({ ok: true, message: 'CodeGraph disabled', skipped: true })
    expect(setCalls[0]).toMatchObject({
      codegraphStatus: 'idle',
      codegraphLastError: null,
    })
  })

  it('skips without executing CodeGraph when another index job holds the lock', async () => {
    mockSource({
      id: 'scm_1',
      localPath: '/repo',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', codegraphEnabled: true },
      codegraphLastIndexedAt: null,
    })
    mockAcquire(undefined)

    const result = await runCodegraphIndex('scm_1')

    expect(result).toEqual({
      ok: true,
      message: 'CodeGraph indexing already in progress',
      skipped: true,
      conflict: true,
    })
    expect(mockExecCli.mock.calls).toHaveLength(0)
  })

  it('marks a successful index idle, clears the last error, and stores last indexed time', async () => {
    mockSource({
      id: 'scm_1',
      localPath: '/repo',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', codegraphEnabled: true },
      codegraphLastIndexedAt: null,
    })
    const { setCalls } = mockUpdates([{ id: 'scm_1' }, { id: 'scm_1' }])
    mockExistsSync.mockReturnValue(true)
    mockCodegraphSuccess('synced')

    const result = await runCodegraphIndex('scm_1')

    expect(result).toEqual({ ok: true, message: 'synced', mode: 'sync' })
    expect(setCalls[0]).toMatchObject({ codegraphStatus: 'indexing', codegraphLastError: null })
    expect(setCalls[1]).toMatchObject({ codegraphStatus: 'idle', codegraphLastError: null })
    expect(
      (setCalls[1] as { codegraphLastIndexedAt?: unknown }).codegraphLastIndexedAt,
    ).toBeInstanceOf(Date)
  })

  it('marks a failed index as error, keeps the previous indexed time, and sanitizes the error', async () => {
    const lastIndexedAt = new Date('2026-01-01T00:00:00.000Z')
    mockSource({
      id: 'scm_1',
      localPath: '/repo',
      config: { type: 'git', repoUrl: 'https://github.com/org/repo.git', codegraphEnabled: true },
      codegraphLastIndexedAt: lastIndexedAt,
    })
    const { setCalls } = mockUpdates([{ id: 'scm_1' }, { id: 'scm_1' }])
    mockExistsSync.mockReturnValue(true)
    mockExecCli.mockRejectedValue(
      Object.assign(new Error('Command failed'), {
        stderr: 'fatal: https://user:secret@example.com/org/repo.git failed',
      }),
    )

    const result = await runCodegraphIndex('scm_1')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('https://***@example.com')
    expect(result.message).not.toContain('secret')
    expect(setCalls[1]).toMatchObject({
      codegraphStatus: 'error',
      codegraphLastIndexedAt: lastIndexedAt,
      codegraphLastError: result.message,
    })
  })
})
