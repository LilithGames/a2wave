import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { planAgentApiKeyBackfill } from '../backfill-agent-api-keys.js'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

const now = new Date('2026-06-01T00:00:00Z')

describe('planAgentApiKeyBackfill', () => {
  it('migrates a legacy REST key into an api-channel row, hashed', () => {
    const plan = planAgentApiKeyBackfill(
      [{ id: 'agt_1', endpointApiKey: 'ak_legacyplaintext', a2aEndpointApiKey: null }],
      new Set(),
      now,
    )

    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({
      agentId: 'agt_1',
      channel: 'api',
      keyHash: sha256('ak_legacyplaintext'),
      keyPrefix: 'ak_legacypl',
    })
    // The name has to be non-empty — it is the required label on every other path.
    expect(plan[0].name.length).toBeGreaterThan(0)
  })

  it('migrates the A2A key onto its own channel', () => {
    const plan = planAgentApiKeyBackfill(
      [{ id: 'agt_1', endpointApiKey: null, a2aEndpointApiKey: 'a2ak_legacyplaintext' }],
      new Set(),
      now,
    )

    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({
      agentId: 'agt_1',
      channel: 'a2a',
      keyHash: sha256('a2ak_legacyplaintext'),
    })
  })

  it('migrates both channels of one Agent independently', () => {
    const plan = planAgentApiKeyBackfill(
      [{ id: 'agt_1', endpointApiKey: 'ak_one', a2aEndpointApiKey: 'a2ak_two' }],
      new Set(),
      now,
    )

    expect(plan.map((p) => p.channel).sort()).toEqual(['a2a', 'api'])
  })

  it('never carries an expiry — a live integration must not start dying on a date nobody chose', () => {
    const plan = planAgentApiKeyBackfill(
      [{ id: 'agt_1', endpointApiKey: 'ak_one', a2aEndpointApiKey: null }],
      new Set(),
      now,
    )

    expect(plan[0].expiresAt).toBeNull()
  })

  it('skips a key already migrated, so a re-run is a no-op', () => {
    const plan = planAgentApiKeyBackfill(
      [{ id: 'agt_1', endpointApiKey: 'ak_one', a2aEndpointApiKey: null }],
      new Set([sha256('ak_one')]),
      now,
    )

    expect(plan).toEqual([])
  })

  it('skips agents with no legacy key at all', () => {
    const plan = planAgentApiKeyBackfill(
      [{ id: 'agt_1', endpointApiKey: null, a2aEndpointApiKey: null }],
      new Set(),
      now,
    )

    expect(plan).toEqual([])
  })

  it('ignores an empty-string legacy column rather than migrating an unusable credential', () => {
    const plan = planAgentApiKeyBackfill(
      [{ id: 'agt_1', endpointApiKey: '', a2aEndpointApiKey: '   ' }],
      new Set(),
      now,
    )

    expect(plan).toEqual([])
  })

  it('deduplicates when two Agents somehow share a legacy key: key_hash is unique, a dup insert would abort the batch', () => {
    const plan = planAgentApiKeyBackfill(
      [
        { id: 'agt_1', endpointApiKey: 'ak_shared', a2aEndpointApiKey: null },
        { id: 'agt_2', endpointApiKey: 'ak_shared', a2aEndpointApiKey: null },
      ],
      new Set(),
      now,
    )

    expect(plan).toHaveLength(1)
  })

  it('stamps createdAt from the supplied clock, not wall time', () => {
    const plan = planAgentApiKeyBackfill(
      [{ id: 'agt_1', endpointApiKey: 'ak_one', a2aEndpointApiKey: null }],
      new Set(),
      now,
    )

    expect(plan[0].createdAt).toEqual(now)
  })

  it('leaves the key live: no revocation, and last-used unknown until it is actually used', () => {
    const plan = planAgentApiKeyBackfill(
      [{ id: 'agt_1', endpointApiKey: 'ak_one', a2aEndpointApiKey: null }],
      new Set(),
      now,
    )

    expect(plan[0].revokedAt).toBeUndefined()
    expect(plan[0].lastUsedAt).toBeUndefined()
  })
})
