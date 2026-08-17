/**
 * The `--help` page, replacing citty's `renderUsage`.
 *
 * citty's version had three defects that compounded into an unreadable page:
 * it padded the LAST column to the widest description (a 250-character `api`
 * description forced all 24 rows out to 332 columns, so every terminal
 * narrower than that wrapped the trailing whitespace into a blank-looking
 * second line — the list read as double-spaced), it never consulted the
 * terminal width (long descriptions broke mid-sentence at column 0, losing the
 * column alignment entirely), and it right-aligned command names so they
 * stepped in and out raggedly.
 *
 * Reimplemented rather than post-processed: the padding is applied inside
 * citty's `formatLineColumns`, so there is no seam to patch from outside, and
 * "strip the trailing spaces afterwards" cannot recover text that was already
 * wrapped at the wrong width. The layout matches what every mainstream CLI
 * uses (claude, codex, lark-cli): two-space indent, left-aligned names, one
 * gutter, and descriptions wrapped with a hanging indent.
 *
 * citty's own `resolveArgs` / `resolveValue` are internal — absent from the
 * CJS bundle's exports, so importing them typechecks and then throws at
 * runtime (see apps/cli/CLAUDE.md). They are reproduced here.
 */

import { formatColumns, helpWidth, wrapText } from './usage.js'

const colors = {
  cyan: (s: string) => `[36m${s}[39m`,
  gray: (s: string) => `[90m${s}[39m`,
  bold: (s: string) => `[1m${s}[22m`,
  underline: (s: string) => `[4m${s}[24m`,
}

/** citty's own heading style: bold + underlined. */
function heading(text: string): string {
  return colors.underline(colors.bold(text))
}

type ArgDef = {
  type?: string
  description?: string
  alias?: string | string[]
  default?: unknown
  required?: boolean
  valueHint?: string
  options?: string[]
  negativeDescription?: string
}

type Meta = {
  name?: string
  description?: string
  version?: string
  hidden?: boolean
  alias?: string | string[]
}

/** citty's own `Resolvable`: a value, a promise of one, or a thunk returning either. */
type Resolvable<T> = T | Promise<T> | (() => T) | (() => Promise<T>)

export type UsageNode = {
  meta?: Resolvable<Meta>
  args?: Resolvable<Record<string, ArgDef>>
  subCommands?: Resolvable<Record<string, Resolvable<UsageNode>>>
}

async function resolveValue<T>(input: Resolvable<T> | undefined): Promise<T | undefined> {
  return typeof input === 'function' ? await (input as () => T | Promise<T>)() : await input
}

function toArray(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value
  return value === undefined ? [] : [value]
}

/** citty parses `--no-x` as a negation of `x`, so `no-`-prefixed names are not re-listed. */
const NEGATIVE_PREFIX = /^no[-A-Z]/

function snakeCase(name: string): string {
  return name
    .replace(/-/g, '_')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
}

function renderValueHint(arg: ArgDef & { name: string }): string {
  const valueHint = arg.valueHint ? `=<${arg.valueHint}>` : ''
  if (!arg.type || arg.type === 'positional' || arg.type === 'boolean') return valueHint
  if (arg.type === 'enum' && arg.options?.length) return `=<${arg.options.join('|')}>`
  return valueHint || `=<${snakeCase(arg.name)}>`
}

function renderDescription(arg: ArgDef, required: boolean): string {
  return [
    arg.description,
    required ? '(Required)' : '',
    arg.default === undefined ? '' : `(Default: ${arg.default})`,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * A meta description may be a hand-formatted block (the root command's AGENT
 * QUICKSTART is an indented, numbered list). Reflowing that would destroy its
 * alignment, so a line that is indented or already fits is passed through
 * verbatim; only long flush-left prose is wrapped.
 */
function renderBlock(text: string, width: number): string[] {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return ['']
    if (line.length <= width) return [line]
    if (/^\s/.test(line)) return [line]
    return wrapText(line, width)
  })
}

/**
 * Render the help page for `cmd`.
 *
 * `width` is injectable so tests can pin the layout without depending on the
 * terminal running them.
 */
export async function renderUsage(
  cmd: UsageNode,
  parent?: UsageNode,
  width: number = helpWidth(),
): Promise<string> {
  const cmdMeta = (await resolveValue(cmd.meta)) || {}
  const parentMeta = (await resolveValue(parent?.meta)) || {}
  const argsDef = (await resolveValue(cmd.args)) || {}

  // Never fall back to process.argv[1] the way citty does — that printed the
  // published binary's absolute path into the usage line of every command
  // whose meta.name was missing.
  const commandName = [parentMeta.name, cmdMeta.name].filter(Boolean).join(' ')

  const argLines: Array<[string, string]> = []
  const posLines: Array<[string, string]> = []
  const usageLine: string[] = []

  for (const [name, argDef] of Object.entries(argsDef)) {
    const arg = { ...argDef, name }
    if (arg.type === 'positional') {
      const label = name.toUpperCase()
      const isRequired = arg.required !== false && arg.default === undefined
      posLines.push([colors.cyan(label + renderValueHint(arg)), renderDescription(arg, isRequired)])
      usageLine.push(isRequired ? `<${label}>` : `[${label}]`)
      continue
    }
    const isRequired = arg.required === true && arg.default === undefined
    const spelling =
      [...toArray(arg.alias).map((a) => `-${a}`), `--${name}`].join(', ') + renderValueHint(arg)
    argLines.push([colors.cyan(spelling), renderDescription(arg, isRequired)])

    // A boolean that defaults on can only be turned off through --no-<name>,
    // so that spelling is listed too — otherwise it is undiscoverable.
    if (
      arg.type === 'boolean' &&
      (arg.default === true || arg.negativeDescription) &&
      !NEGATIVE_PREFIX.test(name)
    ) {
      const negative = [...toArray(arg.alias).map((a) => `--no-${a}`), `--no-${name}`].join(', ')
      argLines.push([
        colors.cyan(negative),
        [arg.negativeDescription, isRequired ? '(Required)' : ''].filter(Boolean).join(' '),
      ])
    }
    if (isRequired) usageLine.push(`--${name}${renderValueHint(arg)}`)
  }

  const commandLines: Array<[string, string]> = []
  if (cmd.subCommands) {
    const names: string[] = []
    for (const [name, sub] of Object.entries((await resolveValue(cmd.subCommands)) ?? {})) {
      const meta = (await resolveValue((await resolveValue(sub))?.meta)) || {}
      if (meta.hidden) continue
      const aliases = toArray(meta.alias)
      commandLines.push([colors.cyan([name, ...aliases].join(', ')), meta.description || ''])
      names.push(name, ...aliases)
    }
    if (names.length > 0) usageLine.push(names.join('|'))
  }

  const out: string[] = []
  const version = cmdMeta.version || parentMeta.version
  if (cmdMeta.description) {
    const label = [commandName, version ? `v${version}` : ''].filter(Boolean).join(' ')
    out.push(...renderBlock(cmdMeta.description, width).map((l) => colors.gray(l)))
    if (label) out.push(colors.gray(`(${label})`))
    out.push('')
  }

  const hasOptions = argLines.length > 0 || posLines.length > 0
  const invocation = [commandName, hasOptions ? '[OPTIONS]' : '', usageLine.join(' ')]
    .filter(Boolean)
    .join(' ')
  // The subcommand list can be far wider than the terminal, and being
  // pipe-joined it is a single space-free "word" that word-wrapping alone
  // cannot split — the root's 24 commands made one 165-character token. Give
  // `wrapText` a break opportunity after each separator, then put it back.
  const usagePrefix = 'USAGE '
  const usageBody = wrapText(
    invocation.replace(/\|/g, '| '),
    Math.max(20, width - usagePrefix.length),
  ).map((line) => line.replace(/\| /g, '|'))
  out.push(`${heading('USAGE')} ${colors.cyan(usageBody[0] ?? '')}`)
  for (const line of usageBody.slice(1)) {
    out.push(`${' '.repeat(usagePrefix.length)}${colors.cyan(line)}`)
  }
  out.push('')

  if (posLines.length > 0) {
    out.push(heading('ARGUMENTS'), '', formatColumns(posLines, width), '')
  }
  if (argLines.length > 0) {
    out.push(heading('OPTIONS'), '', formatColumns(argLines, width), '')
  }
  if (commandLines.length > 0) {
    out.push(heading('COMMANDS'), '', formatColumns(commandLines, width), '')
    out.push(`Use ${colors.cyan(`${commandName} <command> --help`)} for more information.`)
  }

  // Trim trailing blanks so callers control the final spacing.
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}
