import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { platformWorkspaceEntries, platformWorkspacePaths } from '../workspace-platform-entries.js'

const SRC_ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Workspace-root writes that deliberately do NOT register as platform paths.
 * Each one has to stay wrong-by-design for a stated reason, so a new writer
 * lands here only with an argument, never by omission.
 */
const UNREGISTERED_BY_DESIGN: Record<string, string> = {
  artifacts:
    'WORKSPACE_ARTIFACTS_DIRECTORY — both consumers handle it separately (removal deletes it, the dirty check excludes it)',
  '.cursorrules':
    'legacy memory-override strip: only rewritten when the platform’s own marker is present, so an agent edit there IS agent work and must pin the workspace',
}

/**
 * Files that write into a workspace root without registering paths. Same rule:
 * a reason, or register.
 */
const UNREGISTERED_WRITER_FILES: Record<string, string> = {
  'engine/base-engine.ts':
    'strips the legacy memory-override section from CLAUDE.md / AGENTS.md — registering those would exempt them from the dirty check and let reset --hard discard agent edits',
  'lib/git-workspace.ts': 'the consumer — it removes these paths, it does not write them',
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await collectTsFiles(full)))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found
}

describe('platformWorkspacePaths', () => {
  it('derives every provider skills dir and MCP config path plus platform statics', () => {
    const paths = platformWorkspacePaths()
    // Writers that own a fixed entry
    expect(paths.has('.codegraph')).toBe(true)
    expect(paths.has('.kb')).toBe(true)
    // MCP config files + their managed carriers, at full depth
    expect(paths.has('.mcp.json')).toBe(true)
    expect(paths.has('.mcp.json.a2wave-managed')).toBe(true)
    expect(paths.has('.cursor/mcp.json')).toBe(true)
    expect(paths.has('.cursor/mcp.json.a2wave-managed')).toBe(true)
    expect(paths.has('.trae/mcp.json')).toBe(true)
    // Skills dirs from PRESET_PROVIDERS, at full depth
    for (const dir of [
      '.claude/skills',
      '.cursor/skills',
      '.codex/skills',
      '.opencode/skills',
      '.qoder/skills',
      '.kimi-code/skills',
      '.pi/skills',
      '.traecli/skills',
    ]) {
      expect(paths.has(dir)).toBe(true)
    }
  })

  it('never claims a whole shared root — a repo may track .claude/settings.json', () => {
    // The dirty check excludes these paths verbatim. `.claude` alone would also
    // exclude settings.json / hooks, and reset --hard would then silently
    // discard agent edits to them.
    for (const path of platformWorkspacePaths()) {
      expect(path).not.toBe('.claude')
      expect(path).not.toBe('.cursor')
    }
  })

  it('registers every workspace-root write found in the source tree', async () => {
    // The real guard against the recurring blind spot: scan for writers instead
    // of re-listing the ones the aggregator already imports (a test that walks
    // the known writers is a tautology — a fifth writer keeps it green).
    //
    // Two rules, because the literal scan alone caught no actual mount writer:
    // skill-sync/mcp-sync join a *variable* path, so string matching sees
    // nothing. A file that writes into a workspace root must therefore either
    // register its own paths or be waived by name.
    const joinPattern = /join\(\s*(?:workDir|workspacePath|wsPath|workspaceDir)\s*,/g
    const literalPattern =
      /join\(\s*(?:workDir|workspacePath|wsPath|workspaceDir)\s*,\s*['"]([^'"]+)['"]/g
    const offenders: string[] = []
    let writerFilesSeen = 0
    for (const file of await collectTsFiles(SRC_ROOT)) {
      const source = await readFile(file, 'utf-8')
      if (!joinPattern.test(source)) continue
      joinPattern.lastIndex = 0
      writerFilesSeen++
      const relative = file.slice(SRC_ROOT.length)
      const registers = /export function \w*WorkspacePaths\(/.test(source)
      const literalJoins = [...source.matchAll(literalPattern)]
      const joins = [...source.matchAll(joinPattern)]
      // A non-literal path (`join(workDir, skillsDir)`) is invisible to the
      // literal check below — the file has to register instead.
      if (
        joins.length > literalJoins.length &&
        !registers &&
        !UNREGISTERED_WRITER_FILES[relative]
      ) {
        offenders.push(`${relative}: writes a computed workspace path but registers none`)
      }
      for (const match of literalJoins) {
        const written = match[1]
        if (UNREGISTERED_BY_DESIGN[written]) continue
        if (!platformWorkspaceEntries().has(written.split('/')[0])) {
          offenders.push(`${relative}: unregistered literal '${written}'`)
        }
      }
    }
    expect(offenders).toEqual([])
    // Guards the scan itself: a regex that silently stops matching would make
    // every future writer pass. The four registered writers plus the waived
    // files are the floor.
    expect(writerFilesSeen).toBeGreaterThanOrEqual(8)
  })
})

describe('platformWorkspaceEntries', () => {
  it('is the top segment of every platform path', () => {
    const entries = platformWorkspaceEntries()
    for (const path of platformWorkspacePaths()) {
      expect(entries.has(path.split('/')[0])).toBe(true)
    }
    expect(entries.has('.claude')).toBe(true)
    expect(entries.has('.trae')).toBe(true)
  })

  it('never contains path separators — entries are workspace-root names', () => {
    for (const entry of platformWorkspaceEntries()) {
      expect(entry.includes('/')).toBe(false)
    }
  })
})
