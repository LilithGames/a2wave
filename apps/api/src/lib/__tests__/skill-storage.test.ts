import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Mock env before importing skill-storage
vi.mock('../../env.js', () => ({
  env: { A2WAVE_SKILLS_STORAGE: '' },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { env } from '../../env.js'
import {
  findSkillRoot,
  getSkillStoragePath,
  listSkillFiles,
  MAX_SKILL_TOTAL_UPLOAD_BYTES,
  makeTempSkillId,
  parseSkillMd,
  readAllSkillFiles,
  readSkillFile,
  removeSkillStorage,
  replaceSkillFilesWithRollback,
  replaceSkillFolder,
  validateSingleFileSize,
  writeSkillFile,
  writeSkillFolder,
  writeSkillMd,
} from '../skill-storage.js'

let testRoot: string

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'skill-test-'))
  mkdirSync(testRoot, { recursive: true })
  ;(env as any).A2WAVE_SKILLS_STORAGE = testRoot
})

afterEach(() => {
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true })
  }
})

describe('parseSkillMd', () => {
  it('extracts name and description from frontmatter', async () => {
    const content = `---
name: Code Review
description: Reviews code for quality
---
## Instructions
Review the code carefully.`

    const result = parseSkillMd(content)
    expect(result.name).toBe('Code Review')
    expect(result.description).toBe('Reviews code for quality')
    expect(result.body).toContain('Review the code carefully')
  })

  it('defaults name to Untitled Skill when missing', async () => {
    const content = `---
description: Some skill
---
Body content`

    const result = parseSkillMd(content)
    expect(result.name).toBe('Untitled Skill')
  })

  it('returns null description when not provided', async () => {
    const content = `---
name: My Skill
---
Body`

    const result = parseSkillMd(content)
    expect(result.description).toBeNull()
  })

  it('handles content without frontmatter', async () => {
    const content = 'Just a body with no frontmatter'
    const result = parseSkillMd(content)
    expect(result.name).toBe('Untitled Skill')
    expect(result.description).toBeNull()
    expect(result.body).toBe('Just a body with no frontmatter')
  })

  it('trims whitespace from name and description', async () => {
    const content = `---
name: "  Spaced Name  "
description: "  Spaced Desc  "
---
Body`
    const result = parseSkillMd(content)
    expect(result.name).toBe('Spaced Name')
    expect(result.description).toBe('Spaced Desc')
  })

  it('returns null for empty description string', async () => {
    const content = `---
name: Test
description: ""
---
Body`
    const result = parseSkillMd(content)
    expect(result.description).toBeNull()
  })
})

describe('validateSingleFileSize', () => {
  it('does not throw for valid file sizes', async () => {
    expect(() => validateSingleFileSize(1024)).not.toThrow()
    expect(() => validateSingleFileSize(0)).not.toThrow()
  })

  it('throws for files exceeding 10MB', async () => {
    const overLimit = 10 * 1024 * 1024 + 1
    expect(() => validateSingleFileSize(overLimit)).toThrow('10MB')
  })

  it('does not throw at exactly 10MB', async () => {
    const exactLimit = 10 * 1024 * 1024
    expect(() => validateSingleFileSize(exactLimit)).not.toThrow()
  })
})

describe('readSkillFile', () => {
  it('reads a file from skill storage', async () => {
    const skillId = 'skl_read1'
    const skillDir = join(testRoot, skillId)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), 'Hello World')

    const buf = readSkillFile(skillId, 'SKILL.md')
    expect(buf.toString('utf-8')).toBe('Hello World')
  })

  it('blocks path traversal attempts', async () => {
    const skillId = 'skl_traverse'
    const skillDir = join(testRoot, skillId)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'safe.txt'), 'safe')

    expect(() => readSkillFile(skillId, '../../../etc/passwd')).toThrow(
      'Path traversal not allowed',
    )
  })

  it('throws for non-existent file', async () => {
    const skillId = 'skl_nofile'
    const skillDir = join(testRoot, skillId)
    mkdirSync(skillDir, { recursive: true })

    expect(() => readSkillFile(skillId, 'missing.txt')).toThrow('File not found')
  })

  it('throws when trying to read a directory', async () => {
    const skillId = 'skl_dir'
    const skillDir = join(testRoot, skillId)
    const subDir = join(skillDir, 'subdir')
    mkdirSync(subDir, { recursive: true })

    expect(() => readSkillFile(skillId, 'subdir')).toThrow('Cannot read directory as file')
  })
})

describe('writeSkillMd', () => {
  it('creates directory and writes SKILL.md', async () => {
    const skillId = 'skl_write1'
    writeSkillMd(skillId, '# Test Skill')

    const filePath = join(testRoot, skillId, 'SKILL.md')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('# Test Skill')
  })
})

describe('listSkillFiles', () => {
  it('returns empty array for non-existent skill', async () => {
    expect(listSkillFiles('skl_nonexistent')).toEqual([])
  })

  it('lists files and directories sorted correctly', async () => {
    const skillId = 'skl_list1'
    const dir = join(testRoot, skillId)
    mkdirSync(join(dir, 'subdir'), { recursive: true })
    writeFileSync(join(dir, 'b.txt'), 'b')
    writeFileSync(join(dir, 'a.txt'), 'a')
    writeFileSync(join(dir, 'subdir', 'c.txt'), 'c')

    const result = listSkillFiles(skillId)
    // Directories come first, then files alphabetically
    expect(result[0].name).toBe('subdir')
    expect(result[0].type).toBe('directory')
    expect(result[1].name).toBe('a.txt')
    expect(result[2].name).toBe('b.txt')
  })
})

describe('removeSkillStorage', () => {
  it('removes skill directory', async () => {
    const skillId = 'skl_remove1'
    const dir = join(testRoot, skillId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'file.txt'), 'data')

    removeSkillStorage(skillId)
    expect(existsSync(dir)).toBe(false)
  })

  it('does nothing if directory does not exist', async () => {
    expect(() => removeSkillStorage('skl_ghost')).not.toThrow()
  })
})

describe('remote Skill storage swap', () => {
  it('reads files deterministically and restores the old package on rollback', async () => {
    const skillId = 'skl_remote_swap'
    writeSkillFile(skillId, 'SKILL.md', Buffer.from('old'))
    writeSkillFile(skillId, 'references/old.md', Buffer.from('old ref'))

    expect(readAllSkillFiles(skillId).map((file) => file.path)).toEqual([
      'references/old.md',
      'SKILL.md',
    ])

    const swap = replaceSkillFilesWithRollback(skillId, [
      { path: 'SKILL.md', content: Buffer.from('new') },
      { path: 'scripts/run.sh', content: Buffer.from('run') },
    ])
    expect(readSkillFile(skillId, 'SKILL.md').toString()).toBe('new')

    swap.rollback()
    expect(readSkillFile(skillId, 'SKILL.md').toString()).toBe('old')
    expect(readSkillFile(skillId, 'references/old.md').toString()).toBe('old ref')
  })

  it('commits the replacement and removes rollback storage', async () => {
    const skillId = 'skl_remote_commit'
    writeSkillFile(skillId, 'SKILL.md', Buffer.from('old'))
    const swap = replaceSkillFilesWithRollback(skillId, [
      { path: 'SKILL.md', content: Buffer.from('new') },
    ])

    swap.commit()

    expect(readSkillFile(skillId, 'SKILL.md').toString()).toBe('new')
    expect(readdirSync(testRoot).filter((name) => name.includes('_backup_tmp_'))).toEqual([])
  })
})

describe('findSkillRoot', () => {
  it('returns null when no SKILL.md is present', async () => {
    expect(findSkillRoot(['a/b.md', 'a/c.md'])).toBeNull()
    expect(findSkillRoot([])).toBeNull()
  })

  it('returns empty prefix when SKILL.md is at root', async () => {
    const r = findSkillRoot(['SKILL.md', 'references/foo.md'])
    expect(r).toEqual({ prefix: '', skillMdIndex: 0 })
  })

  it('returns the directory of SKILL.md when nested under one folder', async () => {
    const r = findSkillRoot([
      'my-skill/SKILL.md',
      'my-skill/references/foo.md',
      'my-skill/scripts/bar.py',
    ])
    expect(r).toEqual({ prefix: 'my-skill', skillMdIndex: 0 })
  })

  it('prefers the shallowest SKILL.md when multiple exist', async () => {
    const r = findSkillRoot(['pkg/sub/nested/SKILL.md', 'pkg/SKILL.md', 'pkg/references/foo.md'])
    expect(r).toEqual({ prefix: 'pkg', skillMdIndex: 1 })
  })

  it('handles deeply nested SKILL.md', async () => {
    const r = findSkillRoot(['a/b/c/SKILL.md', 'a/b/c/d/file.md'])
    expect(r).toEqual({ prefix: 'a/b/c', skillMdIndex: 0 })
  })
})

describe('writeSkillFolder', () => {
  // 内存版 UploadedFolderFile，避免依赖浏览器 File
  function mkFile(content: string): { arrayBuffer(): Promise<ArrayBuffer>; name: string } {
    const buf = Buffer.from(content, 'utf-8')
    return {
      name: 'in-memory',
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    }
  }

  it('writes SKILL.md + sibling tree, stripping the picked-folder prefix', async () => {
    const skillId = 'skl_folder'
    const result = await writeSkillFolder(
      skillId,
      [mkFile('---\nname: Folder Skill\ndescription: d\n---\nbody'), mkFile('ref'), mkFile('py')],
      ['my-skill/SKILL.md', 'my-skill/references/foo.md', 'my-skill/scripts/bar.py'],
    )

    expect(result).toEqual({ name: 'Folder Skill', description: 'd', body: 'body' })
    const dir = getSkillStoragePath(skillId)
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('Folder Skill')
    expect(readFileSync(join(dir, 'references/foo.md'), 'utf-8')).toBe('ref')
    expect(readFileSync(join(dir, 'scripts/bar.py'), 'utf-8')).toBe('py')
  })

  it('ignores files that fall outside the SKILL.md sibling tree', async () => {
    const skillId = 'skl_outside'
    await writeSkillFolder(
      skillId,
      [mkFile('---\nname: S\n---'), mkFile('stray')],
      ['pkg/SKILL.md', 'other/stray.txt'],
    )
    const dir = getSkillStoragePath(skillId)
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(dir, '../other/stray.txt'))).toBe(false)
  })

  it('throws and rolls back when no SKILL.md is present', async () => {
    const skillId = 'skl_nomd'
    await expect(writeSkillFolder(skillId, [mkFile('x')], ['my-skill/foo.md'])).rejects.toThrow(
      /SKILL\.md/,
    )
    expect(existsSync(getSkillStoragePath(skillId))).toBe(false)
  })

  it('throws when files and paths counts mismatch', async () => {
    await expect(
      writeSkillFolder('skl_mismatch', [mkFile('x')], ['a/SKILL.md', 'a/b.txt']),
    ).rejects.toThrow(/different lengths/)
  })

  it('rolls back the partial directory when aggregate size exceeds the cap', async () => {
    const skillId = 'skl_toobig'
    const big = 'x'.repeat(MAX_SKILL_TOTAL_UPLOAD_BYTES) // SKILL.md 之外再加这个就超限
    await expect(
      writeSkillFolder(
        skillId,
        [mkFile('---\nname: S\n---'), mkFile(big)],
        ['pkg/SKILL.md', 'pkg/huge.bin'],
      ),
    ).rejects.toThrow(/Total folder upload size/)
    // 校验失败回滚整目录，不残留半成品
    expect(existsSync(getSkillStoragePath(skillId))).toBe(false)
  })
})

describe('makeTempSkillId', () => {
  it('keeps the skillId prefix and is unique across calls (no Date.now collision)', async () => {
    const a = makeTempSkillId('skl_x')
    const b = makeTempSkillId('skl_x')
    expect(a.startsWith('skl_x_tmp_')).toBe(true)
    expect(b.startsWith('skl_x_tmp_')).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe('replaceSkillFolder (temp-swap)', () => {
  function mkFile(content: string): { arrayBuffer(): Promise<ArrayBuffer>; name: string } {
    const buf = Buffer.from(content, 'utf-8')
    return {
      name: 'in-memory',
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    }
  }

  function seedOldSkill(skillId: string): void {
    const dir = getSkillStoragePath(skillId)
    mkdirSync(join(dir, 'old-sub'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: Old\n---\nold body')
    writeFileSync(join(dir, 'old-sub', 'legacy.txt'), 'legacy')
  }

  it('replaces existing content on success and leaves no temp dir behind', async () => {
    const skillId = 'skl_swap_ok'
    seedOldSkill(skillId)

    const result = await replaceSkillFolder(
      skillId,
      [mkFile('---\nname: New\ndescription: nd\n---\nnew body'), mkFile('r')],
      ['pkg/SKILL.md', 'pkg/references/r.md'],
    )

    expect(result).toEqual({ name: 'New', description: 'nd', body: 'new body' })
    const dir = getSkillStoragePath(skillId)
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('New')
    expect(readFileSync(join(dir, 'references/r.md'), 'utf-8')).toBe('r')
    // 旧文件被新内容完整替换
    expect(existsSync(join(dir, 'old-sub/legacy.txt'))).toBe(false)
    // 临时目录已被 rename 消费，无残留
    const leftovers = readdirSync(testRoot).filter((n) => n.startsWith(`${skillId}_tmp_`))
    expect(leftovers).toEqual([])
  })

  it('preserves the old skill intact when validation fails (no SKILL.md) — no data loss', async () => {
    const skillId = 'skl_swap_nomd'
    seedOldSkill(skillId)

    await expect(replaceSkillFolder(skillId, [mkFile('x')], ['pkg/foo.md'])).rejects.toThrow(
      /SKILL\.md/,
    )

    // 旧内容必须原封不动
    const dir = getSkillStoragePath(skillId)
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('Old')
    expect(readFileSync(join(dir, 'old-sub/legacy.txt'), 'utf-8')).toBe('legacy')
  })

  it('preserves the old skill when files/paths counts mismatch', async () => {
    const skillId = 'skl_swap_mismatch'
    seedOldSkill(skillId)

    await expect(
      replaceSkillFolder(skillId, [mkFile('x')], ['a/SKILL.md', 'a/b.txt']),
    ).rejects.toThrow(/different lengths/)

    expect(readFileSync(join(getSkillStoragePath(skillId), 'SKILL.md'), 'utf-8')).toContain('Old')
  })

  it('uses a unique temp dir per call so concurrent reuploads do not collide', async () => {
    const skillId = 'skl_swap_concurrent'
    seedOldSkill(skillId)

    // 两个并发 reupload 同一 skill —— 随机后缀保证各写独立临时目录，互不串扰
    const [a, b] = await Promise.all([
      await replaceSkillFolder(skillId, [mkFile('---\nname: A\n---\nbodyA')], ['pkg/SKILL.md']),
      await replaceSkillFolder(skillId, [mkFile('---\nname: B\n---\nbodyB')], ['pkg/SKILL.md']),
    ])

    // 两个请求都成功（无 ENOTEMPTY / 误删对方临时内容）
    expect([a.name, b.name].sort()).toEqual(['A', 'B'])
    // 最终目录是某个赢家的完整内容，且是合法 SKILL.md
    const finalMd = readFileSync(join(getSkillStoragePath(skillId), 'SKILL.md'), 'utf-8')
    expect(finalMd).toMatch(/name: [AB]/)
    // 无临时目录残留
    const leftovers = readdirSync(testRoot).filter((n) => n.startsWith(`${skillId}_tmp_`))
    expect(leftovers).toEqual([])
  })
})
