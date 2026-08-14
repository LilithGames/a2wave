export function resolveProcessInstanceId(configured: string | undefined, host: string): string {
  return configured?.trim() || host
}

/** Stable for one container/pod restart boundary; operators may override it. */
export const processInstanceId = resolveProcessInstanceId(
  process.env.A2WAVE_INSTANCE_ID,
  process.env.HOSTNAME || `process-${process.pid}`,
)
