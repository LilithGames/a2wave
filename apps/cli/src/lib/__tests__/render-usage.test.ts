import { defineCommand } from 'citty'
import { describe, expect, it } from 'vitest'
import { renderUsage } from '../render-usage.js'

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires ESC.
const ANSI = /\u001b\[[0-9;]*m/g
const strip = (value: string) => value.replace(ANSI, '')

const leaf = defineCommand({
  meta: { name: 'whoami', description: 'Show the identity and instance' },
  run() {},
})

const root = defineCommand({
  meta: { name: 'a2wave', version: '0.7.3', description: 'a2wave command-line tool' },
  subCommands: {
    whoami: leaf,
    setup: defineCommand({
      meta: {
        name: 'setup',
        description:
          'Install a local a2wave platform: generate .env + docker-compose.yml, start the container, and wait until healthy. Use --upgrade to move an existing image, or --down to uninstall.',
      },
      run() {},
    }),
    hidden: defineCommand({
      meta: { name: 'hidden', description: 'Not for humans', hidden: true },
      run() {},
    }),
  },
})

const withArgs = defineCommand({
  meta: { name: 'list', description: 'List runs' },
  args: {
    agent: { type: 'string', description: 'Filter by Agent' },
    limit: { type: 'string', description: 'Rows per page', default: '20' },
    json: { type: 'boolean', description: 'Emit the raw payload as compact JSON' },
    id: { type: 'positional', description: 'The run id' },
  },
  run() {},
})

describe('renderUsage', () => {
  it('never emits trailing whitespace on any line', async () => {
    // The defect this whole module exists for: citty padded the last column to
    // the widest description, wrapping every row into a blank-looking line.
    const out = await renderUsage(root, undefined, 100)
    for (const line of out.split('\n')) {
      expect(strip(line)).toBe(strip(line).trimEnd())
    }
  })

  it('never emits a line wider than the given width', async () => {
    for (const width of [60, 80, 100]) {
      const out = await renderUsage(root, undefined, width)
      for (const line of out.split('\n')) {
        expect(strip(line).length).toBeLessThanOrEqual(width)
      }
    }
  })

  it('lists subcommands under a COMMANDS heading, left-aligned', async () => {
    const out = strip(await renderUsage(root, undefined, 100))
    expect(out).toContain('COMMANDS')
    expect(out).toMatch(/^ {2}whoami {2,}Show the identity and instance$/m)
  })

  it('keeps the full text of a long description rather than truncating it', async () => {
    const out = strip(await renderUsage(root, undefined, 100))
    expect(out).toContain('Install a local a2wave platform')
    expect(out).toContain('--down to uninstall.')
  })

  it('omits hidden subcommands', async () => {
    const out = strip(await renderUsage(root, undefined, 100))
    expect(out).not.toContain('Not for humans')
  })

  it('renders the description and version header', async () => {
    const out = strip(await renderUsage(root, undefined, 100))
    expect(out).toContain('a2wave command-line tool')
    expect(out).toContain('v0.7.3')
  })

  it('prefixes the usage line with the parent command name', async () => {
    const out = strip(await renderUsage(leaf, root, 100))
    expect(out).toContain('USAGE a2wave whoami')
  })

  it('never leaks an absolute script path into the usage line', async () => {
    // citty falls back to process.argv[1] when meta.name is missing, which
    // printed the published binary's full path on every --help.
    const nameless = defineCommand({ meta: { description: 'no name' }, run() {} })
    const out = strip(await renderUsage(nameless, undefined, 100))
    expect(out).not.toContain('/')
  })

  it('renders OPTIONS and ARGUMENTS with their hints', async () => {
    const out = strip(await renderUsage(withArgs, root, 100))
    expect(out).toContain('ARGUMENTS')
    expect(out).toContain('OPTIONS')
    expect(out).toContain('--agent')
    expect(out).toContain('(Default: 20)')
    expect(out).toMatch(/ID\b/)
  })

  it('lists the subcommand names on the USAGE line', async () => {
    const out = strip(await renderUsage(root, undefined, 100))
    expect(out).toContain('whoami')
    expect(out).not.toContain('hidden|')
  })

  it('wraps a long pipe-joined subcommand list, which carries no spaces to break on', async () => {
    // The real root has 24 subcommands joined by `|` — one 165-character
    // "word" that word-wrapping alone cannot split, so it ran off the edge.
    const many = defineCommand({
      meta: { name: 'a2wave', description: 'many' },
      subCommands: Object.fromEntries(
        Array.from({ length: 24 }, (_, i) => [
          `command-number-${i}`,
          defineCommand({ meta: { name: `command-number-${i}`, description: 'x' }, run() {} }),
        ]),
      ),
    })
    for (const width of [60, 80, 100]) {
      const lines = strip(await renderUsage(many, undefined, width)).split('\n')
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(width)
      }
      // Every name still appears, and the separator is not lost in the break.
      const usage = lines.join('')
      for (let i = 0; i < 24; i++) expect(usage).toContain(`command-number-${i}`)
    }
  })

  it('wraps the multi-paragraph root description without mangling its blank lines', async () => {
    const framed = defineCommand({
      meta: {
        name: 'a2wave',
        description: 'a2wave command-line tool\n\nAGENT QUICKSTART\n  1. a2wave schema  list paths',
      },
      subCommands: { whoami: leaf },
    })
    const out = strip(await renderUsage(framed, undefined, 100))
    expect(out).toContain('AGENT QUICKSTART')
    // The preformatted block keeps its own indentation.
    expect(out).toMatch(/^ {2}1\. a2wave schema {2}list paths$/m)
  })

  it('ends without a trailing blank run', async () => {
    const out = await renderUsage(root, undefined, 100)
    expect(out.endsWith('\n')).toBe(false)
  })
})
