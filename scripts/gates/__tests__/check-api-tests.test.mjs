import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The gate's own regression tests.
 *
 * The bug these exist to prevent: a suite that fails to LOAD produces zero
 * failing assertions, so a gate that only counts assertion failures reports
 * success on a run where nothing executed. Verified by hand against the real
 * apps/api suite, but re-running that here would cost minutes — so these drive
 * the script with synthetic vitest reports instead.
 */

const SCRIPT = fileURLToPath(new URL('../check-api-tests.mjs', import.meta.url))
const BASELINE_NAME = 'rolls back already-switched sub-repos when a later checkout fails'

/**
 * Run the gate against a canned report, stubbing out the vitest invocation.
 *
 * `pnpm` is replaced by a fake on PATH that writes `report` and exits with
 * `exitCode`, so the script's real control flow — including its handling of
 * res.status/res.error — is exercised end to end.
 */
function runGate(report, exitCode = 0, suiteBaseline = null, extraEnv = {}, gateArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'api-gate-'))
  const reportPath = join(dir, 'report.json')
  const binDir = join(dir, 'bin')
  const vitestArgsPath = join(dir, 'vitest-args.txt')
  spawnSync('mkdir', ['-p', binDir])

  writeFileSync(reportPath, JSON.stringify(report))
  // The fake also records its argv, so tests can assert what the gate passed
  // down to vitest (e.g. that a --shard flag is forwarded verbatim).
  writeFileSync(
    join(binDir, 'pnpm'),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${vitestArgsPath}"\ncat "${reportPath}" > "${reportPath}.copy"\nexit ${exitCode}\n`,
    { mode: 0o755 },
  )

  const args = [SCRIPT]
  // The waiver override is an explicit flag, never an env var — see the gate.
  if (suiteBaseline) args.push(`--suite-baseline=${suiteBaseline}`)
  args.push(...gateArgs)
  const res = spawnSync('node', args, {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      API_TEST_REPORT: reportPath,
      ...extraEnv,
    },
  })
  let vitestArgs = ''
  try {
    vitestArgs = readFileSync(vitestArgsPath, 'utf-8')
  } catch {
    // The gate may fail before spawning vitest (e.g. flag validation).
  }
  return { status: res.status, out: `${res.stdout}${res.stderr}`, vitestArgs }
}

/**
 * Realistic totals: the gate refuses a run that collected almost nothing, so a
 * fixture with 100 tests would be rejected for the wrong reason.
 */
const passingReport = {
  success: true,
  numTotalTestSuites: 1138,
  numFailedTestSuites: 0,
  numTotalTests: 4202,
  numFailedTests: 0,
  testResults: [{ name: 'a.test.ts', status: 'passed', assertionResults: [] }],
}

/**
 * A report with one ordinary assertion failure.
 *
 * BASELINE is empty now, so there is no such thing as a waived assertion — this
 * report must always be rejected. It used to hold the two entries that were
 * fixed at source (root-vs-chmod, same-tick mtime).
 */
const assertionFailingReport = {
  ...passingReport,
  success: false,
  numFailedTests: 1,
  testResults: [
    {
      name: 'git-workspace.test.ts',
      status: 'failed',
      assertionResults: [{ status: 'failed', fullName: `git-workspace ${BASELINE_NAME}` }],
    },
  ],
}

/**
 * A report whose only failure is a suite named in SUITE_BASELINE.
 *
 * The one kind of failure the gate still waives, so it is the right base for
 * tests that need "otherwise acceptable" plus one specific defect.
 */
/**
 * Stand-in waiver used only to exercise the mechanism. The real SUITE_BASELINE
 * is empty and must stay that way; injecting here keeps these tests honest
 * without surrendering regression protection on an actual file.
 */
const FIXTURE_SUITE_BASELINE = JSON.stringify([
  { match: 'src/routes/__tests__/scm-sources.test.ts', reason: 'fixture' },
])

const waivedSuiteReport = {
  ...passingReport,
  success: false,
  numFailedTestSuites: 1,
  testResults: [
    { name: 'src/routes/__tests__/scm-sources.test.ts', status: 'failed', assertionResults: [] },
  ],
}

describe('check-api-tests gate', () => {
  it('fails on any assertion failure now that BASELINE is empty', () => {
    const { status, out } = runGate(assertionFailingReport, 1)
    assert.equal(status, 1)
    assert.match(out, /new assertion failures outside the baseline/)
  })

  it('passes a clean CI run — an empty BASELINE has nothing to go stale', () => {
    // The stale-baseline check is guarded on `deterministic.length > 0`, so an
    // empty BASELINE must not turn every green run red.
    const { status } = runGate(passingReport, 0, null, { CI: '1' })
    assert.equal(status, 0)
  })

  it('does not fire the stale-baseline check outside CI', () => {
    const { status } = runGate(passingReport, 0, null, { CI: '' })
    assert.equal(status, 0)
  })

  it('fails a run that collected almost nothing', () => {
    const { status, out } = runGate({ ...passingReport, numTotalTests: 3 })
    assert.equal(status, 1)
    assert.match(out, /only 3 tests ran/)
  })

  it('fails when vitest counted more failures than the gate enumerated', () => {
    // Base on a waived suite, not a plain assertion failure: with BASELINE empty
    // the latter is rejected by the unexpected-assertion check first, so the
    // accounting check under test would never be reached.
    const { status, out } = runGate(
      { ...waivedSuiteReport, numFailedTests: 5 },
      1,
      FIXTURE_SUITE_BASELINE,
    )
    assert.equal(status, 1)
    assert.match(out, /cannot fully account/)
  })

  it('fails on an unrecognised assertion failure', () => {
    const { status, out } = runGate({
      ...assertionFailingReport,
      numFailedTests: 3,
      testResults: [
        ...assertionFailingReport.testResults,
        {
          name: 'x.test.ts',
          status: 'failed',
          assertionResults: [{ status: 'failed', fullName: 'something brand new' }],
        },
      ],
    })
    assert.equal(status, 1)
    assert.match(out, /something brand new/)
  })

  it('fails when a suite could not load, despite zero failing assertions', () => {
    // The regression this gate was rewritten for: an import-time throw yields a
    // failed SUITE with no failed assertions, which the old check read as green.
    const { status, out } = runGate(
      {
        ...passingReport,
        success: false,
        numFailedTestSuites: 1,
        testResults: [{ name: 'broken.test.ts', status: 'failed', assertionResults: [] }],
      },
      1,
    )
    assert.equal(status, 1)
    assert.match(out, /failed to run/)
    assert.match(out, /broken\.test\.ts/)
  })

  it('fails when vitest reports success=false with nothing attributable', () => {
    const { status, out } = runGate({ ...passingReport, success: false }, 1)
    assert.equal(status, 1)
    assert.match(out, /success=false/)
  })

  it('fails on a non-zero exit this gate cannot explain', () => {
    const { status, out } = runGate(passingReport, 1)
    assert.equal(status, 1)
    assert.match(out, /cannot explain/)
  })

  it('fails when the report is missing entirely', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-gate-'))
    const binDir = join(dir, 'bin')
    spawnSync('mkdir', ['-p', binDir])
    writeFileSync(join(binDir, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })

    const res = spawnSync('node', [SCRIPT], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        API_TEST_REPORT: join(dir, 'does-not-exist.json'),
      },
    })
    assert.equal(res.status, 1)
    assert.match(`${res.stdout}${res.stderr}`, /could not read/)
  })
})

describe('check-api-tests gate — suite baseline', () => {
  it('waives a suite-level failure that is named in SUITE_BASELINE', () => {
    const { status, out } = runGate(waivedSuiteReport, 1, FIXTURE_SUITE_BASELINE)
    assert.equal(status, 0)
    assert.match(out, /known suite/)
  })

  it('still fails on a suite-level failure outside SUITE_BASELINE', () => {
    const { status, out } = runGate(
      {
        ...passingReport,
        success: false,
        numFailedTestSuites: 1,
        testResults: [
          {
            name: 'src/routes/__tests__/brand-new.test.ts',
            status: 'failed',
            assertionResults: [],
          },
        ],
      },
      1,
    )
    assert.equal(status, 1)
    assert.match(out, /brand-new\.test\.ts/)
  })
})

describe('check-api-tests gate — file-level waiver covers its assertions', () => {
  it('waives assertion failures inside a SUITE_BASELINE file', () => {
    // A file waived at suite level has ALL its assertions waived, since a file
    // whose failures move around cannot be pinned test by test.
    const { status, out } = runGate(
      {
        ...passingReport,
        success: false,
        numFailedTests: 1,
        numFailedTestSuites: 1,
        testResults: [
          {
            name: 'src/routes/__tests__/scm-sources.test.ts',
            status: 'failed',
            assertionResults: [
              { status: 'failed', fullName: 'some scm assertion that varies per run' },
            ],
          },
        ],
      },
      1,
      FIXTURE_SUITE_BASELINE,
    )
    assert.equal(status, 0)
    assert.match(out, /known/)
  })

  it('still fails on an assertion in a file that is NOT waived', () => {
    const { status, out } = runGate(
      {
        ...assertionFailingReport,
        numFailedTests: 3,
        testResults: [
          ...assertionFailingReport.testResults,
          {
            name: 'src/routes/__tests__/agents.test.ts',
            status: 'failed',
            assertionResults: [{ status: 'failed', fullName: 'a real regression' }],
          },
        ],
      },
      1,
    )
    assert.equal(status, 1)
    assert.match(out, /a real regression/)
  })
})

describe('check-api-tests gate — SUITE_BASELINE is path-anchored', () => {
  /**
   * A report rooted at `root`: one waived file (git-workspace, in SUITE_BASELINE)
   * plus three real regressions across two other files.
   *
   * artifact-storage counts among the real ones — its assertion used to sit in
   * BASELINE, and now that BASELINE is empty nothing waives it. That is the
   * point of emptying the list, so the expectation moved rather than the test.
   */
  const reportAt = (root) => ({
    ...passingReport,
    success: false,
    numFailedTests: 4,
    testResults: [
      {
        name: `${root}/apps/api/src/lib/__tests__/git-workspace.test.ts`,
        status: 'failed',
        assertionResults: [{ status: 'failed', fullName: `git-workspace ${BASELINE_NAME}` }],
      },
      {
        name: `${root}/apps/api/src/lib/__tests__/artifact-storage.test.ts`,
        status: 'failed',
        assertionResults: [
          {
            status: 'failed',
            fullName:
              'scanAndRegisterArtifacts skips stale artifacts that predate the current run start time',
          },
        ],
      },
      {
        name: `${root}/apps/api/src/routes/__tests__/agents.test.ts`,
        status: 'failed',
        assertionResults: [
          { status: 'failed', fullName: 'agents regression one' },
          { status: 'failed', fullName: 'agents regression two' },
        ],
      },
    ],
  })

  // vitest reports ABSOLUTE paths, so a bare substring was matched against the
  // checkout root as well: `{match:'workspace'}` waived every file under
  // /var/lib/jenkins/workspace/<job>, passing real regressions as green.
  for (const root of [
    '/var/lib/jenkins/workspace/a2wave',
    '/workspace/a2wave',
    '/builds/ai/a2wave',
    '/home/u/conductor/workspaces/a2wave',
  ]) {
    it(`reports real regressions when the checkout is rooted at ${root}`, () => {
      const { status, out } = runGate(
        reportAt(root),
        1,
        // git-workspace is the waived file in this fixture; the point of the
        // test is that the checkout ROOT must not also match the entry.
        JSON.stringify([{ match: 'src/lib/__tests__/git-workspace.test.ts', reason: 'fixture' }]),
      )
      assert.equal(status, 1)
      assert.match(out, /new=3/)
      assert.match(out, /agents regression one/)
    })
  }
})

describe('check-api-tests gate — the `/` anchor is what prevents over-matching', () => {
  it('does not waive a file whose name merely CONTAINS a baseline path', () => {
    // Distinguishes the anchor from the path normalisation. This path ends with
    // the entry as a bare SUBSTRING (`...legacy/xsrc/routes/__tests__/...`) but
    // not at a `/` boundary, so only the leading `/` in the matcher rejects it —
    // drop the anchor and this file is waived and the regression passes.
    const { status, out } = runGate(
      {
        ...assertionFailingReport,
        numFailedTests: 3,
        testResults: [
          ...assertionFailingReport.testResults,
          {
            name: '/builds/a2wave/apps/api/legacy/xsrc/routes/__tests__/scm-sources.test.ts',
            status: 'failed',
            assertionResults: [{ status: 'failed', fullName: 'a real regression' }],
          },
        ],
      },
      1,
    )
    assert.equal(status, 1)
    assert.match(out, /a real regression/)
  })
})

describe('check-api-tests gate — sharding', () => {
  /**
   * CI splits the api suite into N parallel jobs via vitest's --shard. The gate
   * must forward the flag, and must scale its collection floor: a single shard
   * legitimately collects ~1/N of the suite, so holding it to the full-run
   * MIN_TESTS would reject every sharded run.
   */
  const shardedReport = { ...passingReport, numTotalTests: 700 }

  it('forwards --shard to the vitest invocation verbatim', () => {
    const { status, vitestArgs } = runGate(shardedReport, 0, null, {}, ['--shard=2/4'])
    assert.equal(status, 0)
    assert.match(vitestArgs, /--shard=2\/4/)
  })

  it('does not pass a --shard flag when none was given', () => {
    const { status, vitestArgs } = runGate(passingReport, 0)
    assert.equal(status, 0)
    assert.doesNotMatch(vitestArgs, /--shard/)
  })

  it('scales the collection floor by shard count', () => {
    // 700 tests: fine for one shard of four (floor scales down), but a full
    // unsharded run collecting only 700 is a broken include glob.
    const sharded = runGate(shardedReport, 0, null, {}, ['--shard=1/4'])
    assert.equal(sharded.status, 0)
    const full = runGate(shardedReport, 0)
    assert.equal(full.status, 1)
    assert.match(full.out, /only 700 tests ran/)
  })

  it('still rejects a sharded run that collected almost nothing', () => {
    const { status, out } = runGate({ ...passingReport, numTotalTests: 3 }, 0, null, {}, [
      '--shard=1/4',
    ])
    assert.equal(status, 1)
    assert.match(out, /only 3 tests ran/)
  })

  it('names the shard in the summary line', () => {
    const { out } = runGate(shardedReport, 0, null, {}, ['--shard=3/4'])
    assert.match(out, /shard=3\/4/)
  })

  for (const bad of ['--shard=0/4', '--shard=5/4', '--shard=abc', '--shard=2', '--shard=1/0']) {
    it(`rejects a malformed shard flag: ${bad}`, () => {
      const { status, out, vitestArgs } = runGate(passingReport, 0, null, {}, [bad])
      assert.equal(status, 1)
      assert.match(out, /--shard/)
      // Validation must happen before vitest is spawned.
      assert.equal(vitestArgs, '')
    })
  }
})
