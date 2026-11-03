import { z } from 'zod'

/**
 * Max length of a KB document name, in UTF-16 units.
 *
 * Exported because the api clamps auto-derived names (from a remote document title or an
 * uploaded filename) to exactly this bound — a stored name longer than it could never
 * round-trip through `updateKbDocumentInput`, leaving the document permanently unrenameable.
 * Keeping the number in one place is what ties the clamp to the validator.
 */
export const KB_DOCUMENT_NAME_MAX = 200

export const kbDocumentSourceTypeEnum = z.enum(['feishu', 'upload', 'notion'])
export type KbDocumentSourceType = z.infer<typeof kbDocumentSourceTypeEnum>

export const kbDocumentSyncStatusEnum = z.enum(['idle', 'syncing', 'synced', 'error'])
export type KbDocumentSyncStatus = z.infer<typeof kbDocumentSyncStatusEnum>

export const kbDocumentSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(KB_DOCUMENT_NAME_MAX),
  description: z.string().nullable().optional(),
  sourceType: kbDocumentSourceTypeEnum,
  feishuDocToken: z.string().nullable().optional(),
  feishuDocType: z.string().nullable().optional(),
  feishuUrl: z.string().nullable().optional(),
  feishuAppId: z.string().nullable().optional(),
  notionPageId: z.string().nullable().optional(),
  notionUrl: z.string().nullable().optional(),
  originalFilename: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  storagePath: z.string().nullable().optional(),
  contentHash: z.string().nullable().optional(),
  fileSize: z.number().nullable().optional(),
  syncStatus: kbDocumentSyncStatusEnum,
  lastSyncAt: z.coerce.date().nullable().optional(),
  lastSyncError: z.string().nullable().optional(),
  autoSync: z.boolean().default(true),
  syncIntervalMin: z.number().min(1).default(60),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type KbDocument = z.infer<typeof kbDocumentSchema>

export const createKbDocumentInput = z.object({
  // Optional, not nullable and with no default: the web create form no longer asks
  // for a name, because for a remote source the fetched document title is a better
  // one than anything typed while pasting a batch of links. `min(1)` still rejects
  // `''`, so the api can tell "omitted, fall back to the title" apart from "blank".
  name: z.string().min(1).max(KB_DOCUMENT_NAME_MAX).optional(),
  description: z.string().nullable().optional(),
  sourceType: kbDocumentSourceTypeEnum,
  feishuUrl: z.string().nullable().optional(),
  feishuAppId: z.string().nullable().optional(),
  feishuAppSecret: z.string().nullable().optional(),
  notionUrl: z.string().nullable().optional(),
  notionToken: z.string().nullable().optional(),
  autoSync: z.boolean().optional(),
  syncIntervalMin: z.number().min(1).optional(),
})

export type CreateKbDocumentInput = z.infer<typeof createKbDocumentInput>

export const updateKbDocumentInput = z.object({
  name: z.string().min(1).max(KB_DOCUMENT_NAME_MAX).optional(),
  description: z.string().nullable().optional(),
  notionUrl: z.string().trim().min(1).optional(),
  notionToken: z.string().trim().min(1).optional(),
  autoSync: z.boolean().optional(),
  syncIntervalMin: z.number().min(1).optional(),
})

export type UpdateKbDocumentInput = z.infer<typeof updateKbDocumentInput>
