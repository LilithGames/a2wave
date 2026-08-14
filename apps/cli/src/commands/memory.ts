import { readFileSync } from 'node:fs'
import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { forceArgs, requireConfirmation, resolveForceFlag, toStringArray } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'

/**
 * Longest memory file rendered to a human. A memory file is agent-written and
 * grows without bound, so a bare `files get` could dump a megabyte into a
 * context window. `--json` is left WHOLE — dropping lines from a machine
 * payload would corrupt it with no error.
 */
const MAX_HUMAN_LINES = 200

interface MemoryFileEntry {
  name: string
  size?: number
  modifiedAt?: string
}

interface MemoryTopicSummary {
  topicId: string
  title?: string
  scope?: string
  keywords?: string[]
  status?: string
  tokenCount?: number
}

const TOPIC_STATUSES = ['active', 'archived', 'all'] as const

/**
 * Read the content for a write from exactly one source.
 *
 * Exactly one, not "prefer the flag": silently ignoring the second source is how
 * an agent ends up writing the wrong body and having no way to tell.
 */
function readWriteContent(args: Record<string, unknown>): string {
  const inline = args.content as string | undefined
  const fromFile = args['content-file'] as string | undefined
  if ((inline === undefined) === (fromFile === undefined)) {
    throw new CliError('Provide exactly one of --content or --content-file', {
      type: 'validation',
      subtype: 'missing_argument',
    })
  }
  if (inline !== undefined) return inline
  try {
    return readFileSync(fromFile as string, 'utf-8')
  } catch (err) {
    throw new CliError(`Failed to read --content-file (${fromFile}): ${(err as Error).message}`)
  }
}

/** Print at most MAX_HUMAN_LINES lines, naming how to get the rest. */
function printBounded(content: string, full: boolean): void {
  const lines = content.split('\n')
  if (full || lines.length <= MAX_HUMAN_LINES) {
    console.log(content)
    return
  }
  console.log(lines.slice(0, MAX_HUMAN_LINES).join('\n'))
  console.log(
    `\n… ${lines.length - MAX_HUMAN_LINES} more lines truncated. Use --full or --json for everything.`,
  )
}

/**
 * The memory file path is a wildcard segment (`/files/*`), so a nested path is
 * sent as-is rather than encoded — encoding the separators would address a file
 * literally named "notes%2Fa.md".
 */
function filesPath(agentId: string, file: string): string {
  return `/api/memories/${agentId}/files/${file.replace(/^\/+/, '')}`
}

const agentArg = {
  agent: { type: 'positional' as const, description: 'Agent ID or name', required: true },
}

const fileArg = {
  file: {
    type: 'positional' as const,
    description: 'Memory file path, relative to the memory root (e.g. MEMORY.md, notes/a.md)',
    required: true,
  },
}

export const memoryCommand = defineCommand({
  meta: {
    name: 'memory',
    description: 'Read and write an Agent’s memory files and topics',
  },
  subCommands: {
    files: defineCommand({
      meta: { name: 'files', description: 'Agent memory files (raw storage)' },
      subCommands: {
        list: defineCommand({
          meta: {
            name: 'list',
            description: 'List an Agent’s memory files',
            agentMeta: { risk: 'read' },
          },
          args: { ...agentArg, ...jsonArg, ...urlArg },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const result = await client.get<{ data: MemoryFileEntry[] }>(`/api/memories/${agentId}`)
            if (emit(args, result)) return
            if (result.data.length === 0) {
              console.log('No memory files')
              return
            }
            for (const f of result.data) {
              console.log(`${f.name}${f.size === undefined ? '' : `  ${f.size} bytes`}`)
            }
          },
        }),

        get: defineCommand({
          meta: { name: 'get', description: 'Print one memory file', agentMeta: { risk: 'read' } },
          args: {
            ...agentArg,
            ...fileArg,
            full: {
              type: 'boolean' as const,
              description: `Print the whole file instead of the first ${MAX_HUMAN_LINES} lines`,
            },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const result = await client.get<{ data: { filename: string; content: string } }>(
              filesPath(agentId, args.file as string),
            )
            if (emit(args, result)) return
            printBounded(result.data.content, args.full === true)
          },
        }),

        put: defineCommand({
          meta: {
            name: 'put',
            description: 'Write or append to a memory file',
            agentMeta: { risk: 'write' },
          },
          args: {
            ...agentArg,
            ...fileArg,
            content: { type: 'string' as const, description: 'File content' },
            'content-file': {
              type: 'string' as const,
              description: 'Read the content from a file',
            },
            append: {
              type: 'boolean' as const,
              description: 'Append to the existing content instead of replacing it',
            },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const content = readWriteContent(args)
            const agentId = await client.resolveAgentId(args.agent as string)
            const body: Record<string, unknown> = { content }
            if (args.append === true) body.append = true
            const result = await client.put<{ data: { filename: string; size: number } }>(
              filesPath(agentId, args.file as string),
              body,
            )
            if (emit(args, result)) return
            console.log(`Memory file written ✓  ${result.data.filename}  ${result.data.size} bytes`)
          },
        }),

        delete: defineCommand({
          meta: {
            name: 'delete',
            description: 'Delete a memory file',
            agentMeta: { risk: 'high-risk-write' },
          },
          args: {
            ...agentArg,
            ...fileArg,
            ...forceArgs,
            ...urlArg,
          },
          run: async ({ args }) => {
            await requireConfirmation(
              'high-risk-write',
              `Delete memory file "${args.file}"? This cannot be undone.`,
              resolveForceFlag(args),
            )
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            await client.del(filesPath(agentId, args.file as string))
            console.log('Memory file deleted ✓')
          },
        }),
      },
    }),

    topics: defineCommand({
      meta: { name: 'topics', description: 'Structured memory topics' },
      subCommands: {
        list: defineCommand({
          meta: {
            name: 'list',
            description: 'List memory topics (metadata only, no bodies)',
            agentMeta: { risk: 'read' },
          },
          args: {
            ...agentArg,
            status: {
              type: 'string' as const,
              description: `Which topics to list: ${TOPIC_STATUSES.join(' | ')} (default active)`,
            },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const status = args.status as string | undefined
            if (status !== undefined && !TOPIC_STATUSES.includes(status as 'active')) {
              throw new CliError(
                `Invalid --status: ${status} (options: ${TOPIC_STATUSES.join(' | ')})`,
                { type: 'validation', subtype: 'invalid_argument' },
              )
            }
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const query = status ? `?status=${status}` : ''
            const result = await client.get<{
              data: { mode: string; invalidFiles: string[]; topics: MemoryTopicSummary[] }
            }>(`/api/memories/${agentId}/topics${query}`)
            if (emit(args, result)) return

            const { mode, invalidFiles, topics } = result.data
            console.log(`Mode: ${mode}`)
            if (invalidFiles?.length) console.log(`Invalid files: ${invalidFiles.join(', ')}`)
            if (topics.length === 0) {
              console.log('No topics')
              return
            }
            for (const t of topics) {
              const meta = [t.status, t.tokenCount ? `${t.tokenCount} tokens` : null]
                .filter(Boolean)
                .join(', ')
              console.log(`${t.topicId}  ${t.title ?? ''}${meta ? `  (${meta})` : ''}`)
              if (t.keywords?.length) console.log(`  keywords: ${t.keywords.join(', ')}`)
            }
          },
        }),

        recall: defineCommand({
          meta: {
            name: 'recall',
            description: 'Select and read the one active topic that best matches a query',
            agentMeta: { risk: 'read' },
          },
          args: {
            ...agentArg,
            query: { type: 'positional' as const, description: 'Recall query', required: true },
            full: {
              type: 'boolean' as const,
              description: `Print the whole topic body instead of the first ${MAX_HUMAN_LINES} lines`,
            },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const q = encodeURIComponent(args.query as string)
            const result = await client.get<{
              data: (MemoryTopicSummary & { content?: string }) | null
            }>(`/api/memories/${agentId}/topics/recall?q=${q}`)
            if (emit(args, result)) return
            // `data: null` is a successful "nothing matched", not an error — the
            // server answers 200 and an agent should branch on the message, not
            // on an exception.
            if (!result.data) {
              console.log('No matching topic')
              return
            }
            const topic = result.data
            console.log(`${topic.topicId}  ${topic.title ?? ''}`)
            if (topic.content) printBounded(topic.content, args.full === true)
          },
        }),

        remember: defineCommand({
          meta: {
            name: 'remember',
            description: 'Write an insight into a topic, or replace a topic body',
            agentMeta: { risk: 'write' },
          },
          args: {
            ...agentArg,
            topic: {
              type: 'string' as const,
              description: 'Existing topic ID (required with --replace)',
            },
            title: { type: 'string' as const, description: 'Topic title' },
            scope: { type: 'string' as const, description: 'Topic scope' },
            description: { type: 'string' as const, description: 'Topic description' },
            keyword: { type: 'string' as const, description: 'Topic keyword (repeatable)' },
            section: {
              type: 'string' as const,
              description: 'Target section (default "Durable Knowledge")',
            },
            item: { type: 'string' as const, description: 'Insight line to record (repeatable)' },
            replace: {
              type: 'boolean' as const,
              description: 'Replace the whole topic body with --content',
            },
            content: { type: 'string' as const, description: 'New topic body (with --replace)' },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const replace = args.replace === true
            const items = toStringArray(args.item)
            // Validated before the agent lookup so a misuse fails on the flags
            // rather than after a network round-trip.
            if (replace) {
              if (!args.topic || typeof args.content !== 'string') {
                throw new CliError('--replace requires both --topic <id> and --content', {
                  type: 'validation',
                  subtype: 'missing_argument',
                })
              }
            } else if (items.length === 0) {
              throw new CliError('Provide at least one --item, or use --replace with --content', {
                type: 'validation',
                subtype: 'missing_argument',
              })
            }

            const client = createClient({ url: args.url as string | undefined })
            const agentId = await client.resolveAgentId(args.agent as string)
            const body: Record<string, unknown> = replace
              ? { action: 'replace', topicId: args.topic, content: args.content }
              : {
                  action: 'remember',
                  ...(args.topic ? { topicId: args.topic } : {}),
                  ...(args.title ? { title: args.title } : {}),
                  ...(args.scope ? { scope: args.scope } : {}),
                  ...(args.description ? { description: args.description } : {}),
                  ...(toStringArray(args.keyword).length
                    ? { keywords: toStringArray(args.keyword) }
                    : {}),
                  ...(args.section ? { section: args.section } : {}),
                  items,
                }

            const result = await client.post<{
              data: { created?: boolean; topic?: { topicId?: string; title?: string } }
            }>(`/api/memories/${agentId}/topics/remember`, body)
            if (emit(args, result)) return
            const topicId = result.data.topic?.topicId ?? '(unknown)'
            console.log(`${result.data.created ? 'Topic created' : 'Topic updated'} ✓  ${topicId}`)
          },
        }),
      },
    }),
  },
})
