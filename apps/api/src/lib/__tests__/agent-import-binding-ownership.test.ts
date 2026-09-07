import AdmZip from 'adm-zip'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * An archive references an SCM source / KB document by *name*, so resolving it
 * without an owner condition let any importer bind another user's private
 * source (and its stored credentials) simply by naming it.
 */
const insertedValues: Array<Record<string, unknown>> = []
let scmRows: Array<{ id: string; userId: string | null }> = []
let kbRows: Array<{ id: string; userId: string | null }> = []

const txStub = {
  // `isPostgres: true` routes the import through the advisory-lock branch.
  execute: vi.fn(async () => undefined),
  insert: vi.fn(() =>
    asyncQuery({
      values: vi.fn((values: Record<string, unknown>) => {
        insertedValues.push(values)
        return asyncQuery({ run: vi.fn() })
      }),
    }),
  ),
  select: vi.fn(() =>
    asyncQuery({
      from: vi.fn((table: Record<string, unknown> | undefined) => {
        const rows = table?.scmMarker ? scmRows : table?.kbMarker ? kbRows : []
        return asyncQuery({ where: vi.fn(() => asyncQuery({ all: () => rows })) })
      }),
    }),
  ),
}

vi.mock('../../db/client.js', () => ({
  db: { transaction: (fn: (tx: unknown) => unknown) => fn(txStub) },
  isPostgres: true,
}))
vi.mock('../../db/schema.js', () => ({
  agents: {},
  kbDocuments: { kbMarker: true },
  mcpServers: {},
  providers: {},
  scmSources: { scmMarker: true },
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

function buildZip(): Buffer {
  const zip = new AdmZip()
  zip.addFile(
    'manifest.json',
    Buffer.from(JSON.stringify({ version: '1.0', exportedAt: '2026-01-01' })),
  )
  zip.addFile(
    'agent.json',
    Buffer.from(
      JSON.stringify({
        agent: { name: 'Imported', type: 'cursor', config: {}, workspaceType: 'scm' },
        mcpServerRefs: [],
        skillRefs: [],
        kbDocumentRefs: ['alice-notes'],
        providerRef: null,
        scmSourceRef: 'alice-repo',
      }),
    ),
  )
  return zip.toBuffer()
}

beforeEach(() => {
  insertedValues.length = 0
  scmRows = [{ id: 'scm_alice', userId: 'usr_alice' }]
  kbRows = [{ id: 'kbd_alice', userId: 'usr_alice' }]
})

describe('agent import binding ownership', () => {
  it("warns and clears the binding when the archive names another user's SCM source and KB document", async () => {
    const result = await importAgentFromZip(buildZip(), 'usr_bob', false)

    expect(result.warnings).toContainEqual(expect.stringContaining('"alice-repo"'))
    expect(result.warnings).toContainEqual(expect.stringContaining('"alice-notes"'))
    const agentValues = insertedValues.at(-1) as Record<string, unknown>
    expect(agentValues.scmSourceId).toBeNull()
    expect(agentValues.kbDocumentIds).toEqual([])
  })

  it('binds the importer’s own SCM source and KB document', async () => {
    scmRows = [{ id: 'scm_bob', userId: 'usr_bob' }]
    kbRows = [{ id: 'kbd_bob', userId: 'usr_bob' }]

    const result = await importAgentFromZip(buildZip(), 'usr_bob', false)

    expect(result.warnings.join('\n')).not.toContain('alice-')
    const agentValues = insertedValues.at(-1) as Record<string, unknown>
    expect(agentValues.scmSourceId).toBe('scm_bob')
    expect(agentValues.kbDocumentIds).toEqual(['kbd_bob'])
  })

  it("lets an admin importer bind another user's SCM source and KB document", async () => {
    const result = await importAgentFromZip(buildZip(), 'usr_admin', true)

    expect(result.warnings.join('\n')).not.toContain('alice-')
    const agentValues = insertedValues.at(-1) as Record<string, unknown>
    expect(agentValues.scmSourceId).toBe('scm_alice')
    expect(agentValues.kbDocumentIds).toEqual(['kbd_alice'])
  })
})
