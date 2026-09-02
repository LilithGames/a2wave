/**
 * Migration journal `when` timestamps must only ever go up.
 *
 * drizzle's SQLite migrator decides what is pending by comparing each journal
 * entry's `when` against `MAX(created_at)` in `__drizzle_migrations`. An entry
 * whose `when` is lower than one already applied therefore looks *older than the
 * database* and is silently skipped — the migration never runs, and nothing says
 * so. `migrate-runtime.ts` carries two whole repair passes
 * (`fixStaleMigrationTimestamps`, `repairSkippedMigrations`) that exist only
 * because this happened. The cause is always the same: a migration file created
 * or reordered by hand instead of by `pnpm db:generate`.
 *
 * The SQLite lineage already contains ten such entries. Rewriting that history
 * now would change the hashes of migrations that are applied in live databases,
 * which is a far worse cure than the disease — so they are allowlisted by tag and
 * the invariant is enforced from the head forward. Any *new* offender fails here.
 *
 * The allowlist is deliberately by tag, not a count: renaming or regenerating one
 * of these does not silently buy a fresh exemption.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveMigrationDir } from '../migration-directory.js'

type JournalEntry = { idx: number; tag: string; when: number }

/**
 * Entries whose `when` was already out of order when this check was written.
 *
 * Everything here predates the rule. Do **not** add to it: a new entry in this
 * list means a migration was hand-written or hand-reordered, which is exactly
 * what `apps/api/AGENTS.md` forbids.
 */
const HISTORICAL_NON_MONOTONIC_TAGS = new Set([
  '0002_add_nodes',
  '0004_add_install_token',
  '0011_premium_drax',
  '0012_classy_multiple_man',
  '0013_mushy_masked_marvel',
  '0015_colorful_cerise',
  '0015_clean_forgotten_one',
  '0020_acoustic_toxin',
  '0030_breezy_omega_red',
  '0052_oauth_independent_channel',
])

function readJournal(lineage: 'drizzle' | 'drizzle-pg'): JournalEntry[] {
  const path = resolve(resolveMigrationDir(lineage), 'meta/_journal.json')
  return (JSON.parse(readFileSync(path, 'utf8')) as { entries: JournalEntry[] }).entries
}

/**
 * Tags whose `when` is not strictly greater than every `when` before them.
 *
 * Compared against the running **maximum**, not the immediate predecessor: an
 * entry that merely beats the one before it but sits below an earlier peak is
 * still below `MAX(created_at)` in an already-migrated database, and is skipped
 * just the same.
 */
function nonMonotonicTags(entries: JournalEntry[]): string[] {
  const offenders: string[] = []
  let highWater = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    if (entry.when <= highWater) offenders.push(entry.tag)
    highWater = Math.max(highWater, entry.when)
  }
  return offenders
}

describe('migration journal timestamps', () => {
  it('flags an entry that does not advance the high-water mark', () => {
    // Pins the detector itself, so the two suites below cannot pass by accident
    // if this ever stopped detecting anything.
    expect(
      nonMonotonicTags([
        { idx: 0, tag: 'a', when: 100 },
        { idx: 1, tag: 'b', when: 300 },
        { idx: 2, tag: 'c', when: 200 }, // below the peak, not just below `b`
        { idx: 3, tag: 'd', when: 300 }, // equal is not "strictly increasing"
        { idx: 4, tag: 'e', when: 400 },
      ]),
    ).toEqual(['c', 'd'])
  })

  it('has no new out-of-order entry in the SQLite lineage', () => {
    const offenders = nonMonotonicTags(readJournal('drizzle')).filter(
      (tag) => !HISTORICAL_NON_MONOTONIC_TAGS.has(tag),
    )

    expect(
      offenders,
      'Migration `when` went backwards. Generate migrations with `pnpm db:generate` — never hand-write the SQL or edit meta/_journal.json — or drizzle will skip them against an already-migrated database.',
    ).toEqual([])
  })

  it('has no out-of-order entry in the PostgreSQL lineage', () => {
    // No allowlist: this lineage starts from the current schema as migration 0
    // and has never been hand-edited. It must stay that way.
    expect(nonMonotonicTags(readJournal('drizzle-pg'))).toEqual([])
  })

  it('allowlists only entries that are actually still in the journal', () => {
    // Keeps the allowlist from outliving the history it excuses: a stale tag here
    // would quietly exempt nothing while looking like it exempts something.
    const tags = new Set(readJournal('drizzle').map((entry) => entry.tag))
    for (const tag of HISTORICAL_NON_MONOTONIC_TAGS) {
      expect(tags.has(tag), `allowlisted tag ${tag} is no longer in the journal`).toBe(true)
    }
  })
})
