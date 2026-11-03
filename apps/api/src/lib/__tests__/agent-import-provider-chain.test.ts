import { PROVIDER_CHAIN_MAX } from '@a2wave/shared'
import AdmZip from 'adm-zip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same tx stub shape as agent-import-stdio-gate.test.ts: insert/select are
// no-ops so the import runs far enough to reach the config validation.
const insertRun = vi.fn()
const insertValues = vi.fn(() => asyncQuery({ run: insertRun }))
const txStub = {
  insert: vi.fn(() => asyncQuery({ values: insertValues })),
  select: vi.fn(() =>
    asyncQuery({
      from: vi.fn(() => asyncQuery({ where: vi.fn(() => asyncQuery({ get: () => undefined })) })),
    }),
  ),
}
// `isPostgres: true` keeps `withTransaction` on the branch that calls
// `db.transaction`, so the callback still receives `txStub`. The SQLite branch
// would hand it the shared `db`, which here only carries `transaction`.
vi.mock('../../db/client.js', () => ({
  db: { transaction: (fn: (tx: unknown) => unknown) => fn(txStub) },
  isPostgres: true,
}))
vi.mock('../../db/schema.js', () => ({
  agents: {},
  kbDocuments: {},
  mcpServers: {},
  providers: {},
  scmSources: {},
  skills: {},
}))
vi.mock('../skill-storage.js', () => ({
  ensureDir: vi.fn(),
  getSkillStoragePath: (id: string) => `/tmp/skills/${id}`,
}))
vi.mock('../id.js', () => ({ createId: (p?: string) => `${p}_test` }))
vi.mock('../url-safety.js', () => ({ isBlockedHost: () => false }))

import { asyncQuery } from '../../test/async-query.js'
import { importAgentFromZip } from '../agent-import.js'

function buildZip(config: Record<string, unknown>, authMode?: string): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ version: '1.0', exportedAt: '2026-01-01' })),
  )
  zip.addFile(
    'agent.json',
    Buffer.from(
      JSON.stringify({
        name: 'Imported',
        type: 'cursor',
        config,
        mcpServerRefs: [],
        skillRefs: [],
        kbDocumentRefs: [],
        providerRef: null,
        authMode,
        scmSourceRef: null,
      }),
    ),
  )
  return zip.toBuffer()
}

function chainOf(length: number) {
  return Array.from({ length }, (_, i) => ({
    id: `pc_${i}`,
    providerId: `prv_${i}`,
    authMode: 'apiKey',
    enabled: true,
  }))
}

beforeEach(() => {
  insertRun.mockReset()
  insertValues.mockClear()
})

// Import writes `config` verbatim, so the create/update schema's chain cap does
// not apply to it. Without validation here an oversized chain lands in the DB and
// multiplies into (maxRetries + 1) × chainLength subprocess launches at runtime.
describe('agent import provider chain cap', () => {
  it('rejects an imported chain longer than the cap', async () => {
    const zip = buildZip({ providerChain: chainOf(PROVIDER_CHAIN_MAX + 1) })
    await expect(importAgentFromZip(zip, 'usr_alice', false)).rejects.toThrow(/provider chain/i)
    expect(insertRun).not.toHaveBeenCalled()
  })

  it('accepts an imported chain exactly at the cap', async () => {
    const zip = buildZip({ providerChain: chainOf(PROVIDER_CHAIN_MAX) })
    await expect(importAgentFromZip(zip, 'usr_alice', false)).resolves.not.toThrow()
  })

  it('accepts an Agent with no provider chain in its config', async () => {
    const zip = buildZip({})
    await expect(importAgentFromZip(zip, 'usr_alice', false)).resolves.not.toThrow()
  })
})

describe('imported OAuth credentials', () => {
  it('preserves a top-level OAuth mode while requiring a new account binding', async () => {
    await importAgentFromZip(buildZip({}, 'oauth'), 'usr_alice', false)
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ authMode: 'oauth', providerOauthAccountId: null }),
    )
  })
})
