import { api } from '@/lib/api'
import type {
  CreateScmSourceInput,
  ScmSource,
  ScmSourceConfig,
  ScmSourceType,
  UpdateScmSourceInput,
} from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

const SCM_SOURCES_KEY = ['scm-sources'] as const

/** Per-repository outcome inside a git check/probe. `directory` is '' in single-repo mode. */
export type ScmRepoCheckResult = {
  directory: string
  repoUrl: string
  ok: boolean
  message: string
}

export type P4CheckResult = {
  ok: boolean
  message: string
  serverVersion?: string
  clientRoot?: string
  clientRootWarning?: string
  /** Populated for git sources — one entry per repo, so a failure names itself. */
  repos?: ScmRepoCheckResult[]
}

export type ProbeScmSourceInput = {
  type: ScmSourceType
  config: ScmSourceConfig
  localPath?: string
  /**
   * Id of the source the form was loaded from, when editing. Lets the server
   * resolve credentials the form round-tripped as masked placeholders. Omitted
   * when creating, where every value is typed by the user.
   */
  sourceId?: string
}

export type ScmSourceStatus = {
  syncStatus: string
  lastSyncAt: string | null
  lastSyncError: string | null
  initialSyncCompletedAt: string | null
  codegraphStatus: 'idle' | 'indexing' | 'error'
  codegraphLastIndexedAt: string | null
  codegraphLastError: string | null
}

export function useScmSources(params?: { page?: number; pageSize?: number }) {
  const { page = 1, pageSize = 50 } = params ?? {}
  return useQuery({
    queryKey: [...SCM_SOURCES_KEY, page, pageSize],
    queryFn: () => api.list<ScmSource>(`/scm-sources?page=${page}&pageSize=${pageSize}`),
    // POST /sync returns 202 and syncs in the background, so the outcome only
    // ever arrives by re-reading. Poll while anything is mid-sync, and stop once
    // everything has settled — otherwise the card spins until a manual reload.
    refetchInterval: (query) =>
      query.state.data?.data?.some((s) => s.syncStatus === 'syncing') ? 3000 : false,
  })
}

export function useScmSource(id: string) {
  return useQuery({
    queryKey: [...SCM_SOURCES_KEY, id],
    queryFn: () => api.get<ScmSource>(`/scm-sources/${id}`),
    select: (res) => res.data,
    enabled: !!id,
  })
}

export function useCreateScmSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateScmSourceInput) => api.post<ScmSource>('/scm-sources', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: SCM_SOURCES_KEY }),
  })
}

export function useUpdateScmSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateScmSourceInput }) =>
      api.patch<ScmSource>(`/scm-sources/${id}`, input),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: SCM_SOURCES_KEY })
      qc.invalidateQueries({ queryKey: [...SCM_SOURCES_KEY, id] })
    },
  })
}

export function useDeleteScmSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.delete<ScmSource>(`/scm-sources/${id}`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: SCM_SOURCES_KEY })
      qc.invalidateQueries({ queryKey: [...SCM_SOURCES_KEY, id] })
    },
  })
}

export function useSyncScmSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.post<{ message: string }>(`/scm-sources/${id}/sync`, {}),
    onSuccess: (_, id) => {
      // The list key is [...SCM_SOURCES_KEY, page, pageSize], which the per-id
      // key does not prefix-match — so invalidating only the id left the card
      // that triggered the sync showing its pre-sync status indefinitely.
      qc.invalidateQueries({ queryKey: SCM_SOURCES_KEY })
      qc.invalidateQueries({ queryKey: [...SCM_SOURCES_KEY, id] })
      qc.invalidateQueries({ queryKey: [...SCM_SOURCES_KEY, id, 'status'] })
    },
  })
}

export function useReindexScmCodegraph() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ message: string }>(`/scm-sources/${id}/codegraph/reindex`, {}),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: [...SCM_SOURCES_KEY, id] })
      qc.invalidateQueries({ queryKey: [...SCM_SOURCES_KEY, id, 'status'] })
    },
  })
}

export function useCheckScmSource() {
  return useMutation({
    mutationFn: (id: string) => api.post<P4CheckResult>(`/scm-sources/${id}/check`, {}),
  })
}

/**
 * Probe connectivity for the config currently in the form, without saving it.
 * Unlike `useCheckScmSource` (which tests the stored config by id), this works
 * in create mode and reflects unsaved edits.
 */
export function useProbeScmSource() {
  return useMutation({
    mutationFn: (input: ProbeScmSourceInput) =>
      api.post<P4CheckResult>('/scm-sources/probe', input),
  })
}

export type ScmWorkspaceRepoInfo = {
  directory: string // '' denotes the workspace root in single-repo mode
  branch: string | null
  commit: string | null
  error?: string
}

export type ScmWorkspaceCleanup = 'ephemeral' | 'ttl' | 'persistent' | null

export type ScmWorkspaceInfo = {
  name: string
  path: string
  repos: ScmWorkspaceRepoInfo[]
  occupied: boolean
  cleanup: ScmWorkspaceCleanup
  lastRunId: string | null
  lastActivityAt: number | null
}

export function useScmSourceWorkspaces(id: string, enabled = true) {
  return useQuery({
    queryKey: [...SCM_SOURCES_KEY, id, 'workspaces'],
    queryFn: () => api.get<ScmWorkspaceInfo[]>(`/scm-sources/${id}/workspaces`),
    select: (res) => res.data,
    enabled: !!id && enabled,
  })
}

export function useDeleteScmWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.delete<{ message: string }>(`/scm-sources/${id}/workspaces/${encodeURIComponent(name)}`),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: [...SCM_SOURCES_KEY, id, 'workspaces'] })
    },
  })
}

export function useScmSourceStatus(id: string) {
  return useQuery({
    queryKey: [...SCM_SOURCES_KEY, id, 'status'],
    queryFn: () => api.get<ScmSourceStatus>(`/scm-sources/${id}/status`),
    select: (res) => res.data,
    enabled: !!id,
    refetchInterval: (query) => {
      const data = query.state.data as ScmSourceStatus | undefined
      return data?.syncStatus === 'syncing' || data?.codegraphStatus === 'indexing' ? 3_000 : 30_000
    },
  })
}
