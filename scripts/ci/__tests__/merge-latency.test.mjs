import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { format, percentile, summarize } from '../merge-latency.mjs'

const pr = (hours, author = 'alice') => ({
  createdAt: '2026-01-01T00:00:00Z',
  mergedAt: new Date(Date.parse('2026-01-01T00:00:00Z') + hours * 3_600_000).toISOString(),
  author,
})

describe('merge-latency percentile', () => {
  it('nearest-rank over a sorted array', () => {
    assert.equal(percentile([1, 2, 3, 4], 0.5), 2)
    assert.equal(percentile([1, 2, 3, 4], 0.9), 3)
    assert.equal(percentile([5], 0.25), 5)
  })

  it('NaN on empty input, not a crash', () => {
    assert.ok(Number.isNaN(percentile([], 0.5)))
  })
})

describe('merge-latency summarize', () => {
  it('splits humans from bots — bot latency measures attention, not the pipeline', () => {
    const rows = summarize([pr(1), pr(3), pr(5), pr(48, 'dependabot[bot]')])
    const by = Object.fromEntries(rows.map((r) => [r.group, r]))
    assert.equal(by.all.n, 4)
    assert.equal(by.humans.n, 3)
    assert.equal(by.humans.median, 3)
    assert.equal(by.bots.n, 1)
    assert.equal(by.bots.median, 48)
  })
})

describe('merge-latency format', () => {
  it('renders an empty group as a dash', () => {
    const text = format(summarize([pr(2)]))
    assert.match(text, /humans +1 +2\.00h/)
    assert.match(text, /bots +0 +—/)
  })
})
