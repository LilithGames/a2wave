/**
 * `a2wave schema` composes three sources, each authoritative for what it owns:
 * the citty tree (flags, descriptions, required, defaults), the generated
 * snapshot (enum members and output shapes) and `agentMeta` (risk, examples,
 * negative routing). These tests pin the seams, since a value silently coming
 * from the wrong source is exactly what makes a spec worse than none.
 */
import { describe, expect, it } from 'vitest'
import { buildCommandSchema, listCommandPaths } from '../schema.js'

const tree = {
  meta: { name: 'a2wave' },
  subCommands: {
    agents: {
      meta: { name: 'agents', description: 'Manage Agents' },
      subCommands: {
        list: {
          meta: {
            name: 'list',
            description: 'List all Agents',
            agentMeta: { risk: 'read' as const, examples: ['a2wave agents list --json'] },
          },
          args: {
            json: { type: 'boolean', description: 'Emit JSON' },
            limit: { type: 'string', description: 'Rows', default: '20' },
          },
          run: () => {},
        },
        publish: {
          meta: {
            name: 'publish',
            description: 'Publish an Agent',
            agentMeta: {
              risk: 'write' as const,
              preconditions: ['The Agent has a Provider bound'],
              notFor: ['Changing config — use `agents apply`'],
            },
          },
          args: {
            id: { type: 'positional', description: 'Agent ID or name', required: true },
            channels: { type: 'string', description: 'Comma-separated channel list' },
            a: { type: 'boolean', description: 'a' },
            b: { type: 'boolean', description: 'b' },
            c: { type: 'boolean', description: 'c' },
            d: { type: 'boolean', description: 'd' },
            e: { type: 'boolean', description: 'e' },
            f: { type: 'boolean', description: 'f' },
            g: { type: 'boolean', description: 'g' },
          },
          run: () => {},
        },
      },
    },
  },
}

describe('listCommandPaths', () => {
  it('lists leaf paths only, so the index stays cheap', () => {
    // A caller with no argument wants to know what exists, not what each
    // command's every flag is. Listing parents too would just add noise it has
    // to filter.
    expect(listCommandPaths(tree)).toEqual(['agents list', 'agents publish'])
  })
})

describe('buildCommandSchema', () => {
  it('derives name, description and risk from the tree and agentMeta', () => {
    const schema = buildCommandSchema(tree, 'agents list')
    expect(schema.name).toBe('agents list')
    expect(schema.description).toBe('List all Agents')
    expect(schema.risk).toBe('read')
    expect(schema.examples).toEqual(['a2wave agents list --json'])
  })

  it('maps each JSON property back to its CLI flag', () => {
    // The spec is a function-calling shape, so a caller composes JSON keys and
    // needs to know what they spell on the command line. Without `flag` it has
    // to guess the transformation, and a positional does not spell as a flag at
    // all.
    const schema = buildCommandSchema(tree, 'agents publish', { brief: false })
    expect(schema.parameters.properties.id.flag).toBe('<id>')
    expect(schema.parameters.properties.channels.flag).toBe('--channels')
  })

  it('marks required positionals as required', () => {
    const schema = buildCommandSchema(tree, 'agents publish')
    expect(schema.parameters.required).toEqual(['id'])
  })

  it('carries defaults through from the tree', () => {
    const schema = buildCommandSchema(tree, 'agents list')
    expect(schema.parameters.properties.limit.default).toBe('20')
  })

  it('attaches enum and enumDescriptions where the generated snapshot has them', () => {
    // The tree knows `--channels` exists; only the generated snapshot knows
    // which channels are legal. Hardcoding the list here is the drift the whole
    // codegen exists to prevent.
    const schema = buildCommandSchema(tree, 'agents publish', { brief: false })
    expect(schema.parameters.properties.channels.enum).toContain('slack')
    expect(schema.parameters.properties.channels.enumDescriptions).toBeDefined()
  })

  it('carries preconditions and notFor', () => {
    const schema = buildCommandSchema(tree, 'agents publish')
    expect(schema.preconditions).toEqual(['The Agent has a Provider bound'])
    expect(schema.notFor).toEqual(['Changing config — use `agents apply`'])
  })

  it('brief mode keeps required params and drops the rest', () => {
    const brief = buildCommandSchema(tree, 'agents publish', { brief: true })
    expect(Object.keys(brief.parameters.properties)).toContain('id')
    expect(Object.keys(brief.parameters.properties)).not.toContain('a')
    expect(brief.brief).toBe(true)
  })

  it('defaults to brief above the arg threshold, and to full below it', () => {
    // An unbrief schema is the main token hazard: a wide command spends more
    // context describing itself than answering. Small commands lose nothing by
    // staying whole, so the default is per-command rather than global.
    expect(buildCommandSchema(tree, 'agents publish').brief).toBe(true)
    expect(buildCommandSchema(tree, 'agents list').brief).toBe(false)
  })

  it('--full opts back into everything on a wide command', () => {
    const full = buildCommandSchema(tree, 'agents publish', { brief: false })
    expect(Object.keys(full.parameters.properties)).toContain('g')
  })

  it("takes an ID example prefix from the argument's own description", () => {
    // `id` names a different resource on nearly every command, so a single
    // hardcoded prefix is wrong more often than right. The description already
    // spells it ("Run ID (run_xxx)"), which is exact rather than a guess.
    const withPrefix = buildCommandSchema(
      {
        subCommands: {
          runs: {
            meta: { name: 'runs' },
            subCommands: {
              logs: {
                meta: { name: 'logs', agentMeta: { risk: 'read' as const } },
                args: {
                  id: { type: 'positional', description: 'Run ID (run_xxx)', required: true },
                },
                run: () => {},
              },
            },
          },
        },
      },
      'runs logs',
    )
    expect(withPrefix.parameters.properties.id.example).toBe('run_0123456789abcdef')
  })

  it('falls back to a placeholder when no prefix is named', () => {
    // An `<id|name>` argument accepts a name too; inventing `agt_...` for one
    // that resolves a Skill would be a confidently wrong example.
    const schema = buildCommandSchema(tree, 'agents publish', { brief: false })
    expect(schema.parameters.properties.id.example).toBe('<id>')
  })

  it('throws a validation error naming the closest paths for an unknown command', () => {
    expect(() => buildCommandSchema(tree, 'agents publsh')).toThrow(/agents publish/)
  })
})
