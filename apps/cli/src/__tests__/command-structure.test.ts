import { renderUsage } from 'citty'
import { describe, expect, it } from 'vitest'
import { agentsCommand } from '../commands/agents.js'
import { apiCommand } from '../commands/api.js'
import { channelsCommand } from '../commands/channels.js'
import { chatCommand } from '../commands/chat.js'
import { completionCommand } from '../commands/completion.js'
import { configCommand } from '../commands/config.js'
import { docsCommand } from '../commands/docs.js'
import { doctorCommand } from '../commands/doctor.js'
import { evalCommand } from '../commands/eval.js'
import { kbCommand } from '../commands/kb.js'
import { loginCommand, logoutCommand } from '../commands/login.js'
import { mcpCommand } from '../commands/mcp.js'
import { memoryCommand } from '../commands/memory.js'
import { providersCommand } from '../commands/providers.js'
import { runsCommand } from '../commands/runs.js'
import { schemaCommand } from '../commands/schema.js'
import { scmCommand } from '../commands/scm.js'
import { setupCommand } from '../commands/setup.js'
import { skillGroupsCommand } from '../commands/skill-groups.js'
import { skillsCommand } from '../commands/skills.js'
import { statusCommand } from '../commands/status.js'
import { updateCommand } from '../commands/update.js'
import { whoamiCommand } from '../commands/whoami.js'

/**
 * Structural invariants of the citty command tree.
 *
 * Both rules below encode bugs that shipped and were invisible to unit tests,
 * because those tests call a command's `run()` directly and never exercise
 * citty's argument parser or router.
 */

type Node = {
  meta?: { name?: string; description?: string; agentMeta?: { risk?: string } }
  args?: Record<string, { type?: string; default?: unknown }>
  run?: unknown
  subCommands?: Record<string, Node>
}

/** A node that does work itself rather than routing to children. */
function isLeaf(node: Node): boolean {
  return typeof node.run === 'function' && Object.keys(node.subCommands ?? {}).length === 0
}

const ROOTS: Array<[string, Node]> = [
  ['agents', agentsCommand as unknown as Node],
  ['api', apiCommand as unknown as Node],
  ['chat', chatCommand as unknown as Node],
  ['channels', channelsCommand as unknown as Node],
  ['config', configCommand as unknown as Node],
  ['eval', evalCommand as unknown as Node],
  ['kb', kbCommand as unknown as Node],
  ['login', loginCommand as unknown as Node],
  ['logout', logoutCommand as unknown as Node],
  ['mcp', mcpCommand as unknown as Node],
  ['memory', memoryCommand as unknown as Node],
  ['providers', providersCommand as unknown as Node],
  ['runs', runsCommand as unknown as Node],
  ['scm', scmCommand as unknown as Node],
  ['setup', setupCommand as unknown as Node],
  ['skills', skillsCommand as unknown as Node],
  ['skill-groups', skillGroupsCommand as unknown as Node],
  ['status', statusCommand as unknown as Node],
  ['update', updateCommand as unknown as Node],
  ['whoami', whoamiCommand as unknown as Node],
  ['doctor', doctorCommand as unknown as Node],
  ['schema', schemaCommand as unknown as Node],
  ['docs', docsCommand as unknown as Node],
  ['completion', completionCommand as unknown as Node],
]

function walk(
  node: Node,
  path: string[],
  visit: (node: Node, path: string[], parent?: Node) => void,
  parent?: Node,
): void {
  visit(node, path, parent)
  for (const [name, sub] of Object.entries(node.subCommands ?? {})) {
    walk(sub, [...path, name], visit, node)
  }
}

describe('citty command tree invariants', () => {
  it('no node declares both subCommands and a positional argument', () => {
    // citty resolves the first non-flag argument against subCommands, so a
    // positional on the same node is unreachable: `a2wave chat my-agent` parsed
    // "my-agent" as a subcommand name and died with "Unknown command".
    const violations: string[] = []

    for (const [rootName, root] of ROOTS) {
      walk(root, [rootName], (node, path) => {
        const hasSubs = Object.keys(node.subCommands ?? {}).length > 0
        if (!hasSubs) return
        const positionals = Object.entries(node.args ?? {})
          .filter(([, spec]) => spec?.type === 'positional')
          .map(([name]) => name)
        if (positionals.length > 0) {
          violations.push(`a2wave ${path.join(' ')} → positionals ${JSON.stringify(positionals)}`)
        }
      })
    }

    expect(violations, `These nodes cannot be routed by citty:\n${violations.join('\n')}`).toEqual(
      [],
    )
  })

  it('no argument is named with a `no-` prefix', () => {
    // citty treats `--no-X` as negation of `X`: passing `--no-stream` sets
    // `args.stream = false` and never populates an arg literally named
    // "no-stream". Declaring the negative form makes the flag silently inert.
    // Declare the positive with `default: true` and read `=== false` instead.
    const violations: string[] = []

    for (const [rootName, root] of ROOTS) {
      walk(root, [rootName], (node, path) => {
        for (const name of Object.keys(node.args ?? {})) {
          if (name.startsWith('no-')) {
            violations.push(`a2wave ${path.join(' ')} → --${name}`)
          }
        }
      })
    }

    expect(violations, `These flags never receive a value:\n${violations.join('\n')}`).toEqual([])
  })

  it('every node declares meta.name matching its key in the parent tree', () => {
    // citty builds the usage line as
    //   `${parentMeta.name} ` + (cmdMeta.name || process.argv[1])
    // (citty/dist/index.mjs:353). With no meta.name it falls back to argv[1] —
    // the absolute path of the running script — so the published binary printed
    // `USAGE a2wave /usr/local/lib/node_modules/a2wave/dist/index.cjs
    // list|get|...` instead of `USAGE a2wave agents list|get|...`.
    //
    // The name must be the node's own single segment, never a full path:
    // `runMain` resolves `meta.name` against the root command's own name when
    // building the usage prefix, so a multi-word name renders a doubled prefix
    // (`a2wave a2wave agents`) and stops the node from routing at all.
    const violations: string[] = []

    for (const [rootName, root] of ROOTS) {
      walk(root, [rootName], (node, path) => {
        const expected = path[path.length - 1]
        const actual = node.meta?.name
        if (actual !== expected) {
          violations.push(
            `a2wave ${path.join(' ')} → meta.name = ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
          )
        }
      })
    }

    expect(
      violations,
      `These nodes fall back to process.argv[1] in usage output:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('every leaf command declares agentMeta.risk', () => {
    // The CLI's primary consumer is an agent, which has to decide whether it may
    // run something BEFORE running it. A missing label is indistinguishable from
    // "read" to a cautious caller and from "harmless" to a careless one, so the
    // label is mandatory rather than defaulted. Only leaves carry it: a parent
    // with subCommands does no work of its own, and labelling it would have to
    // be the max of its children — a number nobody maintains.
    const RISKS = new Set(['read', 'write', 'high-risk-write'])
    const violations: string[] = []

    for (const [rootName, root] of ROOTS) {
      walk(root, [rootName], (node, path) => {
        if (!isLeaf(node)) return
        const risk = node.meta?.agentMeta?.risk
        if (!risk || !RISKS.has(risk)) {
          violations.push(`a2wave ${path.join(' ')} → agentMeta.risk = ${JSON.stringify(risk)}`)
        }
      })
    }

    expect(
      violations,
      `These leaf commands carry no risk label:\n${violations.join('\n')}`,
    ).toEqual([])
  })

  it('rendered usage never leaks a filesystem path', async () => {
    // The behavioral counterpart of the rule above: assert against the string a
    // user actually sees, so the invariant survives any future change in how
    // citty derives the command name. Rendering every node with its real parent
    // is what reproduced the shipped bug — `node dist/index.cjs agents --help`
    // printed the absolute path of dist/index.cjs three times.
    //
    // Scope note: citty's `resolveSubCommand` passes only the IMMEDIATE parent,
    // so a depth-2 usage line reads `agents members list`, without the leading
    // `a2wave`. That is a citty limitation, not a defect in the tree — widening
    // meta.name to a full path to compensate breaks routing outright. What this
    // test guarantees is the property that actually shipped broken: no absolute
    // path ever reaches the user.
    const violations: string[] = []
    const pending: Array<Promise<void>> = []

    for (const [rootName, root] of ROOTS) {
      walk(root, [rootName], (node, path, parent) => {
        pending.push(
          renderUsage(node as never, parent as never).then((usage) => {
            if (usage.includes(process.argv[1])) {
              violations.push(`a2wave ${path.join(' ')} → usage contains argv[1]`)
            }
          }),
        )
      })
    }
    await Promise.all(pending)

    expect(
      violations,
      `These usage strings embed the script path:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
