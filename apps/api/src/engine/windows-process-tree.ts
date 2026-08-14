import { type ChildProcess, spawn } from 'node:child_process'

const TASKKILL_TIMEOUT_MS = 2_000

export type KillWindowsProcessTree = (pid: number, onComplete: (success: boolean) => void) => void

export function killWindowsProcessTree(pid: number, onComplete: (success: boolean) => void): void {
  let taskkill: ChildProcess
  try {
    taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    onComplete(false)
    return
  }

  let settled = false
  const finish = (success: boolean) => {
    if (settled) return
    settled = true
    clearTimeout(timeout)
    onComplete(success)
  }
  const timeout = setTimeout(() => {
    try {
      taskkill.kill()
    } finally {
      finish(false)
    }
  }, TASKKILL_TIMEOUT_MS)

  taskkill.once('error', () => finish(false))
  taskkill.once('close', (exitCode) => finish(exitCode === 0))
  taskkill.unref()
}

export function terminateCliProcess(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  killProcessTree: KillWindowsProcessTree = killWindowsProcessTree,
): Promise<void> {
  const pid = child.pid
  if (platform === 'win32' && typeof pid === 'number' && pid > 0) {
    return new Promise((resolve) => {
      const fallback = () => {
        try {
          child.kill(signal)
        } catch {}
        resolve()
      }
      try {
        killProcessTree(pid, (success) => {
          if (success) resolve()
          else fallback()
        })
      } catch {
        fallback()
      }
    })
  }
  child.kill(signal)
  return Promise.resolve()
}
