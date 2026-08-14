import { describe, expect, it } from 'vitest'
import { findCommand, leafPaths, walkCommands } from '../command-tree.js'

const tree = {
  meta: { name: 'a2wave' },
  subCommands: {
    agents: {
      meta: { name: 'agents' },
      subCommands: {
        list: { meta: { name: 'list' }, run: () => {} },
        members: {
          meta: { name: 'members' },
          subCommands: { add: { meta: { name: 'add' }, run: () => {} } },
        },
      },
    },
    whoami: { meta: { name: 'whoami' }, run: () => {} },
  },
}

describe('walkCommands', () => {
  it('yields every node except the root, which has no path', () => {
    expect(walkCommands(tree).map((e) => e.path)).toEqual([
      'agents',
      'agents list',
      'agents members',
      'agents members add',
      'whoami',
    ])
  })

  it('marks only nodes with a run as leaves', () => {
    const byPath = Object.fromEntries(walkCommands(tree).map((e) => [e.path, e.leaf]))
    expect(byPath['agents members']).toBe(false)
    expect(byPath['agents members add']).toBe(true)
  })
})

describe('leafPaths', () => {
  it('returns the callable paths only', () => {
    expect(leafPaths(tree)).toEqual(['agents list', 'agents members add', 'whoami'])
  })
})

describe('findCommand', () => {
  it('resolves a multi-segment path', () => {
    expect(findCommand(tree, 'agents members add')?.meta?.name).toBe('add')
  })

  it('tolerates surrounding and repeated whitespace', () => {
    // `schema "agents  list"` is a caller composing a string, not typing one.
    expect(findCommand(tree, '  agents   list ')?.meta?.name).toBe('list')
  })

  it('returns undefined for an unknown path rather than throwing', () => {
    expect(findCommand(tree, 'agents nope')).toBeUndefined()
  })
})
