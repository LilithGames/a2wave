import type {
  ProbeModelsRequest,
  ProbeModelsResponse,
  ProviderDependents,
  ProviderDto,
  ProviderKind,
  ProviderListItem,
  UnsupportedProviderDto,
} from '@a2wave/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'

const PROVIDERS_KEY = ['providers'] as const
const fetchProviderList = () => api.get<ProviderListItem[]>('/providers')

function isUnsupportedProvider(item: ProviderListItem): item is UnsupportedProviderDto {
  return 'status' in item && item.status === 'unsupported'
}

export function useProviders() {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: fetchProviderList,
    select: (res) => res.data.filter((item): item is ProviderDto => !isUnsupportedProvider(item)),
  })
}

export function useUnsupportedProviders() {
  return useQuery({
    queryKey: PROVIDERS_KEY,
    queryFn: fetchProviderList,
    select: (res) => res.data.filter(isUnsupportedProvider),
  })
}

export function useProvider(id: string) {
  return useQuery({
    queryKey: [...PROVIDERS_KEY, id],
    queryFn: () => api.get<ProviderDto>(`/providers/${id}`),
    select: (res) => res.data,
    enabled: !!id,
  })
}

export function useProviderDependents(id: string) {
  return useQuery({
    queryKey: [...PROVIDERS_KEY, id, 'dependents'],
    queryFn: () => api.get<ProviderDependents>(`/providers/${id}/dependents`),
    select: (res) => res.data,
    enabled: !!id,
  })
}

export interface ProviderLoginStatus {
  installed: boolean
  loggedIn: boolean
  version?: string
  minVersion?: string
  versionOk?: boolean
  detail?: string
  method?: string
  raw?: string
  error?: string
  /**
   * `PROBE_FAILED` means the probe itself broke server-side. The engine's own
   * "CLI not found" verdict carries the same installed:false shape, so only
   * this distinguishes a broken check from a missing CLI.
   */
  code?: string
}

/** Checks the server-side CLI session for a stable Provider kind. */
export function useProviderLoginStatus(providerKind: ProviderKind | undefined) {
  return useQuery({
    queryKey: [...PROVIDERS_KEY, 'login-status', providerKind],
    queryFn: () => api.get<ProviderLoginStatus>(`/providers/login-status/${providerKind}`),
    select: (res) => res.data,
    enabled: !!providerKind,
    staleTime: 30_000,
    retry: false,
  })
}

/** Probes models for the supplied Provider kind, auth mode, and credentials. */
export function useProbeModels() {
  return useMutation<ProbeModelsResponse, Error, ProbeModelsRequest>({
    mutationFn: async (req) => {
      // Business errors use the same response envelope, so both success and
      // non-success statuses are decoded before deciding whether to throw.
      const response = await fetch('/api/providers/probe-models', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
      const body = (await response.json().catch(() => null)) as
        | { data: ProbeModelsResponse }
        | { error: unknown }
        | null
      if (!body) {
        throw new Error(`probe-models: empty response (HTTP ${response.status})`)
      }
      if ('data' in body && body.data) {
        return body.data
      }
      throw new Error(
        `probe-models: HTTP ${response.status} — ${
          'error' in body ? JSON.stringify(body.error) : 'unknown'
        }`,
      )
    },
  })
}
