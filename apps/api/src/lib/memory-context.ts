/**
 * 主动记忆上下文注入
 * Run 启动时根据 memoryContextMode 决定注入内容：
 *   off    → 不注入（返回 null）
 *   memory → 全量注入 MEMORY.md（长期记忆：用户偏好、领域约定、历史决策）
 * 工作日志不在此注入，由 agent 按需通过 a2wave-memory skill 主动搜索。
 * 回想策略行为指令由 buildRecallInstruction 单独返回，注入 <recall_strategy> 标签。
 */
import { agentTokenAllows } from './agent-memory-token.js'
import { logger } from './logger.js'
import { getRecallBehaviorInstruction, type MemoryRecallLevel } from './memory-storage.js'
import { getValidatedMemoryMain } from './memory-topics.js'

/** Check if a config value is explicitly set to false (handles string "false" from frontend) */
function isConfigDisabled(value: unknown): boolean {
  return value === false || value === 'false'
}

const VALID_RECALL_LEVELS = new Set<string>(['weak', 'medium', 'strong'])
const VALID_CONTEXT_MODES = new Set<string>(['off', 'memory'])
const MEMORY_MD = 'MEMORY.md'

const SKILL_SLUG = 'a2wave-memory'
const SEARCH_SCRIPT = 'scripts/memory-search.mjs'

/**
 * Whether this Run may actually write memory.
 *
 * The runtime issues a least-privilege token from the user's own words, but that
 * decision used to stay inside the runtime. The Agent therefore acted on the
 * assumption that it could write, attempted a write, was refused, and — per the
 * write policy — reported the refusal to the user, leaking memory bookkeeping
 * into the user-facing reply.
 *
 * The token is the single source of truth here; deriving from it rather than
 * from a parallel flag keeps the injected instruction from drifting out of sync
 * with the permission that is actually enforced. With no token in play, keep the
 * historical wording instead of restricting callers that never went through
 * withScopedMemoryToken.
 */
function resolveWriteAllowed(agentConfig: Record<string, unknown>): boolean {
  const agentEnv = agentConfig.agentEnv as Record<string, string> | undefined
  const token = agentEnv?.A2WAVE_MEMORY_TOKEN
  if (!token) return true
  return agentTokenAllows(token, 'explicit:write')
}

/** 根据 agentConfig 返回当前档位的回想策略指令文本，供独立注入 <recall_strategy> 标签 */
export function buildRecallInstruction(agentConfig: Record<string, unknown>): string {
  const raw = agentConfig.memoryRecallLevel as string
  const recallLevel: MemoryRecallLevel = VALID_RECALL_LEVELS.has(raw)
    ? (raw as MemoryRecallLevel)
    : 'medium'
  const skillsDir = agentConfig.skillsDir as string | undefined
  const scriptPath = skillsDir ? `${skillsDir}/${SKILL_SLUG}/${SEARCH_SCRIPT}` : undefined

  const rawMode = agentConfig.memoryContextMode as string
  const legacyDisabled =
    !VALID_CONTEXT_MODES.has(rawMode) &&
    rawMode !== 'full' &&
    isConfigDisabled(agentConfig.memoryContextInjection)
  const memoryInjected = rawMode !== 'off' && !legacyDisabled

  return getRecallBehaviorInstruction(
    recallLevel,
    scriptPath,
    memoryInjected,
    resolveWriteAllowed(agentConfig),
  )
}

type MemoryContextMode = 'off' | 'memory'

export async function buildMemoryContext(
  agentId: string,
  agentConfig: Record<string, unknown>,
): Promise<string | null> {
  const rawMode = agentConfig.memoryContextMode as string
  // 'full' 已废弃，视同 'memory'；backward compat: 尊重旧 memoryContextInjection=false
  const legacyDisabled =
    !VALID_CONTEXT_MODES.has(rawMode) &&
    rawMode !== 'full' &&
    isConfigDisabled(agentConfig.memoryContextInjection)
  const contextMode: MemoryContextMode =
    rawMode === 'off' ? 'off' : legacyDisabled ? 'off' : 'memory'

  if (contextMode === 'off') return null

  let memoryMdContent: string | null = null
  try {
    memoryMdContent = getValidatedMemoryMain(agentId)
  } catch (err) {
    if (err instanceof Error && err.message === 'File not found') {
      // 文件不存在，跳过
    } else {
      logger.warn({ agentId, err }, 'Failed to read MEMORY.md for context injection')
    }
  }

  if (!memoryMdContent) return null

  return [
    '以下是本次会话注入的长期记忆（MEMORY.md），包含用户偏好、领域约定和历史决策，作为固定背景知识使用。',
    '如需搜索历史工作日志或按用户明确指示维护长期记忆，请主动调用 a2wave-memory skill。',
    '',
    `--- ${MEMORY_MD} ---`,
    memoryMdContent,
  ].join('\n')
}
