/**
 * Publish tab → Telegram channel section.
 *
 * Mirrors the Discord section's fully-controlled shape: all state is owned by
 * the parent so `handlePublish` can still assemble one atomic publish payload.
 *
 * Telegram has no separate application id — the bot identity is the numeric
 * prefix of the token itself — so the credential block is a single field.
 */

import { Checkbox, Radio, Switch } from 'antd'
import { useTranslation } from 'react-i18next'
import { Label } from '@/components/ui/label'

export type TelegramGroupReplyMode = 'reply' | 'new' | 'none'
export type TelegramPrivateReplyMode = 'reply' | 'new' | 'none'

export interface TelegramChannelSectionProps {
  botToken: string
  onBotTokenChange: (value: string) => void
  groupTriggerOnMention: boolean
  onGroupTriggerOnMentionChange: (value: boolean) => void
  groupTriggerOnNewMessage: boolean
  onGroupTriggerOnNewMessageChange: (value: boolean) => void
  groupReplyMode: TelegramGroupReplyMode
  onGroupReplyModeChange: (value: TelegramGroupReplyMode) => void
  privateReplyMode: TelegramPrivateReplyMode
  onPrivateReplyModeChange: (value: TelegramPrivateReplyMode) => void
  sendArtifactsAsFile: boolean
  onSendArtifactsAsFileChange: (value: boolean) => void
}

export function TelegramChannelSection({
  botToken: telegramBotToken,
  onBotTokenChange: setTelegramBotToken,
  groupTriggerOnMention: telegramGroupTriggerOnMention,
  onGroupTriggerOnMentionChange: setTelegramGroupTriggerOnMention,
  groupTriggerOnNewMessage: telegramGroupTriggerOnNewMessage,
  onGroupTriggerOnNewMessageChange: setTelegramGroupTriggerOnNewMessage,
  groupReplyMode: telegramGroupReplyMode,
  onGroupReplyModeChange: setTelegramGroupReplyMode,
  privateReplyMode: telegramPrivateReplyMode,
  onPrivateReplyModeChange: setTelegramPrivateReplyMode,
  sendArtifactsAsFile: telegramSendArtifactsAsFile,
  onSendArtifactsAsFileChange: setTelegramSendArtifactsAsFile,
}: TelegramChannelSectionProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-5">
      <div className="info-panel space-y-1 px-3 py-2.5 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t('agentPublish.telegramSetupTitle')}</p>
        <p>{t('agentPublish.telegramSetupHelp')}</p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="telegram-bot-token" required>
          {t('agentPublish.telegramBotToken')}
        </Label>
        <input
          id="telegram-bot-token"
          type="password"
          value={telegramBotToken}
          onChange={(event) => setTelegramBotToken(event.target.value)}
          placeholder={t('agentPublish.telegramBotTokenPlaceholder')}
          className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3 rounded-lg bg-muted/40 px-4 py-3">
          <Label className="font-semibold">{t('agentPublish.telegramGroupSection')}</Label>
          <div className="flex flex-col gap-1.5">
            <Checkbox
              checked={telegramGroupTriggerOnMention}
              onChange={(event) => setTelegramGroupTriggerOnMention(event.target.checked)}
            >
              {t('agentPublish.telegramTriggerOnMention')}
            </Checkbox>
            <div>
              <Checkbox
                checked={telegramGroupTriggerOnNewMessage}
                onChange={(event) => setTelegramGroupTriggerOnNewMessage(event.target.checked)}
              >
                {t('agentPublish.telegramTriggerOnNewMessage')}
              </Checkbox>
              <p className="mt-1 pl-6 text-xs text-muted-foreground">
                {t('agentPublish.telegramTriggerOnNewMessageHint')}
              </p>
            </div>
          </div>
          <Radio.Group
            value={telegramGroupReplyMode}
            onChange={(event) => setTelegramGroupReplyMode(event.target.value)}
            className="flex flex-col gap-1.5"
          >
            <Radio value="reply">{t('agentPublish.telegramReply')}</Radio>
            <Radio value="new">{t('agentPublish.nativeReplyNew')}</Radio>
            <Radio value="none">{t('agentPublish.nativeReplyNone')}</Radio>
          </Radio.Group>
        </div>
        <div className="space-y-3 rounded-lg bg-muted/40 px-4 py-3">
          <Label className="font-semibold">{t('agentPublish.telegramPrivateSection')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('agentPublish.nativeDmAlwaysTriggers')}
          </p>
          <Radio.Group
            value={telegramPrivateReplyMode}
            onChange={(event) => setTelegramPrivateReplyMode(event.target.value)}
            className="flex flex-col gap-1.5"
          >
            <Radio value="reply">{t('agentPublish.telegramReply')}</Radio>
            <Radio value="new">{t('agentPublish.nativeReplyNew')}</Radio>
            <Radio value="none">{t('agentPublish.nativeReplyNone')}</Radio>
          </Radio.Group>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg bg-muted/40 px-4 py-3">
        <div>
          <Label className="text-sm font-medium">
            {t('agentPublish.nativeSendArtifactsAsFile')}
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('agentPublish.telegramSendArtifactsAsFileHelp')}
          </p>
        </div>
        <Switch checked={telegramSendArtifactsAsFile} onChange={setTelegramSendArtifactsAsFile} />
      </div>
    </div>
  )
}
