/**
 * The three self-describing commands, exercised through their `run()`.
 *
 * Each reads the tree out of the late-bound registry that `src/index.ts`
 * populates, so these register a small fixture tree instead — which also pins
 * that none of them reaches for the real tree by import, the cycle the registry
 * exists to avoid.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CliError } from '../../errors.js'
import { setRootCommand } from '../../lib/root-registry.js'
import { completionCommand } from '../completion.js'
import { docsCommand } from '../docs.js'
import { schemaCommand } from '../schema.js'

const tree = {
  meta: { name: 'a2wave' },
  subCommands: {
    schema: schemaCommand as never,
    agents: {
      meta: { name: 'agents', description: 'Manage Agents' },
      subCommands: {
        list: {
          meta: { name: 'list', description: 'List all Agents', agentMeta: { risk: 'read' } },
          args: { json: { type: 'boolean', description: 'JSON' } },
          run: () => {},
        },
      },
    },
  },
}

let printed: string[] = []

beforeEach(() => {
  printed = []
  vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    printed.push(String(line))
  })
  setRootCommand(tree as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

const run = (cmd: { run?: unknown }, args: Record<string, unknown>) =>
  (cmd.run as (c: { args: Record<string, unknown> }) => unknown)({ args })

describe('schema', () => {
  it('lists command paths when given no argument', () => {
    run(schemaCommand, {})
    expect(JSON.parse(printed[0]).commands).toContain('agents list')
  })

  it('emits one command spec when given a path', () => {
    run(schemaCommand, { command: 'agents list' })
    const spec = JSON.parse(printed[0])
    expect(spec.name).toBe('agents list')
    expect(spec.risk).toBe('read')
  })

  it('prints compact JSON by default and indents under --json-pretty', () => {
    // The output is read into a context window far more often than by a human,
    // so indentation is opt-in here exactly as it is for `emit()`.
    run(schemaCommand, { command: 'agents list' })
    expect(printed[0]).not.toContain('\n')
    printed = []
    run(schemaCommand, { command: 'agents list', 'json-pretty': true })
    expect(printed[0]).toContain('\n')
  })

  it('lets --full override --brief when both are passed', () => {
    // Passing both is a caller correcting itself mid-compose; the wider answer
    // is the safe reading, since the narrow one silently omits parameters.
    run(schemaCommand, { command: 'agents list', brief: true, full: true })
    expect(JSON.parse(printed[0]).brief).toBe(false)
  })

  it('reports an unknown command as validation, not a crash', () => {
    expect(() => run(schemaCommand, { command: 'agents lst' })).toThrow(CliError)
  })
})

describe('docs', () => {
  it('prints the whole guide with no argument', () => {
    run(docsCommand, {})
    expect(printed[0]).toContain('# a2wave CLI — agent guide')
  })

  it('prints one section for a topic', () => {
    run(docsCommand, { topic: 'the-loop' })
    expect(printed[0]).toContain('## The loop')
    expect(printed[0]).not.toContain('## Pagination')
  })

  it('lists slug and title under --list', () => {
    run(docsCommand, { list: true })
    expect(printed.some((l) => l.startsWith('the-loop\t'))).toBe(true)
  })

  it('rejects an unknown topic with the real list', () => {
    expect(() => run(docsCommand, { topic: 'nope' })).toThrow(/the-loop/)
  })
})

describe('completion', () => {
  it('emits a script naming the tree it was built from', () => {
    run(completionCommand, { shell: 'bash' })
    expect(printed[0]).toContain('complete -F _a2wave a2wave')
    expect(printed[0]).toContain('agents list')
  })

  it('rejects an unsupported shell', () => {
    expect(() => run(completionCommand, { shell: 'powershell' })).toThrow(CliError)
  })
})
