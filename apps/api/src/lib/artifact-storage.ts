/**
 * Artifact 文件存储服务
 * 负责产物的磁盘存储、扫描注册、路径安全、过期清理
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import AdmZip from 'adm-zip'
import { and, eq, gt, inArray, isNull, lt, notExists } from 'drizzle-orm'
import { db } from '../db/client.js'
import { artifactShares, artifacts } from '../db/schema.js'
import { artifactsDirForTask } from '../engine/runtime-context.js'
import { deleteStaleShares } from './artifact-share.js'
import { createId } from './id.js'
import { logger } from './logger.js'
import { getSetting } from './settings.js'

/** 获取产物存储根目录绝对路径 */
export async function getArtifactsStorageRoot(): Promise<string> {
  const storagePath = getSetting('artifacts', 'storagePath') || './data/artifacts'
  return resolve(process.cwd(), await storagePath)
}

/** 获取产物保留毫秒数 */
export function getArtifactRetentionMs(): number {
  const hours = Number(getSetting('artifacts', 'retentionHours') ?? '168')
  return hours * 60 * 60 * 1000
}

/** 计算用户 Hash（不透明但一致） */
function userHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 12)
}

/** 获取某次 run 的产物目录（磁盘） */
export async function getArtifactDir(
  agentId: string,
  userId: string | null,
  runId: string,
): Promise<string> {
  const root = await getArtifactsStorageRoot()
  const userSegment = userId ? userHash(userId) : '_system'
  return join(root, agentId, userSegment, runId)
}

/** 确保目录存在 */
function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true })
  }
}

/** MIME type 简单推断 */
export function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    ts: 'text/typescript',
    py: 'text/x-python',
    sh: 'text/x-sh',
    csv: 'text/csv',
    xml: 'application/xml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    tar: 'application/x-tar',
    gz: 'application/gzip',
  }
  return map[ext] ?? 'application/octet-stream'
}

export interface RegisteredArtifact {
  id: string
  filename: string
  storagePath: string
  kind: 'file' | 'directory'
  mimeType: string | null
  /** 生成该产物的 agent；用于分享 URL 段 /s/:agentId/:shareId 与「由谁生成」展示 */
  agentId: string | null
}

/**
 * Recursively copy a directory, lstat-ing each entry so symlinks are skipped at
 * every depth. Returns the total size and number of files copied.
 */
function copyDirSkippingSymlinks(
  src: string,
  dest: string,
): { totalSize: number; fileCount: number } {
  let totalSize = 0
  let fileCount = 0
  ensureDir(dest)
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry)
    const destPath = join(dest, entry)
    const stat = lstatSync(srcPath)
    if (stat.isSymbolicLink()) {
      logger.warn({ path: srcPath }, 'Artifact directory entry is a symlink, skipping')
      continue
    }
    if (stat.isDirectory()) {
      const sub = copyDirSkippingSymlinks(srcPath, destPath)
      totalSize += sub.totalSize
      fileCount += sub.fileCount
    } else if (stat.isFile()) {
      copyFileSync(srcPath, destPath)
      totalSize += stat.size
      fileCount += 1
    }
  }
  return { totalSize, fileCount }
}

/** Workspaces already reported by warnOnWorkspaceLevelArtifacts, see below. */
const workspaceLevelArtifactsReported = new Set<string>()

/**
 * Files directly under the workspace's `artifacts/` sit one level above where
 * the collector looks and are never collected. Two things put them there: a
 * workspace that predates per-run directories (every run used to write to the
 * flat `artifacts/`, and nothing ever removed it), or an Agent that hardcodes
 * a relative `artifacts/` instead of following the injected absolute path.
 * Name them, so either cause is diagnosable from the run's own logs rather
 * than only from an empty artifact list.
 *
 * Only plain files count. Every *directory* at that level is some execution's
 * own drop-box — a run's, or an evaluation turn's, whose taskId carries no
 * `run_` prefix at all — and on a P4 source, where evaluations share the one
 * checkout with chat, a name-prefix test would tell the author to write to
 * $A2WAVE_ARTIFACTS_DIR about a directory they wrote there correctly.
 *
 * Reported once per workspace per process, not once per run: a workspace that
 * predates per-run directories still holds the files those runs left at the top
 * level, and every artifact-less run afterwards would otherwise repeat the same
 * list forever. Once is enough to act on; a restart re-reports if it was not.
 */
function warnOnWorkspaceLevelArtifacts(workDir: string, runId: string): void {
  const workspaceLevelDir = join(workDir, 'artifacts')
  if (workspaceLevelArtifactsReported.has(workspaceLevelDir)) return
  let strays: string[]
  try {
    strays = readdirSync(workspaceLevelDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch (err) {
    // Absent is the normal case for a run that wrote nothing. Anything else —
    // a repo that tracks a plain file named `artifacts`, say — means no run on
    // this workspace can have a directory to collect, which is worth one line.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    workspaceLevelArtifactsReported.add(workspaceLevelDir)
    logger.warn(
      { err, runId, workspaceLevelDir },
      'The workspace artifacts path is not a directory; no artifacts can be collected on this workspace',
    )
    return
  }
  if (strays.length === 0) return
  workspaceLevelArtifactsReported.add(workspaceLevelDir)
  logger.warn(
    { runId, workspaceLevelDir, entries: strays.slice(0, 20) },
    'Files found directly under the workspace artifacts directory; they belong to no run and ' +
      'are not collected. They predate per-run artifact directories, or the Agent wrote ' +
      'outside $A2WAVE_ARTIFACTS_DIR.',
  )
}

/**
 * Drop the execution's artifacts directory once the run has settled. Keyed by
 * the task id for the reason artifactsDirForTask gives.
 *
 * Registration copies every artifact into isolated storage, so the workspace
 * copy is scratch from that point on. Removing it is what keeps a persistent
 * workspace — a per-Agent worktree or a shared SCM checkout — from growing one
 * directory per run forever.
 *
 * Async because this runs on the terminal path of every run and a directory
 * artifact may be hundreds of megabytes across many files: a synchronous
 * recursive delete would hold the single API event loop for the whole walk.
 */
export async function discardRunArtifactsDir(
  workDir: string | undefined,
  taskId: string,
): Promise<void> {
  if (!workDir) return
  try {
    await rm(artifactsDirForTask(workDir, taskId), { recursive: true, force: true })
  } catch (err) {
    logger.warn({ err, taskId, workDir }, 'Failed to remove the run artifacts directory')
  }
}

/**
 * Register everything this run dropped in its own artifacts directory.
 *
 * The source is `artifactsDirForTask(workDir, taskId)`, never the workspace-wide
 * `artifacts/`: the workspace is shared by concurrent runs (see that helper),
 * so scanning it registered whatever a sibling run happened to be writing.
 * Ownership is now positional — a run can only ever see its own directory —
 * which is why no mtime filter is needed to tell the two apart.
 *
 * Top-level files register as `file` artifacts; top-level directories register
 * whole as `directory` artifacts (copied recursively).
 */
export async function scanAndRegisterArtifacts(
  runId: string,
  agentId: string,
  userId: string | null,
  workDir: string,
  taskId: string,
): Promise<RegisteredArtifact[]> {
  const sourceDir = artifactsDirForTask(workDir, taskId)
  if (!existsSync(sourceDir)) {
    warnOnWorkspaceLevelArtifacts(workDir, runId)
    return []
  }

  const stat = statSync(sourceDir)
  if (!stat.isDirectory()) {
    logger.warn(
      { runId, sourceDir },
      'The run artifacts path is not a directory; nothing was collected',
    )
    return []
  }

  const entries = readdirSync(sourceDir)
  if (entries.length === 0) {
    warnOnWorkspaceLevelArtifacts(workDir, runId)
    return []
  }

  const destDir = await getArtifactDir(agentId, userId, runId)
  ensureDir(destDir)

  const resolvedDestDir = resolve(destDir)
  const retentionMs = getArtifactRetentionMs()
  const expiresAt = retentionMs > 0 ? new Date(Date.now() + retentionMs) : null
  const registered: RegisteredArtifact[] = []

  for (const filename of entries) {
    const srcPath = join(sourceDir, filename)
    const srcStat = lstatSync(srcPath)
    if (srcStat.isSymbolicLink()) {
      logger.warn({ filename, runId }, 'Artifact is a symlink, skipping for security')
      continue
    }
    const isDirectory = srcStat.isDirectory()
    if (!isDirectory && !srcStat.isFile()) continue

    // Path security check
    const destPath = join(destDir, filename)
    const resolvedDest = resolve(destPath)
    if (resolvedDest !== resolvedDestDir && !resolvedDest.startsWith(resolvedDestDir + sep)) {
      logger.warn({ filename, runId }, 'Artifact filename failed path traversal check, skipping')
      continue
    }

    let kind: 'file' | 'directory'
    let mimeType: string | null
    let size: number

    if (isDirectory) {
      const { totalSize, fileCount } = copyDirSkippingSymlinks(srcPath, resolvedDest)
      // An empty directory is not an artifact — the Agent left a shell behind.
      if (fileCount === 0) {
        rmSync(resolvedDest, { recursive: true, force: true })
        continue
      }
      kind = 'directory'
      mimeType = null
      size = totalSize
    } else {
      copyFileSync(srcPath, resolvedDest)
      kind = 'file'
      mimeType = guessMimeType(filename)
      size = srcStat.size
    }

    const id = createId('art')
    await db.insert(artifacts).values({
      id,
      runId,
      agentId,
      userId,
      filename,
      storagePath: resolvedDest,
      kind,
      mimeType,
      size,
      expiresAt: expiresAt ?? undefined,
    })

    registered.push({ id, filename, storagePath: resolvedDest, kind, mimeType, agentId })
    logger.info({ runId, filename, kind }, 'Artifact registered')
  }

  return registered
}

/** 目录产物 zip 打包的源大小上限（zip 在内存构建，防止超大目录撑爆内存） */
export const MAX_ZIP_SOURCE_BYTES = 200 * 1024 * 1024

/**
 * 计算目录产物的源大小（递归，跳过 symlink）。
 * 用于在内存 zip 打包前做源大小预检，避免把超大目录打进内存才拒绝。
 */
export function getDirectorySourceSize(dirPath: string): number {
  let total = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        walk(fullPath)
      } else if (stat.isFile()) {
        total += stat.size
      }
    }
  }
  walk(dirPath)
  return total
}

/**
 * 将目录产物打包为内存 zip Buffer（条目以 rootName/ 为前缀）。
 * 复制阶段已剔除 symlink，这里按普通文件树遍历。
 */
export function zipDirectoryToBuffer(dirPath: string, rootName: string): Buffer {
  const zip = new AdmZip()
  const addDir = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry)
      const stat = lstatSync(fullPath)
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) {
        addDir(fullPath, `${prefix}/${entry}`)
      } else if (stat.isFile()) {
        zip.addFile(`${prefix}/${entry}`, readFileSync(fullPath))
      }
    }
  }
  addDir(dirPath, rootName)
  return zip.toBuffer()
}

/**
 * 删除已过期的产物（磁盘文件 + DB 行）。
 * 存在活跃分享（未撤销且未过期）的产物豁免清理——分享发出去的链接
 * 在有效期内必须可访问，不能被 retention 提前删掉。
 */
/**
 * Physically remove the artifact files belonging to the given runs, so that a
 * bulk `DELETE FROM runs` (data retention) doesn't strand their files on disk
 * when the FK cascade wipes the artifact rows. Only touches the filesystem; the
 * DB rows are left for the cascade. Returns the number of files removed.
 */
export async function purgeArtifactFilesForRuns(runIds: string[]): Promise<number> {
  if (runIds.length === 0) return 0
  const rows = await db
    .select({ id: artifacts.id, storagePath: artifacts.storagePath })
    .from(artifacts)
    .where(inArray(artifacts.runId, runIds))
  let removed = 0
  for (const row of rows) {
    try {
      if (existsSync(row.storagePath)) {
        rmSync(row.storagePath, { recursive: true, force: true })
        removed++
      }
    } catch (err) {
      logger.warn({ err, artifactId: row.id }, 'Failed to delete artifact file during retention')
    }
  }
  return removed
}

export async function deleteExpiredArtifacts(): Promise<void> {
  const now = new Date()
  // 先收敛分享表：过期/撤销的 share 行删除后，豁免判断只剩真正活跃的分享。
  // Awaited — the notExists(...) exemption below reads artifact_shares, so an
  // unawaited sweep leaves the stale rows visible to that subquery and every
  // expired artifact stays exempt from collection.
  await deleteStaleShares()
  const expired = await db
    .select()
    .from(artifacts)
    .where(
      and(
        lt(artifacts.expiresAt, now),
        notExists(
          db
            .select({ id: artifactShares.id })
            .from(artifactShares)
            .where(
              and(
                eq(artifactShares.artifactId, artifacts.id),
                isNull(artifactShares.revokedAt),
                gt(artifactShares.expiresAt, now),
              ),
            ),
        ),
      ),
    )

  for (const artifact of expired) {
    try {
      if (existsSync(artifact.storagePath)) {
        rmSync(artifact.storagePath, { recursive: true, force: true })
      }
    } catch (err) {
      logger.warn({ err, artifactId: artifact.id }, 'Failed to delete artifact file')
    }
    await db.delete(artifacts).where(eq(artifacts.id, artifact.id))
  }

  if (expired.length > 0) {
    logger.info({ count: expired.length }, 'Deleted expired artifacts')
  }
}
