interface ExecutionLeaseEntry {
  runId: string
  taskIds: Set<string>
  agentId?: string
  controller: AbortController
  completion: Promise<void>
  resolveCompletion: () => void
  finished: boolean
}

export interface ExecutionLease {
  signal: AbortSignal
  finish: () => void
}

const leasesByRunId = new Map<string, ExecutionLeaseEntry>()
const leasesByTaskId = new Map<string, ExecutionLeaseEntry>()
let durableReleaseHandler: ((runId: string, agentId?: string) => Promise<void>) | undefined
const pendingDurableReleases = new Set<Promise<void>>()
const durableReleaseErrors: unknown[] = []

/** Composition-root hook keeps this process primitive independent of the DB. */
export function setDurableExecutionLeaseReleaseHandler(
  handler: ((runId: string, agentId?: string) => Promise<void>) | undefined,
): void {
  durableReleaseHandler = handler
}

function createExecutionLease(runId: string, agentId?: string): ExecutionLeaseEntry {
  let resolveCompletion!: () => void
  const completion = new Promise<void>((resolve) => {
    resolveCompletion = resolve
  })
  const entry: ExecutionLeaseEntry = {
    runId,
    taskIds: new Set(),
    agentId,
    controller: new AbortController(),
    completion,
    resolveCompletion,
    finished: false,
  }
  leasesByRunId.set(runId, entry)
  return entry
}

function getOrCreateExecutionLease(runId: string, agentId?: string): ExecutionLeaseEntry {
  const existing = leasesByRunId.get(runId)
  if (existing) {
    existing.agentId ??= agentId
    return existing
  }
  return createExecutionLease(runId, agentId)
}

function toExecutionLease(entry: ExecutionLeaseEntry): ExecutionLease {
  return {
    signal: entry.controller.signal,
    finish: () => finishExecutionLeaseEntry(entry),
  }
}

/** Reserve a concurrency slot before any asynchronous execution preparation. */
export function reserveExecutionLease(runId: string, agentId?: string): ExecutionLease {
  return toExecutionLease(getOrCreateExecutionLease(runId, agentId))
}

/** Reserve a lease without racing an SCM binding release for the same Agent. */
export function reserveExecutionLeaseForAgent(
  runId: string,
  agentId: string,
): Promise<ExecutionLease> {
  return withAgentScmWorkloadLock(agentId, async () => reserveExecutionLease(runId, agentId))
}

/** Bind the eventual CLI task to a lease that may already have been cancelled. */
export function bindExecutionLeaseTask(
  runId: string,
  taskId: string,
  agentId?: string,
): ExecutionLease {
  const entry = getOrCreateExecutionLease(runId, agentId)
  const taskOwner = leasesByTaskId.get(taskId)
  if (taskOwner && taskOwner !== entry) {
    throw new Error(`Execution lease already exists for task "${taskId}"`)
  }
  entry.taskIds.add(taskId)
  leasesByTaskId.set(taskId, entry)
  return toExecutionLease(entry)
}

/** Backward-compatible shorthand for reserving and binding in one operation. */
export function beginExecutionLease(
  runId: string,
  taskId: string,
  agentId?: string,
): ExecutionLease {
  return bindExecutionLeaseTask(runId, taskId, agentId)
}

/** Abort an admitted execution and wait until its owner completes lifecycle cleanup. */
export function cancelExecutionLease(runId: string): Promise<void> {
  const entry = leasesByRunId.get(runId)
  if (!entry) return Promise.resolve()
  entry.controller.abort()
  return entry.completion
}

/** Used by CliProcessRunner to close the cancellation-before-spawn window. */
export function getExecutionAbortSignal(taskId: string): AbortSignal | undefined {
  return leasesByTaskId.get(taskId)?.controller.signal
}

export function hasExecutionLease(runId: string): boolean {
  return leasesByRunId.has(runId)
}

/** Every unfinished lifecycle lease consumes capacity, including terminal cleanup. */
export function countActiveExecutionLeases(agentId: string): number {
  let count = 0
  for (const entry of leasesByRunId.values()) {
    if (entry.agentId === agentId && !entry.finished) count++
  }
  return count
}

export function completeExecutionLease(runId: string): void {
  const entry = leasesByRunId.get(runId)
  if (entry) finishExecutionLeaseEntry(entry)
}

/**
 * Snapshot of every unfinished lease, for the stale-lease sweeper to reconcile
 * against Run existence. Terminal status is not enough: the process may still
 * be exiting or cleaning its workspace.
 */
export function listActiveExecutionLeases(): Array<{
  runId: string
  agentId?: string
}> {
  const out: Array<{ runId: string; agentId?: string }> = []
  for (const entry of leasesByRunId.values()) {
    if (!entry.finished) {
      out.push({ runId: entry.runId, agentId: entry.agentId })
    }
  }
  return out
}

/** Wait until every fire-and-forget durable release has reached the database. */
export async function drainDurableExecutionLeaseReleases(): Promise<void> {
  await Promise.all([...pendingDurableReleases])
  if (durableReleaseErrors.length > 0) {
    const errors = durableReleaseErrors.splice(0)
    throw new AggregateError(errors, 'One or more durable SCM workload lease releases failed')
  }
}

/** Wait for active Run lifecycles to finish process and workspace cleanup. */
export async function drainActiveExecutionLeases(): Promise<void> {
  while (leasesByRunId.size > 0) {
    await Promise.all([...leasesByRunId.values()].map((entry) => entry.completion))
  }
}

function finishExecutionLeaseEntry(entry: ExecutionLeaseEntry): void {
  if (entry.finished) return
  entry.finished = true
  if (leasesByRunId.get(entry.runId) === entry) leasesByRunId.delete(entry.runId)
  for (const taskId of entry.taskIds) {
    if (leasesByTaskId.get(taskId) === entry) leasesByTaskId.delete(taskId)
  }
  entry.resolveCompletion()
  const release = durableReleaseHandler?.(entry.runId, entry.agentId)
  if (release) {
    const tracked = release
      .catch((error) => {
        durableReleaseErrors.push(error)
      })
      .finally(() => pendingDurableReleases.delete(tracked))
    pendingDurableReleases.add(tracked)
  }
}

export function _resetExecutionLeasesForTests(): void {
  for (const entry of leasesByRunId.values()) finishExecutionLeaseEntry(entry)
  leasesByRunId.clear()
  leasesByTaskId.clear()
  durableReleaseHandler = undefined
  pendingDurableReleases.clear()
  durableReleaseErrors.length = 0
}

import { withAgentScmWorkloadLock } from '../lib/scm-workload-lock.js'
