import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { providerOauthAccounts } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { ProviderOauthError } from './provider-oauth-protocol.js'

interface BindingInput {
  providerId?: string | null
  authMode?: unknown
  providerOauthAccountId?: string | null
  config?: Record<string, unknown> | null
}

export function hasProviderOauthBindings(input: BindingInput): boolean {
  const chain = input.config?.providerChain
  const entries: BindingInput[] = Array.isArray(chain) && chain.length ? chain : [input]
  return entries.some((entry) => !!entry.providerOauthAccountId)
}

/** Keep account existence and an Agent save in one row-lock transaction. */
export async function withProviderOauthBindings<T>(
  input: BindingInput,
  executor: typeof db,
  save: (tx: typeof db) => Promise<T>,
): Promise<T> {
  const chain = input.config?.providerChain
  const entries: BindingInput[] = Array.isArray(chain) && chain.length ? chain : [input]
  const references = entries
    .filter((entry) => entry.providerOauthAccountId)
    .sort((a, b) =>
      String(a.providerOauthAccountId).localeCompare(String(b.providerOauthAccountId)),
    )
  if (!references.length) return save(executor)
  const run = async (tx: typeof db) => {
    for (const binding of references) {
      if (!binding.providerId || binding.authMode !== 'oauth')
        throw new ProviderOauthError(
          'PROVIDER_OAUTH_BINDING_INVALID',
          'ChatGPT account bindings require an OAuth Provider',
          400,
        )
      // A no-op UPDATE takes a PostgreSQL row lock as well as SQLite's write lock.
      // Deletion obtains this same lock before it checks the Agent references.
      const [account] = await tx
        .update(providerOauthAccounts)
        .set({ revision: sql`${providerOauthAccounts.revision}` })
        .where(
          and(
            eq(providerOauthAccounts.id, binding.providerOauthAccountId as string),
            eq(providerOauthAccounts.providerId, binding.providerId),
          ),
        )
        .returning()
      if (!account)
        throw new ProviderOauthError(
          'PROVIDER_OAUTH_ACCOUNT_NOT_FOUND',
          'The selected ChatGPT account no longer exists',
          409,
        )
      if (account.refreshLeaseId?.startsWith('delete_'))
        throw new ProviderOauthError(
          'PROVIDER_OAUTH_ACCOUNT_DELETING',
          'The selected ChatGPT account is being disconnected',
          409,
        )
    }
    return save(tx)
  }
  return executor === db ? withTransaction(run) : run(executor)
}
