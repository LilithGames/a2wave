import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

const MEMORY_KEY = ['memories'] as const

export interface MemoryFileInfo {
  name: string
  size: number
  mtime: number
}

export interface MemorySearchResult {
  filePath: string
  snippet: string
  score: number
  mtime: number
  fileKind?: 'main' | 'topic' | 'archived_topic' | 'weekly' | 'daily' | 'other'
  topicId?: string | null
  topicStatus?: 'active' | 'archived' | null
}

export type MemoryHierarchyMode = 'empty' | 'legacy_single_file' | 'topic_v2'

export interface MemoryTopicMetadata {
  topicId: string
  title: string
  scope: string
  description: string
  keywords: string[]
  status: 'active' | 'archived'
  updatedAt: string
  path: string
  size: number
  tokenCount: number
  needsReorganization: boolean
}

export interface MemoryTopicizationPreview {
  proposalId: string
  expiresAt: string
  sourceBlockCount: number
  topics: Array<{
    topicId: string
    title: string
    scope: string
    description: string
    keywords: string[]
    sourceBlockCount: number
    tokenCount: number
  }>
  summary: string[]
  manifest: Array<{
    sourceBlockHash: string
    destinationTopicId: string
    destinationBlockHash: string
  }>
}

export interface MemoryStats {
  fileCount: number
  totalSize: number
  dailyFileCount: number
  oldestFile: string | null
  newestFile: string | null
}

/** 列出记忆文件 */
export function useMemoryFiles(agentId: string | undefined) {
  return useQuery({
    queryKey: [...MEMORY_KEY, agentId, 'files'],
    queryFn: () => api.get<MemoryFileInfo[]>(`/memories/${agentId}`),
    enabled: !!agentId,
  })
}

/** 读取文件内容 */
export function useMemoryFileContent(agentId: string | undefined, filename: string | undefined) {
  return useQuery({
    queryKey: [...MEMORY_KEY, agentId, 'file', filename],
    queryFn: () =>
      api.get<{ filename: string; content: string }>(`/memories/${agentId}/files/${filename}`),
    enabled: !!agentId && !!filename,
  })
}

/** List topic metadata without loading topic bodies. */
export function useMemoryTopics(
  agentId: string | undefined,
  status: 'active' | 'archived' | 'all' = 'active',
) {
  return useQuery({
    queryKey: [...MEMORY_KEY, agentId, 'topics', status],
    queryFn: () =>
      api.get<{
        mode: MemoryHierarchyMode
        invalidFiles: string[]
        topics: MemoryTopicMetadata[]
      }>(`/memories/${agentId}/topics?status=${status}`),
    enabled: !!agentId,
  })
}

/** Read one active topic after the user selects its metadata. */
export function useMemoryTopic(agentId: string | undefined, topicId: string | undefined) {
  return useQuery({
    queryKey: [...MEMORY_KEY, agentId, 'topic', topicId],
    queryFn: () =>
      api.get<MemoryTopicMetadata & { content: string }>(`/memories/${agentId}/topics/${topicId}`),
    enabled: !!agentId && !!topicId,
  })
}

export type MemoryReorganizeRequest =
  | { action: 'archive' | 'reactivate'; topicId: string }
  | { action: 'merge'; sourceTopicIds: string[]; targetTopicId: string }
  | {
      action: 'split'
      topicId: string
      replacements: Array<{
        title: string
        scope: string
        description: string
        keywords: string[]
        sections: Array<{
          section:
            | 'Durable Knowledge'
            | 'Decisions and Conventions'
            | 'Workflows'
            | 'Failure Patterns'
            | 'Evidence Pointers'
          items: Array<{ sourceHash: string; content: string }>
        }>
      }>
    }
  | { action: 'topicize-preview' }
  | { action: 'topicize-commit'; proposalId: string }

/** Run editor-only topic lifecycle operations and legacy migration. */
export function useReorganizeMemoryTopics() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, request }: { agentId: string; request: MemoryReorganizeRequest }) =>
      api.post<MemoryTopicizationPreview | { topic?: MemoryTopicMetadata }>(
        `/memories/${agentId}/topics/reorganize`,
        request,
      ),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: [...MEMORY_KEY, vars.agentId] })
    },
  })
}

/** 写入文件 */
export function useUpdateMemoryFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      agentId,
      filename,
      content,
    }: {
      agentId: string
      filename: string
      content: string
    }) =>
      api.put<{ filename: string; size: number }>(`/memories/${agentId}/files/${filename}`, {
        content,
      }),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: [...MEMORY_KEY, vars.agentId] })
    },
  })
}

/** 删除文件 */
export function useDeleteMemoryFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, filename }: { agentId: string; filename: string }) =>
      api.delete<{ deleted: string }>(`/memories/${agentId}/files/${filename}`),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: [...MEMORY_KEY, vars.agentId] })
    },
  })
}

/** 搜索记忆 */
export function useSearchMemories(
  agentId: string | undefined,
  query: string,
  options?: {
    mode?: string
    limit?: number
    decay?: boolean
    halfLife?: number
    mmr?: boolean
    mmrLambda?: number
  },
) {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (options?.mode) params.set('mode', options.mode)
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.decay) {
    params.set('decay', 'true')
    params.set('halfLife', String(options.halfLife ?? 14))
  }
  if (options?.mmr) {
    params.set('mmr', 'true')
    params.set('mmrLambda', String(options.mmrLambda ?? 0.7))
  }

  return useQuery({
    queryKey: [...MEMORY_KEY, agentId, 'search', query, options],
    queryFn: () =>
      api.get<{ results: MemorySearchResult[]; vectorIndexReady: boolean }>(
        `/memories/${agentId}/search?${params.toString()}`,
      ),
    enabled: !!agentId && !!query,
  })
}

/** 重建索引 */
export function useReindexMemory() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId }: { agentId: string }) =>
      api.post<{ message: string }>(`/memories/${agentId}/reindex`, {}),
    onSuccess: (_data, vars) => {
      void queryClient.invalidateQueries({ queryKey: [...MEMORY_KEY, vars.agentId] })
    },
  })
}

/** 统计 */
export function useMemoryStats(agentId: string | undefined) {
  return useQuery({
    queryKey: [...MEMORY_KEY, agentId, 'stats'],
    queryFn: () => api.get<MemoryStats>(`/memories/${agentId}/stats`),
    enabled: !!agentId,
  })
}
