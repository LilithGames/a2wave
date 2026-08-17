#!/usr/bin/env node
import { defineCommand, runCommand } from 'citty'
import { agentsCommand } from './commands/agents.js'
import { apiCommand } from './commands/api.js'
import { channelsCommand } from './commands/channels.js'
import { chatCommand } from './commands/chat.js'
import { completionCommand } from './commands/completion.js'
import { configCommand } from './commands/config.js'
import { docsCommand } from './commands/docs.js'
import { doctorCommand } from './commands/doctor.js'
import { evalCommand } from './commands/eval.js'
import { kbCommand } from './commands/kb.js'
import { loginCommand, logoutCommand } from './commands/login.js'
import { mcpCommand } from './commands/mcp.js'
import { memoryCommand } from './commands/memory.js'
import { providersCommand } from './commands/providers.js'
import { runsCommand } from './commands/runs.js'
import { schemaCommand } from './commands/schema.js'
import { scmCommand } from './commands/scm.js'
import { setupCommand } from './commands/setup.js'
import { skillGroupsCommand } from './commands/skill-groups.js'
import { skillsCommand } from './commands/skills.js'
import { statusCommand } from './commands/status.js'
import { updateCommand } from './commands/update.js'
import { whoamiCommand } from './commands/whoami.js'
import { CliError, toErrorEnvelope } from './errors.js'
import { readAgentMeta } from './lib/agent-meta.js'
import { renderUsage } from './lib/render-usage.js'
import { setRootCommand } from './lib/root-registry.js'
import { getVersion } from './version.js'

/**
 * The block that opens `a2wave --help`.
 *
 * The primary consumer is an AI agent, and the first thing it reads is this
 * page — so it opens with the loop and the tier order rather than with install
 * instructions. Human setup is exiled to the last line on purpose: it is the
 * one item almost no caller of this page needs, and leading with it teaches an
 * agent that the top of --help is not worth reading.
 */
const AGENT_QUICKSTART = `AGENT QUICKSTART
  1. a2wave schema                    list every command path
  2. a2wave schema "<command>" --brief  parameters, risk label, required args
  3. a2wave <command> --dry-run       preview a write, where offered
  4. a2wave <command> --json --fields 'data[].id,data[].name'

  Prefer a typed command over the 'api' escape hatch — api resolves no names,
  validates no parameters, and needs --yes for every write.
  Risk labels: read (safe) | write | high-risk-write (needs --yes; you have no TTY).
  a2wave docs      the full agent guide, including what NOT to use each command for.

  Human first-time setup: a2wave setup, then a2wave login.`

const rootCommand = defineCommand({
  meta: {
    name: 'a2wave',
    version: getVersion(),
    description: `a2wave command-line tool\n\n${AGENT_QUICKSTART}`,
  },
  subCommands: {
    // First on purpose: these three are how a caller learns the rest, so they
    // lead the list an agent reads top-down.
    schema: schemaCommand,
    docs: docsCommand,
    completion: completionCommand,
    setup: setupCommand,
    login: loginCommand,
    logout: logoutCommand,
    status: statusCommand,
    whoami: whoamiCommand,
    doctor: doctorCommand,
    config: configCommand,
    skills: skillsCommand,
    'skill-groups': skillGroupsCommand,
    agents: agentsCommand,
    chat: chatCommand,
    channels: channelsCommand,
    eval: evalCommand,
    mcp: mcpCommand,
    memory: memoryCommand,
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

// `schema` / `docs` / `completion` walk this tree but live inside it, so they
// cannot import it without a cycle. Handing it over here is the one moment it
// exists and they do not yet need it.
setRootCommand(rootCommand as never)

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
 * `--help` branch is citty's own, reproduced here because it lives inside the
 * function being replaced; `--version` is handled a level up, in `runCli`.
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

/**
 * The usage page, followed by the node's risk label.
 *
 * `renderUsage` is ours rather than citty's: citty padded the last column to
 * the widest description, so a 250-character `api` description forced every
 * row of `a2wave --help` out to 332 columns and each one wrapped into a
 * blank-looking second line. See src/lib/render-usage.ts.
 *
 * Printed with `console.log` rather than through consola, which suppresses
 * output whenever it believes it is under test.
 *
 * Only leaves carry a risk label — a group node does no work of its own, so a
 * risk there would have to be the max of its children, which is a number
 * nobody maintains.
 */
async function showUsageWithRisk(cmd: CommandNode, parent?: CommandNode): Promise<void> {
  console.log(`${await renderUsage(cmd, parent)}\n`)
  const risk = readAgentMeta(cmd)?.risk
  if (risk) console.log(`Risk: ${risk}`)
}

/** citty throws its own CLIError for routing failures (unknown/missing command). */
function isCittyRoutingError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'CLIError'
}

async function dispatch(rawArgs: string[]): Promise<void> {
  if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
    const [cmd, parent] = resolveForUsage(rootCommand as CommandNode, rawArgs)
    await showUsageWithRisk(cmd, parent)
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
      await showUsageWithRisk(cmd, parent)
      throw new CliError(err.message, { type: 'validation', subtype: 'unknown_command' })
    }
    throw err
  }
}

export function runCli(rawArgs: string[]): void {
  // citty only recognizes --version when it is the sole raw argument. Preserve
  // the documented compatibility form `a2wave setup --version` without
  // scanning option values such as `chat send -m "--version"`.
  if (
    (rawArgs.length === 1 && rawArgs[0] === '--version') ||
    (rawArgs.length === 2 && rawArgs[0] === 'setup' && rawArgs[1] === '--version')
  ) {
    console.log(getVersion())
    return
  }

  // Silent alias: rewrite the legacy `upgrade` to `update` without registering
  // a duplicate command in help output. Rewriting the argv copy rather than
  // `process.argv` keeps the entry point free of global mutation.
  const normalizedArgs = rawArgs[0] === 'upgrade' ? ['update', ...rawArgs.slice(1)] : rawArgs
  dispatch(normalizedArgs).catch(handleError)
}

runCli(process.argv.slice(2))
