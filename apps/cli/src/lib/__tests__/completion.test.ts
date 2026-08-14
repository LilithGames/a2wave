/**
 * The completion scripts are derived from the tree, so what these pin is that
 * the derivation actually reaches every command and that the emitted text is
 * valid for its shell — a completion that fails to parse is worse than none,
 * because it breaks the user's whole shell startup.
 */
import { describe, expect, it } from 'vitest'
import { SUPPORTED_SHELLS, assertShell, buildCompletion } from '../completion.js'

const tree = {
  meta: { name: 'a2wave' },
  subCommands: {
    agents: {
      meta: { name: 'agents', description: "Manage Agents (it's fine)" },
      subCommands: {
        list: {
          meta: { name: 'list', description: 'List all Agents' },
          args: {
            json: { type: 'boolean', description: 'JSON' },
            id: { type: 'positional', description: 'ignored' },
          },
          run: () => {},
        },
      },
    },
  },
}

describe('assertShell', () => {
  it('accepts each supported shell', () => {
    for (const shell of SUPPORTED_SHELLS) expect(assertShell(shell)).toBe(shell)
  })

  it('rejects anything else, naming what is supported', () => {
    expect(() => assertShell('powershell')).toThrow(/bash, zsh, fish/)
  })
})

describe('buildCompletion', () => {
  it.each(SUPPORTED_SHELLS)('%s names every command in the tree', (shell) => {
    const script = buildCompletion(tree, shell)
    expect(script).toContain('agents')
    expect(script).toContain('list')
  })

  it.each(SUPPORTED_SHELLS)('%s offers flags but never positionals as flags', (shell) => {
    const script = buildCompletion(tree, shell)
    expect(script).toContain('json')
    // A positional is a value, not a flag; emitting `--id` would complete
    // something the parser rejects.
    expect(script).not.toContain('--id')
  })

  it.each(SUPPORTED_SHELLS)('%s escapes an apostrophe in a description', (shell) => {
    // Descriptions are author-written prose and several contain apostrophes;
    // an unescaped one closes the shell literal and corrupts the rest of the
    // script — silently, since it usually still parses as something.
    const script = buildCompletion(tree, shell)
    expect(script).not.toMatch(/'Manage Agents \(it's fine\)'/)
  })
})
