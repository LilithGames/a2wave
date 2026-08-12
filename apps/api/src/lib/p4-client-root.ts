import { isAbsolute, relative, resolve } from 'node:path'
import { sanitizeCredentials } from './git-sync.js'

/**
 * P4 client Root coverage: the single decision both P4 entry points share.
 *
 * `checkP4Connection` and `executeP4Sync` previously each implemented this.
 * They drifted in three ways at once — the sync side gated the whole check
 * behind a managed-path test that is dead for P4 (managed paths are rejected at
 * create time), it lacked the "client does not exist yet" short-circuit the
 * check side had, and the two disagreed on whether an unreadable spec was fatal.
 * The result was a Root mismatch shown in red by "Check connection" and then
 * silently ignored by the sync that followed. One verifier, one set of outcomes.
 */

/** `Root:` plus every `AltRoots:` entry, including one sharing the label line. */
export function parseP4ClientRoots(spec: string): string[] {
  const roots: string[] = []
  let readingAltRoots = false
  for (const line of spec.split(/\r?\n/)) {
    const root = line.match(/^Root:\s*(.+)$/)?.[1]?.trim()
    if (root) {
      roots.push(root)
      readingAltRoots = false
      continue
    }
    const altRoots = line.match(/^AltRoots:\s*(.*)$/)
    if (altRoots) {
      readingAltRoots = true
      const inlineRoot = altRoots[1]?.trim()
      if (inlineRoot) roots.push(inlineRoot)
      continue
    }
    if (readingAltRoots && /^\s+\S/.test(line)) {
      roots.push(line.trim())
      continue
    }
    if (/^\S[^:]*:/.test(line)) readingAltRoots = false
  }
  return roots.filter(isAbsolute)
}

export function p4ClientRootCoversPath(localPath: string, roots: string[]): boolean {
  const candidate = resolve(localPath)
  return roots.some((root) => {
    const child = relative(resolve(root), candidate)
    return child === '' || (!child.startsWith('..') && !isAbsolute(child))
  })
}

export type P4ClientRootVerdict =
  | { outcome: 'covered'; clientRoot?: string }
  | { outcome: 'not-covered'; clientRoot?: string }
  /** The client has not been created on the server yet — not a mismatch. */
  | { outcome: 'client-missing'; detail: string }
  /** No evidence either way; callers must not treat this as a failure. */
  | { outcome: 'indeterminate'; detail: string }

export interface P4ClientRootQuery {
  localPath: string
  /** Raw `p4 info` output, already fetched by the caller. */
  infoOutput: string
  readClientSpec: () => Promise<string>
  clientName: string
}

export async function verifyP4ClientRootCoverage(
  query: P4ClientRootQuery,
): Promise<P4ClientRootVerdict> {
  // A client that does not exist yet answers `p4 client -o` with a template
  // spec whose Root is the p4 process cwd. Comparing against that would blame
  // the Root for what is really a missing client.
  if (/^Client unknown\.\s*$/im.test(query.infoOutput)) {
    return {
      outcome: 'client-missing',
      detail: `P4 client "${query.clientName}" does not exist yet. Create it with a Root or AltRoots that covers the local path.`,
    }
  }

  let roots: string[]
  try {
    roots = parseP4ClientRoots(await query.readClientSpec())
  } catch (error) {
    return {
      outcome: 'indeterminate',
      detail: sanitizeCredentials(error instanceof Error ? error.message : String(error)),
    }
  }

  if (roots.length === 0) {
    return { outcome: 'indeterminate', detail: 'client spec declared no absolute Root' }
  }

  const clientRoot = roots[0]
  return p4ClientRootCoversPath(query.localPath, roots)
    ? { outcome: 'covered', clientRoot }
    : { outcome: 'not-covered', clientRoot }
}
