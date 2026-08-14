/**
 * `a2wave schema [command]` — the CLI describing itself to its caller.
 *
 * With no argument it lists the command paths, cheaply: an index, not a dump.
 * With one, it emits a function-calling spec for that command, composed in
 * lib/schema.ts from the citty tree, the generated shared-schema snapshot and
 * the command's own `agentMeta`.
 */
import { defineCommand } from 'citty'
import { getRootCommand } from '../lib/root-registry.js'
import { buildCommandSchema, listCommandPaths } from '../lib/schema.js'

export const schemaCommand = defineCommand({
  meta: {
    name: 'schema',
    description: 'Machine-readable spec for a command (no argument lists every command path)',
    agentMeta: {
      risk: 'read',
      notFor: ['Reading prose about how the CLI behaves overall — that is `a2wave docs`'],
      examples: [
        'a2wave schema',
        'a2wave schema "agents apply" --brief',
        'a2wave schema "runs list" --full',
      ],
    },
  },
  args: {
    command: {
      type: 'positional',
      description: 'Command path, e.g. "agents apply" (omit to list every path)',
      required: false,
    },
    brief: {
      type: 'boolean',
      description: 'Required params and flags only (the default above 8 args)',
    },
    full: { type: 'boolean', description: 'Every parameter, overriding the brief default' },
    'json-pretty': { type: 'boolean', description: 'Indent the output for reading' },
    // Declared so `schema --json` parses, even though this command answers in
    // JSON regardless: a caller that reaches for the flag out of habit should
    // not get "unknown argument".
    json: { type: 'boolean', description: 'No-op; schema output is always JSON' },
  },
  run: ({ args }) => {
    const root = getRootCommand()
    const indent = args['json-pretty'] === true ? 2 : undefined

    const path = (args.command as string | undefined)?.trim()
    if (!path) {
      // The index deliberately carries paths only. Attaching each command's
      // description here would roughly triple it, and a caller that wants one
      // asks for it by name.
      console.log(JSON.stringify({ commands: listCommandPaths(root) }, null, indent))
      return
    }

    // `--full` wins over `--brief`: passing both is a caller correcting itself,
    // and the wider answer is the safe reading of that.
    const brief = args.full === true ? false : args.brief === true ? true : undefined
    console.log(JSON.stringify(buildCommandSchema(root, path, { brief }), null, indent))
  },
})
