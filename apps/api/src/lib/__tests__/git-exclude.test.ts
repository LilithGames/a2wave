import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendGitExcludePatterns } from '../git-exclude.js'

const peerAppend = vi.hoisted(() => ({ pending: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const snapshot = await actual.readFile(...args)
      if (peerAppend.pending) {
        peerAppend.pending = false
        // A different process has its own mutex and may append after our read.
        await actual.writeFile(String(args[0]), '\n/peer-mcp.json\n', { flag: 'a' })
      }
      return snapshot
    },
  }
})

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'git-exclude-test-'))
})
afterEach(async () => {
  peerAppend.pending = false
  await rm(root, { recursive: true, force: true })
})

describe('appendGitExcludePatterns', () => {
  it('creates missing directories and does not duplicate existing rules', async () => {
    const file = join(root, 'info', 'exclude')
    await appendGitExcludePatterns(file, ['/mcp.json', '/mcp.json'])
    const initial = await readFile(file, 'utf-8')
    await appendGitExcludePatterns(file, ['/mcp.json'])
    expect(await readFile(file, 'utf-8')).toBe(initial)
    expect(initial.split('\n').filter((line) => line === '/mcp.json')).toHaveLength(1)
  })

  it('preserves peer rules appended after its snapshot and an unterminated user rule', async () => {
    const file = join(root, 'exclude')
    await writeFile(file, '/user-file')
    peerAppend.pending = true
    await appendGitExcludePatterns(file, ['/local-mcp.json'])
    const lines = (await readFile(file, 'utf-8')).split('\n')
    expect(lines).toContain('/user-file')
    expect(lines).toContain('/peer-mcp.json')
    expect(lines).toContain('/local-mcp.json')
    await appendGitExcludePatterns(file, ['/another-mcp.json'])
    expect((await readFile(file, 'utf-8')).match(/# a2wave:/g)).toHaveLength(1)
  })

  it('does not mistake a read failure for a missing exclude file', async () => {
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'existing content')
    await expect(
      appendGitExcludePatterns(join(file, 'exclude'), ['/mcp.json']),
    ).rejects.toMatchObject({
      code: 'ENOTDIR',
    })
    expect(await readFile(file, 'utf-8')).toBe('existing content')
  })
})
