/**
 * Guards the hand-written `minVersion` floors in PRESET_PROVIDERS.
 *
 * The floors rise only when an adapter starts depending on a newer CLI
 * capability, but nothing links the two: adding a flag that shipped in a later
 * release leaves the floor silently wrong, and users below it pass the version
 * check and fail at runtime.
 *
 * This snapshots the CLI tokens each adapter can pass and fails on drift. It
 * deliberately does not try to derive the required version — no
 * machine-readable capability-to-version map exists for these CLIs — so its job
 * is to make a silent change loud and force the author to confirm the floor.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isVersionAtLeast, PRESET_PROVIDERS, PROVIDER_KINDS } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import { extractCliSurface } from './helpers/extract-cli-surface.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(testDir, '../../../../..')

interface SnapshotEntry {
  sourceFile: string
  minVersion: string | null
  surface: string[]
  ignoredLiterals: Array<{ token: string; reason: string }>
}

interface Snapshot {
  engines: Record<string, SnapshotEntry>
}

interface LockEntry {
  kind: string
  version: string
  binary: string
}

const snapshot = JSON.parse(
  readFileSync(resolve(testDir, 'cli-invocation-surface.snapshot.json'), 'utf8'),
) as Snapshot

const lock = JSON.parse(
  readFileSync(resolve(repositoryRoot, 'provider-cli-lock.json'), 'utf8'),
) as { providers: LockEntry[] }

const presetOf = (kind: string) => PRESET_PROVIDERS.find((preset) => preset.kind === kind)
const binaryOf = (kind: string) =>
  lock.providers.find((entry) => entry.kind === kind)?.binary ?? kind

function formatDrift(kind: string, added: string[], removed: string[]): string {
  const binary = binaryOf(kind)
  const minVersion = presetOf(kind)?.minVersion
  const floor = minVersion
    ? `minVersion is still ${minVersion}`
    : 'minVersion is still unset (null)'
  const changed = [...added, ...removed].join(', ')
  const target = minVersion ? `${binary} ${minVersion}` : `the oldest ${binary} you support`
  return [
    `${kind}'s CLI invocation surface changed.`,
    added.length > 0 ? `  added:   ${added.join(' ')}` : null,
    removed.length > 0 ? `  removed: ${removed.join(' ')}` : null,
    `  ${floor}`,
    `Confirm ${changed} exists in ${target}:`,
    '  - it does      -> update apps/api/src/engine/__tests__/cli-invocation-surface.snapshot.json',
    '  - it does not  -> raise minVersion (and its comment) in',
    '                   packages/shared/src/schemas/provider.ts as well, then update the snapshot',
  ]
    .filter((line) => line !== null)
    .join('\n')
}

function formatUnclassified(sourceFile: string): string {
  return [
    `${sourceFile} has flag-shaped literals that neither reach the CLI nor appear in the`,
    "snapshot's ignoredLiterals. Either they are a new invocation the extractor cannot see",
    '(extend helpers/extract-cli-surface.ts), or they are not CLI flags at all (record them',
    'in ignoredLiterals with a reason).',
  ].join('\n')
}

function formatPinBelowFloor(kind: string, pinned: string, floor: string): string {
  return [
    `provider-cli-lock.json pins ${kind} at ${pinned}, below its minVersion floor ${floor}.`,
    'a2wave would install a CLI that immediately fails its own version check — raise the pin,',
    'or lower the floor if the floor is wrong.',
  ].join('\n')
}

describe('CLI invocation surface contract', () => {
  it('snapshots every Provider kind', () => {
    expect(Object.keys(snapshot.engines).sort()).toEqual([...PROVIDER_KINDS].sort())
  })

  for (const kind of PROVIDER_KINDS) {
    describe(kind, () => {
      const entry = snapshot.engines[kind]

      it('passes only the CLI tokens recorded in the snapshot', () => {
        expect(entry, `No snapshot entry for "${kind}"`).toBeDefined()
        const source = readFileSync(resolve(repositoryRoot, entry.sourceFile), 'utf8')
        const { surface } = extractCliSurface(source, entry.sourceFile)

        const added = surface.filter((token) => !entry.surface.includes(token))
        const removed = entry.surface.filter((token) => !surface.includes(token))
        if (added.length > 0 || removed.length > 0) {
          throw new Error(formatDrift(kind, added, removed))
        }
        expect(surface).toEqual(entry.surface)
      })

      it('leaves no flag-shaped literal unaccounted for', () => {
        const source = readFileSync(resolve(repositoryRoot, entry.sourceFile), 'utf8')
        const { unclassifiedFlags } = extractCliSurface(source, entry.sourceFile)
        const ignored = entry.ignoredLiterals.map(({ token }) => token).sort()
        expect(unclassifiedFlags, formatUnclassified(entry.sourceFile)).toEqual(ignored)
      })

      it('records the current minVersion floor', () => {
        expect(entry.minVersion).toEqual(presetOf(kind)?.minVersion ?? null)
      })
    })
  }
})

describe('Provider CLI lock pins', () => {
  it('requires Claude Code with origin-aware reliable Result streams', () => {
    expect(presetOf('claude-code')?.minVersion).toBe('2.1.208')
  })

  it('never pins a version below the Provider minVersion floor', () => {
    for (const preset of PRESET_PROVIDERS) {
      const pinned = lock.providers.find((entry) => entry.kind === preset.kind)
      expect(pinned, `provider-cli-lock.json has no entry for "${preset.kind}"`).toBeDefined()
      if (!preset.minVersion || !pinned) continue
      expect(
        isVersionAtLeast(pinned.version, preset.minVersion),
        formatPinBelowFloor(preset.kind, pinned.version, preset.minVersion),
      ).toBe(true)
    }
  })
})
