import { getEmbeddings, isEmbeddingAvailable } from './embedding-service.js'
import { logger } from './logger.js'
import { reindexAgentFts, reindexAgentVectors } from './memory-index.js'
import { callMemoryProvider, type MemoryProviderConfig } from './memory-provider.js'
/**
 * 日志合并整理
 * 将旧的每日日志合并为周摘要，防止无限增长并提高搜索相关性
 */
import {
  deleteMemoryFile,
  listMemoryFiles,
  readMemoryFile,
  writeMemoryFile,
} from './memory-storage.js'

const DEFAULT_MAX_AGE_DAYS = 30
const DAILY_PATTERN = /^memory\/(\d{4}-\d{2}-\d{2})\.md$/

/** Per-agent consolidation lock — prevents concurrent runs on the same agent */
const consolidationQueues = new Map<string, Promise<{ consolidatedCount: number } | null>>()

/** Exported for testing */
export function clearConsolidationQueues(): void {
  consolidationQueues.clear()
}

function getISOWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

export function consolidateMemory(
  agentId: string,
  provider: MemoryProviderConfig,
  options?: { maxAgeDays?: number },
): Promise<{ consolidatedCount: number } | null> {
  const prev = consolidationQueues.get(agentId) ?? Promise.resolve(null)
  const next = prev
    .then(() => doConsolidateMemory(agentId, provider, options))
    .catch((err) => {
      logger.error({ agentId, err }, 'Consolidation failed')
      return null
    })
    .finally(() => {
      if (consolidationQueues.get(agentId) === next) {
        consolidationQueues.delete(agentId)
      }
    })
  consolidationQueues.set(agentId, next)
  return next
}

async function doConsolidateMemory(
  agentId: string,
  provider: MemoryProviderConfig,
  options?: { maxAgeDays?: number },
): Promise<{ consolidatedCount: number } | null> {
  const maxAgeDays = options?.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

  const files = listMemoryFiles(agentId)
  const oldDailyFiles = files
    .filter((f) => {
      const match = f.name.match(DAILY_PATTERN)
      if (!match) return false
      const fileDate = new Date(match[1])
      return fileDate.getTime() < cutoff
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  if (oldDailyFiles.length < 7) return null

  const weekGroups = new Map<string, string[]>()
  for (const f of oldDailyFiles) {
    const dateStr = f.name.match(DAILY_PATTERN)?.[1]
    if (!dateStr) continue
    const week = getISOWeek(new Date(dateStr))
    const group = weekGroups.get(week) ?? []
    group.push(f.name)
    weekGroups.set(week, group)
  }

  let consolidatedCount = 0

  for (const [week, filenames] of weekGroups) {
    if (filenames.length < 2) continue

    const contents: string[] = []
    for (const name of filenames) {
      try {
        const content = readMemoryFile(agentId, name)
        contents.push(`--- ${name} ---\n${content}`)
      } catch (err) {
        logger.warn({ agentId, week, filename: name, err }, 'Skipping unreadable daily memory file')
      }
    }

    if (contents.length === 0) continue

    let summary: string
    try {
      const result = await callMemoryProvider(
        provider,
        `You are a concise work log consolidator. Merge the following daily work logs into a single weekly summary.
Keep the most important information: key decisions, outcomes, patterns, and issues.
Remove redundant details and merge similar entries.
Output a markdown document starting with "# Week ${week}".
Write in the same language as the source content.
Keep it under 50 lines.`,
        contents.join('\n\n'),
        2048,
      )
      if (!result) {
        logger.warn({ agentId, week }, 'Consolidation provider call failed or returned empty')
        continue
      }
      summary = result
    } catch (err) {
      logger.warn({ agentId, week, err }, 'Consolidation provider error')
      continue
    }

    writeMemoryFile(agentId, `memory/weekly/${week}.md`, summary)

    for (const name of filenames) {
      try {
        deleteMemoryFile(agentId, name)
      } catch (err) {
        logger.warn(
          { agentId, week, filename: name, err },
          'Failed to delete consolidated daily memory file',
        )
      }
    }

    consolidatedCount += filenames.length
    logger.info({ agentId, week, fileCount: filenames.length }, 'Consolidated weekly memory')
  }

  if ((await consolidatedCount) > 0) {
    reindexAgentFts(agentId)
    if (await isEmbeddingAvailable(agentId)) {
      void reindexAgentVectors(agentId, (texts) => getEmbeddings(texts, agentId))
    }
  }

  return { consolidatedCount }
}
