/**
 * Purge lapsed device authorization rows.
 *
 * Separate from the configurable data-retention sweeper on purpose: that one is
 * governed by an admin policy measured in days and can be turned off, whereas a
 * device authorization is dead ten minutes after it was created and carries no
 * history worth keeping. Leaving them to the policy sweeper would mean an
 * operator with retention disabled accumulates a row per login attempt forever.
 *
 * Expiry is enforced on read regardless, so this is housekeeping, not a
 * correctness guarantee.
 */
import { lt } from 'drizzle-orm'
import { db } from '../db/client.js'
import { deviceAuthorizations } from '../db/schema.js'
import { logger } from './logger.js'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000 // hourly

/** Delete every row whose deadline has passed. Returns how many went. */
export async function sweepExpiredDeviceAuthorizations(now: Date): Promise<number> {
  // No status filter: once expired, pending / approved / denied / claimed are
  // equally dead, and filtering would strand the terminal ones permanently.
  const deleted = await db
    .delete(deviceAuthorizations)
    .where(lt(deviceAuthorizations.expiresAt, now))
    .returning({ id: deviceAuthorizations.id })
  return deleted.length
}

/** Start the hourly sweeper. Returns a stop function. */
export function startDeviceAuthorizationSweeper(intervalMs = SWEEP_INTERVAL_MS): () => void {
  const tick = async () => {
    try {
      const deleted = await sweepExpiredDeviceAuthorizations(new Date())
      if (deleted > 0) logger.info({ deleted }, 'device-authorization: swept expired rows')
    } catch (error) {
      // A failed sweep must not kill the timer: the next tick is the recovery.
      logger.error({ error }, 'device-authorization: sweep failed')
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
