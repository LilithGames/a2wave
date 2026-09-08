import type { ChildProcess } from 'node:child_process'
import { logger } from '../lib/logger.js'
import {
  type KillWindowsProcessTree,
  killWindowsProcessTree,
  terminateCliProcess,
} from './windows-process-tree.js'

export type SignalProcess = (pid: number, signal: NodeJS.Signals | 0) => boolean

interface CliProcessTreeOptions {
  platform: NodeJS.Platform
  signalProcess?: SignalProcess
  killWindowsProcessTree?: KillWindowsProcessTree
}

/** POSIX callers must spawn with detached: true so the child's PID owns the group. */
export function signalCliProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: CliProcessTreeOptions,
): Promise<void> | undefined {
  const pid = child.pid
  if (options.platform !== 'win32' && typeof pid === 'number' && pid > 0) {
    try {
      const sendSignal = options.signalProcess ?? process.kill.bind(process)
      sendSignal(-pid, signal)
      return undefined
    } catch (error) {
      logger.warn(
        { pid, signal, error },
        'Failed to signal CLI process group; falling back to direct child',
      )
    }
  }
  if (options.platform === 'win32') {
    return terminateCliProcess(
      child,
      signal,
      options.platform,
      options.killWindowsProcessTree ?? killWindowsProcessTree,
    )
  }
  child.kill(signal)
  return undefined
}

export function isCliProcessGroupAlive(
  child: ChildProcess,
  options: Pick<CliProcessTreeOptions, 'platform' | 'signalProcess'>,
): boolean {
  const pid = child.pid
  if (options.platform === 'win32' || typeof pid !== 'number' || pid <= 0) return false
  try {
    const sendSignal = options.signalProcess ?? process.kill.bind(process)
    sendSignal(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
