import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import type { WriteStream } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { StreamLogEntry } from '../engine/types.js'
import { logger } from './logger.js'

const DEFAULT_MAX_FILE_BYTES = 256 * 1024 * 1024 // 256 MiB
const DEFAULT_RETENTION_DAYS = 14
const DEFAULT_MAX_BUFFERED_LINES = 10000
const CLOSE_TIMEOUT_MS = 10_000

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function getRunLogsRoot(): string {
  const override = process.env.A2WAVE_RUN_LOGS_DIR
  return override ? resolve(override) : resolve(process.cwd(), 'data', 'run-logs')
}

function getMaxFileBytes(): number {
  const raw = Number.parseInt(process.env.A2WAVE_RUN_LOG_MAX_BYTES ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_FILE_BYTES
}

function getRetentionMs(): number {
  const raw = Number.parseFloat(process.env.A2WAVE_RUN_LOG_RETENTION_DAYS ?? '')
  const days = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS
  return days * 24 * 60 * 60 * 1000
}

function getMaxBufferedLines(): number {
  const raw = Number.parseInt(process.env.A2WAVE_RUN_LOG_BUFFER_LINES ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BUFFERED_LINES
}

export function getRunLogFilePath(runId: string): string | null {
  if (!RUN_ID_PATTERN.test(runId)) return null
  return join(getRunLogsRoot(), `${runId}.ndjson`)
}

export function runLogFileExists(runId: string): boolean {
  const path = getRunLogFilePath(runId)
  return !!path && existsSync(path)
}

export type RunLogFilter = 'all' | 'tools' | 'messages' | 'problems'

export interface RunLogPage {
  entries: StreamLogEntry[]
  page: number
  pageSize: number
  totalEntries: number
  totalPages: number
  stats: {
    total: number
    tools: number
    messages: number
    errors: number
  }
}

const PROBLEM_SYSTEM_SUBTYPES = new Set([
  'a2a.task.poll_retry',
  'a2a.task.resubscribe_failed',
  'a2a.task.cancel_failed',
])

function matchesRunLogFilter(entry: StreamLogEntry, filter: RunLogFilter): boolean {
  switch (filter) {
    case 'tools':
      return entry.type === 'tool_call' || entry.type === 'tool_heartbeat'
    case 'messages':
      return entry.type === 'assistant'
    case 'problems':
      return (
        entry.type === 'error' ||
        entry.type === 'retry' ||
        (entry.type === 'tool_call' && entry.subtype === 'failed') ||
        (entry.type === 'system' && PROBLEM_SYSTEM_SUBTYPES.has(entry.subtype))
      )
    default:
      return true
  }
}

function updateRunLogStats(stats: RunLogPage['stats'], entry: StreamLogEntry): void {
  stats.total++
  // tools 是语义计数（发起了几次调用），故只数 started，与筛选页行数无对应关系；
  // messages / errors 则与 'messages' / 'problems' 筛选共用谓词，保证头部摘要
  // 与切到对应 tab 后的 totalEntries 口径一致。
  if (entry.type === 'tool_call' && entry.subtype === 'started') stats.tools++
  if (matchesRunLogFilter(entry, 'messages')) stats.messages++
  if (matchesRunLogFilter(entry, 'problems')) stats.errors++
}

/**
 * 逐行迭代 NDJSON entry。损坏行（进程被杀时的半行）静默跳过。
 *
 * finally 中显式销毁底层 read stream：消费方提前 break 时，readline 的
 * 异步迭代器只 close 自身，不会释放输入流的 fd —— 高频读首页（必然提前
 * break）会累积泄漏文件描述符。
 */
async function* iterateNdjsonEntries(path: string): AsyncGenerator<StreamLogEntry> {
  const input = createReadStream(path)
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let entry: StreamLogEntry | null
      try {
        entry = JSON.parse(line) as StreamLogEntry
      } catch {
        entry = null
      }
      if (entry) yield entry
    }
  } finally {
    rl.close()
    input.destroy()
  }
}

interface RunLogTotals {
  matchingEntries: number
  stats: RunLogPage['stats']
}

/**
 * (runId:filter) → 全量统计 的缓存，以文件 size+mtime 做版本号。
 * 日志文件 append-only（run 结束后不再变），size 变化即失效。
 * 命中后翻页只需一次带提前退出的部分扫描，而非两遍全文件 I/O。
 */
const totalsCache = new Map<string, { size: number; mtimeMs: number; totals: RunLogTotals }>()
const TOTALS_CACHE_MAX = 64

function readCachedTotals(key: string, size: number, mtimeMs: number): RunLogTotals | null {
  const hit = totalsCache.get(key)
  if (!hit || hit.size !== size || hit.mtimeMs !== mtimeMs) return null
  // 重插提升 recency，使淘汰近似 LRU
  totalsCache.delete(key)
  totalsCache.set(key, hit)
  return hit.totals
}

function storeCachedTotals(key: string, size: number, mtimeMs: number, totals: RunLogTotals): void {
  totalsCache.delete(key)
  totalsCache.set(key, { size, mtimeMs, totals })
  while (totalsCache.size > TOTALS_CACHE_MAX) {
    const oldest = totalsCache.keys().next().value
    if (oldest === undefined) break
    totalsCache.delete(oldest)
  }
}

/**
 * 单趟扫描：统计 totals 的同时用环形缓冲保留最后 pageSize 条匹配 entry。
 * 冷缓存打开查看器（默认最后一页）只需这一趟，不用再扫第二遍取页内容。
 */
async function scanTotalsAndTail(
  path: string,
  filter: RunLogFilter,
  pageSize: number,
): Promise<{ totals: RunLogTotals; tail: StreamLogEntry[] }> {
  const stats = { total: 0, tools: 0, messages: 0, errors: 0 }
  let matching = 0
  const ring: StreamLogEntry[] = []
  for await (const entry of iterateNdjsonEntries(path)) {
    updateRunLogStats(stats, entry)
    if (!matchesRunLogFilter(entry, filter)) continue
    if (ring.length < pageSize) {
      ring.push(entry)
    } else {
      ring[matching % pageSize] = entry
    }
    matching++
  }
  // 环形缓冲还原为时间序：满环时最旧元素在 matching % pageSize 处
  const tail =
    ring.length < pageSize
      ? ring
      : [...ring.slice(matching % pageSize), ...ring.slice(0, matching % pageSize)]
  return { totals: { matchingEntries: matching, stats }, tail }
}

async function readValidNdjsonRange(
  path: string,
  filter: RunLogFilter,
  startIndex: number,
  endIndex: number,
): Promise<StreamLogEntry[]> {
  const entries: StreamLogEntry[] = []
  let matchingIndex = 0
  for await (const entry of iterateNdjsonEntries(path)) {
    if (!matchesRunLogFilter(entry, filter)) continue
    if (matchingIndex >= startIndex && matchingIndex < endIndex) entries.push(entry)
    matchingIndex++
    if (matchingIndex >= endIndex) break
  }
  return entries
}

export async function readRunLogPage(
  runId: string,
  opts: { page: number | 'last'; pageSize: number; filter?: RunLogFilter },
): Promise<RunLogPage | null> {
  const path = getRunLogFilePath(runId)
  if (!path || !existsSync(path)) return null

  let fileStat: { size: number; mtimeMs: number }
  try {
    fileStat = statSync(path)
  } catch {
    return null // 与 existsSync 之间被删除（过期清理竞态）
  }

  const filter = opts.filter ?? 'all'
  const cacheKey = `${runId}:${filter}`
  let totals = readCachedTotals(cacheKey, fileStat.size, fileStat.mtimeMs)
  let tailFromScan: StreamLogEntry[] | null = null
  if (!totals) {
    const scanned = await scanTotalsAndTail(path, filter, opts.pageSize)
    totals = scanned.totals
    tailFromScan = scanned.tail
    storeCachedTotals(cacheKey, fileStat.size, fileStat.mtimeMs, totals)
  }

  const totalEntries = totals.matchingEntries
  const totalPages = Math.max(1, Math.ceil(totalEntries / opts.pageSize))
  const page = opts.page === 'last' ? totalPages : Math.min(Math.max(1, opts.page), totalPages)

  let entries: StreamLogEntry[]
  if (totalEntries === 0) {
    entries = []
  } else if (tailFromScan && page === totalPages) {
    // 刚做过全量扫描且请求的是末页（含 page 超界被钳到末页）：直接用环形缓冲
    const lastPageCount = totalEntries - (totalPages - 1) * opts.pageSize
    entries = tailFromScan.slice(-lastPageCount)
  } else {
    const startIndex = (page - 1) * opts.pageSize
    entries = await readValidNdjsonRange(path, filter, startIndex, startIndex + opts.pageSize)
  }

  return {
    entries,
    page,
    pageSize: opts.pageSize,
    totalEntries,
    totalPages,
    stats: totals.stats,
  }
}

export interface RunLogFileWriter {
  write: (entry: StreamLogEntry) => void
  close: () => Promise<void>
}

export function createRunLogFileWriter(runId: string): RunLogFileWriter | null {
  const path = getRunLogFilePath(runId)
  if (!path) {
    logger.warn({ runId }, 'run-log-file: invalid runId, full-log sidecar disabled for this run')
    return null
  }

  let stream: WriteStream
  let bytesWritten = 0
  try {
    mkdirSync(getRunLogsRoot(), { recursive: true })
    bytesWritten = existsSync(path) ? statSync(path).size : 0
    stream = createWriteStream(path, { flags: 'a' })
  } catch (err) {
    logger.warn({ err, runId }, 'run-log-file: open failed, full-log sidecar disabled for this run')
    return null
  }

  const maxBytes = getMaxFileBytes()
  const maxBufferedLines = getMaxBufferedLines()
  const pendingLines: string[] = []
  let failed = false
  let capped = false
  let closed = false
  let backpressured = false
  let droppedWhileBackpressured = 0
  let closeResolve: (() => void) | null = null

  const finishCloseIfReady = (): void => {
    if (!closeResolve || backpressured || pendingLines.length > 0) return
    const resolveClose = closeResolve
    closeResolve = null
    stream.end(() => resolveClose())
  }

  const writeDirect = (line: string): void => {
    bytesWritten += Buffer.byteLength(line, 'utf8')
    backpressured = !stream.write(line)
  }

  const capWithMarker = (): void => {
    if (capped) return
    capped = true
    pendingLines.length = 0
    const marker: { type: string; subtype: string; ts: number; dropped?: number } = {
      type: 'system',
      subtype: 'log_file_size_capped',
      ts: Date.now(),
    }
    // 尚未写出 dropped 标记的丢弃数折叠进 cap 标记，排查时不丢线索
    if (droppedWhileBackpressured > 0) {
      marker.dropped = droppedWhileBackpressured
      droppedWhileBackpressured = 0
    }
    writeDirect(`${JSON.stringify(marker)}\n`)
    logger.warn({ runId, maxBytes }, 'run-log-file: size cap reached, dropping further entries')
  }

  const writeCounted = (line: string): void => {
    if (bytesWritten + Buffer.byteLength(line, 'utf8') > maxBytes) {
      capWithMarker()
      return
    }
    writeDirect(line)
  }

  function flushPending(): void {
    if (failed || backpressured) return
    while (!failed && !capped && !backpressured && pendingLines.length > 0) {
      const next = pendingLines.shift()
      if (next) writeCounted(next)
    }
    // dropped 标记在排空 pending 之后写：被丢弃的条目时间上发生在所有 queued
    // 条目之后，标记位置应反映真实丢失点。drain 中途再次背压则推迟到下次 drain。
    // writeCounted 触发 cap 时 capWithMarker 已把计数折叠进 cap 标记并清零；
    // 只有标记真正写出后才在这里清零，避免计数在两个分支间丢失。
    if (droppedWhileBackpressured > 0 && !failed && !capped && !backpressured) {
      writeCounted(
        `${JSON.stringify({
          type: 'system',
          subtype: 'log_file_entries_dropped',
          dropped: droppedWhileBackpressured,
          ts: Date.now(),
        })}\n`,
      )
      if (!capped) droppedWhileBackpressured = 0
    }
    finishCloseIfReady()
  }

  stream.on('error', (err) => {
    if (!failed) {
      failed = true
      logger.warn({ err, runId }, 'run-log-file: write error, dropping further entries')
    }
    if (closeResolve) {
      const resolveClose = closeResolve
      closeResolve = null
      resolveClose()
    }
  })

  stream.on('drain', () => {
    backpressured = false
    flushPending()
  })

  const enqueueOrDrop = (line: string): void => {
    if (pendingLines.length < maxBufferedLines) {
      pendingLines.push(line)
    } else {
      droppedWhileBackpressured++
    }
  }

  const write = (entry: StreamLogEntry): void => {
    if (failed || capped || closed) return
    let line: string
    try {
      line = `${JSON.stringify(entry)}\n`
    } catch {
      return
    }
    if (backpressured) {
      enqueueOrDrop(line)
      return
    }
    writeCounted(line)
  }

  const close = (): Promise<void> => {
    if (closed) return Promise.resolve()
    closed = true
    return new Promise((resolvePromise) => {
      // 持续背压下 drain 可能永不触发（磁盘满 / fd 卡死），而 executeWithRetry
      // 在 finally 里 await close() —— 必须有超时兜底，否则阻塞整个 run 收尾。
      const timer = setTimeout(() => {
        if (!closeResolve) return
        closeResolve = null
        logger.warn(
          { runId, pendingLines: pendingLines.length },
          'run-log-file: close timed out waiting for drain; destroying stream',
        )
        stream.destroy()
        resolvePromise()
      }, CLOSE_TIMEOUT_MS)
      timer.unref()
      closeResolve = () => {
        clearTimeout(timer)
        resolvePromise()
      }
      flushPending()
      if (failed) {
        closeResolve = null
        clearTimeout(timer)
        resolvePromise()
        return
      }
      finishCloseIfReady()
    })
  }

  return { write, close }
}

export function deleteExpiredRunLogs(): void {
  const root = getRunLogsRoot()
  if (!existsSync(root)) return
  const cutoff = Date.now() - getRetentionMs()
  let deleted = 0
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.ndjson')) continue
    const path = join(root, name)
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path)
        deleted++
      }
    } catch (err) {
      logger.warn({ err, path }, 'run-log-file: cleanup failed for file')
    }
  }
  if (deleted > 0) {
    logger.info({ deleted }, 'Deleted expired run log files')
  }
}
