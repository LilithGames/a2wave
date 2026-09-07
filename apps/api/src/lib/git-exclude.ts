import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withKeyedLock } from './keyed-mutex.js'

const PLATFORM_EXCLUDE_HEADER = '# a2wave: platform-written workspace paths'

/**
 * Both workspace initialization and MCP sync add rules to the common exclude
 * file. Serialize local writers for idempotence, and append only missing rules
 * so a peer process cannot erase rules installed since this process read it.
 * A concurrent peer can duplicate a rule or header; duplicates are harmless.
 */
export async function appendGitExcludePatterns(
  excludePath: string,
  patterns: string[],
): Promise<void> {
  await withKeyedLock(`git-exclude:${excludePath}`, async () => {
    let existing = ''
    try {
      existing = await readFile(excludePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    const present = new Set(existing.split('\n').map((line) => line.trim()))
    const missing = [...new Set(patterns)].filter((pattern) => !present.has(pattern))
    if (missing.length === 0) return
    await mkdir(dirname(excludePath), { recursive: true })
    const header = present.has(PLATFORM_EXCLUDE_HEADER) ? '' : `${PLATFORM_EXCLUDE_HEADER}\n`
    // Always start a new line, even if a peer appended after our snapshot.
    // Never rewrite the snapshot: it may already omit another live run's rules.
    await writeFile(excludePath, `\n${header}${missing.join('\n')}\n`, { flag: 'a' })
  })
}
