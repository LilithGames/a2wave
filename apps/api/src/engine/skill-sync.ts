/**
 * Skill file sync — writes agent skills into a designated workspace directory.
 *
 * A Provider declares where skills live via its `skillsDir` property (e.g. ".cursor/skills").
 * Before execution, BaseAgentEngine calls this module to materialize skills as files so the
 * engine (e.g. cursor-agent) can read them natively, instead of stuffing skills into the prompt.
 */

import { access, cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PRESET_PROVIDERS } from '@a2wave/shared'
import matter from 'gray-matter'
import { getSkillStoragePath } from '../lib/skill-storage.js'
import { slugify } from '../lib/slug.js'

const SKILL_MANAGED_MARKER = '.a2wave-managed'

/**
 * Workspace paths this writer owns: every Provider's skillsDir, at full depth
 * (".claude/skills", not ".claude"). Registered with
 * `platformWorkspacePaths()`, which derives the root-entry set from these.
 *
 * Depth matters: the dirty check excludes these paths from "is this agent
 * work?", and excluding all of `.claude` would let `reset --hard` silently
 * discard a repo-tracked `.claude/settings.json` the agent edited.
 */
export function skillSyncWorkspacePaths(): string[] {
  return PRESET_PROVIDERS.filter((preset) => preset.skillsDir).map(
    (preset) => preset.skillsDir as string,
  )
}

function resolveSkillsRoot(workDir: string, skillsDir: string): string {
  return join(workDir, skillsDir)
}

function resolveSkillDir(workDir: string, skillsDir: string, skillSlug: string): string {
  return join(workDir, skillsDir, skillSlug)
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function isManagedSkillDirAsync(dirPath: string): Promise<boolean> {
  if (!(await pathExists(dirPath))) return false
  const s = await stat(dirPath)
  if (!s.isDirectory()) return false
  return pathExists(join(dirPath, SKILL_MANAGED_MARKER))
}

async function resolveNonConflictingSkillDirAsync(
  workDir: string,
  skillsDir: string,
  baseSlug: string,
): Promise<string> {
  const fallbackBase = `${baseSlug}--a2w`
  for (let i = 0; i < 1000; i++) {
    const slug = i === 0 ? baseSlug : i === 1 ? fallbackBase : `${fallbackBase}-${i}`
    const dir = resolveSkillDir(workDir, skillsDir, slug)
    if (!(await pathExists(dir)) || (await isManagedSkillDirAsync(dir))) return dir
  }
  // Safety fallback: practically unreachable.
  return resolveSkillDir(workDir, skillsDir, `${baseSlug}--a2w-${Date.now()}`)
}

/** Skill data to be synced */
export interface SkillFile {
  name: string
  description?: string | null
  content: string | null
  storagePath?: string | null
}

/**
 * Assembles the SKILL.md content written into the workspace.
 *
 * The DB's `skill.content` is the body with frontmatter stripped at upload time (parseSkillMd
 * extracted name/description into dedicated columns). Some engines (e.g. the Codex CLI) require
 * SKILL.md to carry YAML frontmatter when loading a skill, otherwise they report
 * "missing YAML frontmatter" and skip it. Here we rebuild that frontmatter from name/description.
 *
 * Two edge cases (fixed in review):
 * 1) parseSkillMd strips only the first frontmatter block, so the DB body may still start with a
 *    `---` block (a two-part document, a horizontal rule in the body, or even invalid YAML).
 *    Both `matter()` and `matter.stringify(content, …)` parse the content — invalid YAML throws a
 *    YAMLException, which bubbles through prepareSkills past executeStream's fallback try and
 *    fails the run outright. Therefore:
 *      - the hasName probe is wrapped in try/catch;
 *      - serialization uses `matter.stringify('', data)` (empty body) and then concatenates the
 *        content verbatim: the serialization step never hands the content to gray-matter, so it
 *        does not rely on gray-matter's cache side effect (in practice `stringify(content)` only
 *        avoided throwing because the earlier `matter()` probe had populated the cache — it
 *        throws again after clearCache). Note the hasName probe itself still parses the content,
 *        hence the try/catch.
 * 2) Idempotence holds only when a valid `name` already exists, not when *any* frontmatter block
 *    is present — otherwise an incidental `---\nfoo: bar\n---` in the body would be mistaken for
 *    frontmatter and skipped, leaving the output without a name so Codex still skips it.
 *    Concatenating onto an empty body also prevents keys from the content's leading block being
 *    hoisted into the authoritative frontmatter.
 */
function composeSkillMd(skill: SkillFile): string {
  const content = skill.content ?? ''
  let hasName = false
  try {
    hasName = typeof matter(content).data?.name === 'string'
  } catch {
    hasName = false
  }
  if (hasName) return content
  const data: Record<string, string> = { name: skill.name }
  if (skill.description) data.description = skill.description
  return matter.stringify('', data) + content
}

/**
 * Asynchronously syncs skills into the designated workspace directory (without blocking the
 * event loop).
 *
 * Write layout (uniform directory structure):
 * - skills root directory: {workDir}/{skillsDir}
 * - individual skill directory: {skillsRoot}/{slugify(skill.name)}
 * - skill file: {skillDir}/SKILL.md
 *
 * Sync procedure:
 * 1) Create the skills root directory (if absent).
 * 2) Clean up stale a2wave-managed directories: only subdirectories containing the
 *    `.a2wave-managed` marker are removed. Directories without the marker are treated as
 *    hand-authored user content and left untouched.
 * 3) Write this batch of skills one by one:
 *    - the target directory defaults to the slug directory name;
 *    - on a collision with an existing user directory of the same name, it steps aside to
 *      `<slug>--a2w` (incrementing further if necessary);
 *    - `SKILL.md` and the marker file are written inside the directory.
 *
 * @param workDir   absolute path of the workspace root directory
 * @param skillsDir skills directory (relative to workDir), from Provider.skillsDir
 * @param skills    list of skills to sync
 */
export async function syncSkillsToWorkspaceAsync(
  workDir: string,
  skillsDir: string,
  skills: SkillFile[],
): Promise<void> {
  const skillsRoot = resolveSkillsRoot(workDir, skillsDir)
  await mkdir(skillsRoot, { recursive: true })

  // Only clean up a2wave-managed directories, so hand-created user content is never deleted.
  const entries = await readdir(skillsRoot)
  for (const entry of entries) {
    const entryPath = join(skillsRoot, entry)
    const s = await stat(entryPath)
    if (!s.isDirectory()) continue
    const markerPath = join(entryPath, SKILL_MANAGED_MARKER)
    if (await pathExists(markerPath)) {
      await rm(entryPath, { recursive: true, force: true })
    }
  }

  for (const skill of skills) {
    const skillSlug = slugify(skill.name)
    const skillDir = await resolveNonConflictingSkillDirAsync(workDir, skillsDir, skillSlug)
    await mkdir(skillDir, { recursive: true })

    if (skill.storagePath) {
      await copySkillStorageFilesAsync(skill.storagePath, skillDir)
    }

    await writeFile(join(skillDir, 'SKILL.md'), composeSkillMd(skill))
    await writeFile(join(skillDir, SKILL_MANAGED_MARKER), '')
  }
}

async function copySkillStorageFilesAsync(storagePath: string, targetDir: string): Promise<void> {
  const sourceDir = getSkillStoragePath(storagePath)
  if (!(await pathExists(sourceDir))) return

  const entries = await readdir(sourceDir)
  for (const name of entries) {
    if (name === 'SKILL.md') continue
    const src = join(sourceDir, name)
    const dest = join(targetDir, name)
    await cp(src, dest, { recursive: true, force: true })
  }
}
