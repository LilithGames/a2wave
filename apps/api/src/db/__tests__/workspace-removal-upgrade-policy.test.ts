import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(import.meta.dirname, '../../../../..')

describe('workspace removal reservation upgrade policy', () => {
  it('requires a stop-the-world PostgreSQL upgrade across the attempt-token migration', () => {
    const guide = readFileSync(resolve(repositoryRoot, 'docs/agent/postgresql.md'), 'utf8')
    const invariants = readFileSync(
      resolve(repositoryRoot, 'docs/agent/scm-storage-invariants.md'),
      'utf8',
    )

    for (const document of [guide, invariants]) {
      expect(document).toMatch(/stop all pre-attempt-token API\s+replicas/i)
      expect(document).toMatch(/mixed-version operation is unsupported/i)
      expect(document).toMatch(/before applying (?:the )?(?:workspace-removal )?\s*migrations/i)
    }
  })
})
