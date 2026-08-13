#!/usr/bin/env node
/**
 * PR description hygiene gate.
 *
 * PR #28 shipped ~3,800 lines of pasted `pnpm lint/typecheck/test` output in its
 * body, carrying 131 copies of the author's home directory. The paths are not
 * typed by anyone: pnpm prints `> <pkg>@<version> <script> <absolute path>`
 * before every script it runs, so pasting a run log leaks local directory
 * structure as a side effect. The volume also buried the actual result — the
 * body claimed "0 errors" while the pasted log showed 426 warnings, and a
 * reviewer had no way to tell which was the gate verdict.
 *
 * This gate therefore rejects both the symptom (home-directory paths) and the
 * cause (a pasted pnpm run log). It reads the PR body from a file so it works
 * the same in CI and locally:
 *
 *   node scripts/gates/check-pr-body.mjs <file>
 *   gh pr view 28 --json body -q .body | node scripts/gates/check-pr-body.mjs -
 *
 * Fenced code blocks are exempt: a runnable snippet showing `cd /Users/you/repo`
 * is instructional, not an accidental paste.
 */
import { readFileSync } from 'node:fs'

const RULES = [
  {
    rule: 'home-directory path',
    // Negative lookahead keeps /home/appuser, the container path this repo
    // documents for A2WAVE_CLI_INSTALL_ROOT.
    pattern: /(?:\/Users\/[^/\s]+\/|\/home\/(?!appuser\b)[^/\s]+\/|[A-Za-z]:\\Users\\[^\\\s]+)/,
    hint: 'Replace the path with a result. pnpm prints package absolute paths in every run log.',
  },
  {
    rule: 'pasted pnpm run log',
    pattern: /^>\s+\S+@[\d.]+\s+\S+\s+\//m,
    hint: 'Report the gate verdict (e.g. "0 errors, 426 warnings") instead of pasting the run output.',
  },
]

/** Line numbers (1-indexed) that sit inside a fenced code block. */
function fencedLines(lines) {
  const fenced = new Set()
  let open = false
  lines.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      open = !open
      fenced.add(index + 1)
      return
    }
    if (open) fenced.add(index + 1)
  })
  return fenced
}

export function findLeaks(body) {
  const lines = body.split(/\r?\n/)
  const skip = fencedLines(lines)
  const leaks = []

  for (const { rule, pattern, hint } of RULES) {
    lines.forEach((line, index) => {
      const lineNumber = index + 1
      if (skip.has(lineNumber)) return
      // The pnpm-header rule is anchored per line, so test it that way.
      const matcher = new RegExp(pattern.source, pattern.flags.replace('m', ''))
      if (matcher.test(line)) leaks.push({ rule, line: lineNumber, hint })
    })
  }

  return leaks.sort((a, b) => a.line - b.line)
}

function main() {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: check-pr-body.mjs <file|->')
    process.exit(2)
  }

  const body = readFileSync(target === '-' ? 0 : target, 'utf8')
  const leaks = findLeaks(body)

  if (leaks.length === 0) {
    console.log('✓ PR description contains no leaked local paths or pasted run logs')
    return
  }

  console.error('✖ PR description hygiene check failed\n')
  for (const leak of leaks) {
    console.error(`  line ${leak.line}: ${leak.rule}`)
    console.error(`    ${leak.hint}\n`)
  }
  console.error('Report gate results, not terminal output. See .github/PULL_REQUEST_TEMPLATE.md.')
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
