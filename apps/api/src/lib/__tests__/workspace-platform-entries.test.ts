import { describe, expect, it } from 'vitest'
import { platformWorkspaceEntries } from '../workspace-platform-entries.js'

describe('platformWorkspaceEntries', () => {
  it('derives every provider skills dir and MCP config path plus platform statics', () => {
    const entries = platformWorkspaceEntries()
    // Statics
    expect(entries.has('.codegraph')).toBe(true)
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

  it('never contains path separators — entries are workspace-root names', () => {
    for (const entry of platformWorkspaceEntries()) {
      expect(entry.includes('/')).toBe(false)
    }
  })
})
