import { describe, expect, it } from 'vitest'
import { formatColumns, HELP_FALLBACK_WIDTH, helpWidth, wrapText } from '../usage.js'

describe('wrapText', () => {
  it('returns a single line when the text fits', () => {
    expect(wrapText('short enough', 40)).toEqual(['short enough'])
  })

  it('breaks on word boundaries, never mid-word', () => {
    const lines = wrapText('alpha beta gamma delta', 12)
    expect(lines).toEqual(['alpha beta', 'gamma delta'])
  })

  it('never exceeds the requested width', () => {
    const text =
      'Install a local a2wave platform: generate .env + docker-compose.yml, start the container, and wait until healthy.'
    for (const line of wrapText(text, 48)) {
      expect(line.length).toBeLessThanOrEqual(48)
    }
  })

  it('keeps a word longer than the width on its own line rather than truncating it', () => {
    // A URL or a flag spelling can exceed the column; losing characters would
    // make the help lie, so an over-long word overflows instead.
    expect(wrapText('see https://example.com/a/very/long/path now', 10)).toEqual([
      'see',
      'https://example.com/a/very/long/path',
      'now',
    ])
  })

  it('collapses the runs of whitespace a description may carry', () => {
    expect(wrapText('alpha   beta\n\ngamma', 40)).toEqual(['alpha beta gamma'])
  })

  it('returns no lines for empty text, so a description-less row prints bare', () => {
    expect(wrapText('   ', 40)).toEqual([])
  })
})

describe('formatColumns', () => {
  it('left-aligns names and separates them from descriptions by a single gutter', () => {
    const out = formatColumns([['schema', 'Machine-readable spec']], 80)
    expect(out).toBe('  schema  Machine-readable spec')
  })

  it('pads names to a common width so descriptions line up', () => {
    const out = formatColumns(
      [
        ['docs', 'Print the agent guide'],
        ['skill-groups', 'Manage Skill Groups'],
      ],
      80,
    )
    expect(out.split('\n')).toEqual([
      '  docs          Print the agent guide',
      '  skill-groups  Manage Skill Groups',
    ])
  })

  it('emits no trailing whitespace — the defect that made every row wrap', () => {
    // citty padded the LAST column to the widest description, so a 250-char
    // description forced every row out to 332 columns and the terminal wrapped
    // the padding into a blank-looking second line.
    const out = formatColumns(
      [
        ['a', 'short'],
        ['b', 'a considerably longer description than the other row carries'],
      ],
      120,
    )
    for (const line of out.split('\n')) {
      expect(line).toBe(line.trimEnd())
    }
  })

  it('wraps a long description with a hanging indent under the description column', () => {
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi'
    const lines = formatColumns([['setup', words]], 50).split('\n')

    expect(lines.length).toBeGreaterThan(1)
    // First line carries the name; every continuation is indented to sit under
    // the description column, so the block reads as one paragraph.
    expect(lines[0]).toMatch(/^ {2}setup {2}alpha/)
    const descColumn = lines[0].indexOf('alpha')
    for (const line of lines.slice(1)) {
      expect(line.slice(0, descColumn)).toBe(' '.repeat(descColumn))
      expect(line[descColumn]).not.toBe(' ')
    }
    // Every word survives the wrap, in order.
    expect(lines.join(' ').split(/\s+/).filter(Boolean).slice(1).join(' ')).toBe(words)
  })

  it('never emits a line wider than the terminal', () => {
    const rows: Array<[string, string]> = [
      [
        'api',
        'Call any a2wave API endpoint directly (raw HTTP escape hatch). Prefer the typed command when one exists: it validates parameters, resolves names to ids, and applies the right risk label.',
      ],
      ['kb', 'Manage knowledge base documents (KB Document)'],
    ]
    for (const width of [60, 80, 100, 120]) {
      for (const line of formatColumns(rows, width).split('\n')) {
        expect(line.length).toBeLessThanOrEqual(width)
      }
    }
  })

  it('measures the name column by its visible text, ignoring ANSI colour', () => {
    // Names are colourised before they reach the formatter; padding on the
    // escape-bearing string would over-count and break the alignment.
    const out = formatColumns([['\u001b[36mdocs\u001b[39m', 'Print the agent guide']], 80)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires ESC.
    expect(out.replace(/\u001b\[[0-9;]*m/g, '')).toBe('  docs  Print the agent guide')
  })

  it('keeps the description on one line per row when it fits', () => {
    const out = formatColumns([['runs', 'Manage runs']], 80)
    expect(out.split('\n')).toHaveLength(1)
  })

  it('stops widening the name column when one name is pathologically long', () => {
    // A single long name must not push every description off the right edge;
    // it takes its own line instead.
    const out = formatColumns(
      [
        ['a-very-long-command-name-that-eats-the-line', 'does a thing'],
        ['ok', 'fine'],
      ],
      50,
    )
    for (const line of out.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(50)
    }
    expect(out).toContain('does a thing')
  })
})

describe('helpWidth', () => {
  it('falls back to a fixed width when stdout is not a TTY, so agent output is stable', () => {
    expect(helpWidth({ isTTY: false, columns: undefined })).toBe(HELP_FALLBACK_WIDTH)
    expect(HELP_FALLBACK_WIDTH).toBe(100)
  })

  it('uses the terminal width when attached to a narrower TTY', () => {
    expect(helpWidth({ isTTY: true, columns: 72 })).toBe(72)
  })

  it('caps a very wide terminal, since a full-width line is unreadable prose', () => {
    expect(helpWidth({ isTTY: true, columns: 400 })).toBe(HELP_FALLBACK_WIDTH)
  })

  it('never returns a width so narrow that the layout collapses', () => {
    expect(helpWidth({ isTTY: true, columns: 10 })).toBeGreaterThanOrEqual(40)
  })
})
