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
    const pattern =
      /join\(\s*(?:workDir|workspacePath|wsPath|workspaceDir|cwd)\s*,\s*['"]([^'"]+)['"]/g
    const unregistered: string[] = []
    for (const file of await collectTsFiles(SRC_ROOT)) {
      const source = await readFile(file, 'utf-8')
      for (const match of source.matchAll(pattern)) {
        const written = match[1]
        if (UNREGISTERED_BY_DESIGN[written]) continue
        if (!platformWorkspaceEntries().has(written.split('/')[0])) {
          unregistered.push(`${file.slice(SRC_ROOT.length)}: ${written}`)
        }
      }
    }
    expect(unregistered).toEqual([])
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
