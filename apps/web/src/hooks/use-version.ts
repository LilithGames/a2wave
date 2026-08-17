import { useQuery } from '@tanstack/react-query'

/**
 * The running server's version, or null when it cannot be determined.
 *
 * Every surface showing the version is decorative, so a failure resolves to
 * null instead of rejecting — the login footer and the About dialog then simply
 * omit it rather than having to render an error. The value cannot change
 * without a server restart, hence the infinite staleTime and no retry.
 */
export function useVersion() {
  return useQuery({
    queryKey: ['version'],
    queryFn: async (): Promise<string | null> => {
      try {
        const res = await fetch('/api/version', { credentials: 'include' })
        if (!res.ok) return null
        const data = (await res.json()) as { version?: string }
        return data.version ?? null
      } catch {
        return null
      }
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
}
