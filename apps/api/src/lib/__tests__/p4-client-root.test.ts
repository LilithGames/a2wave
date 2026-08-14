import { describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: { SCM_STORAGE_ROOT: '/data/workspace' },
}))

import { verifyP4ClientRootCoverage } from '../p4-client-root.js'

/**
 * The one place that decides whether a P4 client's Root covers a checkout path.
 *
 * checkP4Connection and executeP4Sync used to implement this separately: the
 * sync side gated the whole check behind isManagedLocalPath (dead code, since
 * P4 sources cannot use managed paths), so a Root mismatch the connection check
 * reported in red was silently ignored by the sync that followed.
 */
describe('verifyP4ClientRootCoverage', () => {
  const covering = 'Root:\t/mnt/p4ws\n'

  it('passes when the Root covers the local path', async () => {
    const verdict = await verifyP4ClientRootCoverage({
      localPath: '/mnt/p4ws/main',
      infoOutput: 'Server address: p4:1666\n',
      readClientSpec: async () => covering,
      clientName: 'ws',
    })

    expect(verdict.outcome).toBe('covered')
  })

  it('reports a mismatch when the Root does not cover the local path', async () => {
    const verdict = await verifyP4ClientRootCoverage({
      localPath: '/data/workspace/main',
      infoOutput: 'Server address: p4:1666\n',
      readClientSpec: async () => covering,
      clientName: 'ws',
    })

    expect(verdict.outcome).toBe('not-covered')
    if (verdict.outcome !== 'not-covered') return
    expect(verdict.clientRoot).toBe('/mnt/p4ws')
  })

  // A client that does not exist yet answers `p4 client -o` with a template
  // spec whose Root is the API process cwd — never a real mismatch.
  it('reports the client as missing rather than a Root mismatch', async () => {
    const verdict = await verifyP4ClientRootCoverage({
      localPath: '/mnt/p4ws/main',
      infoOutput: 'Server address: p4:1666\nClient unknown.\n',
      readClientSpec: async () => 'Root:\t/app\n',
      clientName: 'builder-ws',
    })

    expect(verdict.outcome).toBe('client-missing')
    if (verdict.outcome !== 'client-missing') return
    expect(verdict.detail).toContain('builder-ws')
  })

  // Both callers must degrade the same way: an unreadable spec is not evidence
  // of a mismatch, so it can never become a hard failure on its own.
  it('reports indeterminate when the client spec cannot be read', async () => {
    const verdict = await verifyP4ClientRootCoverage({
      localPath: '/mnt/p4ws/main',
      infoOutput: 'Server address: p4:1666\n',
      readClientSpec: async () => {
        throw new Error('timeout reading client spec')
      },
      clientName: 'ws',
    })

    expect(verdict.outcome).toBe('indeterminate')
    if (verdict.outcome !== 'indeterminate') return
    expect(verdict.detail).toContain('timeout')
  })

  it('reports indeterminate when the spec declares no absolute root', async () => {
    const verdict = await verifyP4ClientRootCoverage({
      localPath: '/mnt/p4ws/main',
      infoOutput: 'Server address: p4:1666\n',
      readClientSpec: async () => 'Owner:\tbob\n',
      clientName: 'ws',
    })

    expect(verdict.outcome).toBe('indeterminate')
  })

  it('honours an AltRoots entry that shares the label line', async () => {
    const verdict = await verifyP4ClientRootCoverage({
      localPath: '/mnt/alt/main',
      infoOutput: 'Server address: p4:1666\n',
      readClientSpec: async () => 'Root:\t/mnt/p4ws\nAltRoots:\t/mnt/alt\n\t/mnt/alt2\n',
      clientName: 'ws',
    })

    expect(verdict.outcome).toBe('covered')
  })

  it('redacts credentials from an unreadable-spec detail', async () => {
    const verdict = await verifyP4ClientRootCoverage({
      localPath: '/mnt/p4ws/main',
      infoOutput: 'Server address: p4:1666\n',
      readClientSpec: async () => {
        throw new Error('failed for p4passwd=hunter2')
      },
      clientName: 'ws',
    })

    expect(verdict.outcome).toBe('indeterminate')
    if (verdict.outcome !== 'indeterminate') return
    expect(verdict.detail).not.toContain('hunter2')
  })
})
