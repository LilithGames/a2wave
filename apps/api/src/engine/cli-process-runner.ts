import type { ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { StringDecoder } from 'node:string_decoder'
import { logger } from '../lib/logger.js'
import { type CliSpawnOptions, spawnCli } from './cli-spawn.js'
import { getExecutionAbortSignal } from './execution-lease-registry.js'
import { emitExecutionProcessLogLine } from './execution-process-log.js'
import {
  type KillWindowsProcessTree,
  killWindowsProcessTree,
  terminateCliProcess,
} from './windows-process-tree.js'

const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024
/**
 * Cap on one line of Agent CLI stdout/stderr.
 *
 * Generous on purpose: a stream-json event legitimately carries a whole tool
 * payload on a single line, and truncating real output would corrupt the
 * parse. The cap is a fuse, not a policy — without it a newline-free stream
 * grows the decoder's `remainder` unbounded, and past V8's maximum string
 * length the concat throws RangeError inside a stream 'data' handler, outside
 * the run promise, which takes the whole API process down.
 */
const MAX_AGENT_LINE_CHARS = 8 * 1024 * 1024
/** SIGTERM → SIGKILL grace for one agent CLI. Part of the fail-stop budget. */
export const FORCE_KILL_DELAY_MS = 5_000

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
  /** Complete UTF-8 input written after spawn, then stdin is closed. */
  stdin?: string
  onStdoutLine: (line: string) => void
  parseStderrLines?: boolean
  onSpawned?: () => void
  cleanup?: () => void
}

type SpawnProcess = (command: string, args: string[], options: CliSpawnOptions) => ChildProcess

type SignalProcess = (pid: number, signal: NodeJS.Signals | 0) => boolean

export interface CliProcessRunnerOptions {
  spawnProcess?: SpawnProcess
  stderrLimitBytes?: number
  now?: () => number
  ensureWorkDir?: (cwd: string) => void
  platform?: NodeJS.Platform
  signalProcess?: SignalProcess
  killWindowsProcessTree?: KillWindowsProcessTree
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
  terminationAttempt?: Promise<void>
  finalize?: (result: CliProcessRunResult) => void
  /**
   * The first output-decoding failure, which the exit handler turns into the
   * run's verdict. Recorded rather than finalized on the spot so the SIGTERM →
   * SIGKILL escalation this failure triggers stays armed; see
   * `failOnDecodeError`.
   */
  decodeError?: Error
}

interface LineDecoder {
  write(chunk: Buffer): void
  flush(): void
}

interface LineDecoderOptions {
  maxLineChars?: number
  /** Called with the character count of each dropped oversized line. */
  onOversizedLine?: (discardedChars: number) => void
}

export function createLineDecoder(
  onLine: (line: string) => void,
  options: LineDecoderOptions = {},
): LineDecoder {
  const decoder = new StringDecoder('utf8')
  const maxLineChars = Math.max(0, options.maxLineChars ?? Number.POSITIVE_INFINITY)
  let remainder = ''
  let discardingOversizedLine = false
  let discardedChars = 0

  const reportDiscard = () => {
    if (discardedChars === 0) return
    const dropped = discardedChars
    discardedChars = 0
    options.onOversizedLine?.(dropped)
  }

  const consume = (text: string) => {
    let start = 0
    while (start <= text.length) {
      const newline = text.indexOf('\n', start)
      const completeLine = newline !== -1
      const fragment = text.slice(start, completeLine ? newline : undefined)

      if (discardingOversizedLine) {
        discardedChars += fragment.length
        if (completeLine) {
          discardingOversizedLine = false
          reportDiscard()
        }
      } else if (remainder.length + fragment.length > maxLineChars) {
        discardedChars += remainder.length + fragment.length
        remainder = ''
        discardingOversizedLine = !completeLine
        if (completeLine) reportDiscard()
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
      reportDiscard()
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
  private readonly platform: NodeJS.Platform
  private readonly killWindowsProcessTree: KillWindowsProcessTree

  constructor(options: CliProcessRunnerOptions = {}) {
    const platform = options.platform ?? process.platform
    this.spawnProcess =
      options.spawnProcess ??
      ((command, args, spawnOptions) => spawnCli(command, args, spawnOptions, platform))
    this.stderrLimitBytes = Math.max(0, options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES)
    this.now = options.now ?? (() => performance.now())
    this.ensureWorkDir = options.ensureWorkDir ?? ((cwd) => mkdirSync(cwd, { recursive: true }))
    this.useProcessGroups = platform !== 'win32'
    this.signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal))
    this.platform = platform
    this.killWindowsProcessTree = options.killWindowsProcessTree ?? killWindowsProcessTree
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
        stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
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
      // One warning per process: an Agent that emits one oversized line
      // usually emits many, and a line per drop would bury the run's real log.
      let oversizedLineWarned = false
      const onOversizedLine = (discardedChars: number) => {
        if (oversizedLineWarned) return
        oversizedLineWarned = true
        logger.warn(
          { taskId: options.taskId, discardedChars, maxLineChars: MAX_AGENT_LINE_CHARS },
          `${options.label} dropped an oversized output line; later drops are not logged`,
        )
      }
      const stdoutDecoder = createLineDecoder(options.onStdoutLine, {
        maxLineChars: MAX_AGENT_LINE_CHARS,
        onOversizedLine,
      })
      const stderrDecoder = options.parseStderrLines
        ? createLineDecoder(options.onStdoutLine, {
            maxLineChars: MAX_AGENT_LINE_CHARS,
            onOversizedLine,
          })
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
          try {
            stdoutDecoder.flush()
            stderrDecoder?.flush()
            processLogDecoder.flush()
          } catch (error) {
            // The verdict is already decided here; only a trailing partial
            // line is at stake, and throwing would escape the 'close' handler.
            logger.error({ taskId: options.taskId, error }, `${options.label} output flush failed`)
          }
        }
        runCleanup(options)
        active.resolveCompletion()
        resolve(result)
      }
      active.finalize = finalize

      /**
       * Fail the run, never the process, when decoding output throws.
       *
       * The stream 'data' handlers run outside this promise's try, so an
       * exception escaping one is an uncaught exception that ends the API
       * process. 'spawn-error' is reused deliberately: it is the only reason
       * that carries the Error back to the engine, which turns it into a run
       * failure. The child is terminated first — nothing reads its output any
       * more, and an orphan would hold its worktree and concurrency slot.
       *
       * The verdict is only *recorded* here; the exit handler finalizes it.
       * Finalizing directly cleared the force-kill timer `terminate` had just
       * armed and dropped the entry from `activeProcesses`, so a child that
       * ignored SIGTERM was never escalated to SIGKILL and became invisible to
       * `shutdown()` — the exact orphan this path exists to avoid.
       */
      const failOnDecodeError = (error: unknown) => {
        // Later chunks from a broken decoder keep throwing; the first failure
        // is the cause and the rest are its echoes.
        if (active.decodeError) return
        logger.error({ taskId: options.taskId, error }, `${options.label} output decoding failed`)
        active.decodeError = error instanceof Error ? error : new Error(String(error))
        this.terminate(options.taskId, 'cancelled')
      }

      if (abortSignal) {
        active.abortListener = () => this.terminate(options.taskId, 'cancelled')
        abortSignal.addEventListener('abort', active.abortListener, { once: true })
        if (abortSignal.aborted) active.abortListener()
      }

      child.stdin?.on('error', (error) => {
        logger.debug({ taskId: options.taskId, error }, `${options.label} stdin closed early`)
      })

      child.once('spawn', () => {
        options.onSpawned?.()
        if (options.stdin !== undefined) child.stdin?.end(options.stdin)
      })

      child.stdout?.on('data', (value: Buffer | string) => {
        try {
          stdoutDecoder.write(Buffer.isBuffer(value) ? value : Buffer.from(value))
        } catch (error) {
          failOnDecodeError(error)
        }
      })

      child.stderr?.on('data', (value: Buffer | string) => {
        try {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          stderrOutput = appendBoundedTail(stderrOutput, chunk, this.stderrLimitBytes)
          processLogDecoder.write(chunk)
          logger.debug(
            { taskId: options.taskId },
            `[${options.label} STDERR] ${chunk.toString('utf8', 0, 500)}`,
          )
          stderrDecoder?.write(chunk)
        } catch (error) {
          failOnDecodeError(error)
        }
      })

      child.once('close', (exitCode, signal) => {
        const closeResult = active.decodeError
          ? result({
              reason: 'spawn-error',
              exitCode: null,
              signal: null,
              stderr: stderrOutput.toString('utf8'),
              error: active.decodeError,
            })
          : result({
              reason: active.terminationReason ?? 'completed',
              exitCode,
              signal: signal ?? null,
              stderr: stderrOutput.toString('utf8'),
            })
        if (
          active.terminationReason &&
          (active.terminationAttempt ||
            (!active.forceKillSent && this.isProcessGroupAlive(active.child)))
        ) {
          active.pendingCloseResult = closeResult
          return
        }
        finalize(closeResult)
      })

      child.once('error', (error) => {
        const errorResult = result({
          reason: active.decodeError ? 'spawn-error' : (active.terminationReason ?? 'spawn-error'),
          exitCode: null,
          signal: null,
          stderr: stderrOutput.toString('utf8'),
          error: active.decodeError ?? error,
        })
        if (active.terminationReason && active.terminationAttempt) {
          active.pendingCloseResult = errorResult
          return
        }
        finalize(errorResult)
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

    this.startTerminationAttempt(active, 'SIGTERM')
    active.forceKillTimer = setTimeout(() => {
      active.forceKillTimer = undefined
      active.forceKillSent = true
      this.startTerminationAttempt(active, 'SIGKILL')
      if (active.pendingCloseResult && !active.terminationAttempt) {
        active.finalize?.(active.pendingCloseResult)
      }
    }, FORCE_KILL_DELAY_MS)
    return true
  }

  private startTerminationAttempt(active: ActiveProcess, signal: NodeJS.Signals): void {
    const attempt = this.signalProcessTree(active.child, signal)
    if (!attempt) return
    active.terminationAttempt = attempt
    void attempt.finally(() => {
      if (active.terminationAttempt !== attempt) return
      active.terminationAttempt = undefined
      if (active.pendingCloseResult) active.finalize?.(active.pendingCloseResult)
    })
  }

  private signalProcessTree(
    child: ChildProcess,
    signal: NodeJS.Signals,
  ): Promise<void> | undefined {
    const pid = child.pid
    if (this.useProcessGroups && typeof pid === 'number' && pid > 0) {
      try {
        this.signalProcess(-pid, signal)
        return undefined
      } catch (error) {
        logger.warn(
          { pid, signal, error },
          'Failed to signal CLI process group; falling back to direct child',
        )
      }
    }
    if (this.platform === 'win32') {
      return terminateCliProcess(child, signal, this.platform, this.killWindowsProcessTree)
    }
    child.kill(signal)
    return undefined
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
