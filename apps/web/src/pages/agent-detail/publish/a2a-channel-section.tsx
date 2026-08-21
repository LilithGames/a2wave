/**
 * Publish tab → A2A protocol channel section.
 *
 * Extracted from publish-tab.tsx to keep that file under the 3000-line gate;
 * fully controlled, with all state owned by the parent so `handlePublish` can
 * still assemble one atomic publish payload.
 */

import { Radio, Switch } from 'antd'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'
import { CopyButton } from '@/pages/agent-detail/copy-button'
import { ApiKeyList } from './api-key-list'

export type A2aAuthType = 'none' | 'api_key'

export interface A2aChannelSectionProps {
  /** Agent Card discovery URL (read-only). */
  cardUrl: string
  /** JSON-RPC endpoint URL (read-only). */
  rpcUrl: string
  authType: A2aAuthType
  onAuthTypeChange: (value: A2aAuthType) => void
  /** Undefined before the agent is persisted — no id to address the endpoints or mint a key. */
  agentId: string | undefined
  /** False before the agent is persisted — no id to address the endpoints or mint a key. */
  hasAgent: boolean
  trustForwardedIdentity: boolean
  onTrustForwardedIdentityChange: (value: boolean) => void
}

export function A2aChannelSection({
  cardUrl: a2aCardUrl,
  rpcUrl: a2aRpcUrl,
  authType: a2aAuthType,
  onAuthTypeChange: setA2aAuthType,
  agentId,
  hasAgent,
  trustForwardedIdentity,
  onTrustForwardedIdentityChange: setTrustForwardedIdentity,
}: A2aChannelSectionProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-5">
      {/* --- Section 1: A2A Service (inbound) --- */}
      <div className="space-y-4">
        {hasAgent && (
          <div className="flex flex-col gap-2">
            <Label className="text-sm font-medium text-foreground">
              {t('agentPublish.a2aEndpoint')}
            </Label>
            <div className="flex flex-col gap-2">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t('agentPublish.agentCard')}</p>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                  <code className="flex-1 truncate">{a2aCardUrl}</code>
                  <CopyButton text={a2aCardUrl} label={t('agentPublish.copyEndpoint')} />
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">
                  {t('agentPublish.jsonRpcEndpoint')}
                </p>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
                  <code className="flex-1 truncate">{a2aRpcUrl}</code>
                  <CopyButton text={a2aRpcUrl} label={t('agentPublish.copyEndpoint')} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* --- Section 2: A2A 鉴权（独立于 REST API 渠道）--- */}
        {hasAgent && (
          <div className="flex flex-col gap-4 border-t border-border pt-5">
            {/* 鉴权方式 */}
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-medium text-foreground">
                {t('agentPublish.authType')}
              </Label>
              <Radio.Group
                value={a2aAuthType}
                onChange={(e) => setA2aAuthType(e.target.value)}
                className="flex flex-col gap-1.5"
              >
                <Radio value="none">{t('agentPublish.authTypeNone')}</Radio>
                <Radio value="api_key">{t('agentPublish.authTypeApiKey')}</Radio>
              </Radio.Group>
            </div>

            {/* A2A keys: multiple named keys on the dedicated a2a channel, each
                independently revocable. A REST (`ak_`) key never authenticates here. */}
            {a2aAuthType === 'api_key' && <ApiKeyList agentId={agentId} channel="a2a" />}

            {/* 信任上游转发身份（仅 api_key 鉴权下有意义） */}
            {a2aAuthType === 'api_key' && (
              <div className="flex items-start justify-between gap-6">
                <div className="space-y-1 min-w-0 flex-1">
                  <Label className="text-sm font-medium text-foreground">
                    {t('agentPublish.trustForwardedIdentity')}
                  </Label>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t('agentPublish.trustForwardedIdentityDesc')}
                  </p>
                </div>
                <Switch
                  checked={trustForwardedIdentity}
                  onChange={setTrustForwardedIdentity}
                  className="shrink-0 mt-0.5"
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
