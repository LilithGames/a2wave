/**
 * The publish tab's channel grid: a category filter above a flat card grid.
 *
 * Replaces the old secondary tab strip, which hid which channels were enabled
 * behind eight clicks. Follows the filter+grid pattern already used by the MCP
 * servers and Skills list pages.
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { ModePicker } from '@/components/ui/mode-picker'
import { ChannelCard } from './channel-card'
import {
  CHANNEL_FILTERS,
  CHANNEL_REGISTRY,
  type ChannelCategory,
  type ChannelKey,
} from './channel-registry'

export interface ChannelGridProps {
  /** Which channels are currently switched on. */
  enabled: Record<ChannelKey, boolean>
  onEnabledChange: (channel: ChannelKey, value: boolean) => void
  /** i18n key per channel explaining why it cannot be enabled yet, or null. */
  blockReasons: Partial<Record<ChannelKey, string | null>>
  onConfigure: (channel: ChannelKey) => void
  /** Optional compact summary rendered inside a channel's card. */
  renderInfo?: (channel: ChannelKey) => ReactNode
  /** Live connection readout for the channels that hold a long connection. */
  renderConnection?: (channel: ChannelKey) => ReactNode
  /**
   * Floated to the front of the grid during onboarding, replacing the old
   * "hoist the Feishu tab" behaviour.
   */
  pinnedChannel?: ChannelKey
}

export function ChannelGrid({
  enabled,
  onEnabledChange,
  blockReasons,
  onConfigure,
  renderInfo,
  renderConnection,
  pinnedChannel,
}: ChannelGridProps) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState<ChannelCategory | 'all'>('all')

  /**
   * REST API keeps the first slot even while another channel is pinned.
   *
   * It is the one always-on channel and the baseline every Agent exposes, so
   * it reads as the anchor of the grid. Onboarding used to hoist Feishu above
   * it, which shuffled the always-on card into second place for the users least
   * able to tell that the order had changed.
   */
  const ordered =
    pinnedChannel && pinnedChannel !== 'api'
      ? [...CHANNEL_REGISTRY].sort((a, b) => {
          if (a.key === 'api') return -1
          if (b.key === 'api') return 1
          if (a.key === pinnedChannel) return -1
          if (b.key === pinnedChannel) return 1
          return 0
        })
      : CHANNEL_REGISTRY

  const visible = filter === 'all' ? ordered : ordered.filter((c) => c.category === filter)

  return (
    <div className="space-y-4">
      <ModePicker
        value={filter}
        onChange={(value) => setFilter(value as ChannelCategory | 'all')}
        options={CHANNEL_FILTERS.map((f) => ({ value: f.value, label: t(f.labelKey) }))}
      />

      {visible.length === 0 ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">{t('agentPublish.filterEmpty')}</p>
          </CardContent>
        </Card>
      ) : (
        // Same breakpoints as the Agents / MCP / Skills list grids. At three
        // columns the eight channels wrapped to three rows and each card was
        // stretched wide, leaving a gap on the right of a wide screen.
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((meta) => (
            <ChannelCard
              key={meta.key}
              meta={meta}
              enabled={meta.alwaysOn || enabled[meta.key]}
              onEnabledChange={(value) => onEnabledChange(meta.key, value)}
              blockReason={blockReasons[meta.key] ?? null}
              onConfigure={() => onConfigure(meta.key)}
              info={renderInfo?.(meta.key)}
              connection={renderConnection?.(meta.key)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
