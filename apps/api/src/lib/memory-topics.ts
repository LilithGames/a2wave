import { createHash, randomBytes } from 'node:crypto'
import matter from 'gray-matter'
import { logger } from './logger.js'
import {
  deleteMemoryFile,
  listMemoryFiles,
  readMemoryFile,
  writeMemoryFile,
} from './memory-storage.js'

export const MEMORY_MAIN_FILE = 'MEMORY.md'
export const TOPIC_CATALOG_START = '<!-- a2wave-topic-catalog:start -->'
export const TOPIC_CATALOG_END = '<!-- a2wave-topic-catalog:end -->'
export const ACTIVE_TOPIC_DIR = 'memory/topics'
export const ARCHIVED_TOPIC_DIR = 'memory/topics/archive'

export const MEMORY_MAIN_SUMMARY_HARD_TOKENS = 500
export const MEMORY_MAIN_CATALOG_HARD_TOKENS = 700
export const MEMORY_MAIN_HARD_TOKENS = 1400
export const MEMORY_TOPIC_SOFT_TOKENS = 1500
export const MEMORY_TOPIC_HARD_TOKENS = 2000
export const MEMORY_ACTIVE_TOPIC_LIMIT = 16
export const MEMORY_ACTIVE_TOPICS_BYTES_LIMIT = 64 * 1024
export const MEMORY_TOPIC_KEYWORD_LIMIT = 6
export const MEMORY_TOPIC_DESCRIPTION_LIMIT = 100
export const MEMORY_TOPIC_SCOPE_LIMIT = 240
export const MEMORY_TOPIC_EVIDENCE_POINTER_LIMIT = 20

const TOPIC_ID_PATTERN = /^tpc_[a-f0-9]{8}$/
const ACTIVE_TOPIC_PATH_PATTERN = /^memory\/topics\/(tpc_[a-f0-9]{8})-([a-z0-9-]+)\.md$/
const ARCHIVED_TOPIC_PATH_PATTERN = /^memory\/topics\/archive\/(tpc_[a-f0-9]{8})-([a-z0-9-]+)\.md$/
const ALLOWED_TOPIC_SECTIONS = new Set([
  'Durable Knowledge',
  'Decisions and Conventions',
  'Workflows',
  'Failure Patterns',
  'Evidence Pointers',
])

export type MemoryHierarchyMode = 'empty' | 'legacy_single_file' | 'topic_v2'
export type MemoryTopicStatus = 'active' | 'archived'
export type MemoryTopicSection =
  | 'Durable Knowledge'
  | 'Decisions and Conventions'
  | 'Workflows'
  | 'Failure Patterns'
  | 'Evidence Pointers'

export interface MemoryTopicMetadata {
  topicId: string
  title: string
  scope: string
  description: string
  keywords: string[]
  status: MemoryTopicStatus
  updatedAt: string
}

export interface MemoryTopicRecord extends MemoryTopicMetadata {
  path: string
  body: string
  size: number
  tokenCount: number
  needsReorganization: boolean
}

export interface MemoryTopicList {
  mode: MemoryHierarchyMode
  topics: MemoryTopicRecord[]
  invalidFiles: string[]
}

export interface MemoryTopicInsight {
  topicId?: string
  title: string
  scope: string
  description: string
  keywords: string[]
  section: MemoryTopicSection
  items: string[]
}

export interface MemoryTopicWriteResult {
  topic: MemoryTopicRecord | null
  created: boolean
  warning: 'needs_reorganization' | null
  retainedInHistory: boolean
  reason?: 'insufficient_new_topic_content' | 'topic_hard_limit'
}

export interface MemoryTopicSplitReplacement {
  title: string
  scope: string
  description: string
  keywords: string[]
  sections: Array<{
    section: MemoryTopicSection
    items: Array<{ sourceHash: string; content: string }>
  }>
}

export class MemoryTopicError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'MemoryTopicError'
  }
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new MemoryTopicError('INVALID_TOPIC_METADATA', `${field} is required`)
  }
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length > maxLength) {
    throw new MemoryTopicError(
      'INVALID_TOPIC_METADATA',
      `${field} must not exceed ${maxLength} characters`,
    )
  }
  return normalized
}

function normalizedKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new MemoryTopicError('INVALID_TOPIC_METADATA', 'keywords must be an array')
  }
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const keyword = item.trim().replace(/\s+/g, ' ')
    if (!keyword || keyword.length > 40) continue
    const key = keyword.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(keyword)
  }
  if (result.length === 0 || result.length > MEMORY_TOPIC_KEYWORD_LIMIT) {
    throw new MemoryTopicError(
      'INVALID_TOPIC_METADATA',
      `keywords must contain 1-${MEMORY_TOPIC_KEYWORD_LIMIT} unique values`,
    )
  }
  return result
}

export function estimateMemoryTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0xff) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

export function slugifyTopicTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'topic'
}

export function createTopicId(): string {
  return `tpc_${randomBytes(4).toString('hex')}`
}

export function topicPath(
  metadata: Pick<MemoryTopicMetadata, 'topicId' | 'title' | 'status'>,
): string {
  const dir = metadata.status === 'active' ? ACTIVE_TOPIC_DIR : ARCHIVED_TOPIC_DIR
  return `${dir}/${metadata.topicId}-${slugifyTopicTitle(metadata.title)}.md`
}

export function detectMemoryHierarchyMode(agentId: string): MemoryHierarchyMode {
  try {
    const main = readMemoryFile(agentId, MEMORY_MAIN_FILE)
    return main.includes(TOPIC_CATALOG_START) && main.includes(TOPIC_CATALOG_END)
      ? 'topic_v2'
      : 'legacy_single_file'
  } catch (err) {
    if (err instanceof Error && err.message === 'File not found') return 'empty'
    throw err
  }
}

export function isMemoryTopicPath(path: string): boolean {
  return ACTIVE_TOPIC_PATH_PATTERN.test(path) || ARCHIVED_TOPIC_PATH_PATTERN.test(path)
}

function parseTopicStatus(value: unknown): MemoryTopicStatus {
  if (value === 'active' || value === 'archived') return value
  throw new MemoryTopicError('INVALID_TOPIC_METADATA', 'status must be active or archived')
}

export function parseMemoryTopicFile(path: string, content: string): MemoryTopicRecord {
  const activeMatch = path.match(ACTIVE_TOPIC_PATH_PATTERN)
  const archivedMatch = path.match(ARCHIVED_TOPIC_PATH_PATTERN)
  const pathMatch = activeMatch ?? archivedMatch
  if (!pathMatch) {
    throw new MemoryTopicError('INVALID_TOPIC_PATH', 'Invalid topic path')
  }

  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(content)
  } catch {
    throw new MemoryTopicError('INVALID_TOPIC_FRONTMATTER', 'Invalid topic frontmatter')
  }

  const topicId = requiredString(parsed.data.topic_id, 'topic_id', 20)
  if (!TOPIC_ID_PATTERN.test(topicId) || topicId !== pathMatch[1]) {
    throw new MemoryTopicError('INVALID_TOPIC_METADATA', 'topic_id does not match the topic path')
  }
  const title = requiredString(parsed.data.title, 'title', 80)
  const scope = requiredString(parsed.data.scope, 'scope', MEMORY_TOPIC_SCOPE_LIMIT)
  const description = requiredString(
    parsed.data.description,
    'description',
    MEMORY_TOPIC_DESCRIPTION_LIMIT,
  )
  const keywords = normalizedKeywords(parsed.data.keywords)
  const status = parseTopicStatus(parsed.data.status)
  const expectedStatus: MemoryTopicStatus = activeMatch ? 'active' : 'archived'
  if (status !== expectedStatus) {
    throw new MemoryTopicError('INVALID_TOPIC_METADATA', 'status does not match the topic path')
  }
  const updatedAt = requiredString(parsed.data.updated_at, 'updated_at', 40)
  if (Number.isNaN(Date.parse(updatedAt))) {
    throw new MemoryTopicError('INVALID_TOPIC_METADATA', 'updated_at must be an ISO date')
  }

  const body = parsed.content.trim()
  if (!body.startsWith(`# ${title}`)) {
    throw new MemoryTopicError('INVALID_TOPIC_BODY', 'Topic body must start with its title')
  }
  const tokenCount = estimateMemoryTokens(body)

  return {
    topicId,
    title,
    scope,
    description,
    keywords,
    status,
    updatedAt: new Date(updatedAt).toISOString(),
    path,
    body,
    size: Buffer.byteLength(content, 'utf8'),
    tokenCount,
    needsReorganization: tokenCount >= MEMORY_TOPIC_SOFT_TOKENS,
  }
}

export function renderMemoryTopicFile(metadata: MemoryTopicMetadata, body: string): string {
  const topicId = requiredString(metadata.topicId, 'topic_id', 20)
  if (!TOPIC_ID_PATTERN.test(topicId)) {
    throw new MemoryTopicError('INVALID_TOPIC_METADATA', 'Invalid topic_id')
  }
  const title = requiredString(metadata.title, 'title', 80)
  const scope = requiredString(metadata.scope, 'scope', MEMORY_TOPIC_SCOPE_LIMIT)
  const description = requiredString(
    metadata.description,
    'description',
    MEMORY_TOPIC_DESCRIPTION_LIMIT,
  )
  const keywords = normalizedKeywords(metadata.keywords)
  const status = parseTopicStatus(metadata.status)
  const updatedAt = new Date(metadata.updatedAt)
  if (Number.isNaN(updatedAt.getTime())) {
    throw new MemoryTopicError('INVALID_TOPIC_METADATA', 'Invalid updated_at')
  }
  const normalizedBody = body.trim()
  if (!normalizedBody.startsWith(`# ${title}`)) {
    throw new MemoryTopicError('INVALID_TOPIC_BODY', 'Topic body must start with its title')
  }

  return matter.stringify(normalizedBody, {
    topic_id: topicId,
    title,
    scope,
    description,
    keywords,
    status,
    updated_at: updatedAt.toISOString(),
  })
}

export function listMemoryTopics(
  agentId: string,
  status: MemoryTopicStatus | 'all' = 'active',
): MemoryTopicList {
  const mode = detectMemoryHierarchyMode(agentId)
  const files = listMemoryFiles(agentId).filter(
    (file) =>
      ACTIVE_TOPIC_PATH_PATTERN.test(file.name) || ARCHIVED_TOPIC_PATH_PATTERN.test(file.name),
  )
  const topics: MemoryTopicRecord[] = []
  const invalidFiles: string[] = []

  for (const file of files) {
    try {
      const topic = parseMemoryTopicFile(file.name, readMemoryFile(agentId, file.name))
      if (status === 'all' || topic.status === status) topics.push(topic)
    } catch (err) {
      invalidFiles.push(file.name)
      logger.warn({ agentId, filename: file.name, err }, 'Withholding invalid memory topic')
    }
  }

  topics.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))
  return { mode, topics, invalidFiles }
}

export function readMemoryTopic(agentId: string, topicId: string): MemoryTopicRecord {
  if (!TOPIC_ID_PATTERN.test(topicId)) {
    throw new MemoryTopicError('INVALID_TOPIC_ID', 'Invalid topic ID')
  }
  const topic = listMemoryTopics(agentId, 'active').topics.find(
    (entry) => entry.topicId === topicId,
  )
  if (!topic) throw new MemoryTopicError('TOPIC_NOT_FOUND', 'Active topic not found')
  return topic
}

function extractAgentSummary(main: string): string {
  const summaryMatch = main.match(
    /## Agent Summary\s*\n([\s\S]*?)(?=\n<!-- a2wave-topic-catalog:start -->)/,
  )
  return summaryMatch?.[1]?.trim() ?? ''
}

export function readAgentSummary(agentId: string): string {
  try {
    return extractAgentSummary(readMemoryFile(agentId, MEMORY_MAIN_FILE))
  } catch (err) {
    if (err instanceof Error && err.message === 'File not found') return ''
    throw err
  }
}

function renderCatalog(topics: MemoryTopicRecord[]): string {
  const lines = topics
    .filter((topic) => topic.status === 'active')
    .sort((a, b) => a.title.localeCompare(b.title))
    .flatMap((topic) => [
      `- \`${topic.topicId}\` **${topic.title}** — ${topic.description}`,
      `  Keywords: ${topic.keywords.map((keyword) => `\`${keyword}\``).join(', ')}`,
    ])
  const catalog = [
    '## Topic Catalog',
    '',
    ...(lines.length > 0 ? lines : ['- No active topics.']),
  ].join('\n')
  if (estimateMemoryTokens(catalog) > MEMORY_MAIN_CATALOG_HARD_TOKENS) {
    throw new MemoryTopicError('MEMORY_CATALOG_LIMIT', 'Topic catalog exceeds its hard limit')
  }
  return catalog
}

const DISCLOSURE_GUIDE = `## Disclosure Guide

- Read the closest matching topic before searching historical logs.
- Read at most one topic first; read a second only for a concrete cross-topic dependency.
- Search daily or weekly logs only when topic knowledge is insufficient or exact evidence is needed.`

export function renderMemoryMain(summary: string, topics: MemoryTopicRecord[]): string {
  const normalizedSummary = summary.trim()
  if (estimateMemoryTokens(normalizedSummary) > MEMORY_MAIN_SUMMARY_HARD_TOKENS) {
    throw new MemoryTopicError('MEMORY_SUMMARY_LIMIT', 'Agent Summary exceeds its hard limit')
  }
  const rendered = [
    '# Agent Memory',
    '',
    '## Agent Summary',
    '',
    normalizedSummary || '- No cross-topic startup facts have been recorded.',
    '',
    TOPIC_CATALOG_START,
    renderCatalog(topics),
    TOPIC_CATALOG_END,
    '',
    DISCLOSURE_GUIDE,
    '',
  ].join('\n')
  if (estimateMemoryTokens(rendered) > MEMORY_MAIN_HARD_TOKENS) {
    throw new MemoryTopicError('MEMORY_MAIN_LIMIT', 'MEMORY.md exceeds its hard limit')
  }
  return rendered
}

export function rebuildMemoryMain(agentId: string, summary = readAgentSummary(agentId)): string {
  const topics = listMemoryTopics(agentId, 'active').topics
  const rendered = renderMemoryMain(summary, topics)
  writeMemoryFile(agentId, MEMORY_MAIN_FILE, rendered)
  return rendered
}

export function replaceAgentSummaryFromMainContent(agentId: string, content: string): string {
  const summary = content.includes(TOPIC_CATALOG_START)
    ? extractAgentSummary(content)
    : content.trim()
  return rebuildMemoryMain(agentId, summary)
}

export function getValidatedMemoryMain(agentId: string): string | null {
  let main: string
  try {
    main = readMemoryFile(agentId, MEMORY_MAIN_FILE)
  } catch (err) {
    if (err instanceof Error && err.message === 'File not found') return null
    throw err
  }
  if (detectMemoryHierarchyMode(agentId) === 'legacy_single_file') return main
  return renderMemoryMain(extractAgentSummary(main), listMemoryTopics(agentId, 'active').topics)
}

export function appendAgentSummaryItems(
  agentId: string,
  items: string[],
): { accepted: string[]; rejected: string[] } {
  const existingSummary = readAgentSummary(agentId)
  const lines = existingSummary
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const normalizedExisting = new Set(lines.map((line) => normalizeItem(line).toLowerCase()))
  const accepted: string[] = []
  const rejected: string[] = []
  let summary = existingSummary

  for (const rawItem of items) {
    const item = normalizeItem(rawItem)
    if (!item || normalizedExisting.has(item.toLowerCase())) continue
    const candidate = summary ? `${summary}\n- ${item}` : `- ${item}`
    try {
      renderMemoryMain(candidate, listMemoryTopics(agentId, 'active').topics)
      summary = candidate
      accepted.push(item)
      normalizedExisting.add(item.toLowerCase())
    } catch (err) {
      if (
        err instanceof MemoryTopicError &&
        (err.code === 'MEMORY_SUMMARY_LIMIT' || err.code === 'MEMORY_MAIN_LIMIT')
      ) {
        rejected.push(item)
        continue
      }
      throw err
    }
  }

  rebuildMemoryMain(agentId, summary)
  return { accepted, rejected }
}

function normalizeItem(item: string): string {
  return item
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/\s+/g, ' ')
}

function englishTopicItemDedupKey(item: string): string {
  const normalized = item
    .replace(/\b(?:one|a)[-\s]+weeks?\b/g, ' 7 days ')
    .replace(/\bseven[-\s]+days?\b/g, ' 7 days ')
    .replace(/\b(\d+)[-\s]+days?\b/g, ' $1days ')
    .replace(/\b(?:api[-\s]+(?:keys?|credentials?)|credentials?)\b/g, ' credential ')
    .replace(/\b(?:rotates?|rotated|rotating|rotation)\b/g, ' rotate ')
    .replace(
      /\b(?:warnings?|warns?|warned|warning|alerts?|alerted|alerting|notifies?|notified|notifications?)\b/g,
      ' warn ',
    )
    .replace(
      /\b(?:always|consistently|uniformly|every|each|once|per|requires?|required|requiring|follows?|followed|following|cadence|cycles?|intervals?|periods?|operators?|receives?|received|receiving|with|and|a|an|the|is|are|be|must|should|will|in|advance|style|format)\b/g,
      ' ',
    )
  const tokens: string[] = normalized.match(/[a-z0-9]+/g) ?? []
  const isCredentialRotationCadence =
    tokens.includes('credential') &&
    tokens.includes('rotate') &&
    tokens.includes('warn') &&
    tokens.some((token) => token === 'days' || token.endsWith('days'))
  // Word order is semantic for general English facts (for example, A calls B versus B calls A).
  // Only the narrowly normalized credential-rotation cadence is treated as order-independent.
  return (isCredentialRotationCadence ? tokens.sort() : tokens).join('')
}

/**
 * Produce a conservative equivalence key for topic facts. This intentionally
 * handles only presentation noise and a small set of synonymous policy
 * modifiers; it is not fuzzy matching, so facts with different objects,
 * values, ordering, or conditions remain distinct.
 */
function topicItemDedupKey(item: string): string {
  const normalized = normalizeItem(item)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[`'"“”‘’]/g, '')
  if (!/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(normalized)) {
    return englishTopicItemDedupKey(normalized)
  }
  return normalized
    .replace(/^所有\s*/u, '')
    .replace(/(?:统一|固定|一律|始终)使用/g, '使用')
    .replace(/采用/g, '使用')
    .replace(/必须(?:在)?结尾(?:处)?(?:写|写入|包含|带上|添加)/g, '结尾包含')
    .replace(/(?:在)?结尾(?:处)?必须(?:写|写入|包含|带上|添加)/g, '结尾包含')
    .replace(/(?:样式|格式)(?=[。.!！?？]?$)/, '')
    .replace(/\b(?:always|consistently|uniformly)\s+use\b/g, 'use')
    .replace(/\b(?:style|format)(?=[.!?]?$)/, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function deduplicateTopicBody(body: string): string {
  const seenItems = new Set<string>()
  return body
    .split('\n')
    .filter((line) => {
      if (!/^[-*]\s+/.test(line.trim())) return true
      const key = topicItemDedupKey(line)
      if (seenItems.has(key)) return false
      seenItems.add(key)
      return true
    })
    .join('\n')
}

function topicBodyWithItems(
  title: string,
  body: string | null,
  section: MemoryTopicSection,
  items: string[],
): string {
  if (!ALLOWED_TOPIC_SECTIONS.has(section)) {
    throw new MemoryTopicError('INVALID_TOPIC_SECTION', 'Invalid topic section')
  }
  const normalizedItems = items.map(normalizeItem).filter(Boolean)
  if (normalizedItems.length === 0) {
    throw new MemoryTopicError('INVALID_TOPIC_BODY', 'At least one topic item is required')
  }

  const base = deduplicateTopicBody(body?.trim() || `# ${title}`)
  const existingItems = new Set(
    base
      .split('\n')
      .filter((line) => /^[-*]\s+/.test(line.trim()))
      .map(topicItemDedupKey),
  )
  const additions = normalizedItems.filter((item) => {
    const key = topicItemDedupKey(item)
    if (existingItems.has(key)) return false
    existingItems.add(key)
    return true
  })
  if (additions.length === 0) return base

  const sectionHeading = `## ${section}`
  const additionText = additions.map((item) => `- ${item}`).join('\n')
  const headingIndex = base.indexOf(sectionHeading)
  if (headingIndex === -1) {
    return limitEvidencePointers(`${base}\n\n${sectionHeading}\n\n${additionText}`, section)
  }

  const afterHeading = headingIndex + sectionHeading.length
  const nextHeadingOffset = base.slice(afterHeading).search(/\n## /)
  if (nextHeadingOffset === -1) {
    return limitEvidencePointers(
      `${base}\n${base.endsWith('\n') ? '' : '\n'}${additionText}`,
      section,
    )
  }
  const insertionIndex = afterHeading + nextHeadingOffset
  return limitEvidencePointers(
    `${base.slice(0, insertionIndex).trimEnd()}\n${additionText}\n${base.slice(insertionIndex)}`,
    section,
  )
}

function limitEvidencePointers(body: string, section: MemoryTopicSection): string {
  if (section !== 'Evidence Pointers') return body
  const lines = body.split('\n')
  const headingIndex = lines.findIndex((line) => line.trim() === '## Evidence Pointers')
  if (headingIndex === -1) return body
  const endOffset = lines.slice(headingIndex + 1).findIndex((line) => /^##\s+/.test(line))
  const endIndex = endOffset === -1 ? lines.length : headingIndex + 1 + endOffset
  const sectionLines = lines.slice(headingIndex + 1, endIndex)
  const pointers = sectionLines.filter((line) => /^[-*]\s+/.test(line.trim()))
  if (pointers.length <= MEMORY_TOPIC_EVIDENCE_POINTER_LIMIT) return body
  const retained = pointers.slice(-MEMORY_TOPIC_EVIDENCE_POINTER_LIMIT)
  return [...lines.slice(0, headingIndex + 1), '', ...retained, ...lines.slice(endIndex)].join('\n')
}

const TOPIC_MATCH_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'of',
  'on',
  'or',
  'that',
  'the',
  'these',
  'this',
  'those',
  'to',
  'with',
])

function topicMatchTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_/-]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !TOPIC_MATCH_STOP_WORDS.has(token)),
  )
}

function compactRecallText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function cjkRecallText(text: string): string {
  return [...text.normalize('NFKC').toLowerCase()]
    .filter((character) => /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/u.test(character))
    .join('')
}

function recallLatinTokens(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_/-]*/g) ?? [],
  )
}

function longestCommonSubstringLength(left: string, right: string): number {
  if (!left || !right) return 0
  const row = new Uint16Array(right.length + 1)
  let longest = 0
  for (const leftCharacter of left) {
    let diagonal = 0
    let column = 1
    for (const rightCharacter of right) {
      const previous = row[column]
      row[column] = leftCharacter === rightCharacter ? diagonal + 1 : 0
      if (row[column] > longest) longest = row[column]
      diagonal = previous
      column++
    }
  }
  return longest
}

/**
 * Select at most one active topic from bounded topic content. The matcher is
 * deliberately catalog-first, but tolerates natural-language CJK queries that
 * do not repeat every indexed term. Ambiguous or weak matches fail closed.
 */
export function selectMemoryTopicForRecall(
  query: string,
  topics: MemoryTopicRecord[],
): MemoryTopicRecord | null {
  const normalizedQuery = compactRecallText(query)
  const queryCjk = cjkRecallText(query)
  const queryLatin = recallLatinTokens(query)
  if (!normalizedQuery) return null

  const candidates = topics
    .filter((topic) => topic.status === 'active')
    .map((topic) => {
      if (normalizedQuery.includes(topic.topicId.toLowerCase())) {
        return { topic, score: 10_000, strong: true }
      }

      const catalog = `${topic.title} ${topic.scope} ${topic.description} ${topic.keywords.join(' ')}`
      const catalogCompact = compactRecallText(catalog)
      const catalogCjkMatch = longestCommonSubstringLength(queryCjk, cjkRecallText(catalog))
      const bodyCjkMatch = longestCommonSubstringLength(queryCjk, cjkRecallText(topic.body))
      const catalogLatin = recallLatinTokens(catalog)
      const bodyLatin = recallLatinTokens(topic.body)
      const latinMatches = [...queryLatin].filter(
        (token) => token.length >= 3 && (catalogLatin.has(token) || bodyLatin.has(token)),
      )
      const keywordMatches = topic.keywords
        .map(compactRecallText)
        .filter(
          (keyword) =>
            keyword.length >= 2 &&
            (normalizedQuery.includes(keyword) || keyword.includes(normalizedQuery)),
        )
      const title = compactRecallText(topic.title)
      const titleBonus =
        normalizedQuery.includes(title) || title.includes(normalizedQuery) ? 200 + title.length : 0
      const keywordScore = keywordMatches.reduce(
        (total, keyword) => total + 100 + keyword.length * 5,
        0,
      )
      const latinScore = latinMatches.reduce((total, token) => total + 30 + token.length, 0)
      const score = titleBonus + keywordScore + catalogCjkMatch * 10 + bodyCjkMatch * 2 + latinScore
      const strong =
        keywordMatches.length > 0 ||
        catalogCjkMatch >= 3 ||
        bodyCjkMatch >= 3 ||
        latinMatches.length > 0
      return { topic, score, strong }
    })
    .filter((candidate) => candidate.strong)
    .sort((left, right) => right.score - left.score)

  const best = candidates[0]
  if (!best || (candidates[1] && candidates[1].score === best.score)) return null
  return best.topic
}

function topicMatchScore(insight: MemoryTopicInsight, topic: MemoryTopicRecord): number {
  if (insight.topicId && insight.topicId === topic.topicId) return 100
  const normalizedInsightTitle = insight.title.trim().toLowerCase()
  const normalizedTopicTitle = topic.title.trim().toLowerCase()
  if (normalizedInsightTitle === normalizedTopicTitle) return 10
  const topicKeywords = new Set(topic.keywords.map((keyword) => keyword.trim().toLowerCase()))
  const insightKeywords = insight.keywords.map((keyword) => keyword.trim().toLowerCase())
  const keywordOverlap = insightKeywords.filter((keyword) => topicKeywords.has(keyword)).length
  const keywordDenominator = Math.min(topicKeywords.size, insightKeywords.length)
  const keywordOverlapRatio = keywordDenominator === 0 ? 0 : keywordOverlap / keywordDenominator
  // A single shared entity (for example a product or repository name) is not a topic boundary.
  // Match on keywords only when at least half of the smaller keyword set agrees, or when two
  // independently selected keywords overlap.
  if (keywordOverlap >= 2) {
    return 1 + keywordOverlapRatio
  }
  const scopeA = insight.scope.trim().toLowerCase()
  const scopeB = topic.scope.trim().toLowerCase()
  const scopeATokens = topicMatchTokens(scopeA)
  const scopeBTokens = topicMatchTokens(scopeB)
  const scopeOverlap = [...scopeATokens].filter((token) => scopeBTokens.has(token)).length
  const smallerScopeSize = Math.min(scopeATokens.size, scopeBTokens.size)
  if (smallerScopeSize >= 3 && scopeOverlap >= 2 && scopeOverlap / smallerScopeSize >= 0.6) {
    return 0.75
  }
  const topicTokens = topicMatchTokens(
    `${topic.title} ${topic.scope} ${topic.description} ${topic.keywords.join(' ')}`,
  )
  const insightTokens = topicMatchTokens(
    `${insight.title} ${insight.scope} ${insight.description} ${insight.keywords.join(' ')} ${insight.items.join(' ')}`,
  )
  let overlap = 0
  for (const token of insightTokens) {
    if (topicTokens.has(token)) overlap++
  }
  // A single shared keyword can be a safe entity anchor when two additional concepts also
  // agree across the topic catalog and the durable fact itself. This admits narrow follow-up
  // facts such as a Cedar-Ridge release-review rule into Cedar-Ridge release governance, while
  // still rejecting unrelated concerns that share only the product name (or product + release).
  if (keywordOverlap === 1 && overlap >= 3) {
    return 0.5 + overlap / (topicTokens.size + insightTokens.size)
  }
  if (overlap < 3 || insightTokens.size === 0) return 0
  const overlapRatio = overlap / insightTokens.size
  return overlapRatio >= 0.5 ? overlapRatio : 0
}

function validateInsight(insight: MemoryTopicInsight): MemoryTopicInsight {
  return {
    ...(insight.topicId ? { topicId: requiredString(insight.topicId, 'topicId', 20) } : {}),
    title: requiredString(insight.title, 'title', 80),
    scope: requiredString(insight.scope, 'scope', MEMORY_TOPIC_SCOPE_LIMIT),
    description: requiredString(insight.description, 'description', MEMORY_TOPIC_DESCRIPTION_LIMIT),
    keywords: normalizedKeywords(insight.keywords),
    section: ALLOWED_TOPIC_SECTIONS.has(insight.section) ? insight.section : 'Durable Knowledge',
    items: insight.items.map(normalizeItem).filter(Boolean),
  }
}

function activeTopicBytes(topics: MemoryTopicRecord[]): number {
  return topics.reduce((total, topic) => total + topic.size, 0)
}

function archiveOldestTopic(
  agentId: string,
  excludedTopicIds: ReadonlySet<string>,
): MemoryTopicRecord | null {
  const topics = listMemoryTopics(agentId, 'active')
    .topics.filter((topic) => !excludedTopicIds.has(topic.topicId))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
  const oldest = topics[0]
  if (!oldest) return null
  const metadata: MemoryTopicMetadata = {
    ...oldest,
    status: 'archived',
    updatedAt: new Date().toISOString(),
  }
  const archivedPath = topicPath(metadata)
  writeMemoryFile(agentId, archivedPath, renderMemoryTopicFile(metadata, oldest.body))
  deleteMemoryFile(agentId, oldest.path)
  return parseMemoryTopicFile(archivedPath, readMemoryFile(agentId, archivedPath))
}

function ensureCatalogFits(
  agentId: string,
  protectedTopicIds?: string | ReadonlySet<string>,
  archivedTopicIds?: string[],
): void {
  const protectedIds =
    typeof protectedTopicIds === 'string'
      ? new Set([protectedTopicIds])
      : (protectedTopicIds ?? new Set<string>())
  for (;;) {
    const topics = listMemoryTopics(agentId, 'active').topics
    const exceedsCount = topics.length > MEMORY_ACTIVE_TOPIC_LIMIT
    const exceedsBytes = activeTopicBytes(topics) > MEMORY_ACTIVE_TOPICS_BYTES_LIMIT
    let exceedsCatalog = false
    try {
      renderCatalog(topics)
    } catch (err) {
      if (err instanceof MemoryTopicError && err.code === 'MEMORY_CATALOG_LIMIT') {
        exceedsCatalog = true
      } else {
        throw err
      }
    }
    if (!exceedsCount && !exceedsBytes && !exceedsCatalog) return
    const archived = archiveOldestTopic(agentId, protectedIds)
    if (!archived) {
      throw new MemoryTopicError('ACTIVE_TOPIC_LIMIT', 'Active topic limits cannot be satisfied')
    }
    archivedTopicIds?.push(archived.topicId)
  }
}

export function applyInsightToTopics(
  agentId: string,
  rawInsight: MemoryTopicInsight,
  options?: { allowSingleNewTopicItem?: boolean },
): MemoryTopicWriteResult {
  const insight = validateInsight(rawInsight)
  const activeTopics = listMemoryTopics(agentId, 'active').topics
  if (insight.topicId && !activeTopics.some((topic) => topic.topicId === insight.topicId)) {
    throw new MemoryTopicError('TOPIC_NOT_FOUND', 'Explicit topic ID does not exist or is archived')
  }
  const candidates = activeTopics
    .map((topic) => ({ topic, score: topicMatchScore(insight, topic) }))
    .sort((a, b) => b.score - a.score)
  const best = candidates[0]
  const runnerUp = candidates[1]
  const matched =
    best && best.score >= 0.25 && (!runnerUp || best.score > runnerUp.score) ? best.topic : null

  if (!matched && insight.items.length < 2 && !options?.allowSingleNewTopicItem) {
    return {
      topic: null,
      created: false,
      warning: null,
      retainedInHistory: true,
      reason: 'insufficient_new_topic_content',
    }
  }

  const now = new Date().toISOString()
  const metadata: MemoryTopicMetadata = matched
    ? {
        ...matched,
        keywords: [...new Set([...matched.keywords, ...insight.keywords])].slice(
          0,
          MEMORY_TOPIC_KEYWORD_LIMIT,
        ),
        updatedAt: now,
      }
    : {
        topicId: createTopicId(),
        title: insight.title,
        scope: insight.scope,
        description: insight.description,
        keywords: insight.keywords,
        status: 'active',
        updatedAt: now,
      }
  const body = topicBodyWithItems(
    metadata.title,
    matched?.body ?? null,
    insight.section,
    insight.items,
  )
  const content = renderMemoryTopicFile(metadata, body)
  if (estimateMemoryTokens(body) > MEMORY_TOPIC_HARD_TOKENS) {
    return {
      topic: matched,
      created: false,
      warning: 'needs_reorganization',
      retainedInHistory: true,
      reason: 'topic_hard_limit',
    }
  }

  const path = topicPath(metadata)
  writeMemoryFile(agentId, path, content)
  if (matched && matched.path !== path) deleteMemoryFile(agentId, matched.path)
  ensureCatalogFits(agentId, metadata.topicId)
  rebuildMemoryMain(agentId)
  const topic = readMemoryTopic(agentId, metadata.topicId)
  return {
    topic,
    created: !matched,
    warning: topic.needsReorganization ? 'needs_reorganization' : null,
    retainedInHistory: false,
  }
}

export function replaceTopicBody(
  agentId: string,
  topicId: string,
  body: string,
): MemoryTopicWriteResult {
  const topic = readMemoryTopic(agentId, topicId)
  const normalizedBody = body.trim()
  if (!normalizedBody.startsWith(`# ${topic.title}`)) {
    throw new MemoryTopicError('INVALID_TOPIC_BODY', 'Topic body must start with its title')
  }
  if (estimateMemoryTokens(normalizedBody) > MEMORY_TOPIC_HARD_TOKENS) {
    return {
      topic,
      created: false,
      warning: 'needs_reorganization',
      retainedInHistory: true,
      reason: 'topic_hard_limit',
    }
  }
  const metadata: MemoryTopicMetadata = { ...topic, updatedAt: new Date().toISOString() }
  writeMemoryFile(agentId, topic.path, renderMemoryTopicFile(metadata, normalizedBody))
  rebuildMemoryMain(agentId)
  const updated = readMemoryTopic(agentId, topicId)
  return {
    topic: updated,
    created: false,
    warning: updated.needsReorganization ? 'needs_reorganization' : null,
    retainedInHistory: false,
  }
}

export function replaceManagedTopicFile(
  agentId: string,
  path: string,
  content: string,
): MemoryTopicWriteResult {
  if (!isMemoryTopicPath(path)) {
    throw new MemoryTopicError('INVALID_TOPIC_PATH', 'Invalid topic path')
  }
  const existing = parseMemoryTopicFile(path, readMemoryFile(agentId, path))
  let body = content.trim()
  if (body.startsWith('---')) {
    let proposed: MemoryTopicRecord
    try {
      proposed = parseMemoryTopicFile(path, body)
    } catch (err) {
      if (err instanceof MemoryTopicError) throw err
      throw new MemoryTopicError('INVALID_TOPIC_BODY', 'Invalid topic content')
    }
    if (
      proposed.topicId !== existing.topicId ||
      proposed.title !== existing.title ||
      proposed.scope !== existing.scope ||
      proposed.description !== existing.description ||
      proposed.status !== existing.status ||
      JSON.stringify(proposed.keywords) !== JSON.stringify(existing.keywords)
    ) {
      throw new MemoryTopicError('TOPIC_METADATA_SERVER_OWNED', 'Topic frontmatter is server-owned')
    }
    body = proposed.body
  }
  return replaceTopicBody(agentId, existing.topicId, body)
}

export function deleteMemoryTopicFile(agentId: string, path: string): void {
  if (!isMemoryTopicPath(path)) {
    throw new MemoryTopicError('INVALID_TOPIC_PATH', 'Invalid topic path')
  }
  parseMemoryTopicFile(path, readMemoryFile(agentId, path))
  deleteMemoryFile(agentId, path)
  rebuildMemoryMain(agentId)
}

export function archiveMemoryTopic(agentId: string, topicId: string): MemoryTopicRecord {
  const topic = readMemoryTopic(agentId, topicId)
  const metadata: MemoryTopicMetadata = {
    ...topic,
    status: 'archived',
    updatedAt: new Date().toISOString(),
  }
  const archivedPath = topicPath(metadata)
  writeMemoryFile(agentId, archivedPath, renderMemoryTopicFile(metadata, topic.body))
  deleteMemoryFile(agentId, topic.path)
  rebuildMemoryMain(agentId)
  return parseMemoryTopicFile(archivedPath, readMemoryFile(agentId, archivedPath))
}

export function reactivateMemoryTopic(agentId: string, topicId: string): MemoryTopicRecord {
  const topic = listMemoryTopics(agentId, 'archived').topics.find(
    (entry) => entry.topicId === topicId,
  )
  if (!topic) throw new MemoryTopicError('TOPIC_NOT_FOUND', 'Archived topic not found')
  const metadata: MemoryTopicMetadata = {
    ...topic,
    status: 'active',
    updatedAt: new Date().toISOString(),
  }
  const activePath = topicPath(metadata)
  writeMemoryFile(agentId, activePath, renderMemoryTopicFile(metadata, topic.body))
  deleteMemoryFile(agentId, topic.path)
  ensureCatalogFits(agentId, topicId)
  rebuildMemoryMain(agentId)
  return readMemoryTopic(agentId, topicId)
}

export function mergeMemoryTopics(
  agentId: string,
  sourceTopicIds: string[],
  targetTopicId: string,
): MemoryTopicRecord {
  const uniqueSources = [...new Set(sourceTopicIds)].filter((id) => id !== targetTopicId)
  if (uniqueSources.length === 0) {
    throw new MemoryTopicError('INVALID_TOPIC_MERGE', 'At least one source topic is required')
  }
  const target = readMemoryTopic(agentId, targetTopicId)
  const sources = uniqueSources.map((id) => readMemoryTopic(agentId, id))
  const mergedBody = [
    target.body,
    ...sources.map((topic) => topic.body.replace(/^# .*\n?/, '').trim()),
  ]
    .filter(Boolean)
    .join('\n\n')
  if (estimateMemoryTokens(mergedBody) > MEMORY_TOPIC_HARD_TOKENS) {
    throw new MemoryTopicError('TOPIC_HARD_LIMIT', 'Merged topic would exceed the hard limit')
  }
  const metadata: MemoryTopicMetadata = {
    ...target,
    keywords: [
      ...new Set([...target.keywords, ...sources.flatMap((topic) => topic.keywords)]),
    ].slice(0, MEMORY_TOPIC_KEYWORD_LIMIT),
    updatedAt: new Date().toISOString(),
  }
  // The target is rewritten destructively and the sources are archived one by
  // one, so a failure partway through would otherwise leave the target holding
  // a source's facts while that source is still active — duplicated content
  // that also makes the retry fail permanently (the archived sources no longer
  // read back). Restore everything on the way out, the way splitMemoryTopic does.
  const targetBefore = readMemoryFile(agentId, target.path)
  const archived: string[] = []
  try {
    writeMemoryFile(agentId, target.path, renderMemoryTopicFile(metadata, mergedBody))
    for (const source of sources) {
      archiveMemoryTopic(agentId, source.topicId)
      archived.push(source.topicId)
    }
  } catch (err) {
    try {
      for (const topicId of archived) reactivateMemoryTopic(agentId, topicId)
      writeMemoryFile(agentId, target.path, targetBefore)
      rebuildMemoryMain(agentId)
    } catch {
      // Preserve the original error; repair tooling can recover from the
      // archived copies, which are written before their source is removed.
    }
    throw err
  }
  rebuildMemoryMain(agentId)
  return readMemoryTopic(agentId, targetTopicId)
}

interface TopicBodyBlock {
  hash: string
  section: MemoryTopicSection
  content: string
}

function splitTopicBodyBlocks(topic: MemoryTopicRecord): TopicBodyBlock[] {
  const lines = topic.body.replace(/\r\n/g, '\n').split('\n')
  const blocks: TopicBodyBlock[] = []
  let section: MemoryTopicSection = 'Durable Knowledge'
  let buffer: string[] = []
  const flush = () => {
    const content = buffer.join('\n').trim()
    buffer = []
    if (!content) return
    blocks.push({ hash: hashMemoryBlock(content), section, content })
  }
  for (const line of lines) {
    if (/^#\s+/.test(line)) continue
    const heading = line.match(/^##\s+(.+)$/)
    if (heading) {
      flush()
      if (!ALLOWED_TOPIC_SECTIONS.has(heading[1])) {
        throw new MemoryTopicError('INVALID_TOPIC_SPLIT', 'Source topic has an unknown section')
      }
      section = heading[1] as MemoryTopicSection
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (/^[-*]\s+/.test(line) && buffer.length > 0) flush()
    buffer.push(line)
  }
  flush()
  return blocks
}

function renderSplitTopicBody(
  title: string,
  sections: MemoryTopicSplitReplacement['sections'],
): string {
  const parts = [`# ${title}`]
  for (const section of sections) {
    if (!ALLOWED_TOPIC_SECTIONS.has(section.section) || section.items.length === 0) {
      throw new MemoryTopicError('INVALID_TOPIC_SPLIT', 'Invalid replacement topic section')
    }
    parts.push(
      `## ${section.section}`,
      section.items.map((item) => item.content.trim()).join('\n\n'),
    )
  }
  return parts.join('\n\n')
}

/**
 * Split one incoherent active topic using an explicit, coverage-checked plan.
 * Every source body block must be copied verbatim exactly once; this operation never asks a model
 * to summarize or compact the only curated copy.
 */
export function splitMemoryTopic(
  agentId: string,
  sourceTopicId: string,
  replacements: MemoryTopicSplitReplacement[],
): MemoryTopicRecord[] {
  if (replacements.length < 2) {
    throw new MemoryTopicError(
      'INVALID_TOPIC_SPLIT',
      'At least two replacement topics are required',
    )
  }
  const source = readMemoryTopic(agentId, sourceTopicId)
  const sourceBlocks = splitTopicBodyBlocks(source)
  if (sourceBlocks.length === 0) {
    throw new MemoryTopicError('INVALID_TOPIC_SPLIT', 'Source topic has no semantic blocks')
  }
  const availableByHash = new Map<string, TopicBodyBlock[]>()
  for (const block of sourceBlocks) {
    const values = availableByHash.get(block.hash) ?? []
    values.push(block)
    availableByHash.set(block.hash, values)
  }

  const now = new Date().toISOString()
  const proposed = replacements.map((replacement) => {
    const metadata: MemoryTopicMetadata = {
      topicId: createTopicId(),
      title: replacement.title,
      scope: replacement.scope,
      description: replacement.description,
      keywords: replacement.keywords,
      status: 'active',
      updatedAt: now,
    }
    for (const section of replacement.sections) {
      for (const item of section.items) {
        const candidates = availableByHash.get(item.sourceHash)
        const sourceBlock = candidates?.shift()
        if (!sourceBlock || item.content.trim() !== sourceBlock.content) {
          throw new MemoryTopicError(
            'TOPIC_SPLIT_COVERAGE_FAILED',
            'Every source topic block must be copied verbatim exactly once',
          )
        }
      }
    }
    const body = renderSplitTopicBody(metadata.title, replacement.sections)
    if (estimateMemoryTokens(body) > MEMORY_TOPIC_HARD_TOKENS) {
      throw new MemoryTopicError('TOPIC_HARD_LIMIT', 'A replacement topic exceeds the hard limit')
    }
    const path = topicPath(metadata)
    const content = renderMemoryTopicFile(metadata, body)
    parseMemoryTopicFile(path, content)
    return { metadata, path, content }
  })
  if ([...availableByHash.values()].some((blocks) => blocks.length > 0)) {
    throw new MemoryTopicError(
      'TOPIC_SPLIT_COVERAGE_FAILED',
      'One or more source topic blocks have no replacement',
    )
  }

  const archivedForFit: string[] = []
  try {
    for (const item of proposed) {
      writeMemoryFile(agentId, item.path, item.content)
    }
    archiveMemoryTopic(agentId, sourceTopicId)
    ensureCatalogFits(
      agentId,
      new Set(proposed.map((item) => item.metadata.topicId)),
      archivedForFit,
    )
    rebuildMemoryMain(agentId)
    return proposed.map((item) => readMemoryTopic(agentId, item.metadata.topicId))
  } catch (err) {
    for (const item of proposed) {
      for (const status of ['active', 'archived'] as const) {
        try {
          deleteMemoryFile(agentId, topicPath({ ...item.metadata, status }))
        } catch {
          // Best-effort cleanup; the original source is still the authoritative topic.
        }
      }
    }
    try {
      const archivedSource = listMemoryTopics(agentId, 'archived').topics.find(
        (topic) => topic.topicId === sourceTopicId,
      )
      if (archivedSource) reactivateMemoryTopic(agentId, sourceTopicId)
      for (const topicId of archivedForFit) reactivateMemoryTopic(agentId, topicId)
    } catch {
      // Preserve the original error; repair tooling can recover the validated archived source.
    }
    throw err
  }
}

export function hashMemoryBlock(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}
