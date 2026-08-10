import { randomUUID } from 'node:crypto'
import { type Message, type Part, Role, type Task, TaskState } from '@a2a-js/sdk'
import { TaskNotCancelableError } from '@a2a-js/sdk/errors'
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server'
import type { AttachmentSource } from '../lib/attachment-materializer.js'
import {
  type A2ACallerProvenance,
  A2WAVE_CALLER_PROVENANCE_EXTENSION_URI,
  extractA2ACallerProvenance,
} from './provenance.js'

export interface A2waveExecutorConfig {
  agentConfig: Record<string, unknown>
  workDir?: string
  model?: string
}

export type ExecuteFn = (
  taskId: string,
  payload: {
    taskId: string
    prompt: string
    model?: string
    workDir: string
    agentConfig: Record<string, unknown>
    context?: Record<string, unknown>
    /** A2A attachment sources; run-recording materializes them inside the Agent runtime. */
    attachments?: AttachmentSource[]
  },
  options?: {
    onUpdate?: (content: string) => void
    /** Remote caller assertion for display/audit only; never an authoritative identity. */
    provenance?: A2ACallerProvenance
  },
) => Promise<{
  success: boolean
  output: string
  chatId?: string
  error?: string
  durationMs: number
  /** Another run for the same task ID is still in progress. */
  inProgress?: boolean
}>

export type CancelFn = (taskId: string) => Promise<'cancelled' | 'not_cancellable'>

export class A2waveAgentExecutor implements AgentExecutor {
  constructor(
    private readonly config: A2waveExecutorConfig,
    private readonly executeFn: ExecuteFn,
    private readonly cancelFn?: CancelFn,
    private readonly isReusedTaskEventBus: (taskId: string) => boolean = () => false,
  ) {}

  async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const shouldJoinExistingExecution = this.isReusedTaskEventBus(ctx.taskId)
    let resolveExistingExecutionFinished: (() => void) | undefined
    const existingExecutionFinished = shouldJoinExistingExecution
      ? new Promise<void>((resolve) => {
          resolveExistingExecutionFinished = resolve
          eventBus.once('finished', resolve)
        })
      : undefined
    const parts = ctx.userMessage.parts ?? []
    const prompt = parts
      .filter((part) => part.content?.$case === 'text')
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .join('\n')
    const attachments = extractAttachments(parts)
    const provenance = extractA2ACallerProvenance(ctx.userMessage, ctx.context)
    if (provenance) {
      ctx.context.addActivatedExtension(A2WAVE_CALLER_PROVENANCE_EXTENSION_URI)
    }
    const existingHistory = ctx.task?.history ?? []
    const history = existingHistory.some(
      (message) => message.messageId === ctx.userMessage.messageId,
    )
      ? existingHistory
      : [...existingHistory, ctx.userMessage]

    const initialTask: Task = {
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      // The SDK has already appended the current message to ctx.task for a
      // follow-up turn. Republish that complete snapshot as the mandatory
      // first event so ResultManager does not replace prior history/artifacts.
      artifacts: structuredClone(ctx.task?.artifacts ?? []),
      history: structuredClone(history),
      metadata: structuredClone(ctx.task?.metadata),
    }
    eventBus.publish(AgentEvent.task(initialTask))

    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: TaskState.TASK_STATE_WORKING,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    )

    try {
      const result = await this.executeFn(
        ctx.taskId,
        {
          taskId: ctx.taskId,
          prompt,
          model: this.config.model,
          workDir: this.config.workDir ?? '',
          agentConfig: this.config.agentConfig,
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        {
          ...(provenance ? { provenance } : {}),
          onUpdate: (content: string) => {
            eventBus.publish(
              AgentEvent.statusUpdate({
                taskId: ctx.taskId,
                contextId: ctx.contextId,
                status: {
                  state: TaskState.TASK_STATE_WORKING,
                  message: createAgentMessage(ctx, content),
                  timestamp: new Date().toISOString(),
                },
                metadata: undefined,
              }),
            )
          },
        },
      )

      if (result.success) {
        eventBus.publish(
          AgentEvent.artifactUpdate({
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            artifact: {
              artifactId: randomUUID(),
              name: '',
              description: '',
              parts: [createTextPart(result.output)],
              metadata: undefined,
              extensions: [],
            },
            append: false,
            lastChunk: true,
            metadata: undefined,
          }),
        )
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            status: {
              state: TaskState.TASK_STATE_COMPLETED,
              message: undefined,
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          }),
        )
      } else if (result.inProgress) {
        eventBus.publish(
          AgentEvent.statusUpdate({
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            status: {
              state: TaskState.TASK_STATE_WORKING,
              message: createAgentMessage(ctx, result.error ?? 'Task already in progress'),
              timestamp: new Date().toISOString(),
            },
            metadata: undefined,
          }),
        )
        // A process-shared event bus means another request handler is still
        // publishing this task's terminal events. Keep this handler attached
        // until that original execution finishes; otherwise this handler's
        // finally block would close the shared bus and discard the result.
        await existingExecutionFinished
      } else {
        this.publishFailed(ctx, result.error ?? 'Execution failed', eventBus)
      }
    } catch (err) {
      this.publishFailed(ctx, err instanceof Error ? err.message : String(err), eventBus)
    } finally {
      if (resolveExistingExecutionFinished) {
        eventBus.off('finished', resolveExistingExecutionFinished)
      }
      eventBus.finished()
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    if (this.cancelFn) {
      const result = await this.cancelFn(taskId)
      if (result !== 'cancelled') {
        throw new TaskNotCancelableError(`Task cannot be canceled: ${taskId}`)
      }
    }
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: '',
        status: {
          state: TaskState.TASK_STATE_CANCELED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    )
    eventBus.finished()
  }

  private publishFailed(ctx: RequestContext, errorMsg: string, eventBus: ExecutionEventBus): void {
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        status: {
          state: TaskState.TASK_STATE_FAILED,
          message: createAgentMessage(ctx, errorMsg),
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    )
  }
}

function extractAttachments(parts: Part[]): AttachmentSource[] {
  const attachments: AttachmentSource[] = []
  for (const part of parts) {
    if (part.content?.$case === 'raw') {
      attachments.push({
        kind: 'bytes',
        bytes: Buffer.from(part.content.value).toString('base64'),
        name: part.filename || undefined,
        mimeType: part.mediaType || undefined,
      })
    }
    if (part.content?.$case === 'url') {
      attachments.push({
        kind: 'uri',
        uri: part.content.value,
        name: part.filename || undefined,
        mimeType: part.mediaType || undefined,
      })
    }
  }
  return attachments
}

function createTextPart(text: string): Part {
  return {
    content: { $case: 'text', value: text },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  }
}

function createAgentMessage(ctx: RequestContext, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId: ctx.contextId,
    taskId: ctx.taskId,
    role: Role.ROLE_AGENT,
    parts: [createTextPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  }
}
