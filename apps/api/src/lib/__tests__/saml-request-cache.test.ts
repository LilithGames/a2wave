/**
 * Durable `InResponseTo` state for SAML, against a real migrated SQLite database.
 *
 * `getSaml()` sets `validateInResponseTo: always` — correct, it is what stops an
 * unsolicited or replayed assertion being accepted — but it used node-saml's
 * default `InMemoryCacheProvider`. The AuthnRequest id is then recorded in the
 * heap of whichever process issued the redirect, while the IdP form-POSTs the
 * assertion back to `/api/auth/saml/acs` through the load balancer. Any replica
 * but the issuing one, or the same replica after a restart or a deploy, finds no
 * matching id and fails the login with `SAML_RESPONSE_UNSOLICITED` — a
 * configuration-shaped error that no amount of retrying fixes.
 *
 * Backing the cache with a table makes the state shared and survive restarts.
 * These tests exercise the node-saml `CacheProvider` contract directly:
 * save/get/remove round trip, single-use ids, and expiry.
 *
 * The single-use property is the security-carrying one. node-saml validates the
 * assertion *before* it calls `removeAsync`, so a plain `SELECT` in `getAsync`
 * leaves a captured SAMLResponse replayable: POST it at two replicas at once and
 * both read the row, both validate, both mint a session. Consumption has to
 * happen in the read itself.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', async () => {
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const Database = (await import('better-sqlite3')).default
  const { resolveMigrationDir } = await import('../../db/migration-directory.js')

  const sqlite = new Database(':memory:')
  sqlite.pragma('foreign_keys = ON')

  const dir = resolveMigrationDir('drizzle')
  const journal = JSON.parse(readFileSync(resolve(dir, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ tag: string }>
  }
  for (const entry of journal.entries) {
    const migration = readFileSync(resolve(dir, `${entry.tag}.sql`), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement)
    }
  }

  return { db: drizzle(sqlite), isPostgres: false, sqliteDatabase: sqlite }
})

vi.mock('../../db/schema.js', async () => await import('../../db/schema.sqlite.js'))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { db } from '../../db/client.js'
import { samlRequests } from '../../db/schema.sqlite.js'
import {
  createSamlRequestCacheProvider,
  SAML_REQUEST_EXPIRATION_MS,
  SAML_REQUEST_IN_FLIGHT_MS,
  sweepExpiredSamlRequests,
} from '../saml.js'

const cache = createSamlRequestCacheProvider()

beforeEach(async () => {
  await db.delete(samlRequests)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SAML request cache provider', () => {
  it('round trips an AuthnRequest id through save / get / remove', async () => {
    const saved = await cache.saveAsync('_req-1', '_req-1')

    expect(saved).not.toBeNull()
    expect(saved?.value).toBe('_req-1')
    expect(typeof saved?.createdAt).toBe('number')

    // The ACS POST may land on any replica; this read stands in for that one.
    expect(await cache.getAsync('_req-1')).toBe('_req-1')

    expect(await cache.removeAsync('_req-1')).toBe('_req-1')
    expect(await cache.getAsync('_req-1')).toBeNull()
  })

  it('survives a restart — the row, not process memory, is the state', async () => {
    await cache.saveAsync('_req-restart', '_req-restart')

    // A brand-new provider is what a redeployed replica gets. Same database, so
    // it must still recognise the request.
    expect(await createSamlRequestCacheProvider().getAsync('_req-restart')).toBe('_req-restart')
  })

  it('returns null from saveAsync when the id is already in use', async () => {
    await cache.saveAsync('_req-dup', '_req-dup')

    // node-saml treats null as "already in use" and refuses to reissue.
    expect(await cache.saveAsync('_req-dup', '_req-dup')).toBeNull()
  })

  it('lets only one replica consume an id, so a captured response cannot be replayed', async () => {
    await cache.saveAsync('_req-race', '_req-race')

    // node-saml calls removeAsync only *after* the assertion validates, so the
    // read is the only place consumption can happen. Two replicas racing the
    // same captured SAMLResponse are two providers reading the same row.
    const replicaA = createSamlRequestCacheProvider()
    const replicaB = createSamlRequestCacheProvider()

    expect(await replicaA.getAsync('_req-race')).toBe('_req-race')
    expect(await replicaB.getAsync('_req-race')).toBeNull()
  })

  it('serves the second read of one validation, which node-saml always makes', async () => {
    // Within a single validatePostResponseAsync the id is read twice: once for
    // the Response InResponseTo, once for the assertion's SubjectConfirmation.
    // Consuming the row must not make the second read fail the login.
    await cache.saveAsync('_req-twice', '_req-twice')

    expect(await cache.getAsync('_req-twice')).toBe('_req-twice')
    expect(await cache.getAsync('_req-twice')).toBe('_req-twice')

    // node-saml removes at the end of that validation; the id is dead after.
    expect(await cache.removeAsync('_req-twice')).toBe('_req-twice')
    expect(await cache.getAsync('_req-twice')).toBeNull()
  })

  it('forgets a consumed id once the in-flight window lapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await cache.saveAsync('_req-inflight', '_req-inflight')
    expect(await cache.getAsync('_req-inflight')).toBe('_req-inflight')

    // Backstop for the one node-saml branch that returns without removeAsync:
    // the consumed id must not stay readable on this replica indefinitely.
    vi.setSystemTime(new Date(Date.now() + SAML_REQUEST_IN_FLIGHT_MS + 1000))
    expect(await cache.getAsync('_req-inflight')).toBeNull()
  })

  it('returns null for an unknown id, so an unsolicited assertion is refused', async () => {
    expect(await cache.getAsync('_never-issued')).toBeNull()
    expect(await cache.removeAsync('_never-issued')).toBeNull()
  })

  it('does not return an entry past the request-id expiration window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await cache.saveAsync('_req-old', '_req-old')

    vi.setSystemTime(new Date(Date.now() + SAML_REQUEST_EXPIRATION_MS + 1000))

    // Expiry is enforced on read, not only by the sweeper: a login window that
    // stayed open overnight must not be honoured just because the sweep is late.
    expect(await cache.getAsync('_req-old')).toBeNull()
  })

  it('sweeps rows older than the expiration window and keeps fresh ones', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    await cache.saveAsync('_req-stale', '_req-stale')

    vi.setSystemTime(new Date(Date.now() + SAML_REQUEST_EXPIRATION_MS + 1000))
    await cache.saveAsync('_req-fresh', '_req-fresh')

    expect(await sweepExpiredSamlRequests(new Date())).toBe(1)
    // Only the stale one went; asserted before the read, which consumes.
    expect((await db.select().from(samlRequests)).length).toBe(1)
    expect(await cache.getAsync('_req-fresh')).toBe('_req-fresh')
  })
})
