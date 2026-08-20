import type { Agent, AgentType } from '@a2wave/shared'
import { Tooltip } from 'antd'
import { Check, Copy, Pin } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useProviders } from '@/hooks/use-providers'
import { copyText } from '@/lib/clipboard'
import { cn } from '@/lib/utils'

const agentTypeLabelKeys: Record<AgentType, string> = {
  llm: 'agent.typeLlm',
  cursor: 'agent.typeCursor',
  script: 'agent.typeScript',
}

function CopyIdButton({ text, ariaLabel }: { text: string; ariaLabel: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!(await copyText(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground/50 hover:text-foreground shrink-0"
      onClick={handleCopy}
      aria-label={ariaLabel}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </Button>
  )
}

interface AgentCardProps {
  agent: Pick<
    Agent,
    | 'id'
    | 'name'
    | 'type'
    | 'icon'
    | 'description'
    | 'publishStatus'
    | 'publishChannels'
    | 'providerId'
    | 'pinnedAt'
  >
  /** 切换置顶态；未传则不渲染置顶按钮（如无写权限） */
  onTogglePin?: (agent: { id: string; pinned: boolean }) => void
  /** 该卡片的置顶切换请求进行中，用于禁用按钮避免重复点击 */
  pinPending?: boolean
}

function PinButton({
  pinned,
  pending,
  onToggle,
  pinLabel,
  unpinLabel,
}: {
  pinned: boolean
  pending: boolean
  onToggle: () => void
  pinLabel: string
  unpinLabel: string
}) {
  const handleClick = (e: React.MouseEvent) => {
    // 卡片整体是 <Link>，阻止冒泡与默认跳转，让点击只切换置顶。
    e.preventDefault()
    e.stopPropagation()
    if (!pending) onToggle()
  }

  return (
    <Tooltip title={pinned ? unpinLabel : pinLabel}>
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        aria-label={pinned ? unpinLabel : pinLabel}
        aria-pressed={pinned}
        className={cn(
          // translate-y-px 让图钉在标题文字的光学中线对齐——图钉针尖下坠、视觉重心偏下，
          // 纯 items-center 会显得偏上，向下微调 1px 更贴合文字基线。
          'inline-flex size-4 shrink-0 translate-y-px items-center justify-center rounded-md transition-all',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
          pinned
            ? 'text-interactive-foreground'
            : // 未置顶态默认隐藏，hover 卡片或聚焦时浮现，避免每张卡都挂一个灰针
              'text-muted-foreground/50 opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100',
        )}
      >
        <Pin
          className={cn('h-3.5 w-3.5 transition-transform', pinned ? 'fill-current' : 'rotate-45')}
          aria-hidden="true"
        />
      </button>
    </Tooltip>
  )
}

export function AgentCard({ agent, onTogglePin, pinPending }: AgentCardProps) {
  const { t } = useTranslation()
  const { data: providers } = useProviders()
  // 副标题优先展示 Provider 名称（用户关心底层用哪个 AI），未绑定 Provider 时回退到执行类型文案。
  const providerName = agent.providerId
    ? providers?.find((p) => p.id === agent.providerId)?.name
    : undefined
  const subtitle = providerName ?? t(agentTypeLabelKeys[agent.type as AgentType] ?? 'agent.typeLlm')

  return (
    <Link to={`/agents/${agent.id}`} className="group">
      <Card className="h-full cursor-pointer hover:border-primary/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground shrink-0 text-lg">
                {agent.icon || '🤖'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <CardTitle className="text-base truncate">{agent.name}</CardTitle>
                  {onTogglePin && (
                    <PinButton
                      pinned={!!agent.pinnedAt}
                      pending={!!pinPending}
                      onToggle={() => onTogglePin({ id: agent.id, pinned: !agent.pinnedAt })}
                      pinLabel={t('agent.pin')}
                      unpinLabel={t('agent.unpin')}
                    />
                  )}
                </div>
                <CardDescription className="text-xs mt-0.5 truncate">{subtitle}</CardDescription>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge
                variant={
                  agent.publishStatus === 'published'
                    ? 'success'
                    : agent.publishStatus === 'stopped'
                      ? 'destructive'
                      : 'outline'
                }
                className="shrink-0"
              >
                {agent.publishStatus === 'published'
                  ? t('agent.running')
                  : agent.publishStatus === 'stopped'
                    ? t('agentDetail.stopped')
                    : t('agent.draft')}
              </Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p
            className="text-sm text-muted-foreground line-clamp-2 leading-relaxed"
            style={{ textWrap: 'pretty' }}
          >
            {agent.description ?? t('common.noDescription')}
          </p>
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/50">
            <span className="text-2xs text-muted-foreground/50 font-mono truncate min-w-0 flex-1">
              {agent.id}
            </span>
            <CopyIdButton text={agent.id} ariaLabel={t('agent.copyId')} />
          </div>
        </CardContent>
      </Card>
    </Link>
  )
}
