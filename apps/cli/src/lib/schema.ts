/**
 * Build a function-calling spec for one command.
 *
 * The CLI's primary consumer is an agent, and the way an agent learns a tool is
 * a JSON-Schema-shaped parameter description — not a `--help` page it has to
 * parse. So `a2wave schema <command>` emits that shape, composed from three
 * sources, each authoritative for exactly what it owns:
 *
 *   1. the citty tree      → flags, descriptions, required, defaults
 *   2. src/generated/*.json → enum members and output shapes (from @a2wave/shared)
 *   3. `meta.agentMeta`    → risk, preconditions, notFor, examples
 *
 * Nothing is restated across the three. A restatement is a copy, and a copy of
 * `publishChannelEnum` is precisely the bug this whole subsystem was built to
 * stop recurring.
 */
import { CliError } from '../errors.js'
import generated from '../generated/schemas.json' with { type: 'json' }
import type { CommandRisk } from './agent-meta.js'
import { type ArgSpec, findCommand, leafPaths, type TreeNode } from './command-tree.js'

/**
 * Above this many args, an unbrief schema costs more context than the command
 * it describes. Wide commands therefore default to brief and `--full` opts back
 * in; narrow ones stay whole, because clipping them saves nothing and hides
 * flags a caller would otherwise never learn exists.
 */
const BRIEF_THRESHOLD = 8

export interface SchemaProperty {
  type: string
  description?: string
  /** How this JSON key spells on the command line: `--channels` or `<id>`. */
  flag: string
  default?: unknown
  example?: unknown
  enum?: string[]
  enumDescriptions?: Record<string, string>
}

export interface CommandSchema {
  name: string
  description?: string
  risk: CommandRisk
  brief: boolean
  parameters: {
    type: 'object'
    properties: Record<string, SchemaProperty>
    required: string[]
  }
  preconditions?: string[]
  notFor?: string[]
  examples?: string[]
}

/**
 * Flags whose legal values live in @a2wave/shared, keyed by flag name.
 *
 * Matching on the flag NAME rather than on the command is deliberate:
 * `--channels` means the same thing wherever it appears, and enumerating
 * (command, flag) pairs would need a new entry every time a channel flag lands
 * on another command — the kind of table that silently goes stale.
 */
const ENUM_FLAGS: Record<string, { values: string[]; descriptions?: Record<string, string> }> = {
  channels: {
    values: generated.enums.publishChannel,
    descriptions: {
      api: 'HTTP endpoint with an optional API key',
      a2a: 'Agent-to-agent protocol, callable by other Agents',
      feishu: 'Feishu bot; needs feishuConfig',
      slack: 'Slack bot; needs slackConfig',
      discord: 'Discord bot; needs discordConfig',
      qq_official: 'QQ Official bot; credentials must already be configured',
      schedule: 'Cron trigger; fires unconditionally, needs scheduleConfig',
      oauth: 'IDaaS-authenticated gateway invocation',
      chat_app: 'First-party chat page at /agents/:id/chat_app',
      glab: 'GitLab merge-request poll; starts a run only on a real change',
      gh: 'GitHub pull-request poll; starts a run only on a real change',
    },
  },
  'auth-type': { values: generated.enums.publishAuthType },
  type: { values: generated.enums.agentType },
  status: { values: generated.enums.runStatus },
}

/**
 * The ID prefix an argument's own description names, if any.
 *
 * Descriptions already spell the prefix ("Run ID (run_xxx)", "Artifact ID
 * (art_xxx)"), so reading it back is exact where a per-argument table would be
 * a guess — and `id` means a different resource on almost every command, so a
 * single hardcoded prefix is wrong more often than right.
 */
function idPrefixFromDescription(description?: string): string | undefined {
  return /\b([a-z0-9]{2,4})_(?:xxx|<|\b)/.exec(description ?? '')?.[1]
}

/** A value realistic enough to copy, so a caller does not invent a shape. */
function exampleFor(name: string, spec: ArgSpec): unknown {
  if (spec.type === 'boolean') return true
  if (spec.default !== undefined) return spec.default
  const enumeration = ENUM_FLAGS[name]
  if (enumeration) return enumeration.values[0]
  if (name === 'url') return 'https://a2wave.example.com'
  if (name === 'fields') return 'data[].id,data[].name'

  const prefix = idPrefixFromDescription(spec.description)
  // An argument whose description names no prefix gets a placeholder rather
  // than an invented ID: an `<id|name>` accepts a name too, and a wrong-prefix
  // example is worse than an obvious placeholder.
  return prefix ? `${prefix}_0123456789abcdef` : `<${name}>`
}

/** Positionals have no flag spelling; everything else is `--name`. */
function flagFor(name: string, spec: ArgSpec): string {
  return spec.type === 'positional' ? `<${name}>` : `--${name}`
}

function toProperty(name: string, spec: ArgSpec): SchemaProperty {
  const enumeration = ENUM_FLAGS[name]
  return {
    type: spec.type === 'boolean' ? 'boolean' : 'string',
    ...(spec.description ? { description: spec.description } : {}),
    flag: flagFor(name, spec),
    ...(spec.default !== undefined ? { default: spec.default } : {}),
    example: exampleFor(name, spec),
    ...(enumeration ? { enum: enumeration.values } : {}),
    ...(enumeration?.descriptions ? { enumDescriptions: enumeration.descriptions } : {}),
  }
}

/** Leaf paths, which is what an index of "what can I call" means. */
export function listCommandPaths(root: TreeNode): string[] {
  return leafPaths(root)
}

/** Paths sharing the longest prefix with `wanted`, so a typo gets a next step. */
function nearest(root: TreeNode, wanted: string): string[] {
  const first = wanted.split(/\s+/)[0]
  const sameGroup = leafPaths(root).filter((p) => p.startsWith(`${first} `) || p === first)
  return sameGroup.length > 0 ? sameGroup : leafPaths(root).slice(0, 10)
}

export function buildCommandSchema(
  root: TreeNode,
  path: string,
  options: { brief?: boolean } = {},
): CommandSchema {
  const node = findCommand(root, path)
  if (!node || typeof node.run !== 'function') {
    // A wrong name is the user's typo, not a crash — and an agent recovers from
    // it far faster given the candidates than given "not found".
    throw new CliError(
      `Unknown command: "${path}". Did you mean one of:\n${nearest(root, path)
        .map((p) => `  ${p}`)
        .join('\n')}`,
      { type: 'validation', subtype: 'unknown_command', hint: 'a2wave schema' },
    )
  }

  const args = Object.entries(node.args ?? {})
  const required = args.filter(([, spec]) => spec.required === true).map(([name]) => name)
  const brief = options.brief ?? args.length > BRIEF_THRESHOLD

  // Brief keeps what a call cannot omit — the required params — plus nothing
  // else. A caller that needs more asks for --full, having already learned the
  // command exists; the reverse (paying for every flag on every lookup) is the
  // cost this mode exists to remove.
  const included = brief ? args.filter(([name]) => required.includes(name)) : args

  const agentMeta = node.meta?.agentMeta
  return {
    name: path,
    ...(node.meta?.description ? { description: node.meta.description } : {}),
    // Absent is impossible in practice — the structural test makes every leaf
    // declare one — but the schema must still be well-typed if a node slips in
    // ahead of that test, and `write` is the safe assumption, not `read`.
    risk: agentMeta?.risk ?? 'write',
    brief,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        included.map(([name, spec]) => [name, toProperty(name, spec)]),
      ),
      required,
    },
    ...(agentMeta?.preconditions ? { preconditions: agentMeta.preconditions } : {}),
    ...(agentMeta?.notFor ? { notFor: agentMeta.notFor } : {}),
    ...(agentMeta?.examples ? { examples: agentMeta.examples } : {}),
  }
}
