#!/usr/bin/env node
/**
 * Run the apps/api unit tests and fail on anything except a named baseline of
 * known-broken ASSERTIONS.
 *
 * Why a baseline instead of `allow_failure: true`: a blanket allow_failure lets
 * an MR add any number of API regressions and still show a green pipeline,
 * which is exactly the gate this repo says is non-negotiable. Two tests fail on
 * the shared runner for environment reasons (see BASELINE), and neither is
 * fixable from a CLI-scoped MR — so they are named explicitly.
 *
 * The baseline waives *assertion* failures ONLY. Every other way a run can go
 * wrong — a file that throws while loading, a failing `beforeAll`, a crashed
 * worker, vitest exiting non-zero for a reason with no failing assertion — is a
 * hard failure. Without that split the gate is worse than useless: a regression
 * that stops the suite from loading produces zero failing assertions, so a
 * naive "no unexpected assertion failures" check reports success on a suite
 * that never ran.
 *
 * Shrink the baseline, never grow it: adding an entry needs a reason recorded.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const REPORT_PATH = process.env.API_TEST_REPORT ?? '/tmp/api-tests.json'

/**
 * Substrings that identify the known-failing tests. Keep the reason attached.
 *
 * Empty: both former entries were fixed at source rather than waived.
 * `rolls back already-switched sub-repos` now skips on uid 0 instead of
 * asserting that root cannot write, and `skips stale artifacts` pins the fresh
 * file's mtime instead of racing the clock. A waiver hides the failure from the
 * gate but leaves the bad assumption in the test, so the test stops being worth
 * running everywhere else too.
 *
 * KNOWN GAP — an empty BASELINE does not mean the suite is deterministic. Run
 * in parallel (vitest's default), apps/api still fails a handful of assertions
 * per run, a different handful each time: measured 8, then 4, then 0 locally,
 * and 0 / 2 / 0 on an unmodified main, so it predates this branch. The tests
 * pass individually — it is cross-file interference, not a bug in any one of
 * them. Do NOT paper over it by listing whatever failed today: the names rotate,
 * so the list would grow without ever covering the run after next. Fix the
 * shared state (or pin `--no-file-parallelism`) instead.
 */
const BASELINE = []

const isBaseline = (name) => BASELINE.some((b) => name.includes(b.match))

/**
 * Test FILES whose suite-level failure is waived, with the reason.
 *
 * Separate from BASELINE because the two are different failure kinds: an entry
 * here waives "this file could not finish setting up", not "this assertion is
 * wrong". Both lists shrink, never grow.
 *
 * ⚠️ A file listed here has NO regression protection at all — every assertion
 * inside it is waived, not just the ones that were flaky. Weigh that before
 * adding one: prefer fixing the shared state, as was done for
 * evaluation-tasks.test.ts (its entry is gone because the leak was found).
 */
const SUITE_BASELINE = []

/**
 * Test-only injection point for the waiver mechanism.
 *
 * Both baselines are empty, which is the goal — but the waiver logic itself
 * still has to be exercised (anchoring, "assertions inside a waived file are
 * waived too", the failure-count reconciliation). Without this, those tests
 * could only run by keeping a real waiver alive, i.e. by giving up regression
 * protection on a real file purely to satisfy a test.
 *
 * Deliberately an explicit **argv flag** rather than an env var (review [P3]):
 * an env var is ambient and silent, so any runner could export it and quietly
 * waive whole suites — which is exactly the "shrink, never grow, record a
 * reason" rule this gate exists to enforce. A flag has to be typed into the
 * command line, CI never passes one, and the override announces itself loudly
 * below so it can never pass for a normal run.
 */
function parseSuiteBaselineFlag(argv) {
  const flag = '--suite-baseline='
  const arg = argv.find((a) => a.startsWith(flag))
  if (!arg) return null
  let parsed
  try {
    parsed = JSON.parse(arg.slice(flag.length))
  } catch (err) {
    fail(`[api-tests] ✗ --suite-baseline is not valid JSON: ${err.message}`)
  }
  if (!Array.isArray(parsed) || parsed.some((e) => typeof e?.match !== 'string')) {
    fail('[api-tests] ✗ --suite-baseline must be a JSON array of { match: string } objects.')
  }
  return parsed
}

/**
 * Optional `--shard=<i>/<N>` — forwarded verbatim to vitest so CI can split the
 * api suite into N parallel jobs (the whole-suite wall clock is the pipeline's
 * critical path). Validated here, before vitest spawns: vitest's own error for
 * a bad shard is an unexplained non-zero exit, which this gate refuses to
 * classify — better to name the actual mistake.
 */
function parseShardFlag(argv) {
  const flag = '--shard='
  const arg = argv.find((a) => a.startsWith(flag))
  if (!arg) return null
  const m = arg.slice(flag.length).match(/^([1-9]\d*)\/([1-9]\d*)$/)
  if (!m) fail(`[api-tests] ✗ --shard must look like <index>/<count> (1-based), got: ${arg}`)
  const [index, count] = [Number(m[1]), Number(m[2])]
  if (index > count) {
    fail(`[api-tests] ✗ --shard index ${index} exceeds shard count ${count}.`)
  }
  return { index, count }
}

const shard = parseShardFlag(process.argv.slice(2))

const suiteBaselineOverride = parseSuiteBaselineFlag(process.argv.slice(2))
const suiteBaseline = suiteBaselineOverride ?? SUITE_BASELINE
if (suiteBaselineOverride) {
  console.warn(
    `[api-tests] ⚠ SUITE_BASELINE overridden via --suite-baseline (${suiteBaselineOverride.length} entry/entries). This waives whole test files and is for exercising the gate itself — never for a real run.`,
  )
}

/**
 * Repo-relative path for a report entry, for READABILITY in messages.
 *
 * It does NOT do the anchoring — slicing a prefix cannot change an `endsWith`
 * result. The protection comes entirely from the leading `/` in the matcher
 * below. Keeping this separate matters: the fail-open it replaced (a bare
 * substring matching the checkout root, so `{ match: 'workspace' }` waived
 * every file under `/var/lib/jenkins/workspace/<job>`) is fixed by the anchor,
 * and a future edit that drops the anchor would not be caught by anything here.
 */
function repoRelative(name) {
  const marker = '/apps/api/'
  const i = name.indexOf(marker)
  return i === -1 ? name : name.slice(i + 1)
}

/**
 * Anchored at a path BOUNDARY — the leading `/` is what stops an entry from
 * matching a parent directory, and is the whole fix for the checkout-root
 * fail-open. The `rel === b.match` branch only serves already-relative inputs.
 */
const isSuiteBaseline = (name) => {
  const rel = repoRelative(name)
  return suiteBaseline.some((b) => rel === b.match || rel.endsWith(`/${b.match}`))
}

/**
 * A run that collects almost nothing reports no failures — which is not a pass.
 *
 * A broken `include` glob, a bad `--filter`, or a config edit that stops
 * collection all produce a clean report over an empty run. Same class as the
 * suite-load hole, one level up: previously "a file didn't load", now "no files
 * loaded". apps/api ran 4202 at the time of writing; lower this only with a
 * reason, and only when the suite genuinely shrank.
 */
const MIN_TESTS = 4000

function fail(...lines) {
  for (const line of lines) console.error(line)
  process.exit(1)
}

const res = spawnSync(
  'pnpm',
  [
    '--filter',
    '@a2wave/api',
    'exec',
    'vitest',
    'run',
    '--reporter=json',
    `--outputFile=${REPORT_PATH}`,
    ...(shard ? [`--shard=${shard.index}/${shard.count}`] : []),
  ],
  { stdio: ['ignore', 'inherit', 'inherit'], encoding: 'utf-8' },
)

// The runner itself never started, or died on a signal (OOM-killed worker,
// timeout kill). There is no report to reason about.
if (res.error) fail(`[api-tests] ✗ could not run vitest: ${res.error.message}`)
if (res.signal) fail(`[api-tests] ✗ vitest terminated by signal ${res.signal}`)

let report
try {
  report = JSON.parse(readFileSync(REPORT_PATH, 'utf-8'))
} catch (err) {
  fail(
    `[api-tests] ✗ could not read the vitest JSON report at ${REPORT_PATH}: ${err.message}`,
    '  The run produced no usable result — treating as failure regardless of exit code.',
  )
}

const failedAssertions = []
for (const file of report.testResults ?? []) {
  for (const t of file.assertionResults ?? []) {
    if (t.status === 'failed') failedAssertions.push(t.fullName ?? t.title ?? '(unnamed)')
  }
}

/**
 * Assertions inside a file waived by SUITE_BASELINE are waived too.
 *
 * A file listed there is unreliable as a whole, so enumerating its individual
 * assertions would just move the noise: a different one fails each run.
 */
const waivedFiles = new Set(
  (report.testResults ?? [])
    .filter((f) => isSuiteBaseline(f.name))
    .flatMap((f) => (f.assertionResults ?? []).map((t) => t.fullName ?? t.title ?? '')),
)
const isWaived = (name) => isBaseline(name) || waivedFiles.has(name)

const unexpected = failedAssertions.filter((name) => !isWaived(name))
const expected = failedAssertions.filter(isWaived)

console.log(
  `[api-tests]${shard ? ` shard=${shard.index}/${shard.count}` : ''} ` +
    `suites=${report.numTotalTestSuites ?? '?'} tests=${report.numTotalTests ?? '?'} ` +
    `failedAssertions=${failedAssertions.length} baseline=${expected.length} new=${unexpected.length}`,
)
for (const name of expected) console.log(`  · known: ${name}`)

if (unexpected.length > 0) {
  fail(
    '\n[api-tests] ✗ new assertion failures outside the baseline:',
    ...unexpected.map((name) => `  × ${name}`),
    '\nFix them, or — if genuinely pre-existing and environmental — add an entry to',
    'scripts/gates/check-api-tests.mjs BASELINE with the reason.',
  )
}

/**
 * Suite-level failures are NOT waivable.
 *
 * `numFailedTestSuites` counts files that could not load or whose hooks threw.
 * Such a file contributes no failing assertions, so the check above sees a
 * clean run — this is the hole that let a broken import pass as green.
 * Every baseline entry is an assertion inside a suite that otherwise loads, so
 * a file-level failure is always new information.
 */
const failedSuiteFiles = (report.testResults ?? [])
  .filter((f) => f.status === 'failed')
  .filter((f) => !(f.assertionResults ?? []).some((t) => t.status === 'failed'))
  .map((f) => f.name)
const unexpectedSuites = failedSuiteFiles.filter((name) => !isSuiteBaseline(name))
if (failedSuiteFiles.length > 0) {
  console.log(
    `[api-tests] suiteFailures=${failedSuiteFiles.length} baseline=${failedSuiteFiles.length - unexpectedSuites.length} new=${unexpectedSuites.length}`,
  )
  for (const name of failedSuiteFiles.filter(isSuiteBaseline)) {
    console.log(`  · known suite: ${name}`)
  }
}
if (unexpectedSuites.length > 0) {
  fail(
    `\n[api-tests] ✗ ${unexpectedSuites.length} test suite(s) failed to run.`,
    '  A suite that cannot load reports no failing assertions, so this is never',
    '  covered by the assertion baseline — a file threw on import or in a hook.',
    ...unexpectedSuites.map((name) => `  × ${name}`),
    '\nFix it, or — if pre-existing and environmental — add an entry to',
    'scripts/gates/check-api-tests.mjs SUITE_BASELINE with the reason.',
  )
}

// Last line of defence: vitest said the run failed, or exited non-zero, for a
// reason none of the checks above explained. Do not guess — fail loudly.
const unexplainedExit = res.status !== 0 && expected.length === 0 && failedSuiteFiles.length === 0
if (report.success === false && failedAssertions.length === 0 && failedSuiteFiles.length === 0) {
  fail(
    '\n[api-tests] ✗ vitest reported success=false with no failing assertion.',
    '  Something failed outside the tests themselves (config, setup, teardown).',
  )
}
if (unexplainedExit) {
  fail(
    `\n[api-tests] ✗ vitest exited ${res.status} but no failure was attributable to a test.`,
    '  Refusing to report success on an exit code this gate cannot explain.',
  )
}

/**
 * A shard legitimately collects ~1/N of the suite, so the floor scales down
 * with it. Halved on top of the split because vitest shards by FILE count, not
 * test count — an unlucky shard of small files can sit well under totals/N
 * without anything being wrong. The floor's job survives the slack: a broken
 * include glob or bad --filter yields near-zero, not merely below-average.
 */
const minTests = shard ? Math.floor(MIN_TESTS / shard.count / 2) : MIN_TESTS
if ((report.numTotalTests ?? 0) < minTests) {
  fail(
    `\n[api-tests] ✗ only ${report.numTotalTests ?? 0} tests ran (expected at least ${minTests}).`,
    '  A run that collects almost nothing reports no failures — that is not a pass.',
    '  Check the vitest include globs and the --filter before lowering MIN_TESTS.',
  )
}

// The enumerated failures must account for what vitest itself counted; a
// mismatch means the report holds a failure this gate did not classify.
const reportedFailures = report.numFailedTests ?? failedAssertions.length
if (reportedFailures !== failedAssertions.length) {
  fail(
    `\n[api-tests] ✗ vitest counted ${reportedFailures} failing test(s) but this gate enumerated ${failedAssertions.length}.`,
    '  Refusing to classify a report it cannot fully account for.',
  )
}

// Every baseline entry that no longer fails should be removed from the list.
// `intermittent` entries are exempt from the nudge: not failing is their normal
// state, so reporting them as stale every green run would train people to
// ignore the message that matters for the deterministic ones.
const stale = BASELINE.filter(
  (b) => !b.intermittent && !failedAssertions.some((name) => name.includes(b.match)),
)
const deterministic = BASELINE.filter((b) => !b.intermittent)
// Only meaningful in CI: the baseline entries are all runner-specific (root
// permissions, clock granularity), so on a developer machine they legitimately
// all pass and the check would fail every local run.
if (process.env.CI && stale.length === deterministic.length && deterministic.length > 0) {
  // Cannot distinguish "both were fixed" from "neither ran", and both warrant a
  // decision rather than a log line that scrolls past.
  fail(
    '\n[api-tests] ✗ no baseline entry failed this run.',
    '  Either they are fixed — delete them from BASELINE and say so in the MR —',
    '  or the tests never executed. Both need a human, not a green tick.',
  )
}
if (stale.length > 0) {
  console.log('\n[api-tests] these baseline entries now pass — delete them:')
  for (const b of stale) console.log(`  ✓ ${b.match}`)
}

console.log('[api-tests] ✓ no new failures')
