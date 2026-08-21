import type { RunTriggerSource } from '@a2wave/shared'
import { useTranslation } from 'react-i18next'

/**
 * i18n key per trigger source — the single copy.
 *
 * Typed as a total Record so adding a channel to the shared enum fails the build
 * here instead of silently rendering a raw key; a second hand-maintained copy is
 * how slack/discord went missing from the Agent overview breakdown.
 */
export const SOURCE_LABEL: Record<RunTriggerSource, string> = {
  debug: 'runs.sourceDebug',
  api: 'runs.sourceApi',
  feishu: 'runs.sourceFeishu',
  slack: 'runs.sourceSlack',
  discord: 'runs.sourceDiscord',
  qq_official: 'runs.sourceQQOfficial',
  a2a: 'runs.sourceA2a',
  schedule: 'runs.sourceSchedule',
  oauth: 'runs.sourceOauth',
  chat_app: 'runs.sourceChatApp',
  glab: 'runs.sourceGlab',
  gh: 'runs.sourceGh',
}

/**
 * Inline provenance chip for run rows: renders a muted rounded pill in front
 * of the run intent. Known layers are displayed in order:
 *   - user + caller Agent + source → `⟨张鑫·SDK Manager大神·A2A⟩`
 *   - caller Agent + source        → `⟨SDK Manager大神·A2A⟩`
 *   - source only                  → `⟨A2A⟩`
 * Existing user + source and single-layer combinations remain supported.
 */
export function RunCallerPrefix({
  name,
  callerAgentName,
  source,
}: {
  name: string | null | undefined
  callerAgentName?: string | null
  source: RunTriggerSource | null | undefined
}) {
  const { t } = useTranslation()
  const channelLabel = source ? t(SOURCE_LABEL[source]) : null
  const label = [name, callerAgentName, channelLabel].filter(Boolean).join('·')
  if (!label) return null
  return (
    <span className="mr-1.5 inline-block max-w-[24rem] truncate rounded bg-muted px-1.5 py-0.5 align-middle text-xs font-normal text-muted-foreground">
      {label}
    </span>
  )
}
