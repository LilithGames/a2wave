#!/usr/bin/env node
/**
 * Dependency license inventory gate.
 *
 * docs/dependency-license-inventory.md is a compliance artifact: it claims the repository ships
 * no GPL/AGPL/LGPL/SSPL dependency and no unknown license. A hand-maintained claim drifts the
 * moment a dependency lands, so this gate regenerates the inventory from `pnpm licenses list
 * --json` and compares it against the committed file.
 *
 * Two modes:
 *   - default: regenerate and diff. A mismatch fails with the exact drift.
 *   - --write: regenerate and rewrite the committed file (the generator the doc header cites).
 *
 * `pnpm licenses list` reads the pnpm store, not just node_modules, so it fails on a machine
 * whose store was never populated or was pruned (ERR_PNPM_MISSING_PACKAGE_INDEX_FILE). That is
 * an environment problem, not inventory drift, so it is reported as SKIP rather than a red gate —
 * otherwise a cold CI cache would block every unrelated MR. Genuine drift still fails.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const INVENTORY = 'docs/dependency-license-inventory.md'

/**
 * Licenses that would impose source-disclosure obligations on a distributed proprietary
 * deployment. Presence of any of these must break the build, not merely be recorded.
 */
const FORBIDDEN_PATTERNS = [/\bA?GPL\b/i, /\bLGPL\b/i, /\bSSPL\b/i]

const UNKNOWN_LICENSES = new Set(['', 'Unknown', 'UNKNOWN', 'unknown', 'UNLICENSED'])

/**
 * Operating systems that native toolchains publish per-platform binary packages for. Sourced
 * from the `os:` fields pnpm records in the lockfile, so it covers the long tail (openharmony,
 * loong64 hosts) rather than just the three platforms developers run.
 */
const PLATFORMS = [
  'aix',
  'android',
  'darwin',
  'freebsd',
  'linux',
  'netbsd',
  'openbsd',
  'openharmony',
  'sunos',
  'win32',
]

/**
 * CPU architectures and libc/ABI tails that follow the platform token in these package names.
 * Matching against a closed list rather than "any trailing word" is what separates
 * `@esbuild/darwin-arm64` from `darwin-notify`: only the former's tail is an architecture.
 */
const ARCH_TAILS = [
  'arm',
  'arm64',
  'ia32',
  'x64',
  'x86',
  'loong64',
  'mips64el',
  'ppc64',
  'riscv64',
  's390x',
  'gnu',
  'musl',
  'gnueabihf',
  'musleabihf',
  'msvc',
]

/**
 * Matches a package whose name ends in `<platform>` followed by one or more architecture/libc
 * segments: `@esbuild/darwin-arm64`, `lightningcss-linux-x64-musl`, `@rollup/rollup-win32-x64-msvc`,
 * `@node-rs/argon2-linux-arm-gnueabihf`. The platform must sit on a `-` or `/` boundary and every
 * trailing segment must be a known arch/libc token, so ordinary packages that merely contain a
 * platform word — `linuxify`, `darwin-notify`, `is-wsl` — are not swept up.
 */
const PLATFORM_PACKAGE = new RegExp(
  `(?:^|[-/])(?:${PLATFORMS.join('|')})(?:-(?:${ARCH_TAILS.join('|')}))+$`,
)

/**
 * `fsevents` is a macOS-only dependency with no name-encoded platform, so the suffix rule cannot
 * see it. It is the only such package in the tree; a new one shows up as inventory drift on the
 * first CI run after it lands, which is exactly when it should be reviewed.
 */
const PLATFORM_ONLY_PACKAGES = new Set(['fsevents'])

/**
 * True when a package ships only on some platforms, so pnpm resolves a different set of them on
 * a macOS laptop than on a linux CI runner. Excluded from the rendered inventory to keep the
 * committed file host-independent — never from the forbidden-license check.
 */
export function isPlatformSpecific(name) {
  return PLATFORM_ONLY_PACKAGES.has(name) || PLATFORM_PACKAGE.test(name)
}

/** Run `pnpm licenses list --json` and parse it. Throws with a tagged cause on a cold store. */
export function readLicenseReport(runner = defaultRunner) {
  let raw
  try {
    raw = runner()
  } catch (error) {
    const detail = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`
    if (/MISSING_PACKAGE_INDEX_FILE|ERR_PNPM_/.test(detail)) {
      const wrapped = new Error(`pnpm could not read its store: ${detail.trim().split('\n')[0]}`)
      wrapped.environment = true
      throw wrapped
    }
    throw error
  }
  return JSON.parse(raw)
}

function defaultRunner() {
  return execFileSync('pnpm', ['licenses', 'list', '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
}

/**
 * Flatten pnpm's `{ license: [pkg, ...] }` shape into a sorted package list plus per-license
 * counts. pnpm reports one entry per (name, license) pair with all resolved versions attached,
 * so a package appearing under two licenses is deliberately counted once per license — that is
 * the compliance-relevant unit.
 *
 * Platform-specific native binaries are dropped (see `isPlatformSpecific`): pnpm resolves a
 * different subset of them per host, which would make the committed file unreproducible off the
 * machine that generated it. `platformPackages` keeps them for `findForbidden`, so the exclusion
 * is cosmetic and never a licensing blind spot.
 */
export function summarise(report) {
  const packages = []
  const platformPackages = []
  const counts = new Map()

  for (const [license, entries] of Object.entries(report)) {
    for (const entry of entries) {
      const pkg = {
        name: entry.name,
        versions: [...new Set(entry.versions ?? [])].join(', '),
        license,
      }
      if (isPlatformSpecific(entry.name)) {
        platformPackages.push(pkg)
        continue
      }
      counts.set(license, (counts.get(license) ?? 0) + 1)
      packages.push(pkg)
    }
  }

  packages.sort((a, b) => a.name.localeCompare(b.name) || a.license.localeCompare(b.license))
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const total = packages.length

  return { packages, platformPackages, summary, total }
}

/**
 * Licenses that must never appear. Returns the offending `license → packages` pairs.
 *
 * Scans the platform-specific packages too, even though they are absent from the rendered
 * inventory — they are still shipped code, and only their *listing* is host-dependent noise.
 */
export function findForbidden({ packages, platformPackages = [] }) {
  const violations = []
  for (const pkg of [...packages, ...platformPackages]) {
    if (UNKNOWN_LICENSES.has(pkg.license)) {
      violations.push({ ...pkg, reason: 'unknown license' })
      continue
    }
    if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(pkg.license))) {
      violations.push({ ...pkg, reason: 'copyleft license' })
    }
  }
  return violations
}

/**
 * Render the full document. `generatedOn` is threaded in rather than read from the clock so the
 * output is reproducible: regenerating on an unchanged dependency tree must be a no-op diff,
 * which a today's-date stamp would break every midnight.
 */
export function renderInventory({ packages, summary, total }, generatedOn) {
  const lines = [
    '# Dependency License Inventory',
    '',
    `Generated: ${generatedOn} · \`node scripts/gates/check-license-inventory.mjs --write\` · ${total} packages`,
    '',
    'Regenerate with `pnpm licenses:write`; `pnpm licenses:check` verifies this file still matches',
    'the installed dependency tree and is enforced in CI.',
    '',
    'Platform-specific native binaries (`@esbuild/linux-x64`, `lightningcss-darwin-arm64`,',
    '`fsevents`, …) are omitted: pnpm installs only the ones matching the host, so listing them',
    'would make this file differ between a macOS laptop and a Linux CI runner. They are still',
    'checked for forbidden licenses, and each carries the same license as its parent package.',
    '',
    '## Summary',
    '',
    '| License | Packages |',
    '|---|---|',
    ...summary.map(([license, count]) => `| ${license} | ${count} |`),
    '',
    'Result: **no GPL/AGPL/LGPL/SSPL dependencies and no unknown licenses.** The inventory includes notice, attribution, font, and file-level copyleft licenses such as MPL-2.0; release artifacts must retain all applicable notices.',
    '',
    '## Full list',
    '',
    '| Package | Version(s) | License |',
    '|---|---|---|',
    ...packages.map((pkg) => `| ${pkg.name} | ${pkg.versions} | ${pkg.license} |`),
    '',
  ]
  return lines.join('\n')
}

/** Pull the `Generated: <date>` stamp out of the committed file so a check run can reuse it. */
export function existingGeneratedOn(content) {
  return /^Generated:\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\b/m.exec(content)?.[1] ?? null
}

/** First differing line, for an actionable error instead of a whole-file dump. */
export function firstDifference(expected, actual) {
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const max = Math.max(expectedLines.length, actualLines.length)
  for (let i = 0; i < max; i++) {
    if (expectedLines[i] !== actualLines[i]) {
      return {
        line: i + 1,
        committed: actualLines[i] ?? '<end of file>',
        regenerated: expectedLines[i] ?? '<end of file>',
      }
    }
  }
  return null
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10)
}

function main() {
  const write = process.argv.includes('--write')
  const path = resolve(ROOT, INVENTORY)

  let report
  try {
    report = readLicenseReport()
  } catch (error) {
    if (error.environment) {
      console.warn(`[license-inventory] ⚠ skipped — ${error.message}`)
      console.warn('  Run `pnpm install` to populate the pnpm store, then re-run.')
      return
    }
    throw error
  }

  const data = summarise(report)

  const violations = findForbidden(data)
  if (violations.length > 0) {
    console.error('\n[license-inventory] ✗ disallowed licenses present:\n')
    for (const v of violations) console.error(`  - ${v.name} (${v.license}) — ${v.reason}`)
    process.exit(1)
  }

  const committed = readFileSync(path, 'utf8')

  if (write) {
    const rendered = renderInventory(data, todayStamp())
    // Keep the old stamp when nothing else moved, so a no-op regeneration stays a no-op diff.
    const unchangedBody =
      renderInventory(data, existingGeneratedOn(committed) ?? todayStamp()) === committed
    if (unchangedBody) {
      console.log(`[license-inventory] ✓ ${data.total} packages; ${INVENTORY} already up to date`)
      return
    }
    writeFileSync(path, rendered)
    console.log(`[license-inventory] ✓ wrote ${INVENTORY} — ${data.total} packages`)
    return
  }

  const expected = renderInventory(data, existingGeneratedOn(committed) ?? todayStamp())
  const difference = firstDifference(expected, committed)
  if (difference) {
    console.error(`\n[license-inventory] ✗ ${INVENTORY} is out of date.\n`)
    console.error(`  line ${difference.line}`)
    console.error(`    committed:    ${difference.committed}`)
    console.error(`    regenerated:  ${difference.regenerated}`)
    console.error('\nRegenerate with `pnpm licenses:write` and commit the result.\n')
    process.exit(1)
  }

  console.log(
    `[license-inventory] ✓ ${data.total} packages across ${data.summary.length} licenses; inventory matches`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
