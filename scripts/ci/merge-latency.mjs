#!/usr/bin/env node
/**
 * PR merge-latency report: how long merged PRs waited from open to merge.
 *
 * The CI overhaul (lane skipping, sharding, merge-on-green) exists to keep
 * this number flat as the team and the test suite grow — so it needs to be
 * measurable on demand, not re-derived by hand. Run quarterly, or after any
 * process change:
 *
 *   node scripts/ci/merge-latency.mjs [owner/repo]
 *
 * Uses `gh` for auth; humans and bots are reported separately because
 * dependabot's latency measures our attention, not the pipeline.
 */
import { execFileSync } from 'node:child_process'

/** q in [0,1] over a sorted array; nearest-rank, matching the analysis docs. */
export function percentile(sorted, q) {
  if (sorted.length === 0) return Number.NaN
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
}

/**
 * @param {{createdAt: string, mergedAt: string, author: string}[]} prs
 * @returns {{group: string, n: number, p25: number, median: number, p90: number}[]}
 *   latencies in hours, one row per author group (all / humans / bots)
 */
export function summarize(prs) {
  const hours = (pr) => (new Date(pr.mergedAt) - new Date(pr.createdAt)) / 3_600_000
  const isBot = (pr) => pr.author.endsWith('[bot]')
  const row = (group, list) => {
    const sorted = list.map(hours).sort((a, b) => a - b)
    return {
      group,
      n: sorted.length,
      p25: percentile(sorted, 0.25),
      median: percentile(sorted, 0.5),
      p90: percentile(sorted, 0.9),
    }
  }
  return [
    row('all', prs),
    row(
      'humans',
      prs.filter((pr) => !isBot(pr)),
    ),
    row('bots', prs.filter(isBot)),
  ]
}

export function format(rows) {
  const fmt = (h) => (Number.isNaN(h) ? '—' : `${h.toFixed(2)}h`)
  return [
    'group   n    p25      median   p90',
    ...rows.map(
      (r) =>
        `${r.group.padEnd(7)} ${String(r.n).padEnd(4)} ${fmt(r.p25).padEnd(8)} ${fmt(r.median).padEnd(8)} ${fmt(r.p90)}`,
    ),
  ].join('\n')
}

function main() {
  const repo =
    process.argv[2] ??
    execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      encoding: 'utf-8',
    }).trim()
  const out = execFileSync(
    'gh',
    [
      'api',
      `search/issues?q=repo:${repo}+is:pr+is:merged&sort=updated&per_page=100`,
      '--jq',
      '[.items[] | {createdAt: .created_at, mergedAt: .pull_request.merged_at, author: .user.login}]',
    ],
    { encoding: 'utf-8' },
  )
  console.log(`Last 100 merged PRs of ${repo}:`)
  console.log(format(summarize(JSON.parse(out))))
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
