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
 *
 * The one read node-saml makes that must *not* consume is the second one inside
 * the same validation (`SubjectConfirmationData`). That value is therefore held
 * in an `AsyncLocalStorage` scope whose lifetime is one `validateSamlPostResponse`
 * call — bound to the validation, never to the id. Anything arriving in another
 * scope, concurrently or as a replay, sees only the (already deleted) row.
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

// `validateSamlPostResponse` builds a real node-saml instance; pin the callback
// origin and keep `getSamlEnv` on its env fallback instead of the mocked DB.
vi.mock('../server-url.js', () => ({
  getServerUrl: () => 'https://a2wave.test',
  getSsoCallbackOrigin: () => 'https://a2wave.test',
}))

vi.mock('../sso-settings.js', () => ({
  readSsoDbConfig: () => null,
  readOidcClientSecret: () => undefined,
}))

import { db } from '../../db/client.js'
import { samlRequests } from '../../db/schema.sqlite.js'
import { withTransaction } from '../../db/transaction.js'
import {
  createSamlRequestCacheProvider,
  getSaml,
  resetSamlForTests,
  runInSamlValidation,
  SAML_REQUEST_EXPIRATION_MS,
  sweepExpiredSamlRequests,
  validateSamlPostResponse,
} from '../saml.js'

const cache = createSamlRequestCacheProvider()

beforeEach(async () => {
  await db.delete(samlRequests)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  resetSamlForTests()
})

describe('SAML request cache provider', () => {
  it('round trips an AuthnRequest id through save / get / remove', async () => {
    const saved = await cache.saveAsync('_req-1', '_req-1')

    expect(saved).not.toBeNull()
    expect(saved?.value).toBe('_req-1')
    expect(typeof saved?.createdAt).toBe('number')

    // The ACS POST may land on any replica; this stands in for the validation
    // that runs there — read, then the removeAsync node-saml always ends on.
    await runInSamlValidation(async () => {
      expect(await cache.getAsync('_req-1')).toBe('_req-1')
      expect(await cache.removeAsync('_req-1')).toBe('_req-1')
    })
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

    await runInSamlValidation(async () => {
      expect(await cache.getAsync('_req-twice')).toBe('_req-twice')
      expect(await cache.getAsync('_req-twice')).toBe('_req-twice')

      // node-saml removes at the end of that validation; the id is dead after.
      expect(await cache.removeAsync('_req-twice')).toBe('_req-twice')
      expect(await cache.getAsync('_req-twice')).toBeNull()
    })
  })

  it('refuses a replayed validation the id a previous one already consumed', async () => {
    await cache.saveAsync('_req-replay', '_req-replay')

    // node-saml has one branch that returns without calling removeAsync, so the
    // consumed value can outlive the validation that took it. It must not
    // outlive it far enough to serve the *next* validation: that is a captured
    // SAMLResponse POSTed twice, and the second one has to be refused.
    expect(await runInSamlValidation(() => cache.getAsync('_req-replay'))).toBe('_req-replay')
    expect(await runInSamlValidation(() => cache.getAsync('_req-replay'))).toBeNull()
  })

  it('refuses a concurrent validation racing the same captured response', async () => {
    await cache.saveAsync('_req-overlap', '_req-overlap')

    let firstHasRead = () => {}
    const read = new Promise<void>((resolve) => {
      firstHasRead = resolve
    })
    let releaseFirst = () => {}
    const finish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    // Two ACS POSTs of one captured response, overlapping on this replica: the
    // first is still validating when the second reads.
    const first = runInSamlValidation(async () => {
      const value = await cache.getAsync('_req-overlap')
      firstHasRead()
      await finish
      return value
    })

    await read
    expect(await runInSamlValidation(() => cache.getAsync('_req-overlap'))).toBeNull()

    releaseFirst()
    expect(await first).toBe('_req-overlap')
  })

  it('does not reuse a consumed value outside any validation', async () => {
    await cache.saveAsync('_req-unscoped', '_req-unscoped')

    // No validation in progress means nothing may be held: the consuming DELETE
    // is then the only answer the cache can give.
    expect(await cache.getAsync('_req-unscoped')).toBe('_req-unscoped')
    expect(await cache.getAsync('_req-unscoped')).toBeNull()
    expect(await cache.removeAsync('_req-unscoped')).toBeNull()
  })

  it('runs a real validatePostResponseAsync inside its own scope', async () => {
    vi.stubEnv('A2WAVE_SAML_IDP_ENTRY_POINT', 'https://idp.test/sso/saml')
    vi.stubEnv(
      'A2WAVE_SAML_IDP_CERT',
      Buffer.from('fake-idp-cert-material-for-tests').toString('base64'),
    )
    vi.stubEnv('A2WAVE_SAML_SP_ENTITY_ID', '')

    const saml = await getSaml()
    await cache.saveAsync('_req-entry', '_req-entry')

    const reads: Array<string | null> = []
    // Stands in for node-saml's own pair of reads (the Response's InResponseTo,
    // then the assertion's SubjectConfirmationData) without needing a signed
    // assertion; what is under test is the scope the entry point establishes
    // around them, which is real.
    vi.spyOn(saml, 'validatePostResponseAsync').mockImplementation(async () => {
      reads.push(await cache.getAsync('_req-entry'))
      reads.push(await cache.getAsync('_req-entry'))
      return { profile: null, loggedOut: false }
    })

    await validateSamlPostResponse('ignored-by-the-stub')
    expect(reads).toEqual(['_req-entry', '_req-entry'])

    // Replaying the captured response is a second validation, and a second
    // scope: it gets nothing.
    await validateSamlPostResponse('ignored-by-the-stub')
    expect(reads.slice(2)).toEqual([null, null])
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

  /**
   * Serialisation against a stranger's transaction.
   *
   * better-sqlite3 gives the whole process one connection, so a plain
   * `db.insert(...)` issued while another request sits inside `BEGIN` silently
   * joins that transaction and disappears with its `ROLLBACK` — after this
   * request already told the IdP the AuthnRequest was recorded. The writes here
   * therefore go through `runExclusive`, which waits for the open transaction
   * instead of joining it (see apps/api/src/db/transaction.ts).
   */
  describe('serialises its writes against an unrelated transaction', () => {
    /** Hold a transaction open, run `duringTx` outside it, then roll back. */
    const rollingBackTransaction = async (duringTx: () => Promise<unknown>) => {
      let openTransaction = () => {}
      let releaseTransaction = () => {}
      const opened = new Promise<void>((resolve) => {
        openTransaction = resolve
      })
      const gate = new Promise<void>((resolve) => {
        releaseTransaction = resolve
      })

      const rolledBack = withTransaction(async () => {
        openTransaction()
        await gate
        throw new Error('unrelated transaction rolled back')
      }).catch(() => undefined)

      await opened
      // Started, not awaited: a serialised write parks on the transaction lock,
      // while an unserialised one would land inside the open BEGIN right here.
      const pending = duringTx()
      await new Promise((resolve) => setImmediate(resolve))
      releaseTransaction()
      await rolledBack
      return await pending
    }

    it('keeps a saveAsync that completed while the transaction was open', async () => {
      const saved = await rollingBackTransaction(() => cache.saveAsync('_req-tx', '_req-tx'))

      // saveAsync reported success, so the AuthnRequest is already on its way to
      // the IdP. Losing the row here fails the callback as SAML_RESPONSE_UNSOLICITED.
      expect(saved).not.toBeNull()
      expect(await db.select().from(samlRequests)).toHaveLength(1)
      expect(await createSamlRequestCacheProvider().getAsync('_req-tx')).toBe('_req-tx')
    })

    it('keeps the consuming delete of getAsync, so the id cannot be replayed', async () => {
      await cache.saveAsync('_req-tx-consume', '_req-tx-consume')

      const consumer = createSamlRequestCacheProvider()
      const value = await rollingBackTransaction(() => consumer.getAsync('_req-tx-consume'))

      expect(value).toBe('_req-tx-consume')
      // The consume is the single-use guarantee; resurrecting the row makes the
      // captured SAMLResponse replayable at another replica.
      expect(await db.select().from(samlRequests)).toHaveLength(0)
      expect(await createSamlRequestCacheProvider().getAsync('_req-tx-consume')).toBeNull()
    })

    it('keeps the removeAsync delete', async () => {
      await cache.saveAsync('_req-tx-remove', '_req-tx-remove')

      const remover = createSamlRequestCacheProvider()
      expect(await rollingBackTransaction(() => remover.removeAsync('_req-tx-remove'))).toBe(
        '_req-tx-remove',
      )
      expect(await db.select().from(samlRequests)).toHaveLength(0)
    })

    it('keeps the sweeper delete', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      await cache.saveAsync('_req-tx-sweep', '_req-tx-sweep')
      const sweepAt = new Date(Date.now() + SAML_REQUEST_EXPIRATION_MS + 1000)
      vi.useRealTimers()

      expect(await rollingBackTransaction(() => sweepExpiredSamlRequests(sweepAt))).toBe(1)
      expect(await db.select().from(samlRequests)).toHaveLength(0)
    })
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
