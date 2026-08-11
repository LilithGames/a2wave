import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, symlink, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { ScmSourceConfig } from '@a2wave/shared'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import { scmSources } from '../db/schema.js'
import { sanitizeCredentials } from './git-sync.js'
import { logger } from './logger.js'

const execFileAsync = promisify(execFile)

const CODEGRAPH_TIMEOUT_MS = 10 * 60 * 1000
const CODEGRAPH_MAX_BUFFER = 20 * 1024 * 1024
const CODEGRAPH_MAX_MESSAGE = 10_000

export interface CodegraphIndexResult {
  ok: boolean
  message: string
  mode?: 'init' | 'sync'
  skipped?: boolean
  conflict?: boolean
}

export function isCodegraphEnabled(config: unknown): boolean {
  return Boolean((config as Partial<ScmSourceConfig> | null | undefined)?.codegraphEnabled)
}

/**
 * Make the source's CodeGraph index reachable from a workspace (worktree).
 *
 * The index is generated once per SCM source at `<localPath>/.codegraph`, and
 * the query CLI resolves it relative to cwd — so a run whose cwd is a per-agent
 * worktree would silently degrade to grep without this link. A symlink keeps
 * the cwd-relative contract true with zero assumptions about CLI flags.
 *
 * Idempotent and non-destructive: an existing correct link is kept, a dangling
 * link (source relocated) is repaired, and a real file/directory is never
 * overwritten. Failures only log — index reachability is never worth failing
 * a run over.
 */
export async function ensureCodegraphLink(workspacePath: string, localPath: string): Promise<void> {
  const target = join(localPath, '.codegraph')
  const linkPath = join(workspacePath, '.codegraph')
  if (!existsSync(target)) return

  try {
    const existing = await lstat(linkPath).catch(() => null)
    if (existing) {
      if (!existing.isSymbolicLink()) return
      // Repair only when the link no longer resolves (existsSync follows links).
      if (existsSync(linkPath)) return
      await unlink(linkPath)
    }
    await symlink(target, linkPath, 'dir')
  } catch (err) {
    logger.warn({ err, linkPath, target }, 'Failed to link CodeGraph index into workspace')
  }
}

function trimMessage(message: string): string {
  const trimmed = message.trim()
  if (trimmed.length <= CODEGRAPH_MAX_MESSAGE) return trimmed
  return `${trimmed.slice(0, CODEGRAPH_MAX_MESSAGE)}...`
}

function safeMessage(message: string): string {
  return trimMessage(sanitizeCredentials(message))
}

function errorMessage(error: unknown, mode: 'init' | 'sync'): string {
  const execErr = error as Error & { stderr?: string; stdout?: string; code?: string }
  const stderr = execErr.stderr?.trim()
  const stdout = execErr.stdout?.trim()
  const raw = stderr || stdout || (error instanceof Error ? error.message : String(error))
  return safeMessage(raw) || `CodeGraph ${mode} failed`
}

async function finalizePreAcquiredIndex(
  sourceId: string,
  status: 'idle' | 'error',
  message: string | null,
): Promise<void> {
  await db
    .update(scmSources)
    .set({ codegraphStatus: status, codegraphLastError: message, updatedAt: new Date() })
    .where(eq(scmSources.id, sourceId))
}

export async function runCodegraphForPath(localPath: string): Promise<CodegraphIndexResult> {
  const hasIndex = existsSync(join(localPath, '.codegraph'))
  const mode = hasIndex ? 'sync' : 'init'

  try {
    const { stdout, stderr } = await execFileAsync('codegraph', [mode, localPath], {
      timeout: CODEGRAPH_TIMEOUT_MS,
      maxBuffer: CODEGRAPH_MAX_BUFFER,
      env: { ...process.env, NO_COLOR: '1' },
    })
    const message =
      safeMessage(`${stdout}${stderr ? `\n${stderr}` : ''}`) || `CodeGraph ${mode} completed`
    return { ok: true, message, mode }
  } catch (error) {
    return { ok: false, message: errorMessage(error, mode), mode }
  }
}

export async function runCodegraphIndex(
  sourceId: string,
  options: { alreadyAcquired?: boolean } = {},
): Promise<CodegraphIndexResult> {
  const source = await (
    await db.select().from(scmSources).where(eq(scmSources.id, sourceId)).limit(1)
  )[0]
  if (!source) {
    if (options.alreadyAcquired) {
      await finalizePreAcquiredIndex(sourceId, 'error', 'SCM source not found')
    }
    return { ok: false, message: 'SCM source not found' }
  }

  if (!isCodegraphEnabled(source.config)) {
    if (options.alreadyAcquired) {
      await finalizePreAcquiredIndex(sourceId, 'idle', null)
    }
    return { ok: true, message: 'CodeGraph disabled', skipped: true }
  }

  if (!options.alreadyAcquired) {
    const acquired = await (
      await db
        .update(scmSources)
        .set({ codegraphStatus: 'indexing', codegraphLastError: null, updatedAt: new Date() })
        .where(and(eq(scmSources.id, sourceId), ne(scmSources.codegraphStatus, 'indexing')))
        .returning()
    )[0]

    if (!acquired) {
      return {
        ok: true,
        message: 'CodeGraph indexing already in progress',
        skipped: true,
        conflict: true,
      }
    }
  }

  logger.info({ sourceId, localPath: source.localPath }, 'Starting CodeGraph indexing')
  const result = await runCodegraphForPath(source.localPath)

  await db
    .update(scmSources)
    .set({
      codegraphStatus: result.ok ? 'idle' : 'error',
      codegraphLastIndexedAt: result.ok ? new Date() : source.codegraphLastIndexedAt,
      codegraphLastError: result.ok ? null : result.message,
      updatedAt: new Date(),
    })
    .where(eq(scmSources.id, sourceId))

  if (result.ok) {
    logger.info({ sourceId, mode: result.mode }, 'CodeGraph indexing completed')
  } else {
    logger.error(
      { sourceId, mode: result.mode, error: result.message },
      'CodeGraph indexing failed',
    )
  }

  return result
}
