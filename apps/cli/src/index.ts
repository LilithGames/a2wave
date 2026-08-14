#!/usr/bin/env node
import { defineCommand, runCommand, showUsage } from 'citty'
import { agentsCommand } from './commands/agents.js'
import { apiCommand } from './commands/api.js'
import { chatCommand } from './commands/chat.js'
import { configCommand } from './commands/config.js'
import { doctorCommand } from './commands/doctor.js'
import { evalCommand } from './commands/eval.js'
import { kbCommand } from './commands/kb.js'
import { loginCommand, logoutCommand } from './commands/login.js'
import { mcpCommand } from './commands/mcp.js'
import { providersCommand } from './commands/providers.js'
import { runsCommand } from './commands/runs.js'
import { scmCommand } from './commands/scm.js'
import { setupCommand } from './commands/setup.js'
import { skillsCommand } from './commands/skills.js'
import { statusCommand } from './commands/status.js'
import { updateCommand } from './commands/update.js'
import { whoamiCommand } from './commands/whoami.js'
import { CliError, toErrorEnvelope } from './errors.js'
import { getVersion } from './version.js'

// Silent alias: rewrite the legacy `upgrade` to `update` without registering a
// second entry in subCommands — avoids two identical update commands in help.
// citty has no hidden mechanism, so this is the cleanest workaround.
if (process.argv[2] === 'upgrade') {
  process.argv[2] = 'update'
}

const rootCommand = defineCommand({
  meta: {
    name: 'a2wave',
    version: getVersion(),
    description: 'a2wave command-line tool',
  },
  subCommands: {
    setup: setupCommand,
    login: loginCommand,
    logout: logoutCommand,
    status: statusCommand,
    whoami: whoamiCommand,
    doctor: doctorCommand,
    config: configCommand,
    skills: skillsCommand,
    agents: agentsCommand,
    chat: chatCommand,
    eval: evalCommand,
    mcp: mcpCommand,
    scm: scmCommand,
    kb: kbCommand,
    providers: providersCommand,
    runs: runsCommand,
    // Last on purpose: the raw escape hatch is what an agent should reach for
    // only after finding no typed command above it.
    api: apiCommand,
    update: updateCommand,
  },
})

/**
 * Whether the invocation asked for machine-readable output.
 *
 * `handleError` runs after citty has unwound, so the parsed args are gone and
 * raw argv is the only honest source. A boolean flag never consumes the next
 * token, so the sole ambiguity is a JSON flag appearing as some OTHER flag's
 * value (`chat send bot -m --json`). Skipping the token after any
 * value-carrying flag would need the whole arg schema here; instead treat a
 * token as a flag only when the token before it is not itself a flag awaiting
 * a value — which is exactly "the previous token does not start with -".
 */
function wantsJsonOutput(argv: string[]): boolean {
  const JSON_FLAGS = new Set(['--json', '--json-pretty', '--fields'])
  return argv.some((token, i) => {
    if (!JSON_FLAGS.has(token)) return false
    const prev = i > 0 ? argv[i - 1] : undefined
    // First token, or preceded by something that is not a flag expecting a
    // value. `--fields data[].id` still matches on the flag itself, not on
    // its value, so a value that happens to read `--json` cannot trigger this.
    return prev === undefined || !prev.startsWith('-')
  })
}

export function handleError(err: unknown): never {
  // Errors go to stderr in every mode, so a caller piping stdout to a parser
  // never has the payload and the failure interleaved.
  if (wantsJsonOutput(process.argv.slice(2))) {
    console.error(JSON.stringify(toErrorEnvelope(err)))
    process.exit(1)
  }

  if (err instanceof CliError) {
    console.error(err.message)
    // A hint is a runnable next step, so it earns its own line rather than
    // being buried in the sentence.
    if (err.hint) console.error(`Hint: ${err.hint}`)
    process.exit(1)
  }

  // Anything else is a bug in this CLI. It used to be re-thrown, which meant a
  // TypeError surfaced as a full Node stack dump: unparseable for an agent and
  // alarming for a human. Report it in the same shape as everything else and
  // keep the stack behind a flag for whoever is actually debugging it.
  const message = err instanceof Error ? err.message : String(err)
  console.error(`Internal error: ${message}`)
  if (process.env.A2WAVE_DEBUG && err instanceof Error) console.error(err.stack)
  console.error('This is a bug in the a2wave CLI. Re-run with A2WAVE_DEBUG=1 for the stack.')
  process.exit(1)
}

/**
 * Dispatch, replacing citty's `runMain`.
 *
 * `runMain` catches every error itself, prints it through consola and calls
 * `process.exit(1)` — so `runMain(main).catch(handleError)` never ran, and a
 * plain `CliError` reached the user as a full stack trace with the message
 * printed twice:
 *
 *     ERROR  Not logged in. Run: a2wave login
 *         at requireToken (dist/index.cjs:104:11)
 *         ... six frames of citty internals ...
 *     ERROR  Not logged in. Run: a2wave login
 *
 * Owning the try/catch is the only way to make the error contract real. The
 * `--help` / `--version` branches are citty's own, reproduced here because they
 * live inside the function being replaced.
 */
type CommandNode = {
  subCommands?: Record<string, CommandNode>
}

/**
 * Walk argv down the subcommand tree, returning the deepest node and its
 * parent — the two arguments `showUsage` takes.
 *
 * citty has its own `resolveSubCommand`, but it is internal: not in the public
 * type surface and absent from the CJS bundle's exports, so importing it built
 * fine and then threw `resolveSubCommand is not a function` at runtime.
 */
function resolveForUsage(root: CommandNode, rawArgs: string[]): [CommandNode, CommandNode?] {
  let node = root
  let parent: CommandNode | undefined
  for (const token of rawArgs) {
    if (token.startsWith('-')) continue
    const next = node.subCommands?.[token]
    if (!next) break
    parent = node
    node = next
  }
  return [node, parent]
}

/** citty throws its own CLIError for routing failures (unknown/missing command). */
function isCittyRoutingError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'CLIError'
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2)
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    const [cmd, parent] = resolveForUsage(rootCommand as CommandNode, rawArgs)
    await showUsage(cmd as never, parent as never)
    return
  }
  if (rawArgs.length === 1 && rawArgs[0] === '--version') {
    console.log(getVersion())
    return
  }
  try {
    await runCommand(rootCommand, { rawArgs })
  } catch (err) {
    // A wrong command name is the user's typo, not a crash in this CLI, so it
    // must not surface as `internal` with a "this is a bug" footer. Show the
    // usage that citty would have shown, then report it as a validation error.
    if (isCittyRoutingError(err)) {
      const [cmd, parent] = resolveForUsage(rootCommand as CommandNode, rawArgs)
      await showUsage(cmd as never, parent as never)
      throw new CliError(err.message, { type: 'validation', subtype: 'unknown_command' })
    }
    throw err
  }
}

main().catch(handleError)
