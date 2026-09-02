import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ResolvedMcpServer } from '../mcp-sync.js'
import { cleanupManagedMcpConfigAsync, syncMcpToWorkspaceAtPathAsync } from '../mcp-sync.js'

const RELATIVE = '.cursor/mcp.json'
let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'mcp-sync-async-test-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function readConfig() {
  return JSON.parse(readFileSync(path.join(tmp, RELATIVE), 'utf-8'))
}

function readMarker() {
  return JSON.parse(readFileSync(path.join(tmp, `${RELATIVE}.a2wave-managed`), 'utf-8'))
}

const stdio = (
  name: string,
  command = 'node',
  extras: Partial<ResolvedMcpServer> = {},
): ResolvedMcpServer => ({
  name,
  type: 'stdio',
  command,
  args: ['x'],
  ...extras,
})

describe('syncMcpToWorkspaceAtPathAsync — kimi dialect', () => {
  const KIMI_RELATIVE = '.kimi-code/mcp.json'

  function readKimiConfig() {
    return JSON.parse(readFileSync(path.join(tmp, KIMI_RELATIVE), 'utf-8'))
  }

  it('marks sse servers with transport so kimi does not read them as http', async () => {
    await syncMcpToWorkspaceAtPathAsync(
      tmp,
      KIMI_RELATIVE,
      [{ name: 'legacy', type: 'sse', url: 'https://mcp.example.com/sse' }],
      { dialect: 'kimi' },
    )

    expect(readKimiConfig().mcpServers.legacy).toEqual({
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
    })
  })

  it('uses transport rather than type for http servers', async () => {
    await syncMcpToWorkspaceAtPathAsync(
      tmp,
      KIMI_RELATIVE,
      [{ name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp' }],
      { dialect: 'kimi' },
    )

    const entry = readKimiConfig().mcpServers.remote
    expect(entry).toEqual({ transport: 'http', url: 'https://mcp.example.com/mcp' })
    expect(entry.type).toBeUndefined()
  })

  it('leaves stdio entries in the shared shape', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, KIMI_RELATIVE, [stdio('local')], { dialect: 'kimi' })

    expect(readKimiConfig().mcpServers.local).toEqual({ command: 'node', args: ['x'] })
  })

  it('keeps the default dialect byte-identical for other providers', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [
      { name: 'remote', type: 'http', url: 'https://mcp.example.com/mcp' },
      { name: 'legacy', type: 'sse', url: 'https://mcp.example.com/sse' },
    ])

    expect(readConfig().mcpServers).toEqual({
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      legacy: { url: 'https://mcp.example.com/sse' },
    })
  })
})

describe('syncMcpToWorkspaceAtPathAsync', () => {
  // Ported from the deleted synchronous twin's suite: these two were its only
  // assertions for behaviour that still lives in the shared async writer.
  it('writes an empty mcpServers object when there are no servers', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [])

    expect(readConfig()).toEqual({ mcpServers: {} })
  })

  it('honours a custom target path such as Claude/Qoder .mcp.json', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, '.mcp.json', [
      { name: 'claude-mcp', type: 'stdio', command: 'npx', args: ['-y', '@acme/mcp'] },
    ])

    const config = JSON.parse(readFileSync(path.join(tmp, '.mcp.json'), 'utf-8'))
    expect(config).toEqual({
      mcpServers: { 'claude-mcp': { command: 'npx', args: ['-y', '@acme/mcp'] } },
    })
  })

  it('writes a fresh mcp.json with managed entries', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1'), stdio('s2', 'python')])
    const cfg = readConfig()
    expect(cfg.mcpServers.s1).toEqual({ command: 'node', args: ['x'] })
    expect(cfg.mcpServers.s2).toEqual({ command: 'python', args: ['x'] })
    expect(readMarker().managedServers).toHaveProperty('s1')
  })

  it('keeps a user-edited managed entry intact on resync (fingerprint mismatch)', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1')])
    const cfg = readConfig()
    cfg.mcpServers.s1.command = 'edited-by-user'
    writeFileSync(path.join(tmp, RELATIVE), JSON.stringify(cfg))

    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1', 'fresh')])
    const after = readConfig()
    expect(after.mcpServers.s1).toEqual({ command: 'edited-by-user', args: ['x'] })
    expect(after.mcpServers['s1--a2w']).toEqual({ command: 'fresh', args: ['x'] })
  })

  it('replaces managed entry cleanly when fingerprint matches', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1')])
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1', 'updated')])
    const after = readConfig()
    expect(Object.keys(after.mcpServers)).toEqual(['s1'])
    expect(after.mcpServers.s1).toEqual({ command: 'updated', args: ['x'] })
  })

  it('respects user-owned entry by renaming the new managed copy to --a2w', async () => {
    mkdirSync(path.join(tmp, '.cursor'), { recursive: true })
    writeFileSync(
      path.join(tmp, RELATIVE),
      JSON.stringify({ mcpServers: { s1: { command: 'user-cmd', args: [] } } }),
    )
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('s1')])
    const cfg = readConfig()
    expect(cfg.mcpServers.s1).toEqual({ command: 'user-cmd', args: [] })
    expect(cfg.mcpServers['s1--a2w']).toEqual({ command: 'node', args: ['x'] })
  })

  it('emits sse and http entries with their url/headers and drops invalid ones', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [
      { name: 'sse-srv', type: 'sse', url: 'https://x.example/sse', headers: { 'X-A': '1' } },
      { name: 'http-srv', type: 'http', url: 'https://x.example/http' },
      { name: 'no-cmd', type: 'stdio' },
      { name: 'no-url', type: 'sse' },
    ])
    const cfg = readConfig()
    expect(cfg.mcpServers['sse-srv']).toEqual({
      url: 'https://x.example/sse',
      headers: { 'X-A': '1' },
    })
    expect(cfg.mcpServers['http-srv']).toEqual({
      type: 'http',
      url: 'https://x.example/http',
    })
    expect(cfg.mcpServers).not.toHaveProperty('no-cmd')
    expect(cfg.mcpServers).not.toHaveProperty('no-url')
  })

  it('survives an existing mcp.json that is not valid JSON', async () => {
    mkdirSync(path.join(tmp, '.cursor'), { recursive: true })
    writeFileSync(path.join(tmp, RELATIVE), '{not json')
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('ok')])
    const cfg = readConfig()
    expect(cfg.mcpServers.ok).toEqual({ command: 'node', args: ['x'] })
  })

  it('includes trimmed cwd and env when present', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [
      stdio('s', 'node', { cwd: '   /work   ', env: { TOKEN: 'x' } }),
    ])
    const cfg = readConfig()
    expect(cfg.mcpServers.s).toEqual({
      command: 'node',
      args: ['x'],
      cwd: '/work',
      env: { TOKEN: 'x' },
    })
  })
})

describe('cleanupManagedMcpConfigAsync', () => {
  const configPath = () => path.join(tmp, RELATIVE)
  const markerPath = () => `${path.join(tmp, RELATIVE)}.a2wave-managed`

  it('removes a config file the platform created, secrets and marker included', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [
      {
        name: 'api',
        type: 'http',
        url: 'https://mcp.example.com',
        headers: { Authorization: 'Bearer secret-token' },
      },
    ])
    expect(readFileSync(configPath(), 'utf-8')).toContain('secret-token')

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    expect(existsSync(configPath())).toBe(false)
    expect(existsSync(markerPath())).toBe(false)
  })

  it('keeps a user-authored config file and strips only managed entries', async () => {
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(
      configPath(),
      JSON.stringify({ mcpServers: { mine: { command: 'mine' } }, other: true }),
    )

    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])
    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    expect(existsSync(configPath())).toBe(true)
    expect(readConfig()).toEqual({ mcpServers: { mine: { command: 'mine' } }, other: true })
    expect(existsSync(markerPath())).toBe(false)
  })

  it('never touches a config file that predates the run (no marker)', async () => {
    mkdirSync(path.dirname(configPath()), { recursive: true })
    writeFileSync(configPath(), JSON.stringify({ mcpServers: { mine: { command: 'mine' } } }))

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)

    expect(readConfig()).toEqual({ mcpServers: { mine: { command: 'mine' } } })
  })

  it('keeps the config alive until the last sibling run in the workspace releases it', async () => {
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])
    await syncMcpToWorkspaceAtPathAsync(tmp, RELATIVE, [stdio('managed')])

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)
    expect(existsSync(configPath())).toBe(true)

    await cleanupManagedMcpConfigAsync(tmp, RELATIVE)
    expect(existsSync(configPath())).toBe(false)
  })

  it('is a no-op when nothing was ever written', async () => {
    await expect(cleanupManagedMcpConfigAsync(tmp, RELATIVE)).resolves.toBeUndefined()
  })
})
