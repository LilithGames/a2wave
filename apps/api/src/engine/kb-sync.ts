import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises'
/**
 * KB Document 文件同步 — 将 agent 的知识库文档复制到工作区
 */
import { join } from 'node:path'
import { getKbDocStoragePath } from '../lib/kb-storage.js'

/** Workspace-root directory this module writes into. */
const KB_WORKSPACE_DIR = '.kb'

/**
 * Workspace paths this writer owns. Registered with `platformWorkspacePaths()`
 * so removal and the followSource pinning check learn about them from the
 * writer itself — a new writer cannot be forgotten.
 */
export function kbSyncWorkspacePaths(): string[] {
  return [KB_WORKSPACE_DIR]
}

const KB_MANAGED_MARKER = '.a2wave-kb-managed'

/**
 * `NAME_MAX` on ext4/overlayfs — a single path component may not exceed 255 **bytes**.
 *
 * This has to be enforced here rather than on `kb_documents.name`, because the name is
 * bounded in UTF-16 units (200) while the filesystem counts UTF-8 bytes: 200 CJK
 * characters is 600 bytes. Exceeding it makes `cp` throw `ENAMETOOLONG`, and
 * `syncKbDocsToWorkspaceAsync` is awaited in `base-engine`'s `Promise.all` *before* its
 * try/catch — so the rejection escapes the engine and fails every run of every Agent
 * that mounts the document, not just the copy of that one file. macOS/APFS counts
 * characters instead, so this never reproduces locally.
 */
const MAX_FILENAME_BYTES = 255

/** Truncate to a UTF-8 byte budget without splitting a multi-byte character. */
function truncateToBytes(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf-8')
  if (buf.length <= maxBytes) return value
  // Clamp first: `subarray` reads a negative end as an offset from the tail, which would
  // return a prefix instead of nothing.
  let end = Math.max(0, maxBytes)
  // Back off while the first excluded byte is a continuation byte (0b10xxxxxx),
  // which would mean the cut landed inside a character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf-8')
}

/**
 * The filename a KB document takes inside the workspace `.kb/` directory.
 *
 * Single source of truth on purpose: the Agent is told this name in the
 * auto-generated Knowledge Base skill (`agent-helpers.ts`) and then reads it off disk,
 * so the manifest and the writer computing it separately means the Agent can be handed
 * a path that does not exist. They were identical expressions until the byte clamp was
 * added to only one of them.
 */
export function kbDocFilename(id: string, name: string): string {
  const shortId = id.replace(/^kbd_/, '')
  const suffix = `-${shortId}.md`
  const slug =
    truncateToBytes(
      name
        .toLowerCase()
        .replace(/[^a-z0-9一-鿿]+/g, '-')
        .replace(/^-|-$/g, ''),
      MAX_FILENAME_BYTES - Buffer.byteLength(suffix, 'utf-8'),
    ) || 'doc'
  return `${slug}${suffix}`
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export interface KbDocFile {
  id: string
  name: string
  storagePath: string | null
}

/**
 * Sync KB documents to workspace .kb/ directory.
 * Copies content.md files from ./data/kb/kbd_xxx/ into {workDir}/.kb/{doc-name}.md
 */
export async function syncKbDocsToWorkspaceAsync(
  workDir: string,
  docs: KbDocFile[],
): Promise<void> {
  const kbRoot = join(workDir, KB_WORKSPACE_DIR)

  // Clean up previous managed KB directory
  if (await pathExists(kbRoot)) {
    const markerPath = join(kbRoot, KB_MANAGED_MARKER)
    if (await pathExists(markerPath)) {
      await rm(kbRoot, { recursive: true, force: true })
    }
  }

  await mkdir(kbRoot, { recursive: true })
  // Write managed marker
  await writeFile(join(kbRoot, KB_MANAGED_MARKER), '')

  for (const doc of docs) {
    if (!doc.storagePath) continue
    const sourceDir = getKbDocStoragePath(doc.storagePath)
    const contentPath = join(sourceDir, 'content.md')
    if (!(await pathExists(contentPath))) continue

    const destPath = join(kbRoot, kbDocFilename(doc.id, doc.name))
    await cp(contentPath, destPath, { force: true })
  }
}
