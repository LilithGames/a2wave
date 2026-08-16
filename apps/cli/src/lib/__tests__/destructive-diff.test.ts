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

  /**
   * `config` is a freeform OBJECT and the API replaces it wholesale, so a YAML
   * carrying a partial config silently discards every key it does not name. The
   * scalar and array rules above both miss that shape: an object is neither, so
   * dropping six keys and a whole fallback provider read as an ordinary edit and
   * applied with no confirmation.
   */
  describe('nested objects', () => {
    it('reports the keys an object loses', () => {
      const existing = {
        config: { model: 'opus', timeoutMinutes: 10, maxRetries: 2, readOnly: false },
      }
      const proposed = { config: { model: 'opus' } }

      expect(describeDestructiveDiff(existing, proposed)).toEqual([
        'config: removes 3 keys (timeoutMinutes, maxRetries, readOnly)',
      ])
    })

    it('reports a removal nested deeper than one level', () => {
      const existing = { config: { limits: { cpu: 2, memory: 4 } } }
      const proposed = { config: { limits: { cpu: 2 } } }

      expect(describeDestructiveDiff(existing, proposed)).toEqual([
        'config.limits: removes 1 key (memory)',
      ])
    })

    it('reports a value cleared inside an object', () => {
      const existing = { config: { note: 'keep me' } }
      const proposed = { config: { note: '' } }

      expect(describeDestructiveDiff(existing, proposed)).toEqual(['config.note: cleared'])
    })

    it('ignores a key that is merely edited', () => {
      const existing = { config: { model: 'opus', timeoutMinutes: 10 } }
      const proposed = { config: { model: 'sonnet', timeoutMinutes: 10 } }

      expect(describeDestructiveDiff(existing, proposed)).toEqual([])
    })

    it('ignores a key being added', () => {
      const existing = { config: { model: 'opus' } }
      const proposed = { config: { model: 'opus', readOnly: true } }

      expect(describeDestructiveDiff(existing, proposed)).toEqual([])
    })

    it('reports an object replaced by a non-object as a loss of everything', () => {
      expect(describeDestructiveDiff({ config: { a: 1, b: 2 } }, { config: null })).toEqual([
        'config: cleared',
      ])
    })
  })

  /**
   * A provider chain is an array of OBJECTS with stable ids. Comparing entries
   * by deep equality would call every edited entry "removed" — changing one
   * binding's reasoning effort would report the binding as unmounted — so
   * identity decides membership and the rest is an edit.
   */
  describe('arrays of identified objects', () => {
    const claude = { id: 'pc_claude', providerId: 'prv_c', model: 'opus' }
    const codex = { id: 'pc_codex', providerId: 'prv_x', model: 'gpt-5.6-sol' }

    it('reports a chain entry that disappears, naming it', () => {
      const existing = { config: { providerChain: [claude, codex] } }
      const proposed = { config: { providerChain: [claude] } }

      expect(describeDestructiveDiff(existing, proposed)).toEqual([
        'config.providerChain: removes 1 (pc_codex)',
      ])
    })

    it('ignores an entry whose reasoning effort merely changed', () => {
      const existing = { config: { providerChain: [claude, codex] } }
      const proposed = {
        config: { providerChain: [{ ...claude, reasoningEffort: 'high' }, codex] },
      }

      expect(describeDestructiveDiff(existing, proposed)).toEqual([])
    })

    it('ignores a reordered chain', () => {
      const existing = { config: { providerChain: [claude, codex] } }
      const proposed = { config: { providerChain: [codex, claude] } }

      expect(describeDestructiveDiff(existing, proposed)).toEqual([])
    })

    it('falls back to a name when entries carry no id', () => {
      const existing = { a2aRouteTargets: [{ name: 'pay' }, { name: 'ship' }] }
      const proposed = { a2aRouteTargets: [{ name: 'pay' }] }

      expect(describeDestructiveDiff(existing, proposed)).toEqual([
        'a2aRouteTargets: removes 1 (ship)',
      ])
    })

    it('counts by length when entries are anonymous, rather than printing objects', () => {
      const existing = { config: { steps: [{ run: 'a' }, { run: 'b' }] } }
      const proposed = { config: { steps: [{ run: 'a' }] } }

      // No identity to name, so the count is the honest answer — and never
      // `[object Object]`, which is what deep-equality naming produced.
      expect(describeDestructiveDiff(existing, proposed)).toEqual(['config.steps: removes 1 entry'])
    })

    it('ignores an anonymous list that keeps its length while an entry is edited', () => {
      const existing = { config: { steps: [{ run: 'a' }] } }
      const proposed = { config: { steps: [{ run: 'b' }] } }

      expect(describeDestructiveDiff(existing, proposed)).toEqual([])
    })
  })

  it('reports every removal in one pass, not just the first', () => {
    const existing = {
      skills: ['a', 'b'],
      config: { model: 'opus', providerChain: [{ id: 'pc_1' }, { id: 'pc_2' }] },
    }
    const proposed = {
      skills: ['a'],
      config: { providerChain: [{ id: 'pc_1' }] },
    }

    expect(describeDestructiveDiff(existing, proposed)).toEqual([
      'skills: removes 1 (b)',
      'config: removes 1 key (model)',
      'config.providerChain: removes 1 (pc_2)',
    ])
  })
})

/**
 * `config` is freeform and the repo treats it as secret-bearing — `agents get`
 * prints its top-level KEY NAMES and never a value, "to avoid leaking plaintext
 * to the terminal/logs". Recursing into it for the removal gate opened a path
 * that printed values again: a removed element of a nested primitive array was
 * rendered verbatim into the confirmation prompt.
 *
 * Identity fields stay named at any depth — `pc_codex` is what makes the warning
 * actionable, and an id is not a credential.
 */
describe('value disclosure below the top level', () => {
  it('never prints a removed value from an array nested inside config', () => {
    const existing = { config: { allowedTokens: ['sk-live-abc123', 'sk-live-def456'] } }
    const proposed = { config: { allowedTokens: ['sk-live-abc123'] } }

    const findings = describeDestructiveDiff(existing, proposed)

    expect(findings.join('\n')).not.toContain('sk-live-def456')
    expect(findings).toEqual(['config.allowedTokens: removes 1 entry'])
  })

  it('still names top-level list members, which are ids the user chose', () => {
    // skills / mcpServerIds are the case the naming exists for, and they are not
    // reached by recursing into a freeform object.
    expect(describeDestructiveDiff({ skills: ['a', 'b'] }, { skills: ['a'] })).toEqual([
      'skills: removes 1 (b)',
    ])
  })

  it('still names a removed chain entry by its identity', () => {
    const existing = { config: { providerChain: [{ id: 'pc_claude' }, { id: 'pc_codex' }] } }
    const proposed = { config: { providerChain: [{ id: 'pc_claude' }] } }

    expect(describeDestructiveDiff(existing, proposed)).toEqual([
      'config.providerChain: removes 1 (pc_codex)',
    ])
  })

  it('keeps naming removed KEYS at any depth, which carry no value', () => {
    const existing = { config: { limits: { cpu: 2, apiKey: 'sk-live' } } }
    const proposed = { config: { limits: { cpu: 2 } } }

    // The key name is the actionable part; its value is exactly what must not
    // be echoed, and removing a key never prints one.
    expect(describeDestructiveDiff(existing, proposed)).toEqual([
      'config.limits: removes 1 key (apiKey)',
    ])
  })
})
