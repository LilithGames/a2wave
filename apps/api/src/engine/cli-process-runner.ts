import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { logger } from '../lib/logger.js'
import { getExecutionAbortSignal } from './execution-lease-registry.js'
import { emitExecutionProcessLogLine } from './execution-process-log.js'

const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024
const FORCE_KILL_DELAY_MS = 5_000

export type CliProcessExitReason = 'completed' | 'timeout' | 'cancelled' | 'spawn-error'

export interface CliProcessRunResult {
  reason: CliProcessExitReason
  exitCode: number | null
  signal: NodeJS.Signals | null
  stderr: string
  durationMs: number
  error?: Error
}

export interface CliProcessRunOptions {
  taskId: string
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  timeoutMs: number
  label: string
  onStdoutLine: (line: string) => void
  parseStderrLines?: boolean
  onSpawned?: () => void
  cleanup?: () => void
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess

type SignalProcess = (pid: number, signal: NodeJS.Signals | 0) => boolean

export interface CliProcessRunnerOptions {
  spawnProcess?: SpawnProcess
  stderrLimitBytes?: number
  now?: () => number
  ensureWorkDir?: (cwd: string) => void
  platform?: NodeJS.Platform
  signalProcess?: SignalProcess
}

interface ActiveProcess {
  child: ChildProcess
  completion: Promise<void>
  resolveCompletion: () => void
  terminationReason?: Extract<CliProcessExitReason, 'timeout' | 'cancelled'>
  forceKillTimer?: ReturnType<typeof setTimeout>
  forceKillSent?: boolean
  abortSignal?: AbortSignal
  abortListener?: () => void
  pendingCloseResult?: CliProcessRunResult
  finalize?: (result: CliProcessRunResult) => void
}

interface LineDecoder {
  write(chunk: Buffer): void
  flush(): void
}

interface LineDecoderOptions {
  maxLineChars?: number
}

export function createLineDecoder(
  onLine: (line: string) => void,
  options: LineDecoderOptions = {},
): LineDecoder {
  const decoder = new StringDecoder('utf8')
  const maxLineChars = Math.max(0, options.maxLineChars ?? Number.POSITIVE_INFINITY)
  let remainder = ''
  let discardingOversizedLine = false

  const consume = (text: string) => {
    let start = 0
    while (start <= text.length) {
      const newline = text.indexOf('\n', start)
      const completeLine = newline !== -1
      const fragment = text.slice(start, completeLine ? newline : undefined)

      if (discardingOversizedLine) {
        if (completeLine) discardingOversizedLine = false
      } else if (remainder.length + fragment.length > maxLineChars) {
        remainder = ''
        discardingOversizedLine = !completeLine
      } else if (completeLine) {
        onLine(`${remainder}${fragment}`)
        remainder = ''
      } else {
        remainder += fragment
      }

      if (!completeLine) break
      start = newline + 1
    }
  }

  return {
    write(chunk) {
      consume(decoder.write(chunk))
    },
    flush() {
      consume(decoder.end())
      if (!discardingOversizedLine && remainder.trim()) onLine(remainder)
      remainder = ''
      discardingOversizedLine = false
    },
  }
}

function appendBoundedTail(current: Buffer, chunk: Buffer, limitBytes: number): Buffer {
  if (limitBytes === 0) return Buffer.alloc(0)
  const combined = Buffer.concat([current, chunk])
  return combined.length <= limitBytes ? combined : combined.subarray(combined.length - limitBytes)
}

function runCleanup(options: CliProcessRunOptions): void {
  try {
    options.cleanup?.()
  } catch (error) {
    logger.warn(
      { taskId: options.taskId, error },
      `${options.label} process cleanup callback failed`,
    )
  }
}

/**
 * Owns the lifecycle of every Agent CLI child process in the API process.
 * A single global task map makes cancellation independent of the Provider
 * selected by a fallback attempt.
 */
export class CliProcessRunner {
  private readonly activeProcesses = new Map<string, ActiveProcess>()
  private readonly spawnProcess: SpawnProcess
  private readonly stderrLimitBytes: number
  private readonly now: () => number
  private readonly ensureWorkDir: (cwd: string) => void
  private readonly useProcessGroups: boolean
  private readonly signalProcess: SignalProcess

  constructor(options: CliProcessRunnerOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn
    this.stderrLimitBytes = Math.max(0, options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES)
    this.now = options.now ?? (() => performance.now())
    this.ensureWorkDir = options.ensureWorkDir ?? ((cwd) => mkdirSync(cwd, { recursive: true }))
    this.useProcessGroups = (options.platform ?? process.platform) !== 'win32'
    this.signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal))
  }

  get activeCount(): number {
    return this.activeProcesses.size
  }

  run(options: CliProcessRunOptions): Promise<CliProcessRunResult> {
    const startedAt = this.now()
    const result = (fields: Omit<CliProcessRunResult, 'durationMs'>): CliProcessRunResult => ({
      ...fields,
      durationMs: Math.max(0, this.now() - startedAt),
    })

    if (this.activeProcesses.has(options.taskId)) {
      runCleanup(options)
      return Promise.resolve(
        result({
          reason: 'spawn-error',
          exitCode: null,
          signal: null,
          stderr: '',
          error: new Error(`Task "${options.taskId}" is already running`),
        }),
      )
    }

    const abortSignal = getExecutionAbortSignal(options.taskId)
    if (abortSignal?.aborted) {
      runCleanup(options)
      return Promise.resolve(
        result({
          reason: 'cancelled',
          exitCode: null,
          signal: null,
          stderr: '',
        }),
      )
    }

    let child: ChildProcess
    try {
      this.ensureWorkDir(options.cwd)
      child = this.spawnProcess(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: this.useProcessGroups,
      })
    } catch (error) {
      runCleanup(options)
      return Promise.resolve(
        result({
          reason: 'spawn-error',
          exitCode: null,
          signal: null,
          stderr: '',
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      )
    }

    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve
    })
    const active: ActiveProcess = { child, completion, resolveCompletion, abortSignal }
    this.activeProcesses.set(options.taskId, active)

    return new Promise((resolve) => {
      let finalized = false
      let stderrOutput: Buffer = Buffer.alloc(0)
      const stdoutDecoder = createLineDecoder(options.onStdoutLine)
      const stderrDecoder = options.parseStderrLines
        ? createLineDecoder(options.onStdoutLine)
        : undefined
      const processLogDecoder = createLineDecoder(
        (line) => emitExecutionProcessLogLine(options.taskId, line),
        { maxLineChars: 4 * 1024 },
      )

      const timeout = setTimeout(() => {
        logger.warn({ taskId: options.taskId }, `${options.label} stream execution timed out`)
        this.terminate(options.taskId, 'timeout')
      }, options.timeoutMs)

      const finalize = (result: CliProcessRunResult) => {
        if (finalized) return
        finalized = true
        clearTimeout(timeout)
        if (active.forceKillTimer) clearTimeout(active.forceKillTimer)
        if (active.abortSignal && active.abortListener) {
          active.abortSignal.removeEventListener('abort', active.abortListener)
        }
        if (this.activeProcesses.get(options.taskId) === active) {
          this.activeProcesses.delete(options.taskId)
        }
        if (result.reason !== 'spawn-error') {
          stdoutDecoder.flush()
          stderrDecoder?.flush()
          processLogDecoder.flush()
        }
        runCleanup(options)
        active.resolveCompletion()
        resolve(result)
      }
      active.finalize = finalize

      if (abortSignal) {
        active.abortListener = () => this.terminate(options.taskId, 'cancelled')
        abortSignal.addEventListener('abort', active.abortListener, { once: true })
        if (abortSignal.aborted) active.abortListener()
      }

      child.once('spawn', () => options.onSpawned?.())

      child.stdout?.on('data', (value: Buffer | string) => {
        stdoutDecoder.write(Buffer.isBuffer(value) ? value : Buffer.from(value))
      })

      child.stderr?.on('data', (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        stderrOutput = appendBoundedTail(stderrOutput, chunk, this.stderrLimitBytes)
        processLogDecoder.write(chunk)
        logger.debug(
          { taskId: options.taskId },
          `[${options.label} STDERR] ${chunk.toString('utf8', 0, 500)}`,
        )
        stderrDecoder?.write(chunk)
      })

      child.once('close', (exitCode, signal) => {
        const closeResult = result({
          reason: active.terminationReason ?? 'completed',
          exitCode,
          signal: signal ?? null,
          stderr: stderrOutput.toString('utf8'),
        })
        if (
          active.terminationReason &&
          !active.forceKillSent &&
          this.isProcessGroupAlive(active.child)
        ) {
          active.pendingCloseResult = closeResult
          return
        }
        finalize(closeResult)
      })

      child.once('error', (error) => {
        finalize(
          result({
            reason: active.terminationReason ?? 'spawn-error',
            exitCode: null,
            signal: null,
            stderr: stderrOutput.toString('utf8'),
            error,
          }),
        )
      })
    })
  }

  cancel(taskId: string): boolean {
    return this.terminate(taskId, 'cancelled')
  }

  async cancelAndWait(taskId: string): Promise<boolean> {
    const active = this.activeProcesses.get(taskId)
    if (!active) return false
    this.terminate(taskId, 'cancelled')
    await active.completion
    return true
  }

  async shutdown(): Promise<void> {
    const taskIds = [...this.activeProcesses.keys()]
    await Promise.all(taskIds.map((taskId) => this.cancelAndWait(taskId)))
  }

  private terminate(
    taskId: string,
    reason: Extract<CliProcessExitReason, 'timeout' | 'cancelled'>,
  ): boolean {
    const active = this.activeProcesses.get(taskId)
    if (!active) return false
    active.terminationReason ??= reason
    if (active.forceKillTimer || active.forceKillSent) return true

    this.signalProcessTree(active.child, 'SIGTERM')
    active.forceKillTimer = setTimeout(() => {
      active.forceKillTimer = undefined
      active.forceKillSent = true
      this.signalProcessTree(active.child, 'SIGKILL')
      if (active.pendingCloseResult) active.finalize?.(active.pendingCloseResult)
    }, FORCE_KILL_DELAY_MS)
    return true
  }

  private signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
    const pid = child.pid
    if (this.useProcessGroups && typeof pid === 'number' && pid > 0) {
      try {
        this.signalProcess(-pid, signal)
        return
      } catch (error) {
        logger.warn(
          { pid, signal, error },
          'Failed to signal CLI process group; falling back to direct child',
        )
      }
    }
    child.kill(signal)
  }

  private isProcessGroupAlive(child: ChildProcess): boolean {
    const pid = child.pid
    if (!this.useProcessGroups || typeof pid !== 'number' || pid <= 0) return false
    try {
      this.signalProcess(-pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }
}

export const cliProcessRunner = new CliProcessRunner()
