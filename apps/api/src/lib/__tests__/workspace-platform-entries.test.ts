import { describe, expect, it } from 'vitest'
import { kbSyncWorkspaceEntries } from '../../engine/kb-sync.js'
import { mcpSyncWorkspaceEntries } from '../../engine/mcp-sync.js'
import { skillSyncWorkspaceEntries } from '../../engine/skill-sync.js'
import { codegraphWorkspaceEntries } from '../codegraph-index.js'
import { platformWorkspaceEntries } from '../workspace-platform-entries.js'

describe('platformWorkspaceEntries', () => {
  it('derives every provider skills dir and MCP config path plus platform statics', () => {
    const entries = platformWorkspaceEntries()
    // Writers that own a fixed root entry
    expect(entries.has('.codegraph')).toBe(true)
    expect(entries.has('.kb')).toBe(true)
    // Root-level MCP config + its managed carrier
    expect(entries.has('.mcp.json')).toBe(true)
    expect(entries.has('.mcp.json.a2wave-managed')).toBe(true)
    // Skills dirs from PRESET_PROVIDERS (top segment)
    for (const dir of [
      '.claude',
      '.cursor',
      '.codex',
      '.opencode',
      '.qoder',
      '.kimi-code',
      '.pi',
      '.traecli',
    ]) {
      expect(entries.has(dir)).toBe(true)
    }
    // MCP dirs from the provider catalog
    expect(entries.has('.trae')).toBe(true)
  })

  it('covers every writer that touches the workspace root', () => {
    // Guards the registration model: each writer contributes its own entries,
    // so this asserts the aggregate is non-empty for all four of them rather
    // than re-listing names a writer could change.
    const entries = platformWorkspaceEntries()
    for (const writer of [
      skillSyncWorkspaceEntries,
      mcpSyncWorkspaceEntries,
      kbSyncWorkspaceEntries,
      codegraphWorkspaceEntries,
    ]) {
      const own = writer()
      expect(own.length).toBeGreaterThan(0)
      for (const entry of own) expect(entries.has(entry)).toBe(true)
    }
  })

  it('never contains path separators — entries are workspace-root names', () => {
    for (const entry of platformWorkspaceEntries()) {
      expect(entry.includes('/')).toBe(false)
    }
  })
})
