/**
 * Help-page layout primitives.
 *
 * citty's own `formatLineColumns` pads *every* column to the widest entry —
 * including the last one. With a 250-character description in the set (`api`),
 * all 24 rows of `a2wave --help` were padded out to 332 columns, and every
 * terminal narrower than that wrapped the trailing whitespace into a
 * blank-looking second line. The list read as double-spaced and mid-sentence
 * broken. It also right-aligned the name column, so command names stepped in
 * and out raggedly.
 *
 * These replace that with the layout every mainstream CLI uses (claude, codex,
 * lark-cli): two-space indent, left-aligned names, one gutter, descriptions
 * wrapped to the terminal with a hanging indent, and no trailing whitespace on
 * any line.
 */

/**
 * Width used when stdout is not a TTY.
 *
 * The primary consumer of this page is an agent reading piped output, which
 * reports no columns. A fixed number keeps that output byte-identical between
 * runs and machines — a terminal-dependent width would make help text a
 * flaky snapshot. It doubles as the cap for very wide terminals: a 400-column
 * line of prose is unreadable no matter how much room there is.
 */
export const HELP_FALLBACK_WIDTH = 100

/** Below this the two-column layout has no room left for words. */
const MIN_WIDTH = 40

/** Spaces before the name column, and between the two columns. */
const INDENT = 2
const GUTTER = 2

/**
 * The widest a name column may grow. Past this, one outlier command name
 * would squeeze every description on the page into a sliver.
 */
const MAX_NAME_WIDTH = 24

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes requires ESC.
const ANSI = /\[[0-9;]*m/g

/** Visible length, ignoring the colour escapes citty wraps names in. */
function visibleLength(value: string): number {
  return value.replace(ANSI, '').length
}

type Stream = { isTTY?: boolean; columns?: number }

/**
 * The column budget for a help page.
 *
 * Clamped at both ends: `MIN_WIDTH` because the layout stops making sense
 * below it, `HELP_FALLBACK_WIDTH` because long lines of prose get hard to
 * track back to the next line's start.
 */
export function helpWidth(stream: Stream = process.stdout): number {
  const columns = stream.isTTY ? stream.columns : undefined
  if (!columns) return HELP_FALLBACK_WIDTH
  return Math.max(MIN_WIDTH, Math.min(columns, HELP_FALLBACK_WIDTH))
}

/**
 * Break `text` into lines of at most `width` visible characters.
 *
 * A word longer than the width (a URL, a long flag spelling) is emitted on its
 * own line and allowed to overflow rather than being cut: truncating it would
 * make the help text wrong, which is worse than a ragged right edge.
 */
export function wrapText(text: string, width: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (line === '') {
      line = word
      continue
    }
    if (visibleLength(line) + 1 + visibleLength(word) <= width) {
      line += ` ${word}`
    } else {
      lines.push(line)
      line = word
    }
  }
  lines.push(line)
  return lines
}

/**
 * Render `[name, description]` rows as two aligned columns.
 *
 * Names are padded to a shared width so descriptions line up; a name wider
 * than `MAX_NAME_WIDTH` (or wider than the budget leaves room for) takes its
 * own line and its description starts on the next one, rather than dragging
 * the whole column right.
 */
export function formatColumns(rows: Array<[string, string]>, width: number): string {
  if (rows.length === 0) return ''

  const nameWidth = Math.min(MAX_NAME_WIDTH, Math.max(...rows.map(([name]) => visibleLength(name))))
  const descColumn = INDENT + nameWidth + GUTTER
  // Always leave a usable description column, even in a narrow terminal.
  const descWidth = Math.max(MIN_WIDTH - descColumn, width - descColumn)
  const hangingIndent = ' '.repeat(descColumn)

  const out: string[] = []
  for (const [name, description] of rows) {
    const nameLength = visibleLength(name)
    const lines = wrapText(description, descWidth)

    if (nameLength > nameWidth) {
      // Outlier name: give it a line of its own, then indent the description
      // under the shared column so the page still scans as one list.
      out.push(`${' '.repeat(INDENT)}${name}`)
      for (const line of lines) out.push(`${hangingIndent}${line}`)
      continue
    }

    const padded = `${' '.repeat(INDENT)}${name}${' '.repeat(nameWidth - nameLength)}`
    if (lines.length === 0) {
      // No description: emit the bare name with no trailing gutter.
      out.push(padded.trimEnd())
      continue
    }
    out.push(`${padded}${' '.repeat(GUTTER)}${lines[0]}`)
    for (const line of lines.slice(1)) out.push(`${hangingIndent}${line}`)
  }
  return out.join('\n')
}
