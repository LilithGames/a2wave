#!/usr/bin/env node
/**
 * Classify a PR's changed files into CI lanes, so the workflow can skip
 * expensive jobs a diff cannot affect.
 *
 * Design rules (learned from hermes-agent's detect + ollama's `changes` job):
 *
 * - FAIL OPEN. A file no rule recognises turns every lane on. The classifier
 *   may only *exclude* work it can positively prove irrelevant; anything else
 *   errs toward running the suite. Same for `--all` (used on push to main):
 *   post-merge validation is never weakened by lane skipping.
 * - Cheap gates (lint, typecheck, secret-scan) are NOT lanes — the workflow
 *   runs them unconditionally. Only expensive suites are skippable.
 * - This must stay a PURE mapping from paths to lanes (exported for unit
 *   tests); the git invocation lives only in the CLI entry below.
 * - Never replace this with `on.paths`: with a required aggregate check, a
 *   workflow that does not trigger leaves the check pending forever and the
 *   PR unmergeable. Skipping must happen INSIDE the workflow, where skipped
 *   still reports a conclusion.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

/** Lanes the workflow can skip. Order here is the output order, nothing more. */
export const LANES = ['api', 'web', 'cli', 'licenses', 'pgschema']

/**
 * Paths that force EVERY lane on — they configure the pipeline or the
 * dependency graph itself, so no per-lane reasoning is safe (vllm calls the
 * same list `run_all_patterns`).
 */
const RUN_ALL = [
  /^\.github\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^biome\.json$/,
  /^vitest\.workspace\./,
  /^scripts\/gates\//,
  /^scripts\/ci\//,
  /^\.husky\//,
]

/**
 * Positively-known-irrelevant paths: nothing in any test lane can be affected.
 * Lint and secret-scan still run on these — they are not lanes.
 * Keep this list SHORT and obvious; when in doubt, let a file fall through to
 * the fail-open default instead of adding it here.
 */
const NO_LANES = [
  /^docs\//,
  // Root-level prose and instruction files only. NOT a global *.md rule:
  // apps/web/src/content/manual/** is in-app content that ships in the web
  // bundle, so a .md there must reach the web lane via the RULES below.
  /^[^/]+\.md$/,
  /(^|\/)(AGENTS|CLAUDE)\.md$/,
  /^LICENSE/,
  /^\.gitignore$/,
  /^\.gitleaks\.toml$/, // gitleaks-config tests live in the always-on lint job
  /^e2e\//, // Playwright is deliberately not in CI (see ci.yml header)
  /^playwright\.config\./,
]

/** First matching rule wins; a file matching nothing turns every lane on. */
const RULES = [
  { pattern: /^apps\/api\/src\/db\//, lanes: ['api', 'pgschema'] },
  { pattern: /^apps\/api\/(drizzle|drizzle-pg)\//, lanes: ['api', 'pgschema'] },
  { pattern: /^apps\/api\/drizzle(\.pg)?\.config\.ts$/, lanes: ['api', 'pgschema'] },
  { pattern: /^apps\/api\//, lanes: ['api'] },
  { pattern: /^apps\/web\//, lanes: ['web'] },
  { pattern: /^apps\/cli\//, lanes: ['cli'] },
  // shared is imported by api, web and cli alike; pgschema regenerates from the
  // shared-typed schema, so it rides along too.
  { pattern: /^packages\/shared\//, lanes: ['api', 'web', 'cli', 'pgschema'] },
  // scripts/ tests (deploy, provider-clis, auth-secret…) run in the cli lane.
  { pattern: /^scripts\//, lanes: ['cli'] },
  // A per-app package.json can add a dependency: its own lane + the license
  // inventory. (The ROOT package.json is a RUN_ALL path, handled above.)
  { pattern: /^apps\/api\/package\.json$/, lanes: ['api', 'licenses'] },
  { pattern: /^apps\/web\/package\.json$/, lanes: ['web', 'licenses'] },
  { pattern: /^apps\/cli\/package\.json$/, lanes: ['cli', 'licenses'] },
  { pattern: /^packages\/shared\/package\.json$/, lanes: ['api', 'web', 'cli', 'licenses'] },
]

/**
 * Paths whose change requires a human sign-off (`ci-reviewed` label) before
 * merge — the review-labels gate. These are the spots where CLAUDE.md says
 * "reviewed via MR" / "shrink-only" but nothing enforced it: the CI definition
 * itself, the gate scripts and their waiver lists, the pinned CLI lock,
 * coverage thresholds, and DB migrations.
 */
const CI_REVIEW = [
  /^\.github\//,
  /^scripts\/gates\//,
  /^scripts\/ci\//,
  /^provider-cli-lock\.json$/,
  /(^|\/)vitest\.config\.ts$/,
  /^apps\/api\/(drizzle|drizzle-pg)\//,
  /^\.husky\//,
]

const matchesAny = (patterns, file) => patterns.some((p) => p.test(file))

/**
 * @param {string[]} files repo-relative changed paths
 * @returns {{lanes: Record<string, boolean>, ciReview: boolean, ciReviewFiles: string[], failOpen: string[]}}
 */
export function classify(files) {
  const lanes = Object.fromEntries(LANES.map((l) => [l, false]))
  const failOpen = []

  for (const file of files) {
    if (matchesAny(RUN_ALL, file)) {
      for (const l of LANES) lanes[l] = true
      continue
    }
    if (matchesAny(NO_LANES, file)) continue
    // package.json rules sit inside RULES but must win over the app-directory
    // prefix rules, so RULES is scanned for the most specific match first:
    const rule = RULES.filter((r) => r.pattern.test(file)).sort(
      (a, b) => b.pattern.source.length - a.pattern.source.length,
    )[0]
    if (rule) {
      for (const l of rule.lanes) lanes[l] = true
    } else {
      // Unknown file: fail open.
      failOpen.push(file)
      for (const l of LANES) lanes[l] = true
    }
  }

  const ciReviewFiles = files.filter((f) => matchesAny(CI_REVIEW, f))
  return { lanes, ciReview: ciReviewFiles.length > 0, ciReviewFiles, failOpen }
}

/** All lanes on, no review requirement implied by the event itself. */
export function allOn() {
  return {
    lanes: Object.fromEntries(LANES.map((l) => [l, true])),
    ciReview: false,
    ciReviewFiles: [],
    failOpen: [],
  }
}

export function toOutputs({ lanes, ciReview, ciReviewFiles }) {
  return [
    ...LANES.map((l) => `${l}=${lanes[l]}`),
    `ci_review=${ciReview}`,
    // Comma-joined for the label-gate message; paths cannot contain commas here.
    `ci_review_files=${ciReviewFiles.join(',')}`,
  ]
}

function main() {
  const argv = process.argv.slice(2)
  const arg = (name) => {
    const i = argv.indexOf(name)
    return i === -1 ? null : argv[i + 1]
  }

  let result
  if (argv.includes('--all')) {
    // push / workflow_dispatch: full validation, nothing skipped.
    result = allOn()
  } else {
    const base = arg('--base')
    const head = arg('--head')
    if (!base || !head) {
      console.error('usage: detect-changes.mjs --all | --base <sha> --head <sha>')
      process.exit(1)
    }
    // Three-dot: diff against the merge base, like the PR view — a stale main
    // in the PR branch must not drag unrelated files into the classification.
    const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      encoding: 'utf-8',
    })
    const files = out.split('\n').filter(Boolean)
    result = classify(files)
    console.error(`[detect] ${files.length} changed file(s)`)
    for (const f of result.failOpen) console.error(`[detect] fail-open (unclassified): ${f}`)
  }

  const lines = toOutputs(result)
  for (const line of lines) console.log(line)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
