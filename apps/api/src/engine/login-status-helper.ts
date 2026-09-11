/**
 * 共享：本机登录态检测辅助函数。
 *
 * 为 `AgentEngine.checkLoginStatus` 的实现提供：
 * - 带超时的子进程包装（SIGTERM → SIGKILL 升级）
 * - ANSI/CSI 转义序列 / 光标回退码剥离
 * - stdout / stderr / exitCode 的统一聚合
 */

import { StringDecoder } from 'node:string_decoder'
import { logger } from '../lib/logger.js'
import { isCliProcessGroupAlive, signalCliProcessTree } from './cli-process-tree.js'
import { spawnCli } from './cli-spawn.js'
import { buildSafeAgentProcessEnv } from './runtime-context.js'

const PROBE_OUTPUT_LIMIT_BYTES = 1024 * 1024
const PROBE_FORCE_KILL_DELAY_MS = 2_000

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence stripping requires \x1B/\x07 control chars
const ANSI_PATTERN = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07]*\x07|[PX^_][^\x1B]*\x1B\\|.)/g

/** 剥离 ANSI 转义 / 回车 / 终端光标控制字符。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '').replace(/\r/g, '')
}

export interface StatusProbeResult {
  /** CLI 正常解析到的退出码（未超时且 ENOENT 未触发） */
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** true 表示 CLI 可执行文件不在 PATH / 无法 spawn */
  notFound: boolean
}

export interface StatusProbeOptions {
  /** 超时，默认 15s（cursor-agent status 的网络检测约 6-8s） */
  timeoutMs?: number
  /** 日志标签：`'codex'` / `'cursor'` / `'claude-code'`，便于日志 grep */
  logTag?: string
  /**
   * Extra variables merged over the safe Agent subprocess allowlist.
   * 用于 listAvailableModels 等需要注入临时凭证 env（如 CURSOR_API_KEY）的场景。
   */
  env?: NodeJS.ProcessEnv
  /**
   * Complete environment: passed to spawn verbatim, NOT merged over
   * `process.env` — which is the only way a probe can *remove* an inherited
   * variable. Use it when the probe must share one env constructor with
   * execution: Kimi, for example, clears the `KIMI_MODEL_*` env-provider family
   * at execution time, so a probe inheriting them would report a model (and a
   * login state) that no real run can use. Takes precedence over `env`.
   */
  completeEnv?: NodeJS.ProcessEnv
}

/**
 * 启动 CLI、收集输出、等待退出，永远 resolve —— 调用方根据 `notFound` /
 * `timedOut` / `exitCode` / `stdout` 自行判定登录态。
 */
export function runStatusProbe(
  command: string,
  args: string[],
  options: StatusProbeOptions = {},
): Promise<StatusProbeResult> {
  const timeoutMs = options.timeoutMs ?? 15_000
  const tag = options.logTag ?? command
  const platform = process.platform
  return new Promise((resolve) => {
    logger.info({ tag, cmd: command, args, timeoutMs }, '[login-status] probing')
    let child: ReturnType<typeof spawnCli>
    try {
      child = spawnCli(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        env: options.completeEnv ?? { ...buildSafeAgentProcessEnv(), ...options.env },
      })
    } catch (err) {
      // Windows can throw synchronously when a bare command resolves to a .cmd
      // shim (EPERM). Version discovery is best-effort: one unusable CLI must
      // not reject Promise.all() and turn the complete Provider CLI list into a
      // 500 response.
      const error = err as NodeJS.ErrnoException
      const notFound = true
      logger.warn(
        {
          tag,
          cmd: command,
          notFound,
          err: error.message,
          stderrSample: truncateForRaw(error.message, 300),
        },
        '[login-status] probe failed to spawn',
      )
      resolve({
        exitCode: null,
        stdout: '',
        stderr: error.message,
        timedOut: false,
        notFound,
      })
      return
    }

    const output = {
      stdout: { text: '', bytes: 0, decoder: new StringDecoder('utf8') },
      stderr: { text: '', bytes: 0, decoder: new StringDecoder('utf8') },
    }
    let settled = false
    let timedOut = false
    let closed = false
    let terminating = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let terminationAttempt: Promise<void> | undefined

    const clearCompletedTermination = () => {
      if (!closed || terminationAttempt || !forceKillTimer) return
      if (isCliProcessGroupAlive(child, { platform })) return
      clearTimeout(forceKillTimer)
      forceKillTimer = undefined
    }

    const signal = (signalName: NodeJS.Signals) => {
      try {
        const attempt = signalCliProcessTree(child, signalName, { platform })
        if (!attempt) return
        terminationAttempt = attempt
        void attempt
          .catch((error) => {
            logger.warn({ tag, error }, '[login-status] probe tree termination failed')
          })
          .finally(() => {
            if (terminationAttempt !== attempt) return
            terminationAttempt = undefined
            clearCompletedTermination()
          })
      } catch (error) {
        logger.warn({ tag, error }, '[login-status] probe termination failed')
      }
    }

    const terminate = () => {
      if (terminating) return
      terminating = true
      // Keep this timer independent of result settlement and the leader's exit.
      // A surviving descendant still owns the group after its parent is gone.
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined
        signal('SIGKILL')
      }, PROBE_FORCE_KILL_DELAY_MS)
      signal('SIGTERM')
      clearCompletedTermination()
    }

    const readOutput = (stream: keyof typeof output) =>
      stripAnsi(output[stream].text + output[stream].decoder.end())

    const settle = (result: StatusProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.removeListener('data', onStdout)
      child.stderr?.removeListener('data', onStderr)
      // Drain without retaining late output while the process tree is stopping.
      child.stdout?.resume()
      child.stderr?.resume()
      output.stdout.text = ''
      output.stderr.text = ''
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      settle({
        exitCode: null,
        stdout: readOutput('stdout'),
        stderr: readOutput('stderr'),
        timedOut: true,
        notFound: false,
      })
      terminate()
    }, timeoutMs)

    const collect = (stream: keyof typeof output, chunk: Buffer) => {
      if (settled) return
      const target = output[stream]
      if (target.bytes + chunk.length > PROBE_OUTPUT_LIMIT_BYTES) {
        const error = `${stream} exceeded the ${PROBE_OUTPUT_LIMIT_BYTES} byte probe output limit`
        logger.warn({ tag, stream }, '[login-status] probe output limit exceeded')
        // Discard incomplete output: a valid prefix must never be parsed as a
        // successful login/model result after the probe has exceeded its budget.
        settle({ exitCode: null, stdout: '', stderr: error, timedOut: false, notFound: false })
        terminate()
        return
      }
      target.bytes += chunk.length
      target.text += target.decoder.write(chunk)
    }
    const onStdout = (chunk: Buffer) => collect('stdout', chunk)
    const onStderr = (chunk: Buffer) => collect('stderr', chunk)
    child.stdout?.on('data', onStdout)
    child.stderr?.on('data', onStderr)

    child.on('error', (err) => {
      if (settled) return
      const isNotFound = true
      const cleanStdout = readOutput('stdout')
      const cleanStderr = readOutput('stderr') || err.message
      logger.warn(
        {
          tag,
          cmd: command,
          notFound: isNotFound,
          err: err.message,
          stderrSample: truncateForRaw(cleanStderr, 300),
        },
        '[login-status] probe errored',
      )
      settle({
        exitCode: null,
        stdout: cleanStdout,
        stderr: cleanStderr,
        timedOut: false,
        notFound: isNotFound,
      })
    })

    child.on('close', (code) => {
      closed = true
      clearCompletedTermination()
      if (settled) return
      const cleanStdout = readOutput('stdout')
      const cleanStderr = readOutput('stderr')
      logger.info(
        {
          tag,
          cmd: command,
          exitCode: code,
          timedOut,
          stdoutLen: cleanStdout.length,
          stderrLen: cleanStderr.length,
          stdoutSample: truncateForRaw(cleanStdout, 300),
          stderrSample: truncateForRaw(cleanStderr, 300),
        },
        '[login-status] probe finished',
      )
      settle({
        exitCode: code,
        stdout: cleanStdout,
        stderr: cleanStderr,
        timedOut,
        notFound: false,
      })
    })
  })
}

/** stdout/stderr 截断用于 logs / raw 字段。 */
export function truncateForRaw(text: string, maxLen = 400): string {
  const trimmed = text.trim()
  return trimmed.length <= maxLen ? trimmed : `${trimmed.slice(0, maxLen)}...`
}

/**
 * Generic CLI version probe: run `<command> --version` and return the trimmed
 * stdout. Returns null when not installed / timed out / non-zero exit — the
 * version check is best-effort enrichment and must never block the main flow.
 */
export async function probeCliVersion(
  command: string,
  args: string[] = ['--version'],
): Promise<string | null> {
  const result = await runStatusProbe(command, args, {
    logTag: `${command}-version`,
    timeoutMs: 10_000,
  })
  if (result.notFound || result.timedOut || result.exitCode !== 0) return null
  // First line only: some CLIs (e.g. traecli) print extra lines (build
  // date / commit); the version token lives on the first line.
  const out = (result.stdout.trim() || result.stderr.trim()).split('\n')[0]?.trim()
  return out || null
}
