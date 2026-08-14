import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { confirmDestructive } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'
import { pageArgs, pageQuery } from '../lib/paginate.js'

/**
 * Longest Skill file rendered to a human. A Skill can ship reference material of
 * any size, so a bare `files get` would otherwise dump it all into a context
 * window. `--json` stays whole: dropping lines from a machine payload corrupts
 * it with no error.
 */
const MAX_SKILL_FILE_LINES = 200

interface SkillFileEntry {
  name: string
  type: 'file' | 'directory'
  size?: number
  entries?: SkillFileEntry[]
}

/** Depth-first flatten of the tree into `dir/file` paths `files get` accepts. */
function flattenSkillFiles(
  entries: SkillFileEntry[],
  prefix = '',
): Array<{
  path: string
  size?: number
}> {
  const out: Array<{ path: string; size?: number }> = []
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.type === 'directory') {
      out.push(...flattenSkillFiles((entry.entries as SkillFileEntry[]) ?? [], path))
    } else {
      out.push({ path, ...(entry.size === undefined ? {} : { size: entry.size }) })
    }
  }
  return out
}

/** Print at most MAX_SKILL_FILE_LINES lines, naming how to get the rest. */
function printBoundedText(content: string, full: boolean): void {
  const lines = content.split('\n')
  if (full || lines.length <= MAX_SKILL_FILE_LINES) {
    console.log(content)
    return
  }
  console.log(lines.slice(0, MAX_SKILL_FILE_LINES).join('\n'))
  console.log(
    `\n… ${lines.length - MAX_SKILL_FILE_LINES} more lines truncated. Use --full or --json for everything.`,
  )
}

interface Skill {
  id: string
  name: string
  description?: string | null
  content?: string | null
  storagePath?: string | null
  visibility: 'private' | 'all-users'
  createdAt: string
  updatedAt: string
}

interface RemoteSkillCandidate {
  name: string
  description: string | null
  path: string
  digest: string
  fileCount: number
  totalBytes: number
}

interface RemoteSkillInspection {
  inputUrl: string
  repository: string
  requestedRef: string
  revision: string
  candidates: RemoteSkillCandidate[]
}

interface RemoteSkillUpdateCheck {
  latestRevision: string
  latestDigest: string
  updateAvailable: boolean
  sourceDirty: boolean
  conflicts: string[]
  files: Array<{
    path: string
    localChange: 'added' | 'modified' | 'deleted' | null
    remoteChange: 'added' | 'modified' | 'deleted' | null
    conflict: boolean
  }>
}

type RemoteSkillUpdateStrategy = 'abort' | 'preserve_local' | 'overwrite'
type SkillVisibility = Skill['visibility']

function parseVisibility(value: unknown): SkillVisibility | undefined {
  if (value === undefined) return undefined
  if (value === 'private' || value === 'all-users') return value
  throw new CliError('--visibility must be private or all-users')
}

function isRemoteSkillUrl(value: string | undefined): value is string {
  if (!value) return false
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    return ['github.com', 'www.github.com', 'skills.sh', 'www.skills.sh'].includes(hostname)
  } catch {
    return false
  }
}

async function installRemoteSkills(
  client: ReturnType<typeof createClient>,
  source: string,
  options: { skill?: string; all?: boolean; group?: string; visibility?: SkillVisibility },
) {
  if (options.skill && options.all) {
    throw new CliError('--skill and --all cannot be used together')
  }
  const inspected = await client.post<{ data: RemoteSkillInspection }>(
    '/api/skills/remote/inspect',
    { url: source },
  )
  const candidates = inspected.data.candidates

  let selected: RemoteSkillCandidate[]
  if (options.skill) {
    selected = candidates.filter(
      (candidate) => candidate.name === options.skill || candidate.path === options.skill,
    )
    if (selected.length === 0) {
      throw new CliError(
        `No remote Skill matched "${options.skill}". Available: ${candidates
          .map((candidate) => `${candidate.name} (${candidate.path})`)
          .join(', ')}`,
      )
    }
    if (selected.length > 1) {
      throw new CliError(`"${options.skill}" matched multiple Skills; use the repository path`)
    }
  } else if (options.all) {
    if (candidates.length > 20) {
      throw new CliError(
        `The repository contains ${candidates.length} Skills; --all supports at most 20. Use --skill.`,
      )
    }
    selected = candidates
  } else if (candidates.length === 1) {
    selected = candidates
  } else {
    throw new CliError(
      `Found ${candidates.length} Skills. Choose one with --skill <name-or-path>, or use --all.`,
    )
  }

  const body: Record<string, unknown> = {
    url: inspected.data.inputUrl,
    requestedRef: inspected.data.requestedRef,
    revision: inspected.data.revision,
    selections: selected.map((candidate) => ({
      path: candidate.path,
      digest: candidate.digest,
    })),
  }
  if (options.group) {
    body.groupId = await client.resolveSkillGroupId(options.group)
  }
  if (options.visibility) body.visibility = options.visibility
  const installed = await client.post<{ data: Skill[] }>('/api/skills/remote/install', body)
  for (const skill of installed.data) {
    console.log(`Skill installed ✓  ${skill.id}  ${skill.name}`)
  }
}

export const skillsCommand = defineCommand({
  meta: { name: 'skills', description: 'Manage Skills' },
  subCommands: {
    create: defineCommand({
      meta: {
        name: 'create',
        agentMeta: { risk: 'write' },
        description: 'Create a Skill (via fields, or upload .md/.zip with --file)',
      },
      args: {
        name: { type: 'string', description: 'Skill name (required for field-based creation)' },
        description: { type: 'string', description: 'Description' },
        content: { type: 'string', description: 'Instruction content (SKILL.md body)' },
        'content-file': { type: 'string', description: 'Read instruction content from a file' },
        group: { type: 'string', description: 'Parent Skill Group (ID or name)' },
        visibility: {
          type: 'string',
          description: 'Visibility: private (default) or all-users (administrators only)',
        },
        file: { type: 'string', description: 'Upload a .md or .zip file to create the Skill' },
        url: {
          type: 'string',
          description:
            'skills.sh or GitHub URL to install; for the legacy server override use --server-url',
        },
        skill: {
          type: 'string',
          description: 'Install one remote candidate by name or repository path',
        },
        all: {
          type: 'boolean',
          description: 'Install every discovered remote candidate (maximum 20)',
        },
        'server-url': {
          type: 'string',
          description: 'One-off override of the a2wave instance URL',
        },
      },
      run: async ({ args }) => {
        const url = args.url as string | undefined
        const remoteUrl = isRemoteSkillUrl(url) ? url : undefined
        const serverUrl =
          (args['server-url'] as string | undefined) ?? (remoteUrl ? undefined : url)
        const client = createClient({ url: serverUrl })

        if (remoteUrl) {
          if (args.file || args.name || args.content || args['content-file']) {
            throw new CliError(
              '--url remote installation cannot be combined with --file, --name, --content, or --content-file',
            )
          }
          await installRemoteSkills(client, remoteUrl, {
            skill: args.skill as string | undefined,
            all: args.all as boolean | undefined,
            group: args.group as string | undefined,
            visibility: parseVisibility(args.visibility),
          })
          return
        }

        // --file: create via upload
        if (args.file) {
          const filePath = args.file as string
          const fileName = basename(filePath)
          if (!fileName.endsWith('.md') && !fileName.endsWith('.zip')) {
            throw new CliError('Only .md or .zip files are supported')
          }
          const fileBuffer = readFileSync(filePath)
          const formData = new FormData()
          formData.append('file', new Blob([fileBuffer]), fileName)
          if (args.group) {
            const groupId = await client.resolveSkillGroupId(args.group as string)
            formData.append('groupId', groupId)
          }
          const visibility = parseVisibility(args.visibility)
          if (visibility) formData.append('visibility', visibility)
          const { data } = await client.postFormData<{ data: Skill }>(
            '/api/skills/upload',
            formData,
          )
          console.log(`Skill uploaded ✓  ${data.id}  ${data.name}`)
          return
        }

        // Field-based creation
        if (!args.name)
          throw new CliError('--name is required to create a Skill (or upload with --file)')
        const body: Record<string, unknown> = { name: args.name as string }
        if (args.description) body.description = args.description as string
        if (args['content-file']) {
          body.content = readFileSync(args['content-file'] as string, 'utf-8')
        } else if (args.content) {
          body.content = args.content as string
        }
        if (args.group) {
          body.groupId = await client.resolveSkillGroupId(args.group as string)
        }
        const visibility = parseVisibility(args.visibility)
        if (visibility) body.visibility = visibility
        const { data } = await client.post<{ data: Skill }>('/api/skills', body)
        console.log(`Skill created ✓  ${data.id}  ${data.name}`)
      },
    }),

    install: defineCommand({
      meta: {
        name: 'install',
        agentMeta: { risk: 'write' },
        description: 'Install public Skills from a skills.sh or GitHub URL',
      },
      args: {
        source: {
          type: 'positional',
          description: 'skills.sh or GitHub URL',
          required: true,
        },
        skill: {
          type: 'string',
          description: 'Install one candidate by name or repository path',
        },
        all: {
          type: 'boolean',
          description: 'Install every discovered candidate (maximum 20)',
        },
        group: { type: 'string', description: 'Parent Skill Group (ID or name)' },
        visibility: {
          type: 'string',
          description: 'Visibility: private (default) or all-users (administrators only)',
        },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        await installRemoteSkills(client, args.source as string, {
          skill: args.skill as string | undefined,
          all: args.all as boolean | undefined,
          group: args.group as string | undefined,
          visibility: parseVisibility(args.visibility),
        })
      },
    }),

    'check-update': defineCommand({
      meta: {
        name: 'check-update',
        agentMeta: { risk: 'read' },
        description: 'Check a remote Skill for upstream and local file changes',
      },
      args: {
        id: { type: 'positional', description: 'Skill ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const skillId = await client.resolveSkillId(args.id as string)
        const result = await client.post<{ data: RemoteSkillUpdateCheck }>(
          `/api/skills/${skillId}/remote/check`,
          {},
        )
        if (emit(args, result)) return
        const check = result.data
        console.log(
          check.updateAvailable
            ? `Update available ✓  ${check.latestRevision}`
            : `Already up to date ✓  ${check.latestRevision}`,
        )
        if (check.sourceDirty) console.log('Local changes detected')
        for (const file of check.files) {
          const conflict = file.conflict ? '  CONFLICT' : ''
          console.log(
            `${file.path}  local=${file.localChange ?? '-'}  upstream=${file.remoteChange ?? '-'}${conflict}`,
          )
        }
      },
    }),

    'update-remote': defineCommand({
      meta: {
        name: 'update-remote',
        agentMeta: { risk: 'write' },
        description: 'Update a remote Skill after an explicit three-way comparison',
      },
      args: {
        id: { type: 'positional', description: 'Skill ID or name', required: true },
        strategy: {
          type: 'string',
          description: 'Conflict strategy: abort, preserve-local, or overwrite',
          default: 'abort',
        },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const skillId = await client.resolveSkillId(args.id as string)
        const checked = await client.post<{ data: RemoteSkillUpdateCheck }>(
          `/api/skills/${skillId}/remote/check`,
          {},
        )
        if (!checked.data.updateAvailable) {
          console.log(`Already up to date ✓  ${checked.data.latestRevision}`)
          return
        }

        const rawStrategy = args.strategy as string
        const strategy = rawStrategy === 'preserve-local' ? 'preserve_local' : rawStrategy
        if (!['abort', 'preserve_local', 'overwrite'].includes(strategy)) {
          throw new CliError('--strategy must be abort, preserve-local, or overwrite')
        }
        if (checked.data.conflicts.length > 0 && strategy === 'abort') {
          throw new CliError(
            `Update has conflicts in: ${checked.data.conflicts.join(', ')}. Re-run with --strategy preserve-local or --strategy overwrite.`,
          )
        }

        await client.post(`/api/skills/${skillId}/remote/update`, {
          revision: checked.data.latestRevision,
          digest: checked.data.latestDigest,
          strategy: strategy as RemoteSkillUpdateStrategy,
        })
        console.log(`Remote Skill updated ✓  ${checked.data.latestRevision}`)
      },
    }),

    list: defineCommand({
      meta: { name: 'list', description: 'List all Skills', agentMeta: { risk: 'read' } },
      args: { ...jsonArg, ...pageArgs, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const result = await client.get<{ data: Skill[] }>(`/api/skills?${pageQuery(args, 100)}`)
        if (emit(args, result)) return
        if (result.data.length === 0) {
          console.log('No Skills yet')
          return
        }
        for (const s of result.data) {
          const desc = s.description ? `  ${s.description}` : ''
          console.log(`${s.id}  ${s.name}  [${s.visibility}]${desc}`)
        }
      },
    }),

    get: defineCommand({
      meta: {
        name: 'get',
        description: 'Show Skill details (ID or name)',
        agentMeta: { risk: 'read' },
      },
      args: {
        id: { type: 'positional', description: 'Skill ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const skillId = await client.resolveSkillId(args.id as string)
        const result = await client.get<{ data: Skill }>(`/api/skills/${skillId}`)
        if (emit(args, result)) return
        const s = result.data
        console.log(`ID:          ${s.id}`)
        console.log(`Name:        ${s.name}`)
        console.log(`Description: ${s.description ?? ''}`)
        console.log(`Visibility:  ${s.visibility}`)
        console.log(`Updated:     ${s.updatedAt}`)
        if (s.content) {
          console.log('\n--- Content ---')
          console.log(s.content)
        }
      },
    }),

    update: defineCommand({
      meta: {
        name: 'update',
        description: 'Update a Skill (ID or name)',
        agentMeta: { risk: 'write' },
      },
      args: {
        id: { type: 'positional', description: 'Skill ID or name', required: true },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        content: { type: 'string', description: 'New instruction content (SKILL.md body)' },
        'content-file': {
          type: 'string',
          description: 'Read instruction content from a file (e.g. ./SKILL.md)',
        },
        file: {
          type: 'string',
          description:
            'Upload a .md or .zip file to fully replace the Skill (cannot be combined with --visibility)',
        },
        visibility: {
          type: 'string',
          description: 'New visibility: private or all-users (administrators only)',
        },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        if (args.file && args.visibility !== undefined) {
          throw new CliError('--file and --visibility cannot be used together')
        }
        const skillId = await client.resolveSkillId(args.id as string)
        const visibility = parseVisibility(args.visibility)

        // --file: full replacement (reupload)
        if (args.file) {
          const filePath = args.file as string
          const fileName = basename(filePath)
          if (!fileName.endsWith('.md') && !fileName.endsWith('.zip')) {
            throw new CliError('Only .md or .zip files are supported')
          }
          const fileBuffer = readFileSync(filePath)
          const blob = new Blob([fileBuffer])
          const formData = new FormData()
          formData.append('file', blob, fileName)
          await client.postFormData(`/api/skills/${skillId}/reupload`, formData)
          console.log('Skill file replaced ✓')
          return
        }

        // Field update (patch)
        const body: Record<string, string> = {}
        if (args.name) body.name = args.name as string
        if (args.description) body.description = args.description as string
        if (args['content-file']) {
          body.content = readFileSync(args['content-file'] as string, 'utf-8')
        } else if (args.content) {
          body.content = args.content as string
        }
        if (visibility) body.visibility = visibility

        if (Object.keys(body).length === 0) {
          throw new CliError(
            'Specify at least one field to update: --name, --description, --content, --content-file, --file, --visibility',
          )
        }

        await client.patch(`/api/skills/${skillId}`, body)
        console.log('Skill updated ✓')
      },
    }),

    delete: defineCommand({
      meta: {
        name: 'delete',
        agentMeta: { risk: 'high-risk-write' },
        description: 'Delete a Skill (irreversible; ID or name; confirms by default)',
      },
      args: {
        id: { type: 'positional', description: 'Skill ID or name', required: true },
        force: { type: 'boolean', description: 'Skip confirmation (for scripts/CI)' },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const skillId = await client.resolveSkillId(args.id as string)
        await confirmDestructive(
          `This will permanently delete Skill ${skillId} (${args.id}). This cannot be undone.`,
          args.force as boolean,
        )
        await client.del(`/api/skills/${skillId}`)
        console.log('Skill deleted ✓')
      },
    }),

    files: defineCommand({
      meta: {
        name: 'files',
        description: 'Read the files a Skill ships (decide whether to attach it before you do)',
      },
      subCommands: {
        list: defineCommand({
          meta: {
            name: 'list',
            description: 'List the files in a Skill’s storage',
            agentMeta: { risk: 'read' },
          },
          args: {
            id: { type: 'positional', description: 'Skill ID or name', required: true },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const skillId = await client.resolveSkillId(args.id as string)
            const result = await client.get<{ data: { path: string; entries: SkillFileEntry[] } }>(
              `/api/skills/${skillId}/files`,
            )
            if (emit(args, result)) return
            // The API answers with a nested tree, but every consumer of this
            // list wants a path it can pass straight back to `files get`.
            const flat = flattenSkillFiles(result.data.entries ?? [])
            if (flat.length === 0) {
              console.log('No files')
              return
            }
            for (const f of flat) {
              console.log(`${f.path}${f.size === undefined ? '' : `  ${f.size} bytes`}`)
            }
          },
        }),

        get: defineCommand({
          meta: {
            name: 'get',
            description: 'Print one file from a Skill’s storage',
            agentMeta: { risk: 'read' },
          },
          args: {
            id: { type: 'positional', description: 'Skill ID or name', required: true },
            file: {
              type: 'positional',
              description: 'File path within the Skill (e.g. SKILL.md, refs/api.md)',
              required: true,
            },
            full: {
              type: 'boolean',
              description: `Print the whole file instead of the first ${MAX_SKILL_FILE_LINES} lines`,
            },
            ...jsonArg,
            ...urlArg,
          },
          run: async ({ args }) => {
            const client = createClient({ url: args.url as string | undefined })
            const skillId = await client.resolveSkillId(args.id as string)
            const path = (args.file as string).replace(/^\/+/, '')
            // This route answers with the file BODY, not a JSON envelope — text
            // for known text extensions, octet-stream otherwise. `getRaw` is the
            // only client method that hands back an unparsed Response.
            const res = await client.getRaw(`/api/skills/${skillId}/files/${path}`)
            const contentType = res.headers.get('content-type') ?? ''
            if (!/^text\/|json/i.test(contentType)) {
              throw new CliError(
                `"${path}" is a binary file (${contentType || 'unknown type'}); the CLI will not print it.`,
                {
                  type: 'validation',
                  subtype: 'binary_file',
                  hint: `a2wave api GET /api/skills/${skillId}/files/${path}`,
                },
              )
            }
            const content = await res.text()
            // The route returns a bare body, so wrap it in the `data` envelope
            // every other command emits — a caller should not have to special-
            // case one endpoint's shape.
            if (emit(args, { data: { path, content } })) return
            printBoundedText(content, args.full === true)
          },
        }),
      },
    }),
  },
})
