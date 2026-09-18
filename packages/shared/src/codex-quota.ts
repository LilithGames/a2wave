/** Account-wide quota reported by the server's Codex login, not per-Agent usage. */
export interface CodexQuotaWindow {
  id: string
  label: string | null
  usedPercent: number
  windowDurationMins: number | null
  /** Unix timestamp in seconds; null when Codex does not report a reset. */
  resetsAt: number | null
}

export interface CodexQuota {
  status: 'available' | 'not_logged_in' | 'unsupported' | 'unavailable'
  windows: CodexQuotaWindow[]
}
