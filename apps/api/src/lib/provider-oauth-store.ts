import { randomUUID } from 'node:crypto'
import { and, eq, gt, isNull, lt, notLike, or, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  providerOauthAccounts as accounts,
  agents,
  providerOauthLogins as logins,
  settings,
  users,
} from '../db/schema.js'
import { runExclusive, withTransaction } from '../db/transaction.js'
import { jsonArrayContainsKeyValue } from './json-sql.js'
import { ProviderOauthError } from './provider-oauth-protocol.js'

export type ProviderOauthAccountRow = typeof accounts.$inferSelect
export type ProviderOauthLoginRow = typeof logins.$inferSelect
export type ProviderOauthAccountWrite = typeof accounts.$inferInsert

export async function getOauthAccount(id: string) {
  return (await db.select().from(accounts).where(eq(accounts.id, id)).limit(1))[0]
}
export async function listOauthAccounts(providerId: string) {
  return db.select().from(accounts).where(eq(accounts.providerId, providerId))
}
export async function getOauthLogin(id: string) {
  return (await db.select().from(logins).where(eq(logins.id, id)).limit(1))[0]
}
export async function getOauthLoginUser(id: string) {
  return (
    await db
      .select({ isActive: users.isActive, tokenVersion: users.tokenVersion })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
  )[0]
}
export async function insertOauthLogin(row: typeof logins.$inferInsert) {
  await runExclusive(async () => {
    await db.insert(logins).values(row)
  })
}
export async function transitionOauthLogin(
  id: string,
  expected: ProviderOauthLoginRow['status'],
  patch: Partial<typeof logins.$inferInsert>,
) {
  return runExclusive(
    async () =>
      (
        await db
          .update(logins)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(logins.id, id), eq(logins.status, expected)))
          .returning({ id: logins.id })
      ).length > 0,
  )
}

/** One deployment registration host, durable across restarts and shared by replicas. */
export async function getOauthHostId(): Promise<string> {
  return withTransaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ category: 'provider-oauth', key: 'hostId', value: `urn:uuid:${randomUUID()}` })
      .onConflictDoNothing()
    const [row] = await tx
      .select()
      .from(settings)
      .where(and(eq(settings.category, 'provider-oauth'), eq(settings.key, 'hostId')))
      .limit(1)
    if (!row)
      throw new ProviderOauthError(
        'provider_oauth_unavailable',
        'Could not establish the authorization host',
        503,
      )
    return row.value
  })
}

/** Persist identity and rotating tokens with the one-use login completion. */
export async function commitOauthLogin(
  loginId: string,
  row: ProviderOauthAccountWrite,
  reconnect: boolean,
): Promise<void> {
  await withTransaction(async (tx) => {
    const won = await tx
      .update(logins)
      .set({
        status: 'completed',
        accountId: row.id,
        tokenHash: '',
        pendingEnc: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(logins.id, loginId),
          eq(logins.status, 'exchanging'),
          gt(logins.expiresAt, new Date()),
        ),
      )
      .returning({ id: logins.id })
    if (!won.length)
      throw new ProviderOauthError(
        'login_expired',
        'The authorization attempt expired or was already completed',
        409,
      )
    if (reconnect) {
      const updated = await tx
        .update(accounts)
        .set({
          tokensEnc: row.tokensEnc,
          email: row.email,
          expiresAt: row.expiresAt,
          earliestRefreshAt: row.earliestRefreshAt,
          reauthRequired: false,
          revision: sql`${accounts.revision} + 1`,
          refreshLeaseId: null,
          refreshLeaseExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(accounts.id, row.id),
            eq(accounts.subject, row.subject),
            eq(accounts.clientId, row.clientId),
            or(isNull(accounts.refreshLeaseId), notLike(accounts.refreshLeaseId, 'delete_%')),
          ),
        )
        .returning({ id: accounts.id })
      if (!updated.length)
        throw new ProviderOauthError(
          'account_mismatch',
          'The selected account no longer exists or its registration changed',
          409,
        )
    } else {
      await tx.insert(accounts).values(row)
    }
  })
}

/** Compare-and-set lease serializes rotating refreshes across PostgreSQL replicas. */
export async function claimOauthRefresh(
  id: string,
  leaseId: string,
  until: Date,
  revision: number,
): Promise<boolean> {
  return withTransaction(async (tx) => {
    const won =
      (
        await tx
          .update(accounts)
          .set({ refreshLeaseId: leaseId, refreshLeaseExpiresAt: until })
          .where(
            and(
              eq(accounts.id, id),
              eq(accounts.revision, revision),
              or(isNull(accounts.refreshLeaseId), lt(accounts.refreshLeaseExpiresAt, new Date())),
            ),
          )
          .returning({ id: accounts.id })
      ).length > 0
    if (won && leaseId.startsWith('delete_')) {
      const references = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          or(
            eq(agents.providerOauthAccountId, id),
            jsonArrayContainsKeyValue(
              agents.config,
              ['providerChain'],
              'providerOauthAccountId',
              id,
            ),
          ),
        )
        .limit(1)
      if (references.length)
        throw new ProviderOauthError(
          'account_in_use',
          'Remove this account from its Agent bindings before deleting it',
          409,
        )
    }
    return won
  })
}
export async function finishOauthRefresh(
  id: string,
  leaseId: string,
  revision: number,
  patch: Partial<ProviderOauthAccountWrite>,
  keepLease = false,
): Promise<boolean> {
  return runExclusive(
    async () =>
      (
        await db
          .update(accounts)
          .set({
            ...patch,
            revision: revision + 1,
            ...(keepLease ? {} : { refreshLeaseId: null, refreshLeaseExpiresAt: null }),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(accounts.id, id),
              eq(accounts.revision, revision),
              eq(accounts.refreshLeaseId, leaseId),
            ),
          )
          .returning({ id: accounts.id })
      ).length > 0,
  )
}
