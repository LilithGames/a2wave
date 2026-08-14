import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { forceArgs, parseIntFlag, requireConfirmation, resolveForceFlag } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'
import { pageArgs, pageQuery } from '../lib/paginate.js'

interface KbDocument {
  id: string
  name: string
  description?: string | null
  sourceType: 'feishu' | 'upload' | 'notion'
  syncStatus: string
  feishuUrl?: string | null
  notionUrl?: string | null
  originalFilename?: string | null
  autoSync: boolean
  syncIntervalMin: number
  lastSyncAt?: string | null
  lastSyncError?: string | null
  createdAt: string
  updatedAt: string
}

export const kbCommand = defineCommand({
  meta: { name: 'kb', description: 'Manage knowledge base documents (KB Document)' },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List all KB documents', agentMeta: { risk: 'read' } },
      args: { ...jsonArg, ...pageArgs, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const result = await client.get<{ data: KbDocument[] }>(
          `/api/kb-documents?${pageQuery(args, 100)}`,
        )
        if (emit(args, result)) return
        if (result.data.length === 0) {
          console.log('No KB documents')
          return
        }
        for (const d of result.data) {
          console.log(`${d.id}  [${d.sourceType}]  ${d.name}  sync=${d.syncStatus}`)
        }
      },
    }),

    get: defineCommand({
      meta: {
        name: 'get',
        description: 'Show KB document details (by ID or name)',
        agentMeta: { risk: 'read' },
      },
      args: {
        id: { type: 'positional', description: 'KB Document ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveKbDocumentId(args.id as string)
        const res = await client.get<{ data: KbDocument }>(`/api/kb-documents/${id}`)
        if (emit(args, res)) return
        const d = res.data
        console.log(`ID:          ${d.id}`)
        console.log(`Name:        ${d.name}`)
        console.log(`SourceType:  ${d.sourceType}`)
        console.log(`SyncStatus:  ${d.syncStatus}`)
        console.log(`AutoSync:    ${d.autoSync} (every ${d.syncIntervalMin} min)`)
        if (d.feishuUrl) console.log(`FeishuUrl:   ${d.feishuUrl}`)
        if (d.notionUrl) console.log(`NotionUrl:   ${d.notionUrl}`)
        if (d.originalFilename) console.log(`File:        ${d.originalFilename}`)
        if (d.lastSyncAt) console.log(`LastSyncAt:  ${d.lastSyncAt}`)
        if (d.lastSyncError) console.log(`LastError:   ${d.lastSyncError}`)
        if (d.description) console.log(`Description: ${d.description}`)
        console.log(`Updated:     ${d.updatedAt}`)
      },
    }),

    create: defineCommand({
      meta: {
        name: 'create',
        agentMeta: { risk: 'write' },
        description:
          'Create a KB document from a Feishu / Notion source (for local files use kb upload)',
      },
      args: {
        name: { type: 'string', description: 'Document name', required: true },
        description: { type: 'string', description: 'Description' },
        'feishu-url': { type: 'string', description: 'Feishu document URL' },
        'feishu-app-id': { type: 'string', description: 'Feishu App ID' },
        'feishu-app-secret': { type: 'string', description: 'Feishu App Secret' },
        'notion-url': { type: 'string', description: 'Notion page URL' },
        'notion-token': { type: 'string', description: 'Notion Integration Token' },
        'auto-sync': { type: 'boolean', description: 'Enable auto sync' },
        'sync-interval': { type: 'string', description: 'Sync interval (minutes)' },
        ...urlArg,
      },
      run: async ({ args }) => {
        const feishuUrl = args['feishu-url'] as string | undefined
        const notionUrl = args['notion-url'] as string | undefined
        if (Boolean(feishuUrl) === Boolean(notionUrl)) {
          throw new CliError('Exactly one of --feishu-url or --notion-url is required')
        }
        const client = createClient({ url: args.url as string | undefined })
        const body: Record<string, unknown> = {
          name: args.name as string,
          sourceType: feishuUrl ? 'feishu' : 'notion',
        }
        if (feishuUrl) body.feishuUrl = feishuUrl
        if (notionUrl) body.notionUrl = notionUrl
        if (args.description) body.description = args.description as string
        if (args['feishu-app-id']) body.feishuAppId = args['feishu-app-id'] as string
        if (args['feishu-app-secret']) body.feishuAppSecret = args['feishu-app-secret'] as string
        if (args['notion-token']) body.notionToken = args['notion-token'] as string
        if (args['auto-sync'] !== undefined) body.autoSync = args['auto-sync'] as boolean
        if (args['sync-interval'] !== undefined)
          body.syncIntervalMin = parseIntFlag(args['sync-interval'], 'sync-interval', { min: 1 })
        const { data } = await client.post<{ data: KbDocument }>('/api/kb-documents', body)
        console.log(`KB document created ✓  ${data.id}  ${data.name}`)
      },
    }),

    upload: defineCommand({
      meta: {
        name: 'upload',
        agentMeta: { risk: 'write' },
        description:
          'Upload a local .md / .txt file as a KB document (name taken from the filename)',
      },
      args: {
        file: { type: 'string', description: 'Path to a .md or .txt file', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const filePath = args.file as string
        const fileName = basename(filePath)
        if (!fileName.endsWith('.md') && !fileName.endsWith('.txt')) {
          throw new CliError('Only .md or .txt files are supported')
        }
        const client = createClient({ url: args.url as string | undefined })
        const fileBuffer = readFileSync(filePath)
        const formData = new FormData()
        formData.append('file', new Blob([fileBuffer]), fileName)
        const { data } = await client.postFormData<{ data: KbDocument }>(
          '/api/kb-documents/upload',
          formData,
        )
        console.log(`KB document uploaded ✓  ${data.id}  ${data.name}`)
      },
    }),

    update: defineCommand({
      meta: {
        name: 'update',
        agentMeta: { risk: 'write' },
        description: 'Update KB document metadata or Notion connection (by ID or name)',
      },
      args: {
        id: { type: 'positional', description: 'KB Document ID or name', required: true },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        'notion-url': { type: 'string', description: 'New Notion page URL' },
        'notion-token': { type: 'string', description: 'New Notion Integration Token' },
        'auto-sync': { type: 'boolean', description: 'Enable/disable auto sync' },
        'sync-interval': { type: 'string', description: 'Sync interval (minutes)' },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveKbDocumentId(args.id as string)
        const body: Record<string, unknown> = {}
        if (args.name) body.name = args.name as string
        if (args.description) body.description = args.description as string
        const notionUrl = (args['notion-url'] as string | undefined)?.trim()
        const notionToken = (args['notion-token'] as string | undefined)?.trim()
        if (notionUrl) body.notionUrl = notionUrl
        if (notionToken) body.notionToken = notionToken
        if (args['auto-sync'] !== undefined) body.autoSync = args['auto-sync'] as boolean
        if (args['sync-interval'] !== undefined)
          body.syncIntervalMin = parseIntFlag(args['sync-interval'], 'sync-interval', { min: 1 })
        if (Object.keys(body).length === 0) {
          throw new CliError(
            'Specify at least one field to update: --name, --description, --notion-url, --notion-token, --auto-sync, --sync-interval',
          )
        }
        await client.patch(`/api/kb-documents/${id}`, body)
        console.log('KB document updated ✓')
      },
    }),

    delete: defineCommand({
      meta: {
        name: 'delete',
        description: 'Delete a KB document (by ID or name)',
        agentMeta: { risk: 'high-risk-write' },
      },
      args: {
        id: { type: 'positional', description: 'KB Document ID or name', required: true },
        ...forceArgs,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        // Resolve first so the confirmation names the ID actually being deleted.
        const id = await client.resolveKbDocumentId(args.id as string)
        await requireConfirmation(
          'high-risk-write',
          `This will permanently delete KB document ${id} (${args.id}). This action is irreversible.`,
          resolveForceFlag(args),
        )
        await client.del(`/api/kb-documents/${id}`)
        console.log('KB document deleted ✓')
      },
    }),

    sync: defineCommand({
      meta: {
        name: 'sync',
        agentMeta: { risk: 'write' },
        description: 'Manually re-fetch the document content from Feishu / Notion',
      },
      args: {
        id: { type: 'positional', description: 'KB Document ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveKbDocumentId(args.id as string)
        await client.post(`/api/kb-documents/${id}/sync`, {})
        console.log('Sync triggered ✓')
      },
    }),

    content: defineCommand({
      meta: {
        name: 'content',
        agentMeta: { risk: 'read' },
        description: 'Print the cached document body (for troubleshooting)',
      },
      args: {
        id: { type: 'positional', description: 'KB Document ID or name', required: true },
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const id = await client.resolveKbDocumentId(args.id as string)
        // /content returns plain text; read it with getRaw
        const res = await client.getRaw(`/api/kb-documents/${id}/content`)
        console.log(await res.text())
      },
    }),
  },
})
