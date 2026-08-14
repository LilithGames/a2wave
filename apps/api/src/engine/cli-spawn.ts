import { type ChildProcess, execFile, spawn as nodeSpawn } from 'node:child_process'
import crossSpawn from 'cross-spawn'
import { terminateCliProcess } from './windows-process-tree.js'

export type CliSpawnOptions = Parameters<typeof nodeSpawn>[2]

export interface CliExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
}

export interface CliExecResult {
  stdout: string
  stderr: string
}

type CliExecError = Error & {
  code?: string | number | null
  stdout: string
  stderr: string
}

/**
 * Spawn a Provider CLI without changing the established POSIX execution path.
 *
 * npm exposes global commands as `.cmd` shims on native Windows. Recent Node
 * releases refuse to launch those batch files through `child_process.spawn`
 * directly. cross-spawn resolves the shim and escapes each argument before it
 * invokes cmd.exe. Linux/macOS continue to use Node's native spawn unchanged.
 */
export function spawnCli(
  command: string,
  args: string[],
  options: CliSpawnOptions,
  platform: NodeJS.Platform = process.platform,
): ChildProcess {
  const spawn = platform === 'win32' ? crossSpawn : nodeSpawn
  return spawn(command, args, options) as ChildProcess
}

function createExecError(
  message: string,
  stdout: string,
  stderr: string,
  code?: string | number | null,
): CliExecError {
  return Object.assign(new Error(message), { code, stdout, stderr })
}

/**
 * Buffered CLI execution for short-lived tool commands that need the same
 * Windows npm-shim handling as Provider processes.
 */
export function execCli(
  command: string,
  args: string[],
  options: CliExecOptions = {},
  platform: NodeJS.Platform = process.platform,
): Promise<CliExecResult> {
  if (platform !== 'win32') {
    return new Promise((resolve, reject) => {
      execFile(command, args, options, (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }))
          return
        }
        resolve({ stdout, stderr })
      })
    })
  }

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnCli(
        command,
        args,
        {
          cwd: options.cwd,
          env: options.env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
        platform,
      )
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve({ stdout, stderr })
    }

    const terminate = () => {
      void terminateCliProcess(child, 'SIGTERM', platform)
    }

    const append = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
      const text = chunk.toString()
      if (stream === 'stdout') stdout += text
      else stderr += text

      const maxBuffer = options.maxBuffer
      if (
        maxBuffer !== undefined &&
        Buffer.byteLength(stream === 'stdout' ? stdout : stderr) > maxBuffer
      ) {
        terminate()
        finish(
          createExecError(
            `${stream} maxBuffer length exceeded`,
            stdout,
            stderr,
            'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          ),
        )
      }
    }

    child.stdout?.on('data', (chunk: Buffer | string) => append('stdout', chunk))
    child.stderr?.on('data', (chunk: Buffer | string) => append('stderr', chunk))
    child.once('error', (error) => {
      finish(createExecError(error.message, stdout, stderr, (error as NodeJS.ErrnoException).code))
    })
    child.once('close', (exitCode) => {
      if (exitCode === 0) finish()
      else {
        finish(
          createExecError(
            `Command failed with exit code ${String(exitCode)}: ${command}`,
            stdout,
            stderr,
            exitCode,
          ),
        )
      }
    })

    if (options.timeout !== undefined && options.timeout > 0) {
      timer = setTimeout(() => {
        terminate()
        finish(
          createExecError(
            `Command timed out after ${options.timeout}ms: ${command}`,
            stdout,
            stderr,
            'ETIMEDOUT',
          ),
        )
      }, options.timeout)
    }
  })
}
