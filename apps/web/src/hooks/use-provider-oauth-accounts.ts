import type { ProviderOauthAccount, ProviderOauthLoginStatus } from '@a2wave/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'

export const oauthAccountsKey = (providerId: string) => ['provider-oauth-accounts', providerId]

export interface ProviderOauthLogin {
  loginId: string
  loginToken: string
  expiresAt: string
}

export function useProviderOauthAccounts(providerId: string) {
  return useQuery({
    queryKey: oauthAccountsKey(providerId),
    queryFn: async () =>
      (await api.get<ProviderOauthAccount[]>(`/providers/${providerId}/oauth-accounts`)).data,
    enabled: !!providerId,
  })
}

export function useStartProviderOauthLogin(providerId: string) {
  return useMutation({
    mutationFn: async (input: { accountId?: string; label?: string }) =>
      (await api.post<ProviderOauthLogin>(`/providers/${providerId}/oauth-accounts/login`, input))
        .data,
  })
}

export function useProviderOauthLoginStatus(providerId: string, loginId?: string) {
  return useQuery({
    queryKey: [...oauthAccountsKey(providerId), 'login', loginId],
    queryFn: async () =>
      (
        await api.get<ProviderOauthLoginStatus>(
          `/providers/${providerId}/oauth-accounts/logins/${loginId}`,
        )
      ).data,
    enabled: !!providerId && !!loginId,
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'completed' || status === 'failed' || status === 'expired' ? false : 2000
    },
  })
}

export function useUpdateProviderOauthAccount(providerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ accountId, label }: { accountId: string; label: string }) =>
      (
        await api.patch<ProviderOauthAccount>(
          `/providers/${providerId}/oauth-accounts/${accountId}`,
          { label },
        )
      ).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: oauthAccountsKey(providerId) }),
  })
}

export function useDeleteProviderOauthAccount(providerId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (accountId: string) =>
      api.delete(`/providers/${providerId}/oauth-accounts/${accountId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: oauthAccountsKey(providerId) }),
  })
}
