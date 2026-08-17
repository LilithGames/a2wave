import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execSyncMock = vi.fn()
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    execSync: (...args: unknown[]) => execSyncMock(...args),
  }
})

import version from '../version.js'

beforeEach(() => {
  execSyncMock.mockReset()
  delete process.env.APP_VERSION
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildApp() {
  return new Hono().route('/version', version)
}

describe('routes/version', () => {
  it('returns the version resolved from `git describe`', async () => {
    execSyncMock.mockReturnValue(Buffer.from('v1.2.3\n'))

    const res = await buildApp().request('/version')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version: 'v1.2.3' })
  })

  it('prefers APP_VERSION env over `git describe`', async () => {
    process.env.APP_VERSION = '9.9.9'

    const res = await buildApp().request('/version')
    expect(await res.json()).toEqual({ version: '9.9.9' })
    expect(execSyncMock).not.toHaveBeenCalled()
  })

  it('falls back to "dev" outside a git checkout', async () => {
    execSyncMock.mockImplementation(() => {
      throw new Error('not a git repo')
    })

    const res = await buildApp().request('/version')
    expect(await res.json()).toEqual({ version: 'dev' })
  })

  /**
   * The login page is unauthenticated, so this endpoint must answer without a
   * session — and must stay a bare version string. Anything heavier (DB, disk,
   * engine probes) belongs on /health, which is what this route exists to avoid
   * dragging into a public page load.
   */
  it('answers without credentials and exposes nothing but the version', async () => {
    execSyncMock.mockReturnValue(Buffer.from('v1.2.3\n'))

    const res = await buildApp().request('/version')
    expect(res.status).toBe(200)
    expect(Object.keys((await res.json()) as object)).toEqual(['version'])
  })
})
