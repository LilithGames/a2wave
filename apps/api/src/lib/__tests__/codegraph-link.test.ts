import { existsSync } from 'node:fs'
import { lstat, mkdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { ensureCodegraphLink } from '../codegraph-index.js'

const TEST_DIR = join(tmpdir(), `codegraph-link-test-${Date.now()}`)
const LOCAL_PATH = join(TEST_DIR, 'source')
const WS_PATH = join(TEST_DIR, 'workspace')

describe('ensureCodegraphLink', () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
    await mkdir(LOCAL_PATH, { recursive: true })
    await mkdir(WS_PATH, { recursive: true })
  })

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true })
  })

  it('links the source index into the workspace', async () => {
    await mkdir(join(LOCAL_PATH, '.codegraph'))
    await writeFile(join(LOCAL_PATH, '.codegraph', 'index.db'), 'data')

    await ensureCodegraphLink(WS_PATH, LOCAL_PATH)

    expect(await readlink(join(WS_PATH, '.codegraph'))).toBe(join(LOCAL_PATH, '.codegraph'))
    expect(existsSync(join(WS_PATH, '.codegraph', 'index.db'))).toBe(true)
  })

  it('is idempotent across repeated calls', async () => {
    await mkdir(join(LOCAL_PATH, '.codegraph'))

    await ensureCodegraphLink(WS_PATH, LOCAL_PATH)
    await ensureCodegraphLink(WS_PATH, LOCAL_PATH)

    expect((await lstat(join(WS_PATH, '.codegraph'))).isSymbolicLink()).toBe(true)
  })

  it('does nothing when the source has no index', async () => {
    await ensureCodegraphLink(WS_PATH, LOCAL_PATH)
    expect(existsSync(join(WS_PATH, '.codegraph'))).toBe(false)
  })

  it('never overwrites an existing real entry in the workspace', async () => {
    await mkdir(join(LOCAL_PATH, '.codegraph'))
    await mkdir(join(WS_PATH, '.codegraph'))
    await writeFile(join(WS_PATH, '.codegraph', 'local.txt'), 'mine')

    await ensureCodegraphLink(WS_PATH, LOCAL_PATH)

    expect((await lstat(join(WS_PATH, '.codegraph'))).isDirectory()).toBe(true)
    expect(existsSync(join(WS_PATH, '.codegraph', 'local.txt'))).toBe(true)
  })

  it('repairs a resolving link that points at a stale source location', async () => {
    // localPath edited while the old checkout still exists on disk: the link
    // resolves, but to an index of code the workspace no longer contains.
    const oldLocal = join(TEST_DIR, 'old-source')
    await mkdir(join(oldLocal, '.codegraph'), { recursive: true })
    await mkdir(join(LOCAL_PATH, '.codegraph'), { recursive: true })
    await symlink(join(oldLocal, '.codegraph'), join(WS_PATH, '.codegraph'), 'dir')

    await ensureCodegraphLink(WS_PATH, LOCAL_PATH)

    expect(await readlink(join(WS_PATH, '.codegraph'))).toBe(join(LOCAL_PATH, '.codegraph'))
  })

  it('repairs a dangling link left by a relocated source', async () => {
    await mkdir(join(LOCAL_PATH, '.codegraph'))
    await symlink(join(TEST_DIR, 'gone', '.codegraph'), join(WS_PATH, '.codegraph'), 'dir')

    await ensureCodegraphLink(WS_PATH, LOCAL_PATH)

    expect(await readlink(join(WS_PATH, '.codegraph'))).toBe(join(LOCAL_PATH, '.codegraph'))
  })
})
