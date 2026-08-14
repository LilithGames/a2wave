/**
 * 共享：本机登录态检测辅助函数。
 *
 * 为 `AgentEngine.checkLoginStatus` 的实现提供：
 * - 带超时的子进程包装（SIGTERM → SIGKILL 升级）
 * - ANSI/CSI 转义序列 / 光标回退码剥离
 * - stdout / stderr / exitCode 的统一聚合
 */

import { logger } from '../lib/logger.js'
import { spawnCli } from './cli-spawn.js'
import { buildSafeAgentProcessEnv } from './runtime-context.js'
import { terminateCliProcess } from './windows-process-tree.js'

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
  return new Promise((resolve) => {
    logger.info({ tag, cmd: command, args, timeoutMs }, '[login-status] probing')
    let child: ReturnType<typeof spawnCli>
    try {
      child = spawnCli(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
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

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const settle = (result: StatusProbeResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const timer = setTimeout(() => {
      timedOut = true
      settle({
        exitCode: null,
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        timedOut: true,
        notFound: false,
      })
      void terminateCliProcess(child, 'SIGTERM')
      const killTimer = setTimeout(() => terminateCliProcess(child, 'SIGKILL'), 2000)
      killTimer.unref()
      child.once('exit', () => clearTimeout(killTimer))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      const isNotFound = true
      const cleanStdout = stripAnsi(stdout)
      const cleanStderr = stripAnsi(stderr) || err.message
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
      clearTimeout(timer)
      const cleanStdout = stripAnsi(stdout)
      const cleanStderr = stripAnsi(stderr)
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
