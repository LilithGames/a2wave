import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: { A2WAVE_MEMORY_STORAGE: '' },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { env } from '../../env.js'
import {
  checkSizeLimit,
  deleteMemoryFile,
  enforceCapacity,
  getAgentMemoryDir,
  getAllMemoryContent,
  getMemoryStats,
  getMemoryStorageRoot,
  getRecallBehaviorInstruction,
  listMemoryFiles,
  readMemoryFile,
  removeAgentMemory,
  writeMemoryFile,
} from '../memory-storage.js'

let testRoot: string

beforeEach(() => {
  testRoot = mkdtempSync(join(tmpdir(), 'memory-test-'))
  mkdirSync(testRoot, { recursive: true })
  ;(env as { A2WAVE_MEMORY_STORAGE: string }).A2WAVE_MEMORY_STORAGE = testRoot
})

afterEach(() => {
  if (existsSync(testRoot)) {
    rmSync(testRoot, { recursive: true })
  }
})

describe('getMemoryStorageRoot', () => {
  it('returns absolute path based on env', async () => {
    const root = getMemoryStorageRoot()
    expect(root).toContain('memory-test-')
  })
})

describe('getAgentMemoryDir', () => {
  it('returns agent-specific directory', async () => {
    const dir = getAgentMemoryDir('agt_123')
    expect(dir).toContain('agt_123')
  })
})

describe('writeMemoryFile', () => {
  it('writes MEMORY.md to agent directory', async () => {
    writeMemoryFile('agt_w1', 'MEMORY.md', '# Long-term memory')

    const filePath = join(testRoot, 'agt_w1', 'MEMORY.md')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('# Long-term memory')
  })

  it('writes daily file under memory/ subdirectory', async () => {
    writeMemoryFile('agt_w2', 'memory/2026-03-15.md', '## Work log')

    const filePath = join(testRoot, 'agt_w2', 'memory', '2026-03-15.md')
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, 'utf-8')).toBe('## Work log')
  })

  it('blocks path traversal in filename', async () => {
    expect(() => writeMemoryFile('agt_w3', '../../../etc/passwd', 'bad')).toThrow(
      'Invalid file path',
    )
  })

  it('blocks empty filename', async () => {
    expect(() => writeMemoryFile('agt_w4', '', 'content')).toThrow('Invalid file path')
  })
})

describe('readMemoryFile', () => {
  it('reads an existing file', async () => {
    writeMemoryFile('agt_r1', 'MEMORY.md', 'Hello')
    const content = readMemoryFile('agt_r1', 'MEMORY.md')
    expect(content).toBe('Hello')
  })

  it('throws for non-existent file', async () => {
    const agentDir = join(testRoot, 'agt_r2')
    mkdirSync(agentDir, { recursive: true })
    expect(() => readMemoryFile('agt_r2', 'missing.md')).toThrow('File not found')
  })

  it('blocks path traversal', async () => {
    expect(() => readMemoryFile('agt_r3', '../../../etc/passwd')).toThrow('Invalid file path')
  })

  it('throws when trying to read a directory', async () => {
    const agentDir = join(testRoot, 'agt_r4')
    mkdirSync(join(agentDir, 'memory'), { recursive: true })
    expect(() => readMemoryFile('agt_r4', 'memory')).toThrow('Cannot read directory as file')
  })
})

describe('deleteMemoryFile', () => {
  it('deletes an existing file', async () => {
    writeMemoryFile('agt_d1', 'MEMORY.md', 'to delete')
    deleteMemoryFile('agt_d1', 'MEMORY.md')

    const filePath = join(testRoot, 'agt_d1', 'MEMORY.md')
    expect(existsSync(filePath)).toBe(false)
  })

  it('throws for non-existent file', async () => {
    const agentDir = join(testRoot, 'agt_d2')
    mkdirSync(agentDir, { recursive: true })
    expect(() => deleteMemoryFile('agt_d2', 'missing.md')).toThrow('File not found')
  })

  it('blocks path traversal', async () => {
    expect(() => deleteMemoryFile('agt_d3', '../other/file.md')).toThrow('Invalid file path')
  })
})

describe('listMemoryFiles', () => {
  it('returns empty array for non-existent agent', async () => {
    expect(listMemoryFiles('agt_noexist')).toEqual([])
  })

  it('lists top-level and memory/ files sorted', async () => {
    writeMemoryFile('agt_l1', 'MEMORY.md', 'long-term')
    writeMemoryFile('agt_l1', 'memory/2026-03-15.md', 'day1')
    writeMemoryFile('agt_l1', 'memory/2026-03-16.md', 'day2')

    const files = listMemoryFiles('agt_l1')
    expect(files).toHaveLength(3)
    expect(files.map((f) => f.name)).toEqual([
      'MEMORY.md',
      'memory/2026-03-15.md',
      'memory/2026-03-16.md',
    ])
    expect(files[0].size).toBeGreaterThan(0)
    expect(files[0].mtime).toBeGreaterThan(0)
  })
})

describe('getAllMemoryContent', () => {
  it('reads all files content', async () => {
    writeMemoryFile('agt_all', 'MEMORY.md', 'main')
    writeMemoryFile('agt_all', 'memory/2026-03-15.md', 'daily')

    const contents = getAllMemoryContent('agt_all')
    expect(contents).toHaveLength(2)
    expect(contents[0].content).toBe('main')
    expect(contents[1].content).toBe('daily')
  })

  it('returns empty for non-existent agent', async () => {
    expect(getAllMemoryContent('agt_ghost')).toEqual([])
  })
})

describe('getMemoryStats', () => {
  it('returns correct stats', async () => {
    writeMemoryFile('agt_s1', 'MEMORY.md', 'main content')
    writeMemoryFile('agt_s1', 'memory/2026-03-15.md', 'day1')
    writeMemoryFile('agt_s1', 'memory/2026-03-16.md', 'day2')

    const stats = getMemoryStats('agt_s1')
    expect(stats.fileCount).toBe(3)
    expect(stats.dailyFileCount).toBe(2)
    expect(stats.totalSize).toBeGreaterThan(0)
    expect(stats.oldestFile).toBeTruthy()
    expect(stats.newestFile).toBeTruthy()
  })

  it('returns zeroed stats for non-existent agent', async () => {
    const stats = getMemoryStats('agt_noexist')
    expect(stats.fileCount).toBe(0)
    expect(stats.totalSize).toBe(0)
    expect(stats.dailyFileCount).toBe(0)
    expect(stats.oldestFile).toBeNull()
    expect(stats.newestFile).toBeNull()
  })
})

describe('enforceCapacity', () => {
  it('does nothing when under limit', async () => {
    writeMemoryFile('agt_cap1', 'memory/2026-03-15.md', 'day1')
    writeMemoryFile('agt_cap1', 'memory/2026-03-16.md', 'day2')

    const deleted = enforceCapacity('agt_cap1', 5)
    expect(deleted).toBe(0)
    expect(listMemoryFiles('agt_cap1')).toHaveLength(2)
  })

  it('deletes oldest daily files when over limit', async () => {
    for (let i = 1; i <= 5; i++) {
      writeMemoryFile('agt_cap2', `memory/2026-03-${String(i).padStart(2, '0')}.md`, `day${i}`)
    }

    const deleted = enforceCapacity('agt_cap2', 3)
    expect(deleted).toBe(2)

    const remaining = listMemoryFiles('agt_cap2')
    expect(remaining).toHaveLength(3)
  })

  it('does not delete weekly summary files', async () => {
    for (let i = 1; i <= 5; i++) {
      writeMemoryFile('agt_cap_w', `memory/2026-03-${String(i).padStart(2, '0')}.md`, `day${i}`)
    }
    writeMemoryFile('agt_cap_w', 'memory/weekly/2026-W10.md', 'weekly summary')

    const deleted = enforceCapacity('agt_cap_w', 3)
    expect(deleted).toBe(2)

    // Weekly summary should still exist
    expect(readMemoryFile('agt_cap_w', 'memory/weekly/2026-W10.md')).toBe('weekly summary')
    // Only 3 daily files remain
    const files = listMemoryFiles('agt_cap_w')
    const dailyFiles = files.filter((f) => /^memory\/\d{4}-\d{2}-\d{2}\.md$/.test(f.name))
    expect(dailyFiles).toHaveLength(3)
  })

  it('does not delete MEMORY.md', async () => {
    writeMemoryFile('agt_cap3', 'MEMORY.md', 'long-term')
    for (let i = 1; i <= 3; i++) {
      writeMemoryFile('agt_cap3', `memory/2026-03-${String(i).padStart(2, '0')}.md`, `day${i}`)
    }

    enforceCapacity('agt_cap3', 2)

    // MEMORY.md should still exist
    expect(readMemoryFile('agt_cap3', 'MEMORY.md')).toBe('long-term')
    // Only 2 daily files should remain
    const files = listMemoryFiles('agt_cap3')
    const dailyFiles = files.filter((f) => f.name.startsWith('memory/'))
    expect(dailyFiles).toHaveLength(2)
  })
})

describe('removeAgentMemory', () => {
  it('removes entire agent directory', async () => {
    writeMemoryFile('agt_rm1', 'MEMORY.md', 'content')
    writeMemoryFile('agt_rm1', 'memory/2026-03-15.md', 'daily')

    removeAgentMemory('agt_rm1')
    expect(existsSync(join(testRoot, 'agt_rm1'))).toBe(false)
  })

  it('does nothing for non-existent agent', async () => {
    expect(() => removeAgentMemory('agt_ghost')).not.toThrow()
  })
})

describe('checkSizeLimit', () => {
  it('returns true when under limit', async () => {
    writeMemoryFile('agt_sz1', 'MEMORY.md', 'small')
    expect(checkSizeLimit('agt_sz1', 100)).toBe(true)
  })

  it('returns false when would exceed 10MB', async () => {
    writeMemoryFile('agt_sz2', 'MEMORY.md', 'small')
    expect(checkSizeLimit('agt_sz2', 10 * 1024 * 1024 + 1)).toBe(false)
  })
})

describe('getRecallBehaviorInstruction', () => {
  it('instructs explicit memory requests to use a2wave-memory write script', async () => {
    const instruction = getRecallBehaviorInstruction(
      'medium',
      '.cursor/skills/a2wave-memory/scripts/memory-search.mjs',
      true,
    )

    expect(instruction).toContain('a2wave-memory skill')
    expect(instruction).toContain('<memory-search-command>')
    expect(instruction).toContain('<memory-topics-command>')
    expect(instruction).toContain('<memory-read-topic-command>')
    expect(instruction).toContain('<memory-write-command>')
    expect(instruction).toContain('`node .cursor/skills/a2wave-memory/scripts/memory-search.mjs`')
    expect(instruction).toContain('`node .cursor/skills/a2wave-memory/scripts/memory-write.mjs`')
    expect(instruction).toContain('memory-write.mjs')
    expect(instruction).toContain('--remember')
    expect(instruction).toContain('--replace <topic-id>')
    expect(instruction).toContain('不要批量读取所有主题')
    expect(instruction).toContain('覆盖 Cursor / Claude Code / Codex')
    expect(instruction).toContain('仅描述“长期”“稳定”“固定”')
    expect(instruction).toContain('交给 Run 结束后的自动洞察提取')
    expect(instruction).toContain('若写入失败')
  })

  it('derives write command from the search script directory for non-standard search filenames', async () => {
    const instruction = getRecallBehaviorInstruction(
      'medium',
      '.codex/skills/a2wave-memory/scripts/memory-query.mjs',
      true,
    )

    expect(instruction).toContain('`node .codex/skills/a2wave-memory/scripts/memory-query.mjs`')
    expect(instruction).toContain('`node .codex/skills/a2wave-memory/scripts/memory-write.mjs`')
  })

  it('routes common recall and explicit additions through one memory command each', async () => {
    const instruction = getRecallBehaviorInstruction(
      'medium',
      '.codex/skills/a2wave-memory/scripts/memory-search.mjs',
      true,
    )

    expect(instruction).toContain(
      '`<memory-recall-command>` = `node .codex/skills/a2wave-memory/scripts/memory-search.mjs --recall <query>`',
    )
    expect(instruction).toContain('优先只运行一次 `<memory-recall-command>`')
    expect(instruction).toContain('新增明确记忆直接运行一次')
    expect(instruction).toContain('不要先列出或读取主题')
    expect(instruction).toContain('成功响应即为服务器确认，不要再次读取主题核验')
    expect(instruction).toContain('只根据已保存主题')
    expect(instruction).toContain('无匹配后立即停止')
    expect(instruction).toContain('不得搜索历史')
  })
})
