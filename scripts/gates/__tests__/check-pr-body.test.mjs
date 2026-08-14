import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findLeaks } from '../check-pr-body.mjs'

test('accepts a body that reports gate results instead of pasting logs', () => {
  const body = [
    '## Summary',
    '- managed storage for Git sources',
    '',
    '## Gate results',
    '| `pnpm lint` | 0 errors, 426 warnings — unchanged from `main` |',
    '| `pnpm test` | API 5,747 passing |',
  ].join('\n')

  assert.deepEqual(findLeaks(body), [])
})

test('flags a macOS home-directory path', () => {
  const leaks = findLeaks('ran in /Users/lilithgames_1/work/a2wave-github')

  assert.equal(leaks.length, 1)
  assert.equal(leaks[0].rule, 'home-directory path')
})

test('flags Linux and Windows home-directory paths', () => {
  assert.equal(findLeaks('/home/jenkins/build/a2wave').length, 1)
  assert.equal(findLeaks(String.raw`C:\Users\dev\a2wave`).length, 1)
})

/**
 * The direct source of the #28 leak: pnpm prints `> pkg@version script <abspath>`
 * before every script it runs, so any pasted run log carries the path.
 */
test('flags a pasted pnpm script header even without a home path', () => {
  const leaks = findLeaks('> a2wave@0.7.2 lint /srv/ci/a2wave-github\n> biome check .')

  assert.ok(leaks.some((leak) => leak.rule === 'pasted pnpm run log'))
})

test('reports the offending line number so the author can find it', () => {
  const leaks = findLeaks('## Summary\nfine\n/Users/someone/repo\n')

  assert.equal(leaks[0].line, 3)
})

/**
 * `/home/appuser` is the container path this repo documents (A2WAVE_CLI_INSTALL_ROOT),
 * and `/Users/` inside a fenced block is usually illustrative rather than a leak.
 */
test('does not flag documented container paths', () => {
  assert.deepEqual(findLeaks('CLIs install into /home/appuser/.a2wave'), [])
})

test('ignores content inside fenced code blocks', () => {
  const body = ['before', '```sh', 'cd /Users/me/repo && pnpm dev', '```', 'after'].join('\n')

  assert.deepEqual(findLeaks(body), [])
})

test('reports every distinct leak, not just the first', () => {
  const leaks = findLeaks('/Users/a/x\nsome text\n/home/b/y')

  assert.equal(leaks.length, 2)
})
