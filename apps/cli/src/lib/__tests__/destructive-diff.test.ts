/**
 * `agents apply` is `write` in general and `high-risk-write` when its diff
 * REMOVES things — because that is the one shape of apply an agent cannot undo
 * from the YAML it is holding. Adding a skill is recoverable by removing it;
 * unmounting the skill the Agent depended on is not, once the YAML that named
 * it is gone.
 */
import { describe, expect, it } from 'vitest'
import { describeDestructiveDiff } from '../agent-yaml.js'

describe('describeDestructiveDiff', () => {
  it('reports nothing when a list only grows', () => {
    expect(describeDestructiveDiff({ skills: ['a'] }, { skills: ['a', 'b'] })).toEqual([])
  })

  it('reports a list that loses a member', () => {
    expect(describeDestructiveDiff({ skills: ['a', 'b'] }, { skills: ['a'] })).toEqual([
      'skills: removes 1 (b)',
    ])
  })

  it('reports a list emptied entirely', () => {
    expect(describeDestructiveDiff({ mcpServerIds: ['m1'] }, { mcpServerIds: [] })).toEqual([
      'mcpServerIds: removes 1 (m1)',
    ])
  })

  it('reports a set value being cleared', () => {
    // A systemPrompt replaced by another is an ordinary edit; a systemPrompt
    // replaced by nothing discards content the YAML no longer carries.
    expect(describeDestructiveDiff({ systemPrompt: 'be helpful' }, { systemPrompt: '' })).toEqual([
      'systemPrompt: cleared',
    ])
  })

  it('ignores a value that is merely changed', () => {
    expect(describeDestructiveDiff({ systemPrompt: 'a' }, { systemPrompt: 'b' })).toEqual([])
  })

  it('ignores a field the diff does not touch', () => {
    expect(describeDestructiveDiff({ skills: ['a', 'b'] }, { description: 'x' })).toEqual([])
  })

  it('ignores a field that was unset before', () => {
    // Nothing is removed by first setting something.
    expect(describeDestructiveDiff({}, { skills: ['a'] })).toEqual([])
  })
})
