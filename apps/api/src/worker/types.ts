import type { ReferencedPromptContext } from '../engine/types.js'

/** Task payload sent to the worker/executor */
export interface WorkerTaskPayload {
  taskId: string
  prompt: string
  model?: string
  workDir?: string
  chatId?: string
  agentConfig: import('../lib/agent-helpers.js').AgentConfig
  /** Complete runtime/audit context; the engine sanitizes its {{context}} template view. */
  context?: Record<string, unknown>
  /** Quoted external material rendered separately from trusted Agent instructions. */
  referencedPromptContext?: ReferencedPromptContext
  /** Agent 级别环境变量（从 Agent.env 展开） */
  agentEnv?: Record<string, string>
}

/** Options for executeInWorker */
export interface ExecuteWorkerOptions {
  stepId?: string
  runId?: string
  onUpdate?: (content: string) => void
  onLogEntry?: (entry: import('../engine/types.js').StreamLogEntry) => void
  timeoutMs?: number
}

/** Result from executeInWorker */
export interface ExecuteWorkerResult {
  success: boolean
  output: string
  chatId?: string
  error?: string
  durationMs: number
  /** Token usage forwarded from ExecuteResult.usage. */
  usage?: import('../engine/types.js').TokenUsage
}
