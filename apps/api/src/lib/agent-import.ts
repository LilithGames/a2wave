import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import {
  chatAppConfigSchema,
  type GroupConfig,
  gitTriggerConfigSchemaFor,
  providerChainSchema,
} from '@a2wave/shared'
/**
 * Agent 导入逻辑
 * 从 ZIP 包或远程 URL 导入 Agent 及其关联实体。
 */
import AdmZip from 'adm-zip'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { agents, kbDocuments, mcpServers, providers, scmSources, skills } from '../db/schema.js'
import { withTransaction } from '../db/transaction.js'
import { providerCatalog } from '../engine/provider-catalog.js'
import { env } from '../env.js'
import {
  computeExportedSkillPackageDigest,
  type ExportedAgent,
  type ExportedMcpServer,
  type ExportedSkillMetadata,
  type ExportedSkillPackageFile,
  type ExportManifest,
  isRetiredOauthAccessMode,
  isSensitiveKey,
  REBINDABLE_SYSTEM_SKILL_NAMES,
} from './agent-export.js'
import { createId } from './id.js'
import { resolveUsageScope } from './mcp-stdio.js'
import { acquireScmPathMutationLock } from './scm-path-plan.js'
import { ensureDir, getSkillStoragePath, readAllSkillFiles } from './skill-storage.js'
import {
  createStreamingSafeFetch,
  parseTrustedHostnames,
  type StreamingSafeFetchOptions,
} from './streaming-safe-fetch.js'
import { isBlockedHost as isBlockedHostShared } from './url-safety.js'
import { assertSafeStrictUrl } from './url-safety-core.js'

// Re-export so existing imports (tests, mcp-servers.ts) keep working without mass rewrite.
export { isBlockedHost } from './url-safety.js'

// ============================================================
// Types
// ============================================================

export interface ImportResult {
  agent: { id: string; name: string }
  mcpServers: Array<{ id: string; name: string }>
  skills: Array<{ id: string; name: string }>
  warnings: string[]
}

// ============================================================
// Core Import
// ============================================================

const SUPPORTED_MANIFEST_VERSIONS = ['1.0']
const MAX_IMPORT_ZIP_BYTES = 50 * 1024 * 1024 // 50MB
const MAX_IMPORT_ERROR_BYTES = 64 * 1024
const DEFAULT_IMPORT_TIMEOUT_MS = 120_000
const MEMORY_SKILL_NAME = 'a2wave-memory'
const MASKED_CREDENTIAL = '********'

export interface AgentImportArchiveLimits {
  maxEntries: number
  maxEntryUncompressedBytes: number
  maxTotalUncompressedBytes: number
  maxSkillUncompressedBytes: number
  maxSkillFiles: number
  maxPathBytes: number
  maxPathSegmentBytes: number
}

/**
 * Agent imports may contain several Skills, so the archive-wide budget is
 * deliberately larger than the existing 10MiB per-Skill contract. Both local
 * and URL imports still retain their compressed request/download limits.
 */
export const AGENT_IMPORT_ARCHIVE_LIMITS: Readonly<AgentImportArchiveLimits> = {
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 10 * 1024 * 1024,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,
  maxSkillUncompressedBytes: 10 * 1024 * 1024,
  maxSkillFiles: 500,
  maxPathBytes: 1024,
  maxPathSegmentBytes: 255,
}

function getArchivedSkillPackageFiles(zip: AdmZip, dirName: string): ExportedSkillPackageFile[] {
  const prefix = `skills/${dirName}/`
  return zip
    .getEntries()
    .filter(
      (entry) =>
        !entry.isDirectory &&
        entry.entryName.startsWith(prefix) &&
        entry.entryName !== `${prefix}skill.json`,
    )
    .map((entry) => ({ path: entry.entryName.slice(prefix.length), data: entry.getData() }))
}

function getPersistedSkillPackageFiles(
  skill: typeof skills.$inferSelect,
): ExportedSkillPackageFile[] {
  const files = skill.storagePath
    ? readAllSkillFiles(skill.id)
        .filter((file) => file.path !== 'SKILL.md' && file.path !== 'skill.json')
        .map((file) => ({ path: file.path, data: file.content }))
    : []
  if (skill.content) {
    files.push({ path: 'SKILL.md', data: Buffer.from(skill.content, 'utf-8') })
  }
  return files
}

function formatBytes(bytes: number): string {
  if (bytes % (1024 * 1024) === 0) return `${bytes / 1024 / 1024}MB`
  if (bytes % 1024 === 0) return `${bytes / 1024}KB`
  return `${bytes} bytes`
}

function validateArchivePath(rawPath: string, limits: AgentImportArchiveLimits): string {
  if (
    !rawPath ||
    rawPath.includes('\0') ||
    rawPath.includes('\\') ||
    rawPath.startsWith('/') ||
    rawPath.startsWith('//') ||
    /^[a-zA-Z]:/.test(rawPath) ||
    rawPath.includes('//') ||
    Buffer.byteLength(rawPath, 'utf-8') > limits.maxPathBytes
  ) {
    throw new Error(`ZIP contains an illegal path: ${JSON.stringify(rawPath)}`)
  }

  const withoutDirectorySuffix = rawPath.endsWith('/') ? rawPath.slice(0, -1) : rawPath
  const segments = withoutDirectorySuffix.split('/')
  if (
    !withoutDirectorySuffix ||
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        Buffer.byteLength(segment, 'utf-8') > limits.maxPathSegmentBytes,
    )
  ) {
    throw new Error(`ZIP contains an illegal path: ${JSON.stringify(rawPath)}`)
  }
  return rawPath
}

function assertRawCentralDirectoryPaths(zipBuffer: Buffer, limits: AgentImportArchiveLimits): void {
  // EOCD is within the final 65,557 bytes (22-byte record + 65,535-byte comment).
  const minOffset = Math.max(0, zipBuffer.length - 65_557)
  let eocd = -1
  for (let offset = zipBuffer.length - 22; offset >= minOffset; offset--) {
    if (zipBuffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new Error('Invalid ZIP archive: end-of-central-directory record is missing')

  const diskNumber = zipBuffer.readUInt16LE(eocd + 4)
  const centralDisk = zipBuffer.readUInt16LE(eocd + 6)
  const entriesOnDisk = zipBuffer.readUInt16LE(eocd + 8)
  const totalEntries = zipBuffer.readUInt16LE(eocd + 10)
  const centralSize = zipBuffer.readUInt32LE(eocd + 12)
  const centralOffset = zipBuffer.readUInt32LE(eocd + 16)
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== totalEntries ||
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new Error('Invalid ZIP archive: multi-disk and ZIP64 archives are not supported')
  }
  if (totalEntries > limits.maxEntries) {
    throw new Error(`ZIP archive contains more than ${limits.maxEntries} entries`)
  }
  if (centralOffset + centralSize > eocd || centralOffset + centralSize > zipBuffer.length) {
    throw new Error('Invalid ZIP archive: central directory is out of bounds')
  }

  let offset = centralOffset
  for (let index = 0; index < totalEntries; index++) {
    if (offset + 46 > zipBuffer.length || zipBuffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('Invalid ZIP archive: malformed central directory entry')
    }
    const nameLength = zipBuffer.readUInt16LE(offset + 28)
    const extraLength = zipBuffer.readUInt16LE(offset + 30)
    const commentLength = zipBuffer.readUInt16LE(offset + 32)
    const entryEnd = offset + 46 + nameLength + extraLength + commentLength
    if (entryEnd > zipBuffer.length || entryEnd > centralOffset + centralSize) {
      throw new Error('Invalid ZIP archive: central directory entry is out of bounds')
    }
    const rawName = zipBuffer.subarray(offset + 46, offset + 46 + nameLength)
    validateArchivePath(rawName.toString('utf-8'), limits)
    offset = entryEnd
  }
  if (offset !== centralOffset + centralSize) {
    throw new Error('Invalid ZIP archive: central directory size does not match its entries')
  }
}

/**
 * Validate the entire archive before any entry is decompressed, parsed, written,
 * or used in a database transaction. The optional AdmZip input exists for unit
 * tests; production always passes the original Buffer so raw pre-sanitization
 * central-directory paths are checked as well.
 */
export function preflightAgentImportArchive(
  archive: Buffer | AdmZip,
  limits: AgentImportArchiveLimits = AGENT_IMPORT_ARCHIVE_LIMITS,
): void {
  const zip = Buffer.isBuffer(archive) ? new AdmZip(archive) : archive
  if (Buffer.isBuffer(archive)) assertRawCentralDirectoryPaths(archive, limits)
  const entries = zip.getEntries()
  if (entries.length > limits.maxEntries) {
    throw new Error(`ZIP archive contains more than ${limits.maxEntries} entries`)
  }

  const seenPaths = new Set<string>()
  const filePaths = new Set<string>()
  const requiredDirectories = new Set<string>()
  const skillBytes = new Map<string, number>()
  const skillFiles = new Map<string, number>()
  let totalBytes = 0
  for (const entry of entries) {
    const entryPath = validateArchivePath(entry.entryName, limits)
    const collisionKey = entryPath.replace(/\/$/, '').toLowerCase()
    if (seenPaths.has(collisionKey)) {
      throw new Error(`Duplicate ZIP entry path: ${entryPath}`)
    }
    seenPaths.add(collisionKey)
    const normalizedPath = entryPath.replace(/\/$/, '')
    const pathParts = normalizedPath.split('/')
    for (let index = 1; index < pathParts.length; index++) {
      const parentPath = pathParts.slice(0, index).join('/').toLowerCase()
      if (filePaths.has(parentPath)) {
        throw new Error(`ZIP entry path conflicts with a file: ${entryPath}`)
      }
      requiredDirectories.add(parentPath)
    }
    if (!entry.isDirectory) {
      if (requiredDirectories.has(collisionKey)) {
        throw new Error(`ZIP entry path conflicts with a directory: ${entryPath}`)
      }
      filePaths.add(collisionKey)
    }
    if (entry.isDirectory !== entryPath.endsWith('/')) {
      throw new Error(`ZIP contains an illegal path: ${JSON.stringify(entryPath)}`)
    }

    const unixMode = ((entry.attr ?? 0) >>> 16) & 0o170000
    if (unixMode === 0o120000) {
      throw new Error(`ZIP contains a symbolic link: ${entryPath}`)
    }

    const size = entry.header?.size
    const compressedSize = entry.header?.compressedSize
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(`ZIP entry ${entryPath} has an invalid uncompressed size`)
    }
    if (!Number.isSafeInteger(compressedSize) || compressedSize < 0) {
      throw new Error(`ZIP entry ${entryPath} has an invalid compressed size`)
    }
    if (entry.isDirectory && size !== 0) {
      throw new Error(`ZIP directory ${entryPath} has an invalid uncompressed size`)
    }
    if (size > limits.maxEntryUncompressedBytes) {
      throw new Error(
        `A single entry in the ZIP archive must not exceed ${formatBytes(limits.maxEntryUncompressedBytes)}`,
      )
    }
    totalBytes += size
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalUncompressedBytes) {
      throw new Error(
        `ZIP total uncompressed size must not exceed ${formatBytes(limits.maxTotalUncompressedBytes)}`,
      )
    }

    const parts = normalizedPath.split('/')
    if (parts[0] === 'skills' && parts.length >= 3 && !entry.isDirectory) {
      const skillName = parts[1]
      const nextBytes = (skillBytes.get(skillName) ?? 0) + size
      const nextFiles = (skillFiles.get(skillName) ?? 0) + 1
      if (nextBytes > limits.maxSkillUncompressedBytes) {
        throw new Error(
          `Skill ${skillName} must not exceed ${formatBytes(limits.maxSkillUncompressedBytes)} uncompressed`,
        )
      }
      if (nextFiles > limits.maxSkillFiles) {
        throw new Error(`Skill ${skillName} contains more than ${limits.maxSkillFiles} files`)
      }
      skillBytes.set(skillName, nextBytes)
      skillFiles.set(skillName, nextFiles)
    }
  }
}

/**
 * Blank out placeholder values in an imported MCP `env` / `headers` record.
 *
 * `sanitizeMcpServer` masks these with `maskAllStringRecord`, which replaces *every*
 * value unconditionally — so a placeholder arriving here can never be restored, and
 * writing it through would make '********' the credential itself. The field then reads
 * as configured while the remote answers 401 on every run. Blanking leaves the key
 * visible (the operator still sees which headers the server expects) with an obviously
 * empty value, which is the honest state.
 */
function clearMaskedRecord<T extends Record<string, string> | null | undefined>(record: T): T {
  if (!record) return record
  let cleared = false
  const next = Object.fromEntries(
    Object.entries(record).map(([key, value]) => {
      if (value !== MASKED_CREDENTIAL) return [key, value]
      cleared = true
      return [key, '']
    }),
  )
  return (cleared ? next : record) as T
}

/** True when any imported MCP `env` / `headers` value is a masked placeholder. */
function hasMaskedMcpCredential(mcp: ExportedMcpServer): boolean {
  const values = [...Object.values(mcp.headers ?? {}), ...Object.values(mcp.env ?? {})]
  return values.some((value) => value === MASKED_CREDENTIAL)
}

/**
 * True when an imported MCP server would introduce stdio command execution
 * (host RCE) — a top-level stdio server, or a group with an inline stdio
 * backend. Import must reject these for non-admins, mirroring the create gate,
 * so import can't be used to smuggle in an executable stdio server.
 */
function importedMcpIntroducesStdio(mcp: ExportedMcpServer): boolean {
  if (mcp.type === 'stdio') return true
  if (mcp.type === 'group' && mcp.groupConfig) {
    const backends = (mcp.groupConfig as { backends?: Record<string, unknown[]> }).backends
    for (const list of Object.values(backends ?? {})) {
      for (const b of list as Array<{ mode?: string; type?: string }>) {
        if (b.mode === 'inline' && b.type === 'stdio') return true
      }
    }
  }
  return false
}

/**
 * Keep Agent imports behind the same outbound URL boundary as direct MCP
 * creation. Imported JSON is untrusted and otherwise bypasses the route-level
 * validation before the MCP is persisted and exposed to Agent subprocesses.
 */
function assertImportedMcpUrlsSafe(mcp: ExportedMcpServer): void {
  if ((mcp.type === 'sse' || mcp.type === 'http') && mcp.url) {
    try {
      assertSafeStrictUrl(mcp.url)
    } catch {
      throw new Error('Imported MCP URL must be a public HTTP(S) address')
    }
  }

  if (mcp.type !== 'group' || !mcp.groupConfig) return
  const backends = (mcp.groupConfig as { backends?: Record<string, unknown[]> }).backends
  for (const [groupKey, list] of Object.entries(backends ?? {})) {
    for (const backend of list as Array<{
      mode?: string
      type?: string
      name?: string
      url?: string
    }>) {
      if (
        backend.mode !== 'inline' ||
        (backend.type !== 'sse' && backend.type !== 'http') ||
        !backend.url
      ) {
        continue
      }
      try {
        assertSafeStrictUrl(backend.url)
      } catch {
        throw new Error(
          `Imported MCP inline backend URL must be a public HTTP(S) address: ${groupKey}/${backend.name ?? 'unnamed'}`,
        )
      }
    }
  }
}

/** Import an Agent from a ZIP buffer. `allowStdio` gates stdio MCP servers to admins. */
export async function importAgentFromZip(
  zipBuffer: Buffer,
  userId: string,
  allowStdio = false,
): Promise<ImportResult> {
  if (zipBuffer.length > MAX_IMPORT_ZIP_BYTES) {
    throw new Error(`ZIP file must not exceed ${MAX_IMPORT_ZIP_BYTES / 1024 / 1024}MB`)
  }

  preflightAgentImportArchive(zipBuffer)
  const zip = new AdmZip(zipBuffer)
  const warnings: string[] = []

  // 1. Parse and validate manifest
  const manifestEntry = zip.getEntry('manifest.json')
  if (!manifestEntry) {
    throw new Error(
      'No manifest.json found in the ZIP archive; this is not a valid Agent export package',
    )
  }
  const manifest: ExportManifest = JSON.parse(manifestEntry.getData().toString('utf-8'))
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(manifest.version)) {
    throw new Error(
      `Unsupported export package version: ${manifest.version}. Supported versions: ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}`,
    )
  }

  // 2. Parse agent.json
  const agentEntry = zip.getEntry('agent.json')
  if (!agentEntry) {
    throw new Error('No agent.json found in the ZIP archive')
  }
  const exportedAgent: ExportedAgent = JSON.parse(agentEntry.getData().toString('utf-8'))

  // Collect skill file writes to perform AFTER transaction succeeds
  const pendingFileWrites: Array<{ path: string; data: Buffer }> = []
  const pendingDirs: string[] = []

  // Wrap all DB operations in a transaction so partial failures don't leave orphan records
  const result = await withTransaction(async (tx) => {
    // The import may bind its new Agent to an existing SCM source. Hold the
    // same transaction-scoped lifecycle lock used by source deletion so the
    // name lookup and Agent insert cannot straddle a deletion reservation.
    if (exportedAgent.scmSourceRef) {
      await acquireScmPathMutationLock(tx)
    }
    // 3. Import MCP Servers
    const mcpIdMap = new Map<string, string>() // ref filename -> new ID
    const importedMcps: Array<{ id: string; name: string }> = []
    // One warning covers the whole import: a bundle with ten servers should not stack
    // ten identical toasts.
    let warnedMaskedMcpCredential = false

    for (const ref of exportedAgent.mcpServerRefs) {
      if (!ref || ref.includes('/') || ref.includes('\\') || ref === '.' || ref === '..') {
        throw new Error(`Invalid MCP Server reference in Agent export: ${JSON.stringify(ref)}`)
      }
      const mcpEntry = zip.getEntry(`mcp-servers/${ref}`)
      if (!mcpEntry) {
        warnings.push(`MCP Server file mcp-servers/${ref} is missing from the ZIP archive; skipped`)
        continue
      }
      const mcpData: ExportedMcpServer = JSON.parse(mcpEntry.getData().toString('utf-8'))

      // stdio MCP = arbitrary host command execution; non-admin imports must not
      // create one (same bar as the create route). Reject the whole import so a
      // crafted ZIP can't smuggle in an executable stdio server.
      if (!allowStdio && importedMcpIntroducesStdio(mcpData)) {
        throw new Error('Only admin can import agents that define stdio MCP servers')
      }
      assertImportedMcpUrlsSafe(mcpData)

      if (hasMaskedMcpCredential(mcpData) && !warnedMaskedMcpCredential) {
        warnedMaskedMcpCredential = true
        warnings.push('MCP Server credentials are not imported; re-enter them before use')
      }

      // Always create new - add suffix if name exists
      const existingMcp = (
        await tx.select().from(mcpServers).where(eq(mcpServers.name, mcpData.name)).limit(1)
      )[0]
      const finalName = existingMcp ? `${mcpData.name} (Imported)` : mcpData.name

      const newId = createId('mcp')
      await tx.insert(mcpServers).values({
        id: newId,
        name: finalName,
        description: mcpData.description,
        type: mcpData.type as 'stdio' | 'sse' | 'http' | 'group',
        command: mcpData.command,
        args: mcpData.args,
        cwd: mcpData.cwd,
        url: mcpData.url,
        headers: clearMaskedRecord(mcpData.headers),
        env: clearMaskedRecord(mcpData.env),
        isEnabled: mcpData.isEnabled,
        // Imported groupConfig is opaque JSON shaped by sanitizeMcpServer;
        // cast to the schema's typed variant without revalidating backends.
        groupConfig: (mcpData.groupConfig ??
          null) as (typeof mcpServers.$inferInsert)['groupConfig'],
        // Same rule as create: stdio-capable forced admin-only, non-stdio →
        // 'private' (owner-only, self-service for the importer). An imported copy
        // is never auto-shared; the importer can share it later if they are admin.
        usageScope: resolveUsageScope({
          type: mcpData.type,
          groupConfig: mcpData.groupConfig as GroupConfig | null,
          requested: undefined,
          isAdmin: allowStdio,
          fallback: 'private',
        }),
        userId,
      })

      mcpIdMap.set(ref, newId)
      importedMcps.push({ id: newId, name: finalName })
    }

    // 4. Import Skills
    const skillIdMap = new Map<string, string>() // ref dir name -> new ID
    const importedSkills: Array<{ id: string; name: string }> = []
    let shouldDisableImportedMemory = false
    let boundSystemMemorySkillId: string | undefined

    for (const ref of exportedAgent.skillRefs) {
      const dirName = ref.replace(/\/$/, '')
      if (
        !dirName ||
        dirName.includes('/') ||
        dirName.includes('\\') ||
        dirName === '.' ||
        dirName === '..'
      ) {
        throw new Error(`Invalid Skill reference in Agent export: ${JSON.stringify(ref)}`)
      }
      const skillJsonEntry = zip.getEntry(`skills/${dirName}/skill.json`)
      if (!skillJsonEntry) {
        warnings.push(`Skill directory skills/${dirName} has no skill.json; skipped`)
        continue
      }
      const skillMeta = JSON.parse(
        skillJsonEntry.getData().toString('utf-8'),
      ) as ExportedSkillMetadata

      // ZIP metadata is attacker-controlled, so a system-builtin declaration is
      // only a candidate. Rebind it after both the declared digest and the target
      // system row's complete portable package match the actual archive bytes.
      const builtinOrigin =
        skillMeta.origin?.kind === 'system-builtin' ? skillMeta.origin : undefined
      const claimsBuiltinOrigin =
        builtinOrigin?.name === skillMeta.name && REBINDABLE_SYSTEM_SKILL_NAMES.has(skillMeta.name)
      let trustedBuiltin: typeof skills.$inferSelect | undefined
      let targetBuiltin: typeof skills.$inferSelect | undefined
      let builtinDowngradeReason: 'package-mismatch' | 'unverifiable-provenance' | undefined
      if (claimsBuiltinOrigin) {
        const archiveFiles = getArchivedSkillPackageFiles(zip, dirName)
        const archiveDigest = computeExportedSkillPackageDigest(skillMeta, archiveFiles)
        targetBuiltin = (
          await tx
            .select()
            .from(skills)
            .where(
              and(
                eq(skills.name, skillMeta.name),
                isNull(skills.userId),
                eq(skills.visibility, 'all-users'),
              ),
            )
            .limit(1)
        )[0]
        let targetDigest: string | undefined
        if (targetBuiltin) {
          try {
            targetDigest = computeExportedSkillPackageDigest(
              targetBuiltin,
              getPersistedSkillPackageFiles(targetBuiltin),
            )
          } catch {
            targetDigest = undefined
          }
        }
        if (builtinOrigin.digest === archiveDigest && targetDigest === archiveDigest) {
          trustedBuiltin = targetBuiltin
        } else {
          builtinDowngradeReason = 'package-mismatch'
        }
      } else if (
        skillMeta.origin?.kind === 'system-builtin' ||
        (skillMeta.origin === undefined && REBINDABLE_SYSTEM_SKILL_NAMES.has(skillMeta.name))
      ) {
        // Legacy archives cannot distinguish a platform built-in from a user's
        // same-name Skill. Preserve their contents instead of guessing by name or
        // expected filenames, and make the downgrade visible to the importer.
        builtinDowngradeReason = 'unverifiable-provenance'
        if (REBINDABLE_SYSTEM_SKILL_NAMES.has(skillMeta.name)) {
          targetBuiltin = (
            await tx
              .select()
              .from(skills)
              .where(
                and(
                  eq(skills.name, skillMeta.name),
                  isNull(skills.userId),
                  eq(skills.visibility, 'all-users'),
                ),
              )
              .limit(1)
          )[0]
        }
      }
      if (trustedBuiltin) {
        skillIdMap.set(ref, trustedBuiltin.id)
        importedSkills.push({ id: trustedBuiltin.id, name: trustedBuiltin.name })
        if (trustedBuiltin.name === MEMORY_SKILL_NAME) {
          boundSystemMemorySkillId = trustedBuiltin.id
        }
        continue
      }

      // Read SKILL.md content
      const skillMdEntry = zip.getEntry(`skills/${dirName}/SKILL.md`)
      const content = skillMdEntry ? skillMdEntry.getData().toString('utf-8') : null

      // Always create new - add suffix if name exists
      const existingSkill =
        targetBuiltin ??
        (await tx.select().from(skills).where(eq(skills.name, skillMeta.name)).limit(1))[0]
      const finalName = existingSkill ? `${skillMeta.name} (Imported)` : skillMeta.name

      const newId = createId('skl')
      const storagePath = newId

      await tx.insert(skills).values({
        id: newId,
        name: finalName,
        description: skillMeta.description,
        content,
        storagePath,
        userId,
        visibility: 'private',
      })

      // Collect skill files for writing after transaction succeeds
      const skillStoragePath = getSkillStoragePath(newId)
      pendingDirs.push(skillStoragePath)

      const prefix = `skills/${dirName}/`
      for (const entry of zip.getEntries()) {
        if (entry.isDirectory) continue
        if (!entry.entryName.startsWith(prefix)) continue
        if (entry.entryName === `${prefix}skill.json`) continue // skip metadata

        const relativePath = entry.entryName.slice(prefix.length)
        if (!relativePath) continue

        const resolvedSkillStoragePath = resolve(skillStoragePath)
        const targetPath = resolve(resolvedSkillStoragePath, relativePath)
        if (
          targetPath !== resolvedSkillStoragePath &&
          !targetPath.startsWith(resolvedSkillStoragePath + sep)
        ) {
          throw new Error(`Skill file path escapes its storage directory: ${relativePath}`)
        }
        pendingDirs.push(dirname(targetPath))
        pendingFileWrites.push({ path: targetPath, data: entry.getData() })
      }

      const isDowngradedMemory =
        skillMeta.name === MEMORY_SKILL_NAME && builtinDowngradeReason !== undefined
      if (isDowngradedMemory && targetBuiltin) {
        // Keep the untrusted package for inspection without mounting it. Memory
        // enable/disable controls are defined in terms of the seeded system Skill,
        // so binding the target row prevents a downgraded copy from surviving an
        // otherwise successful memory disable operation.
        skillIdMap.set(ref, targetBuiltin.id)
        importedSkills.push({ id: targetBuiltin.id, name: targetBuiltin.name })
        boundSystemMemorySkillId = targetBuiltin.id
        warnings.push(
          builtinDowngradeReason === 'package-mismatch'
            ? `Skill "${skillMeta.name}" could not verify its built-in provenance against the target instance; its packaged contents were preserved as a private copy and the target built-in Skill was bound`
            : `Skill "${skillMeta.name}" has no verifiable built-in provenance; its packaged contents were preserved as a private copy and the target built-in Skill was bound`,
        )
      } else if (isDowngradedMemory) {
        importedSkills.push({ id: newId, name: finalName })
        shouldDisableImportedMemory = true
        warnings.push(
          builtinDowngradeReason === 'package-mismatch'
            ? `Skill "${skillMeta.name}" could not verify its built-in provenance and the target built-in Skill is unavailable; its packaged contents were preserved as an unbound private copy and long-term memory was disabled`
            : `Skill "${skillMeta.name}" has no verifiable built-in provenance and the target built-in Skill is unavailable; its packaged contents were preserved as an unbound private copy and long-term memory was disabled`,
        )
      } else {
        skillIdMap.set(ref, newId)
        importedSkills.push({ id: newId, name: finalName })
        if (builtinDowngradeReason === 'package-mismatch') {
          warnings.push(
            `Skill "${skillMeta.name}" could not verify its built-in provenance against the target instance; imported as a private copy`,
          )
        } else if (builtinDowngradeReason === 'unverifiable-provenance') {
          warnings.push(
            `Skill "${skillMeta.name}" has no verifiable built-in provenance; imported as a private copy`,
          )
        }
      }
    }

    // 5. Resolve Provider by name
    let providerId: string | null = null
    let providerAuthMode: (typeof agents.$inferInsert)['authMode'] = 'apiKey'
    if (exportedAgent.providerRef) {
      const provider = (
        await tx
          .select()
          .from(providers)
          .where(eq(providers.name, exportedAgent.providerRef))
          .limit(1)
      )[0]
      if (provider) {
        providerId = provider.id
        providerAuthMode =
          providerCatalog.get(provider.kind)?.manifest.capabilities.defaultAuthMode ?? 'apiKey'
      } else {
        warnings.push(
          `Provider "${exportedAgent.providerRef}" does not exist on the target instance; it was cleared and must be configured manually`,
        )
      }
    }

    // 6. Resolve SCM Source by name
    let scmSourceId: string | null = null
    if (exportedAgent.scmSourceRef) {
      const scm = (
        await tx
          .select()
          .from(scmSources)
          .where(
            and(
              eq(scmSources.name, exportedAgent.scmSourceRef),
              isNull(scmSources.deletionRequestedAt),
            ),
          )
          .limit(1)
      )[0]
      if (scm) {
        scmSourceId = scm.id
      } else {
        warnings.push(
          `SCM Source "${exportedAgent.scmSourceRef}" does not exist on the target instance; it was cleared and must be configured manually`,
        )
      }
    }

    // 7. Resolve KB Documents by name
    const kbDocIds: string[] = []
    for (const docName of exportedAgent.kbDocumentRefs) {
      const doc = (
        await tx.select().from(kbDocuments).where(eq(kbDocuments.name, docName)).limit(1)
      )[0]
      if (doc) {
        kbDocIds.push(doc.id)
      } else {
        warnings.push(
          `Knowledge base document "${docName}" does not exist on the target instance; skipped`,
        )
      }
    }

    // 8. Create Agent - add suffix only if name already exists
    const agentId = createId('agt')
    const existingAgent = (
      await tx.select().from(agents).where(eq(agents.name, exportedAgent.name)).limit(1)
    )[0]
    const agentName = existingAgent ? `${exportedAgent.name} (Imported)` : exportedAgent.name

    const newMcpIds = exportedAgent.mcpServerRefs
      .map((ref) => mcpIdMap.get(ref))
      .filter((id): id is string => !!id)

    const newSkillIds = exportedAgent.skillRefs
      .map((ref) => skillIdMap.get(ref))
      .filter((id): id is string => !!id)

    // Public share archives deliberately omit every Skill package and reference.
    // Keep the long-term-memory switch authoritative anyway: an enabled import
    // must bind the seeded system Skill, never land with an enabled switch and no
    // runtime capability. Other malformed/legacy archives receive the same repair.
    const importedMemoryRequested =
      (exportedAgent.config as { memoryEnabled?: unknown } | null | undefined)?.memoryEnabled ===
      true
    if (importedMemoryRequested && !shouldDisableImportedMemory && !boundSystemMemorySkillId) {
      const targetMemorySkill = (
        await tx
          .select()
          .from(skills)
          .where(
            and(
              eq(skills.name, MEMORY_SKILL_NAME),
              isNull(skills.userId),
              eq(skills.visibility, 'all-users'),
            ),
          )
          .limit(1)
      )[0]
      if (targetMemorySkill) {
        newSkillIds.push(targetMemorySkill.id)
        importedSkills.push({ id: targetMemorySkill.id, name: targetMemorySkill.name })
        boundSystemMemorySkillId = targetMemorySkill.id
      } else {
        shouldDisableImportedMemory = true
        warnings.push(
          'Long-term memory was disabled because the target built-in Skill "a2wave-memory" is unavailable',
        )
      }
    }

    const importedConfig = shouldDisableImportedMemory
      ? { ...(exportedAgent.config ?? {}), memoryEnabled: false }
      : exportedAgent.config

    // The provider chain cap is a create/update-schema rule, and import writes
    // `config` verbatim — so validate here too rather than let an oversized chain
    // land in the DB and fail only at execution time. Reusing the same schema keeps
    // the two boundaries from drifting apart.
    const importedChain = (exportedAgent.config as { providerChain?: unknown } | null | undefined)
      ?.providerChain
    if (importedChain !== undefined) {
      const parsed = providerChainSchema.safeParse(importedChain)
      if (!parsed.success) {
        throw new Error(
          `Imported Agent "${exportedAgent.name}" has an invalid provider chain: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        )
      }
    }

    // Same boundary discipline as the provider chain above: the chat page config
    // is rendered straight into the page, so a malformed import (hand-edited ZIP,
    // an export from a newer/older schema) would surface as a crashed page rather
    // than a rejected import. Normalised through the schema so defaults are filled
    // in too.
    // Validate rather than trust: a hand-edited export with an out-of-range
    // interval would otherwise be persisted and then rejected at poll time,
    // leaving a channel that looks configured but never fires.
    // Generic over the provider so each column receives only its own variant —
    // the schema itself now rejects the cross-assignment that three separate
    // write paths previously had to remember to guard against by hand.
    const parseGitTriggerConfig = <P extends 'glab' | 'gh'>(
      value: unknown,
      expectedProvider: P,
    ): P extends 'glab'
      ? (typeof agents.$inferInsert)['glabConfig']
      : (typeof agents.$inferInsert)['ghConfig'] => {
      const none = null as P extends 'glab'
        ? (typeof agents.$inferInsert)['glabConfig']
        : (typeof agents.$inferInsert)['ghConfig']
      if (value == null) return none
      const parsed = gitTriggerConfigSchemaFor(expectedProvider).safeParse(value)
      if (!parsed.success) {
        warnings.push(
          `${expectedProvider} trigger config is invalid and was dropped (${parsed.error.issues[0]?.message ?? 'validation failed'}); reconfigure the channel before publishing`,
        )
        return none
      }
      // A provider mismatch no longer needs its own branch: the provider-bound
      // schema rejects it as a validation failure above, with the same warning.
      return parsed.data as P extends 'glab'
        ? (typeof agents.$inferInsert)['glabConfig']
        : (typeof agents.$inferInsert)['ghConfig']
    }
    const importedGlabConfig = parseGitTriggerConfig(exportedAgent.glabConfig, 'glab')
    const importedGhConfig = parseGitTriggerConfig(exportedAgent.ghConfig, 'gh')

    let importedChatAppConfig: (typeof agents.$inferInsert)['chatAppConfig'] = null
    if (exportedAgent.chatAppConfig != null) {
      const parsed = chatAppConfigSchema.safeParse(exportedAgent.chatAppConfig)
      if (!parsed.success) {
        throw new Error(
          `Imported Agent "${exportedAgent.name}" has an invalid chat page config: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        )
      }
      importedChatAppConfig = parsed.data
    }

    const exportedPublishChannels = exportedAgent.publishChannels ?? []
    // A git-trigger channel whose config was dropped must not stay enabled:
    // publishing it would show the channel as live while nothing ever polls.
    const droppedGitChannels = new Set<string>()
    if (exportedPublishChannels.includes('glab') && !importedGlabConfig) {
      droppedGitChannels.add('glab')
    }
    if (exportedPublishChannels.includes('gh') && !importedGhConfig) {
      droppedGitChannels.add('gh')
    }
    for (const channel of droppedGitChannels) {
      warnings.push(`${channel} channel was disabled because it has no usable trigger config`)
    }
    const importedPublishChannels = exportedPublishChannels.filter(
      (channel) =>
        channel !== 'slack' &&
        channel !== 'discord' &&
        channel !== 'qq_official' &&
        !droppedGitChannels.has(channel),
    )
    if (exportedPublishChannels.includes('slack') || exportedAgent.slackConfig) {
      warnings.push('Slack credentials are not imported; reconfigure Slack before publishing')
    }
    if (exportedPublishChannels.includes('discord') || exportedAgent.discordConfig) {
      warnings.push('Discord credentials are not imported; reconfigure Discord before publishing')
    }
    if (exportedPublishChannels.includes('qq_official') || exportedAgent.qqOfficialConfig) {
      warnings.push(
        'QQ Official credentials are not imported; reconfigure QQ Official before publishing',
      )
    }

    let omittedA2ARouteCredentials = false
    const importedA2ARouteTargets = exportedAgent.a2aRouteTargets?.map((target) => {
      if (
        target &&
        typeof target === 'object' &&
        !Array.isArray(target) &&
        (target as Record<string, unknown>).type === 'remote' &&
        (target as Record<string, unknown>).apiKey === MASKED_CREDENTIAL
      ) {
        omittedA2ARouteCredentials = true
        const { apiKey: _, ...withoutCredential } = target as Record<string, unknown>
        return withoutCredential
      }
      return target
    })
    if (omittedA2ARouteCredentials) {
      warnings.push(
        'Remote A2A route credentials are not imported; reconfigure protected routes before use',
      )
    }

    // Export masks sensitive values to the placeholder, so importing one verbatim would
    // make '********' the credential itself: every run authenticates with the literal
    // dots while the UI, which renders any sensitive value as dots, looks correctly
    // configured. Clear it so the field reads as empty and asks to be filled in.
    //
    // The condition mirrors `sanitizeAgent`'s `v.sensitive || isSensitiveKey(k)` exactly.
    // Matching on the flag alone would miss a key-name-detected secret, which exports as
    // dots while keeping `sensitive: false`.
    //
    // Such an entry is also promoted to `sensitive: true`. Export judged it a secret by
    // name, and importing that judgement is the whole point: leaving the flag false means
    // the value the user retypes is stored unmasked and returned verbatim by every
    // `GET /agents/:id` — `maskSensitiveEnv` masks on the flag alone — so every viewer of
    // the Agent reads a live credential that the source instance at least masked.
    let omittedSensitiveEnv = false
    const importedEnv = exportedAgent.env
      ? Object.fromEntries(
          Object.entries(
            exportedAgent.env as Record<string, { value: string; sensitive: boolean }>,
          ).map(([key, entry]) => {
            if (entry?.value === MASKED_CREDENTIAL && (entry.sensitive || isSensitiveKey(key))) {
              omittedSensitiveEnv = true
              return [key, { ...entry, value: '', sensitive: true }]
            }
            return [key, entry]
          }),
        )
      : exportedAgent.env
    if (omittedSensitiveEnv) {
      warnings.push(
        'Sensitive environment variable values are not imported; re-enter them before use',
      )
    }

    await tx.insert(agents).values({
      id: agentId,
      name: agentName,
      description: exportedAgent.description,
      type: exportedAgent.type as 'llm' | 'cursor' | 'script',
      config: importedConfig,
      status: 'active',
      icon: exportedAgent.icon,
      systemPrompt: exportedAgent.systemPrompt,
      skills: newSkillIds,
      mcpServerIds: newMcpIds,
      kbDocumentIds: kbDocIds,
      publishStatus: 'draft',
      providerApiKey: null,
      providerBaseUrl: null,
      providerOauthToken: null,
      endpointApiKey: null,
      publishAuthType: 'api_key',
      publishIpWhitelist: [],
      publishDescription: null,
      publishChannels: importedPublishChannels as Array<
        | 'api'
        | 'a2a'
        | 'feishu'
        | 'slack'
        | 'discord'
        | 'qq_official'
        | 'schedule'
        | 'oauth'
        | 'chat_app'
      >,
      // Same fail-closed landing as migration 0100, so an old bundle cannot import an Agent
      // more open than the one it was exported from.
      //
      // A *missing* mode counts as `feishu_scope`, not as the new default: bundles exported
      // before 0071 carry no `oauthAccessMode`, yet their source Agent ran on this column's
      // old DEFAULT — which was `feishu_scope`, i.e. restricted. Reading absence as
      // `all_idaas_users` would republish it open to every OIDC-authenticated user.
      //
      // And as in 0100, "restricted" only means something for a bundle that actually
      // publishes the oauth channel; everything else lands on the new default rather than
      // importing as a deny-all Agent nobody asked for.
      oauthAccessMode: isRetiredOauthAccessMode(exportedAgent.oauthAccessMode)
        ? importedPublishChannels.includes('oauth')
          ? 'specified_users'
          : 'all_idaas_users'
        : exportedAgent.oauthAccessMode,
      // Never carried by a bundle (see agent-export.ts), so an imported `specified_users`
      // Agent always starts deny-all until its new owner enters their own roster.
      oauthAllowedEmails: null,
      a2aSkills: exportedAgent.a2aSkills as (typeof agents.$inferInsert)['a2aSkills'],
      a2aRouteTargets: importedA2ARouteTargets as (typeof agents.$inferInsert)['a2aRouteTargets'],
      showLocalChildOutput: exportedAgent.showLocalChildOutput,
      showRemoteChildOutput: exportedAgent.showRemoteChildOutput,
      feishuConfig: exportedAgent.feishuConfig as (typeof agents.$inferInsert)['feishuConfig'],
      slackConfig: null,
      discordConfig: null,
      qqOfficialConfig: null,
      // Carries presentation copy only, so unlike Slack/Discord there is no
      // credential to strip and it round-trips intact.
      chatAppConfig: importedChatAppConfig,
      scheduleConfig:
        exportedAgent.scheduleConfig as (typeof agents.$inferInsert)['scheduleConfig'],
      glabConfig: importedGlabConfig,
      ghConfig: importedGhConfig,
      publishedAt: null,
      providerId,
      authMode: providerAuthMode,
      env: importedEnv as (typeof agents.$inferInsert)['env'],
      workspaceType: exportedAgent.workspaceType as 'scm' | 'temp',
      scmSourceId,
      maxConcurrency: exportedAgent.maxConcurrency,
      userId,
    })

    // Skill files are written INSIDE the transaction, as its last step. Writing
    // them after the commit meant an ENOSPC/EDQUOT here left committed skills
    // rows whose storagePath was empty or half-written — the operator saw a 500
    // and reasonably concluded nothing was imported, while every later run of
    // the Agent silently mounted an incomplete skill package. Throwing here now
    // rolls the rows back; the directories are cleaned up so a retry starts
    // from a clean slate rather than adding an "(Imported)" duplicate set.
    const createdDirs: string[] = []
    try {
      for (const dir of pendingDirs) {
        if (!existsSync(dir)) createdDirs.push(dir)
        ensureDir(dir)
      }
      for (const { path, data } of pendingFileWrites) {
        writeFileSync(path, data)
      }
    } catch (err) {
      for (const dir of createdDirs) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // Best-effort: the rethrown error is what the operator acts on, and
          // the transaction rollback is what keeps the database consistent.
        }
      }
      throw err
    }

    return {
      agent: { id: agentId, name: agentName },
      mcpServers: importedMcps,
      skills: importedSkills,
      warnings,
    }
  })

  return result
}

// ============================================================
// SSRF Protection
// ============================================================
// The full isBlockedHost implementation lives in ./url-safety.ts (including the
// TRUSTED_IMPORT_HOSTS allowance). What remains here is only validateImportUrl:
// the agent-import-specific entry semantics and its error messages.

/** ZIP magic bytes: PK\x03\x04 */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/** Validate that a URL is safe for server-side fetch */
export function validateImportUrl(rawUrl: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }

  // Only allow http(s)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only the http/https protocols are supported')
  }

  // Block private/internal hosts (agent-import 走带 TRUSTED_IMPORT_HOSTS 放行的版本)
  if (isBlockedHostShared(parsed.hostname)) {
    throw new Error('Access to internal network addresses is not allowed')
  }

  return parsed
}

/** Check if content-type or buffer looks like a ZIP */
function isZipContent(contentType: string, buffer: Buffer): boolean {
  // Check common ZIP content-type variants
  const zipTypes = [
    'application/zip',
    'application/x-zip',
    'application/x-zip-compressed',
    'application/octet-stream',
  ]
  if (zipTypes.some((t) => contentType.includes(t))) return true

  // Fallback: check ZIP magic bytes (PK\x03\x04)
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_MAGIC)) return true

  return false
}

// ============================================================
// URL Import
// ============================================================

/** Import an Agent from a remote a2wave instance export URL */
export async function importAgentFromUrl(
  url: string,
  userId: string,
  headers?: Record<string, string>,
  allowStdio = false,
  fetchOptions: StreamingSafeFetchOptions & { timeoutMs?: number } = {},
): Promise<ImportResult> {
  // Preserve the import-specific protocol/literal-host error contract before
  // entering the stronger DNS-resolving transport.
  validateImportUrl(url)

  const timeoutMs = fetchOptions.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS
  const controller = new AbortController()
  const timeoutError = new Error(
    `Remote Agent download timed out after ${Math.ceil(timeoutMs / 1000)} seconds`,
  )
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort(timeoutError)
      reject(timeoutError)
    }, timeoutMs)
  })

  const {
    timeoutMs: _timeoutMs,
    trustedHosts = parseTrustedHostnames(env.TRUSTED_IMPORT_HOSTS),
    ...transportOptions
  } = fetchOptions
  const fetchRemote = createStreamingSafeFetch({
    ...transportOptions,
    trustedHosts,
  })

  const download = async (): Promise<Buffer> => {
    const res = await fetchRemote(url, {
      headers: headers ?? {},
      signal: controller.signal,
    })

    if (!res.ok) {
      const text = await readBoundedText(res, MAX_IMPORT_ERROR_BYTES)
      throw new Error(
        `Failed to download from the remote URL: ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`,
      )
    }

    const zipBuffer = await readBoundedImportBody(res)
    const contentType = res.headers.get('content-type') ?? ''
    if (!isZipContent(contentType, zipBuffer)) {
      throw new Error(`The remote URL did not return a ZIP file (Content-Type: ${contentType})`)
    }
    return zipBuffer
  }

  try {
    const zipBuffer = await Promise.race([download(), timeout])
    return importAgentFromZip(zipBuffer, userId, allowStdio)
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

function parseContentLength(res: Response): number | undefined {
  const raw = res.headers.get('content-length')
  if (!raw || !/^\d+$/.test(raw.trim())) return undefined
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

async function readBoundedImportBody(res: Response): Promise<Buffer> {
  const declaredLength = parseContentLength(res)
  if (declaredLength !== undefined && declaredLength > MAX_IMPORT_ZIP_BYTES) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`ZIP file must not exceed ${MAX_IMPORT_ZIP_BYTES / 1024 / 1024}MB`)
  }
  if (!res.body) return Buffer.alloc(0)

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_IMPORT_ZIP_BYTES) {
      await reader.cancel().catch(() => {})
      throw new Error(`ZIP file must not exceed ${MAX_IMPORT_ZIP_BYTES / 1024 / 1024}MB`)
    }
    chunks.push(value)
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  )
}

async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    const remaining = maxBytes - total
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining))
      total += remaining
      truncated = true
      break
    }
    chunks.push(value)
    total += value.byteLength
  }
  if (truncated || total >= maxBytes) await reader.cancel().catch(() => {})
  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString('utf-8')
  return truncated ? `${text}…` : text
}
