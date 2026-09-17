/**
 * Memory 文件存储服务
 * 负责 Agent 记忆文件的磁盘存储、CRUD、容量管控
 *
 * 目录结构：
 * data/memories/<agentId>/
 * ├── MEMORY.md              # 长期记忆
 * └── memory/
 *     ├── 2026-03-15.md      # 每日日志
 *     └── 2026-03-16.md
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { env } from '../env.js'
import { logger } from './logger.js'

const MAX_TOTAL_SIZE_BYTES = 10 * 1024 * 1024 // 10MB per agent

/** Shared marker for CLAUDE.md memory override injection/removal */
export const MEMORY_OVERRIDE_MARKER = '<!-- a2wave-memory-override -->'

/**
 * Per-agent write lock — serializes all MEMORY.md / daily-log writes from
 * both worklog-generator and the skill API route, preventing TOCTOU races.
 */
const agentWriteQueues = new Map<string, Promise<void>>()

export interface MemoryWriteQueueMeta {
  operation?: string
  filename?: string
  runId?: string
}

export function queueAgentWrite(
  agentId: string,
  fn: () => void | Promise<void>,
  meta: MemoryWriteQueueMeta = {},
): Promise<void> {
  const prev = agentWriteQueues.get(agentId) ?? Promise.resolve()
  const next = prev
    .catch(() => {
      // Previous write failures are reported to their callers, but must not poison
      // the per-agent queue and block later memory writes forever.
    })
    .then(() => fn())
    .catch((err) => {
      logger.error({ agentId, ...meta, err }, 'Memory write queue operation failed')
      throw err
    })
    .finally(() => {
      if (agentWriteQueues.get(agentId) === next) agentWriteQueues.delete(agentId)
    })
  agentWriteQueues.set(agentId, next)
  return next
}

/** Exported for testing */
export function clearAgentWriteQueues(): void {
  agentWriteQueues.clear()
}
const DEFAULT_MAX_DAILY_FILES = 200

/** 获取 memories 存储根目录的绝对路径 */
export function getMemoryStorageRoot(): string {
  return resolve(process.cwd(), env.A2WAVE_MEMORY_STORAGE)
}

/** 获取指定 Agent 的记忆目录绝对路径 */
export function getAgentMemoryDir(agentId: string): string {
  return join(getMemoryStorageRoot(), agentId)
}

/** 确保目录存在 */
function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

/** 校验文件路径安全（防止路径遍历） */
function validatePath(baseDir: string, filename: string): string {
  const normalized = filename.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\//, '')
  if (!normalized || normalized.includes('..')) {
    throw new Error('Invalid file path')
  }

  const targetPath = join(baseDir, normalized)
  const resolvedBase = resolve(baseDir)
  const resolvedTarget = resolve(targetPath)

  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(resolvedBase + sep)) {
    throw new Error('Path traversal not allowed')
  }

  return resolvedTarget
}

export interface MemoryFileInfo {
  name: string
  size: number
  mtime: number
}

/** 列出 Agent 记忆文件（递归遍历所有子目录） */
export function listMemoryFiles(agentId: string): MemoryFileInfo[] {
  const agentDir = getAgentMemoryDir(agentId)
  if (!existsSync(agentDir)) {
    return []
  }

  const results: MemoryFileInfo[] = []

  function scanDir(dir: string, prefix: string): void {
    for (const name of readdirSync(dir)) {
      const fullPath = join(dir, name)
      const stat = statSync(fullPath)
      const relativeName = prefix ? `${prefix}/${name}` : name
      if (stat.isFile()) {
        results.push({ name: relativeName, size: stat.size, mtime: stat.mtimeMs })
      } else if (stat.isDirectory()) {
        scanDir(fullPath, relativeName)
      }
    }
  }

  scanDir(agentDir, '')

  return results.sort((a, b) => a.name.localeCompare(b.name))
}

/** 读取记忆文件内容 */
export function readMemoryFile(agentId: string, filename: string): string {
  const agentDir = getAgentMemoryDir(agentId)
  const resolvedPath = validatePath(agentDir, filename)

  if (!existsSync(resolvedPath)) {
    throw new Error('File not found')
  }

  const stat = statSync(resolvedPath)
  if (stat.isDirectory()) {
    throw new Error('Cannot read directory as file')
  }

  return readFileSync(resolvedPath, 'utf-8')
}

/** 写入记忆文件 */
export function writeMemoryFile(agentId: string, filename: string, content: string): void {
  const agentDir = getAgentMemoryDir(agentId)
  const resolvedPath = validatePath(agentDir, filename)

  const parentDir = resolve(resolvedPath, '..')
  ensureDir(parentDir)

  writeFileSync(resolvedPath, content, 'utf-8')
  logger.info({ agentId, filename }, 'Wrote memory file')
}

/** 删除记忆文件 */
export function deleteMemoryFile(agentId: string, filename: string): void {
  const agentDir = getAgentMemoryDir(agentId)
  const resolvedPath = validatePath(agentDir, filename)

  if (!existsSync(resolvedPath)) {
    throw new Error('File not found')
  }

  rmSync(resolvedPath)
  logger.info({ agentId, filename }, 'Deleted memory file')
}

export interface MemoryFileContent {
  filename: string
  content: string
  mtime: number
}

/** 读取全部记忆文件内容（供索引用） */
export function getAllMemoryContent(agentId: string): MemoryFileContent[] {
  const files = listMemoryFiles(agentId)
  const results: MemoryFileContent[] = []

  for (const file of files) {
    try {
      const content = readMemoryFile(agentId, file.name)
      results.push({ filename: file.name, content, mtime: file.mtime })
    } catch (err) {
      logger.warn(
        { agentId, filename: file.name, err },
        'Skipped unreadable memory file during indexing',
      )
    }
  }

  return results
}

export interface MemoryStats {
  fileCount: number
  totalSize: number
  dailyFileCount: number
  oldestFile: string | null
  newestFile: string | null
}

/** 统计 Agent 记忆状态 */
export function getMemoryStats(agentId: string): MemoryStats {
  const files = listMemoryFiles(agentId)

  const dailyFiles = files.filter((f) => DAILY_FILE_PATTERN.test(f.name))

  const totalSize = files.reduce((sum, f) => sum + f.size, 0)

  const sortedByTime = [...files].sort((a, b) => a.mtime - b.mtime)

  return {
    fileCount: files.length,
    totalSize,
    dailyFileCount: dailyFiles.length,
    oldestFile: sortedByTime[0]?.name ?? null,
    newestFile: sortedByTime[sortedByTime.length - 1]?.name ?? null,
  }
}

const DAILY_FILE_PATTERN = /^memory\/\d{4}-\d{2}-\d{2}\.md$/

/** 容量管控：当 memory/ 下 daily 文件数超限时，按日期从旧到新删除多余文件 */
export function enforceCapacity(agentId: string, maxFiles = DEFAULT_MAX_DAILY_FILES): number {
  const files = listMemoryFiles(agentId)
  const dailyFiles = files
    .filter((f) => DAILY_FILE_PATTERN.test(f.name))
    .sort((a, b) => a.name.localeCompare(b.name))

  if (dailyFiles.length <= maxFiles) {
    return 0
  }

  const toDelete = dailyFiles.slice(0, dailyFiles.length - maxFiles)
  for (const file of toDelete) {
    try {
      deleteMemoryFile(agentId, file.name)
    } catch (err) {
      logger.warn({ agentId, filename: file.name, err }, 'Failed to delete old daily memory file')
    }
  }

  logger.info({ agentId, deleted: toDelete.length }, 'Enforced memory capacity')
  return toDelete.length
}

/** 删除 Agent 的全部记忆目录 */
export function removeAgentMemory(agentId: string): void {
  const agentDir = getAgentMemoryDir(agentId)
  if (existsSync(agentDir)) {
    rmSync(agentDir, { recursive: true })
    logger.info({ agentId }, 'Removed agent memory directory')
  }
}

// --- Recall level behavioral instructions ---

export type MemoryRecallLevel = 'weak' | 'medium' | 'strong'

const DEFAULT_SEARCH_SCRIPT = 'scripts/memory-search.mjs'
const DEFAULT_WRITE_SCRIPT = 'scripts/memory-write.mjs'

function deriveWriteScriptPath(scriptPath: string): string {
  if (scriptPath.endsWith('memory-search.mjs')) {
    return scriptPath.replace(/memory-search\.mjs$/, 'memory-write.mjs')
  }

  const scriptDir = dirname(scriptPath)
  return scriptDir === '.' ? DEFAULT_WRITE_SCRIPT : join(scriptDir, 'memory-write.mjs')
}

function buildRecallText(
  recallLevel: MemoryRecallLevel,
  scriptPath: string,
  memoryInjected: boolean,
  writeAllowed: boolean,
): string {
  const cmd = `node ${scriptPath}`
  const recallCmd = `${cmd} --recall`
  const topicsCmd = `${cmd} --topics`
  const readTopicCmd = `${cmd} --topic`
  const writeScriptPath = deriveWriteScriptPath(scriptPath)
  const writeCmd = `node ${writeScriptPath}`

  const memoryMdDesc = memoryInjected
    ? '**MEMORY.md** — 紧凑启动摘要与主题目录（已通过系统提示词注入，无需额外读取）'
    : '**MEMORY.md** — 紧凑启动摘要与主题目录（未注入系统提示词，可通过搜索命令查阅）'

  const dataSources = `你有一个跨会话的平台记忆系统，按渐进式披露分为三层：
1. ${memoryMdDesc}
2. **主题记忆** — 有边界的长期知识文件。优先运行一次 \`${recallCmd} "<查询>"\`，由服务器只选择并返回最相关的一个活跃主题；只有无匹配或存在具体交叉依赖时才列目录或读取其他主题
3. **历史记录** — 每日/每周工作日志。仅在主题不匹配、信息不完整或需要时间线证据时，运行 \`${cmd} "<关键词>"\` 搜索

不要批量读取所有主题。通常先读最相关的一个主题；只有出现具体依赖时才读取第二个或第三个主题。`

  const commandMap = `## 本次实际命令

- \`<memory-search-command>\` = \`${cmd}\`
- \`<memory-recall-command>\` = \`${recallCmd} <query>\`
- \`<memory-topics-command>\` = \`${topicsCmd}\`
- \`<memory-read-topic-command>\` = \`${readTopicCmd} <topic-id>\`${
    writeAllowed ? `\n- \`<memory-write-command>\` = \`${writeCmd}\`` : ''
  }`

  const noWritePolicy = `## 本次写入权限

本次 Run 未授予记忆写入权限：用户没有提出明确的记忆写入请求，运行时据此只签发了只读凭据。不要尝试调用任何记忆写入命令，调用必然被服务器拒绝。

任务过程中获得的长期事实交给 Run 结束后的自动洞察提取处理，不需要你在本次对话里写入。这是按设计生效的权限约束，不是故障：不要在回复中提及记忆写入的授权状态或失败原因。

不要写 AGENTS.md、CLAUDE.md、.cursorrules 或任何底层 CLI 原生 memory 文件。`

  const authorizedWritePolicy = `## 显式记忆指令

a2wave 平台记忆覆盖 Cursor / Claude Code / Codex 等底层 CLI 的原生 memory 行为。
当用户明确要求"记住"、"以后都按"、"remember this"、"save to memory"、"忘记"或"更新记忆"时，必须使用 a2wave-memory skill：

“明确要求”必须是让记忆系统执行新增、更新或遗忘的祈使请求。仅描述“长期”“稳定”“固定”的事实，不等于授权本次对话直接写入；“只需确认理解”“不要保存”等措辞也不得触发直接写入。未拒绝持久化的普通稳定陈述可交给 Run 结束后的自动洞察提取按长期性门槛处理；用户明确要求本次不要长期保存时，后台工作日志和洞察也必须跳过。

1. 新增明确记忆直接运行一次 \`${writeCmd} --remember\`，通过标准输入传入结构化 JSON；不要先列出或读取主题。若注入目录中有明确匹配，可带 \`topicId\`，否则由服务器选择主题并去重。
2. 写入命令的成功响应即为服务器确认，不要再次读取主题核验。
3. 只有更新或忘记已有内容时，才列出并读取最接近的主题，然后将修改后的完整正文传给 \`${writeCmd} --replace <topic-id>\`。
4. 只有服务器报告 \`legacy_single_file\` 时，才使用兼容流程：读取 MEMORY.md、合并修改后用 \`${writeCmd} MEMORY.md\` 完整写回。
5. MEMORY.md 的目录与披露指引由服务器重建，不得直接改写。

不要写 AGENTS.md、CLAUDE.md、.cursorrules 或任何底层 CLI 原生 memory 文件。仅明确记忆措辞触发写入；普通偏好表达、任务过程和临时想法不主动写入。运行时会按原始用户请求签发最小权限。仅当用户本次明确要求写入记忆、而写入失败或被拒绝时，不要重试或声称已保存，并明确告知用户记忆没有保存成功；用户没有明确要求写入时，写入被拒属于按设计生效的权限约束，静默跳过即可，不要在回复中提及记忆写入的授权状态或失败原因。`

  const writePolicy = writeAllowed ? authorizedWritePolicy : noWritePolicy

  const progressiveRecall = `先利用已注入的 MEMORY.md 摘要与目录形成精确查询，优先只运行一次 \`<memory-recall-command>\`。服务器只披露最相关的一个活跃主题；返回无匹配时，或第一个主题揭示具体交叉依赖时，才运行 \`${topicsCmd}\` 或 \`${readTopicCmd} <topic-id>\`。主题无匹配、内容不足或需要原始时间线证据时，才运行 \`${cmd} "<关键词>"\` 搜索历史记录。当用户把回答限定为“只根据已保存主题”，并要求“不要猜测”或“没有就说没有”时，无匹配后立即停止并如实回答；不得搜索历史、列出其他主题或读取其他主题，除非用户另行明确要求历史证据。`

  switch (recallLevel) {
    case 'weak':
      return `## 回想策略：按需搜索

${dataSources}

${commandMap}

${writePolicy}

仅在用户**明确要求**时（如"回忆一下"、"查一下之前"、"remember"）启动渐进回想。${progressiveRecall}其余场景直接执行任务。`
    case 'strong':
      return `## 回想策略：主动发现

${dataSources}

${commandMap}

${writePolicy}

在每个任务开始时执行渐进回想。${progressiveRecall}`
    default:
      return `## 回想策略：经验驱动

${dataSources}

${commandMap}

${writePolicy}

在以下场景中，必须执行渐进回想：

- 问题排查、故障定位（可能有过往排查经验或已知问题）
- 数据查询、报表分析（可能有常用查询模式或表结构记录）
- 架构/设计决策（避免推翻已达成的共识）
- 用户提及"之前"、"上次"、"我们讨论过"、"回忆"
- 重构、技术选型、约定变更

${progressiveRecall}

以下场景无需回想，直接执行：明确的单行修复、纯粹的信息查询、用户给出了完整具体的指令。`
  }
}

export function getRecallBehaviorInstruction(
  recallLevel: MemoryRecallLevel = 'medium',
  scriptPath: string = DEFAULT_SEARCH_SCRIPT,
  memoryInjected = true,
  writeAllowed = true,
): string {
  return buildRecallText(recallLevel, scriptPath, memoryInjected, writeAllowed)
}

// --- CLAUDE.md legacy override removal ---

/** Remove legacy memory override section from a workspace config file (CLAUDE.md / AGENTS.md) */
export function removeMemoryOverride(claudeMdPath: string): void {
  if (!existsSync(claudeMdPath)) return
  const content = readFileSync(claudeMdPath, 'utf-8')
  if (!content.includes(MEMORY_OVERRIDE_MARKER)) return

  const escaped = MEMORY_OVERRIDE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`${escaped}[\\s\\S]*?${escaped}\\n*`)
  const cleaned = content.replace(regex, '').replace(/^\n+/, '')
  writeFileSync(claudeMdPath, cleaned, 'utf-8')
}

/** 检查写入是否会超过总大小限制（覆写已有文件时扣除旧文件大小） */
export function checkSizeLimit(
  agentId: string,
  newContentSize: number,
  filename?: string,
): boolean {
  const files = listMemoryFiles(agentId)
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  let existingSize = 0
  if (filename) {
    const existing = files.find((f) => f.name === filename)
    if (existing) existingSize = existing.size
  }
  return totalSize - existingSize + newContentSize <= MAX_TOTAL_SIZE_BYTES
}
