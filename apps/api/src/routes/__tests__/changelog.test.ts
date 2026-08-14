import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

describe('resolveChangelogPath', () => {
  it('finds the repo-root CHANGELOG.md from the tsx source layout (4 levels up)', async () => {
    const { resolveChangelogPath } = await import('../changelog.js')
    const exists = (path: string) => path === '/repo/CHANGELOG.md'
    expect(resolveChangelogPath('/repo/apps/api/src/routes', exists)).toBe('/repo/CHANGELOG.md')
  })

  it('finds /app/CHANGELOG.md from the bundled dist layout in the Docker image', async () => {
    // Regression: the hardcoded 4-level walk resolved to /CHANGELOG.md from
    // /app/apps/api/dist, so the endpoint served empty content in the image.
    const { resolveChangelogPath } = await import('../changelog.js')
    const exists = (path: string) => path === '/app/CHANGELOG.md'
    expect(resolveChangelogPath('/app/apps/api/dist', exists)).toBe('/app/CHANGELOG.md')
  })

  it('returns null when no CHANGELOG.md exists on the way to the filesystem root', async () => {
    const { resolveChangelogPath } = await import('../changelog.js')
    expect(resolveChangelogPath('/nowhere/deep/dir', () => false)).toBeNull()
  })
})

describe('Changelog routes', () => {
  let app: Hono

  beforeEach(async () => {
    vi.clearAllMocks()
    const mod = await import('../changelog.js')
    app = new Hono()
    app.route('/api/changelog', mod.default)
  })

  describe('GET /', () => {
    it('returns changelog content when file exists', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue('## v0.3.4\n\n- 变更摘要')

      const res = await app.request('/api/changelog')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body).toEqual({ content: '## v0.3.4\n\n- 变更摘要' })
      expect(res.headers.get('Cache-Control')).toBe('no-store')
    })

    it('returns empty content when file does not exist', async () => {
      mockExistsSync.mockReturnValue(false)

      const res = await app.request('/api/changelog')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body).toEqual({ content: '' })
      expect(mockReadFileSync).not.toHaveBeenCalled()
    })

    it('returns empty content on read error', async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockImplementation(() => {
        throw new Error('read error')
      })

      const res = await app.request('/api/changelog')
      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body).toEqual({ content: '' })
    })
  })
})
