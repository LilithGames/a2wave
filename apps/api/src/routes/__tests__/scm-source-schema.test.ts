import { createScmSourceInput, updateScmSourceInput } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'

// workspacesPath 空串/纯空白不应绕过校验：之前 `""` 能过路由层的 `if (workspacesPath)` 分支、
// 被存库为 `""`，运行时又会落到 defaultWorkspacesPath —— 校验路径和实际路径不一致。
// schema 层统一归一成 null，让 DB 值和运行值一致（都是默认路径）。
describe('scm-source input schema — workspacesPath normalization', () => {
  const baseCreate = {
    name: 'n',
    type: 'git' as const,
    localPath: '/abs/path',
    config: { type: 'git' as const, repoUrl: 'https://x', branch: 'main' },
  }

  it('create: localPath may be omitted for managed storage allocation', () => {
    const { localPath: _localPath, ...withoutPath } = baseCreate
    const parsed = createScmSourceInput.parse(withoutPath)
    expect(parsed.localPath).toBeUndefined()
  })

  it('create: empty string workspacesPath becomes null', async () => {
    const parsed = createScmSourceInput.parse({ ...baseCreate, workspacesPath: '' })
    expect(parsed.workspacesPath).toBeNull()
  })

  it('create: whitespace-only workspacesPath becomes null', async () => {
    const parsed = createScmSourceInput.parse({ ...baseCreate, workspacesPath: '   ' })
    expect(parsed.workspacesPath).toBeNull()
  })

  it('create: explicit null stays null', async () => {
    const parsed = createScmSourceInput.parse({ ...baseCreate, workspacesPath: null })
    expect(parsed.workspacesPath).toBeNull()
  })

  it('create: non-empty string passes through', async () => {
    const parsed = createScmSourceInput.parse({ ...baseCreate, workspacesPath: '/tmp/ws' })
    expect(parsed.workspacesPath).toBe('/tmp/ws')
  })

  it('update: omitted field stays undefined (preserves no-change semantics)', async () => {
    const parsed = updateScmSourceInput.parse({ name: 'n' })
    expect(parsed.workspacesPath).toBeUndefined()
  })

  it('update: empty string becomes null (treated as "clear to default")', async () => {
    const parsed = updateScmSourceInput.parse({ workspacesPath: '' })
    expect(parsed.workspacesPath).toBeNull()
  })

  it('update: explicit null stays null', async () => {
    const parsed = updateScmSourceInput.parse({ workspacesPath: null })
    expect(parsed.workspacesPath).toBeNull()
  })
})
