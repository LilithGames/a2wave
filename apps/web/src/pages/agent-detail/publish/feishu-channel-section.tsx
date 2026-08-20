/**
 * Publish tab → 飞书机器人 (Feishu bot) channel section.
 *
 * Extracted from publish-tab.tsx to keep that file under the 3000-line gate.
 * State still lives in the parent (one atomic publish payload is assembled
 * there); this component is fully controlled. The card-callout measurement and
 * the scope derivation are Feishu-only, so they live here rather than adding
 * four more props.
 *
 * The `data-tour` anchors are load-bearing: the onboarding tour drives the
 * Feishu FTUE by querying them (see components/onboarding/onboarding-tour.tsx).
 */

import { Checkbox, InputNumber, Popover, Radio, Switch } from 'antd'
import { Eye, EyeOff, Globe, Info } from 'lucide-react'
import type { CSSProperties, RefObject } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { message } from '@/lib/antd-static'
import { copyText } from '@/lib/clipboard'
import { CopyButton } from '@/pages/agent-detail/copy-button'

export type FeishuReplyMode = 'quote' | 'new' | 'none'
export type FeishuTopicReplyMode = 'topic_reply' | 'none'
export type FeishuTopicReplyMentionTarget = 'trigger_sender' | 'topic_creator' | 'none'
export type FeishuReplyContentType =
  | 'text'
  | 'post'
  | 'interactive'
  | 'interactive_card'
  | 'streaming_card'

/** Group-chat trigger + reply settings. */
export interface FeishuGroupSettings {
  triggerOnAt: boolean
  triggerOnNewMessage: boolean
  replyMode: FeishuReplyMode
}

/** Topic-group (话题群) trigger + reply settings. */
export interface FeishuTopicSettings {
  triggerOnAt: boolean
  triggerOnNewTopic: boolean
  triggerOnNewComment: boolean
  replyMode: FeishuTopicReplyMode
  replyMentionTarget: FeishuTopicReplyMentionTarget
  injectRootMessage: boolean
}

/** Reply rendering, debug suffixes and artifact delivery. */
export interface FeishuReplySettings {
  contentType: FeishuReplyContentType
  cardTemplateId: string
  debugShowSessionId: boolean
  debugShowProvider: boolean
  debugShowModel: boolean
  sendArtifactsAsFile: boolean
  fetchUserInfo: boolean
}

/** Welcome message and the events that deliver it. */
export interface FeishuWelcomeSettings {
  message: string
  onP2pEnabled: boolean
  p2pIdleDays: number
  onGroupAddedEnabled: boolean
}

export interface FeishuChannelSectionProps {
  /** Shown only on the "create a new app" branch of the setup chooser. */
  showCreateGuide: boolean
  /** Focus target for the onboarding tour's "enter App ID" step. */
  appIdInputRef: RefObject<HTMLInputElement | null>
  appId: string
  onAppIdChange: (value: string) => void
  appSecret: string
  onAppSecretChange: (value: string) => void
  /** Base tenant scopes; `im:chat` is appended here when a welcome is enabled. */
  baseScopes: readonly string[]
  group: FeishuGroupSettings
  onGroupChange: (patch: Partial<FeishuGroupSettings>) => void
  p2pReplyMode: FeishuReplyMode
  onP2pReplyModeChange: (value: FeishuReplyMode) => void
  topic: FeishuTopicSettings
  onTopicChange: (patch: Partial<FeishuTopicSettings>) => void
  reply: FeishuReplySettings
  onReplyChange: (patch: Partial<FeishuReplySettings>) => void
  welcome: FeishuWelcomeSettings
  onWelcomeChange: (patch: Partial<FeishuWelcomeSettings>) => void
  launcherUrl: string
}

export function FeishuChannelSection({
  showCreateGuide: feishuShowCreateGuide,
  appIdInputRef: feishuAppIdInputRef,
  appId: feishuAppId,
  onAppIdChange: setFeishuAppId,
  appSecret: feishuAppSecret,
  onAppSecretChange: setFeishuAppSecret,
  baseScopes,
  group,
  onGroupChange,
  p2pReplyMode,
  onP2pReplyModeChange: setP2pReplyMode,
  topic,
  onTopicChange,
  reply,
  onReplyChange,
  welcome,
  onWelcomeChange,
  launcherUrl: FEISHU_LAUNCHER_URL,
}: FeishuChannelSectionProps) {
  const { t, i18n } = useTranslation()
  const [feishuSecretVisible, setFeishuSecretVisible] = useState(false)

  // Destructured aliases keep the moved JSX byte-identical to its previous form.
  const { triggerOnAt: groupTriggerOnAt, triggerOnNewMessage: groupTriggerOnNewMessage } = group
  const groupReplyMode = group.replyMode
  const {
    triggerOnAt: topicTriggerOnAt,
    triggerOnNewTopic: topicTriggerOnNewTopic,
    triggerOnNewComment: topicTriggerOnNewComment,
    replyMode: topicReplyMode,
    replyMentionTarget: topicReplyMentionTarget,
    injectRootMessage: topicInjectRootMessage,
  } = topic
  const {
    contentType: feishuReplyContentType,
    cardTemplateId: feishuCardTemplateId,
    debugShowSessionId: feishuDebugShowSessionId,
    debugShowProvider: feishuDebugShowProvider,
    debugShowModel: feishuDebugShowModel,
    sendArtifactsAsFile: feishuSendArtifactsAsFile,
    fetchUserInfo: feishuFetchUserInfo,
  } = reply
  const {
    message: feishuWelcomeMessage,
    onP2pEnabled: feishuWelcomeOnP2pEnabled,
    p2pIdleDays: feishuWelcomeP2pIdleDays,
    onGroupAddedEnabled: feishuWelcomeOnGroupAddedEnabled,
  } = welcome

  const setGroupTriggerOnAt = (v: boolean) => onGroupChange({ triggerOnAt: v })
  const setGroupTriggerOnNewMessage = (v: boolean) => onGroupChange({ triggerOnNewMessage: v })
  const setGroupReplyMode = (v: FeishuReplyMode) => onGroupChange({ replyMode: v })
  const setTopicTriggerOnAt = (v: boolean) => onTopicChange({ triggerOnAt: v })
  const setTopicTriggerOnNewTopic = (v: boolean) => onTopicChange({ triggerOnNewTopic: v })
  const setTopicTriggerOnNewComment = (v: boolean) => onTopicChange({ triggerOnNewComment: v })
  const setTopicReplyMode = (v: FeishuTopicReplyMode) => onTopicChange({ replyMode: v })
  const setTopicReplyMentionTarget = (v: FeishuTopicReplyMentionTarget) =>
    onTopicChange({ replyMentionTarget: v })
  const setTopicInjectRootMessage = (v: boolean) => onTopicChange({ injectRootMessage: v })
  const setFeishuReplyContentType = (v: FeishuReplyContentType) => onReplyChange({ contentType: v })
  const setFeishuCardTemplateId = (v: string) => onReplyChange({ cardTemplateId: v })
  const setFeishuDebugShowSessionId = (v: boolean) => onReplyChange({ debugShowSessionId: v })
  const setFeishuDebugShowProvider = (v: boolean) => onReplyChange({ debugShowProvider: v })
  const setFeishuDebugShowModel = (v: boolean) => onReplyChange({ debugShowModel: v })
  const setFeishuSendArtifactsAsFile = (v: boolean) => onReplyChange({ sendArtifactsAsFile: v })
  const setFeishuFetchUserInfo = (v: boolean) => onReplyChange({ fetchUserInfo: v })
  const setFeishuWelcomeMessage = (v: string) => onWelcomeChange({ message: v })
  const setFeishuWelcomeOnP2pEnabled = (v: boolean) => onWelcomeChange({ onP2pEnabled: v })
  const setFeishuWelcomeP2pIdleDays = (v: number) => onWelcomeChange({ p2pIdleDays: v })
  const setFeishuWelcomeOnGroupAddedEnabled = (v: boolean) =>
    onWelcomeChange({ onGroupAddedEnabled: v })

  // `contact:contact.*` (tenant_access_token namespace) is required by fetchUserInfo, so it is
  // always listed in the base set. It no longer covers the OAuth channel: that authorized via
  // the Feishu visible scope, which has been replaced by a local email allowlist.
  // 开场白依赖「进群 / 进单聊」事件，飞书要求 im:chat 才会推送对应事件；它属于可选功能，
  // 只在用户启用开场白时才追加，避免给不用该功能的集成过度授权。
  const feishuWelcomeEnabled = feishuWelcomeOnP2pEnabled || feishuWelcomeOnGroupAddedEnabled
  const feishuTenantScopes = [
    ...baseScopes,
    ...(feishuWelcomeEnabled ? (['im:chat'] as const) : []),
  ]
  const feishuAppScopesJson = JSON.stringify(
    { scopes: { tenant: [...feishuTenantScopes], user: [] } },
    null,
    2,
  )

  const feishuInteractiveRadioWrapRef = useRef<HTMLSpanElement>(null)
  const feishuCardCalloutRef = useRef<HTMLDivElement>(null)
  const [feishuCardCalloutArrowX, setFeishuCardCalloutArrowX] = useState<string>('50%')

  // biome-ignore lint/correctness/useExhaustiveDependencies: i18n.language is the trigger for re-measuring after locale-driven layout shift
  useLayoutEffect(() => {
    if (groupReplyMode === 'none' || feishuReplyContentType !== 'interactive') {
      setFeishuCardCalloutArrowX('50%')
      return
    }
    const wrap = feishuInteractiveRadioWrapRef.current
    const callout = feishuCardCalloutRef.current
    if (!wrap || !callout) return

    const updateArrow = () => {
      const w = feishuInteractiveRadioWrapRef.current
      const c = feishuCardCalloutRef.current
      if (!w || !c) return
      const marker =
        w.querySelector<HTMLElement>('.ant-radio-inner') ??
        w.querySelector<HTMLElement>('.ant-radio')
      const rect = (marker ?? w).getBoundingClientRect()
      const cr = c.getBoundingClientRect()
      const centerPx = rect.left + rect.width / 2 - cr.left
      const edgePad = 18
      const minX = edgePad
      const maxX = cr.width - edgePad
      setFeishuCardCalloutArrowX(`${Math.round(Math.min(Math.max(centerPx, minX), maxX))}px`)
    }

    updateArrow()
    const ro = new ResizeObserver(updateArrow)
    ro.observe(wrap)
    ro.observe(callout)
    window.addEventListener('resize', updateArrow)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updateArrow)
    }
  }, [groupReplyMode, feishuReplyContentType, i18n.language])

  return (
    <div className="space-y-5">
      {/* 「创建新应用」分支：launcher 引导（已有应用分支不展示） */}
      {feishuShowCreateGuide && (
        <div className="rounded-lg border border-primary/30 bg-brand-gradient-subtle px-3 py-3 text-sm">
          <p className="mb-2 font-medium text-foreground">
            {t('agentPublish.feishuCreateGuideTitle')}
          </p>
          <ol className="mb-3 list-inside list-decimal space-y-1 text-muted-foreground">
            <li>{t('agentPublish.feishuCreateGuideStep1')}</li>
            <li>{t('agentPublish.feishuCreateGuideStep2')}</li>
            <li>{t('agentPublish.feishuCreateGuideStep3')}</li>
            <li>{t('agentPublish.feishuCreateGuideStep4')}</li>
          </ol>
          <Button
            type="button"
            size="sm"
            onClick={() => window.open(FEISHU_LAUNCHER_URL, '_blank', 'noopener,noreferrer')}
          >
            <Globe className="h-4 w-4" aria-hidden="true" />
            {t('agentPublish.feishuOpenLauncher')}
          </Button>
        </div>
      )}

      {/* Required permissions + events & callbacks */}
      <div className="info-panel px-3 py-2.5 text-sm text-muted-foreground">
        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 md:gap-0">
          <div className="min-w-0 md:pr-4">
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                <p className="font-medium text-foreground">{t('agentPublish.feishuPermissions')}</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={async () => {
                  if (!(await copyText(feishuAppScopesJson))) return
                  message.success(t('agentPublish.feishuScopesJsonCopied'))
                }}
              >
                {t('agentPublish.feishuCopyScopesJson')}
              </Button>
            </div>
            <ul className="list-inside list-disc space-y-0.5 font-mono text-xs">
              {feishuTenantScopes.map((scope) => (
                <li key={scope}>{scope}</li>
              ))}
            </ul>
          </div>
          <div className="min-w-0 md:border-l md:border-border md:pl-4">
            <p className="mb-1 font-medium text-foreground">{t('agentPublish.feishuEvents')}</p>
            <ul className="list-inside list-disc space-y-0.5 text-xs">
              <li>{t('agentPublish.feishuSubscribeMode')}</li>
              <li>
                {t('agentPublish.feishuAddEvent')}
                <code className="font-mono">im.message.receive_v1</code>
              </li>
              <li>{t('agentPublish.feishuCallbackSubscribeMode')}</li>
              <li>
                {t('agentPublish.feishuAddCallback')}
                <code className="font-mono">card.action.trigger</code>
              </li>
            </ul>
          </div>
        </div>
      </div>

      {/* App ID */}
      <div className="flex flex-col gap-2">
        <Label required className="text-sm font-medium text-foreground">
          {t('agentPublish.feishuAppId')}
        </Label>
        <div
          data-tour="feishu-app-id"
          className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        >
          <input
            ref={feishuAppIdInputRef}
            type="text"
            value={feishuAppId}
            onChange={(e) => setFeishuAppId(e.target.value)}
            placeholder="cli_xxx"
            className="flex-1 bg-transparent outline-none"
          />
          {feishuAppId && <CopyButton text={feishuAppId} label={t('common.copy')} />}
        </div>
      </div>

      {/* App Secret */}
      <div className="flex flex-col gap-2">
        <Label required className="text-sm font-medium text-foreground">
          {t('agentPublish.feishuAppSecret')}
        </Label>
        <div
          data-tour="feishu-app-secret"
          className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm"
        >
          <input
            type={feishuSecretVisible ? 'text' : 'password'}
            // 隐藏且已配置时显示 8 个圆点遮罩（点眼睛查看明文）；新输入则照常编辑。
            value={!feishuSecretVisible && feishuAppSecret ? '••••••••' : feishuAppSecret}
            onChange={(e) => setFeishuAppSecret(e.target.value)}
            readOnly={!feishuSecretVisible && !!feishuAppSecret}
            placeholder={t('agentPublish.feishuAppSecretPlaceholder')}
            className="flex-1 bg-transparent outline-none"
          />
          <button
            type="button"
            onClick={() => setFeishuSecretVisible((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={
              feishuSecretVisible
                ? t('agentPublish.feishuAppSecretHide')
                : t('agentPublish.feishuAppSecretShow')
            }
          >
            {feishuSecretVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          {feishuAppSecret && feishuSecretVisible && (
            <CopyButton text={feishuAppSecret} label={t('common.copy')} />
          )}
        </div>
      </div>

      {/* ── 普通群回复配置 ── */}
      <div className="flex flex-col gap-3 rounded-lg bg-muted/40 px-4 py-3">
        <Label className="text-sm font-semibold text-foreground">
          {t('agentPublish.feishuGroupSection')}
        </Label>

        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.feishuTrigger')}
          </Label>
          <div className="flex flex-col gap-1.5">
            <Checkbox
              checked={groupTriggerOnAt}
              onChange={(e) => setGroupTriggerOnAt(e.target.checked)}
            >
              {t('agentPublish.feishuTriggerOnAt')}
            </Checkbox>
            <Checkbox
              checked={groupTriggerOnNewMessage}
              onChange={(e) => setGroupTriggerOnNewMessage(e.target.checked)}
            >
              {t('agentPublish.feishuTriggerOnNewMessage')}
            </Checkbox>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.feishuReplyMode')}
          </Label>
          <Radio.Group
            value={groupReplyMode}
            onChange={(e) => {
              const v = e.target.value
              setGroupReplyMode(v)
              if (v === 'none') setTopicReplyMode('none')
              else if (topicReplyMode === 'none') setTopicReplyMode('topic_reply')
            }}
            className="flex flex-col gap-1.5"
          >
            <Radio value="quote">{t('agentPublish.feishuReplyQuote')}</Radio>
            <Radio value="new">{t('agentPublish.feishuReplyNew')}</Radio>
            <Radio value="none">{t('agentPublish.feishuReplyNone')}</Radio>
          </Radio.Group>
        </div>
      </div>

      {/* ── P2P 单聊配置 ── */}
      <div className="flex flex-col gap-3 rounded-lg bg-muted/40 px-4 py-3">
        <Label className="text-sm font-semibold text-foreground">
          {t('agentPublish.feishuP2pSection')}
        </Label>

        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.feishuReplyMode')}
          </Label>
          <Radio.Group
            value={p2pReplyMode}
            onChange={(e) => setP2pReplyMode(e.target.value)}
            className="flex flex-col gap-1.5"
          >
            <Radio value="quote">{t('agentPublish.feishuReplyQuote')}</Radio>
            <Radio value="new">{t('agentPublish.feishuReplyNew')}</Radio>
            <Radio value="none">{t('agentPublish.feishuReplyNone')}</Radio>
          </Radio.Group>
        </div>
      </div>

      {/* ── 话题群回复配置 ── */}
      <div className="flex flex-col gap-3 rounded-lg bg-muted/40 px-4 py-3">
        <Label className="text-sm font-semibold text-foreground">
          {t('agentPublish.feishuTopicSection')}
        </Label>

        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.feishuTrigger')}
          </Label>
          <div className="flex flex-col gap-1.5">
            <Checkbox
              checked={topicTriggerOnAt}
              onChange={(e) => setTopicTriggerOnAt(e.target.checked)}
            >
              {t('agentPublish.feishuTriggerOnAt')}
            </Checkbox>
            <Checkbox
              checked={topicTriggerOnNewTopic}
              onChange={(e) => setTopicTriggerOnNewTopic(e.target.checked)}
            >
              {t('agentPublish.feishuTopicTriggerOnNewTopic')}
            </Checkbox>
            <Checkbox
              checked={topicTriggerOnNewComment}
              onChange={(e) => setTopicTriggerOnNewComment(e.target.checked)}
            >
              {t('agentPublish.feishuTopicTriggerOnNewComment')}
            </Checkbox>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.feishuReplyMode')}
          </Label>
          <Radio.Group
            value={topicReplyMode}
            onChange={(e) => {
              const v = e.target.value
              setTopicReplyMode(v)
              if (v === 'none') setGroupReplyMode('none')
              else if (groupReplyMode === 'none') setGroupReplyMode('quote')
            }}
            className="flex flex-col gap-1.5"
          >
            <Radio value="topic_reply">{t('agentPublish.feishuTopicReply')}</Radio>
            <Radio value="none">{t('agentPublish.feishuReplyNone')}</Radio>
          </Radio.Group>
        </div>

        {/* "Do not mention" governs ordinary group replies too, so this stays reachable
            whenever either surface still replies — topicReplyMode alone would hide a
            setting that is still in effect for a config with only group replies on. */}
        {(topicReplyMode !== 'none' || groupReplyMode !== 'none') && (
          <div className="flex flex-col gap-2">
            <Label className="text-sm font-medium text-foreground">
              {t('agentPublish.feishuTopicReplyMentionTarget')}
            </Label>
            <Radio.Group
              value={topicReplyMentionTarget}
              onChange={(e) => setTopicReplyMentionTarget(e.target.value)}
              className="flex flex-col gap-1.5"
            >
              <Radio value="trigger_sender">
                {t('agentPublish.feishuTopicMentionTriggerSender')}
              </Radio>
              <Radio value="topic_creator">{t('agentPublish.feishuTopicMentionCreator')}</Radio>
              <Radio value="none">{t('agentPublish.feishuTopicMentionNone')}</Radio>
            </Radio.Group>
            <p className="text-xs text-muted-foreground">
              {t('agentPublish.feishuTopicReplyMentionTargetHint')}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Checkbox
            checked={topicInjectRootMessage}
            onChange={(e) => setTopicInjectRootMessage(e.target.checked)}
          >
            {t('agentPublish.feishuTopicInjectRootMessage')}
          </Checkbox>
          <p className="pl-6 text-xs text-muted-foreground">
            {t('agentPublish.feishuTopicInjectRootMessageHint')}
          </p>
        </div>
      </div>

      {/* Reply content type (peer to reply mode); card template nested only when interactive */}
      {(groupReplyMode !== 'none' || topicReplyMode !== 'none' || p2pReplyMode !== 'none') && (
        <div className="flex flex-col gap-3 rounded-lg bg-muted/40 px-4 py-3">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.feishuReplyContentType')}
          </Label>
          <div className="flex flex-col gap-2">
            <Radio.Group
              value={feishuReplyContentType}
              onChange={(e) => setFeishuReplyContentType(e.target.value)}
              className="flex flex-row flex-wrap items-center gap-x-5 gap-y-2"
            >
              <Radio value="text" className="shrink-0">
                {t('agentPublish.feishuReplyText')}
              </Radio>
              <Radio value="post" className="shrink-0">
                {t('agentPublish.feishuReplyPost')}
              </Radio>
              <span ref={feishuInteractiveRadioWrapRef} className="inline-flex shrink-0">
                <Radio value="interactive" className="shrink-0">
                  {t('agentPublish.feishuReplyInteractive')}
                </Radio>
              </span>
              <span className="inline-flex shrink-0 items-center gap-1">
                <Radio value="interactive_card" className="shrink-0">
                  {t('agentPublish.feishuReplyInteractiveCard')}
                </Radio>
                <Popover
                  trigger="hover"
                  placement="bottomLeft"
                  content={
                    <p className="max-w-[360px] whitespace-pre-line text-xs text-muted-foreground">
                      {t('agentPublish.feishuInteractiveCardSetup')}
                    </p>
                  }
                >
                  <Info
                    aria-label={t('agentPublish.feishuInteractiveCardSetup')}
                    className="size-3.5 cursor-help text-muted-foreground"
                  />
                </Popover>
              </span>
              <Radio value="streaming_card" className="shrink-0">
                {t('agentPublish.feishuReplyStreamingCard')}
              </Radio>
            </Radio.Group>
            {feishuReplyContentType === 'interactive' && (
              <div
                ref={feishuCardCalloutRef}
                style={
                  {
                    '--feishu-card-callout-arrow-x': feishuCardCalloutArrowX,
                  } as CSSProperties
                }
                className="relative mt-1 space-y-2 overflow-visible rounded-md border border-border/60 bg-muted/25 px-3 py-2.5 after:pointer-events-none after:absolute after:-top-[5px] after:z-[11] after:size-[11px] after:-translate-x-1/2 after:rotate-45 after:border-border/60 after:border-t after:border-l after:bg-transparent after:content-[''] after:[left:var(--feishu-card-callout-arrow-x)] before:pointer-events-none before:absolute before:-top-[4px] before:z-[12] before:size-[10px] before:-translate-x-1/2 before:rotate-45 before:border-border/60 before:border-t before:border-l before:bg-muted/25 before:content-[''] before:[left:var(--feishu-card-callout-arrow-x)]"
              >
                {/* 盖住顶边中间一小段，与父卡片底色一致，避免横线穿过尖角；与双层菱形配合闭合 */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute -top-px z-[10] h-px w-[14px] -translate-x-1/2 bg-card"
                  style={{ left: feishuCardCalloutArrowX }}
                />
                <Label className="text-sm font-medium text-foreground">
                  {t('agentPublish.feishuCardTemplateId')}
                </Label>
                <div className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-sm">
                  <input
                    type="text"
                    value={feishuCardTemplateId}
                    onChange={(e) => setFeishuCardTemplateId(e.target.value)}
                    placeholder={t('agentPublish.feishuCardTemplateIdPlaceholder')}
                    className="flex-1 bg-transparent outline-none"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('agentPublish.feishuCardTemplateIdHelp')}
                </p>
                <a
                  href="https://open.feishu.cn/cardkit"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="self-start text-xs text-interactive-foreground hover:underline"
                >
                  {t('agentPublish.feishuCardCreateLink')}
                </a>
              </div>
            )}
          </div>

          {/* 调试信息：勾选项以文本后缀追加到回复末尾，展示运行信息 */}
          <div className="flex flex-col gap-2 border-border/60 border-t pt-3">
            <div className="flex flex-col gap-0.5">
              <Label className="text-sm font-medium text-foreground">
                {t('agentPublish.feishuDebugCard')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('agentPublish.feishuDebugCardHelp')}
              </p>
            </div>
            <div className="flex flex-row flex-wrap items-center gap-x-5 gap-y-2">
              <Checkbox
                checked={feishuDebugShowSessionId}
                onChange={(e) => setFeishuDebugShowSessionId(e.target.checked)}
              >
                {t('agentPublish.feishuDebugSessionId')}
              </Checkbox>
              <Checkbox
                checked={feishuDebugShowProvider}
                onChange={(e) => setFeishuDebugShowProvider(e.target.checked)}
              >
                {t('agentPublish.feishuDebugProvider')}
              </Checkbox>
              <Checkbox
                checked={feishuDebugShowModel}
                onChange={(e) => setFeishuDebugShowModel(e.target.checked)}
              >
                {t('agentPublish.feishuDebugModel')}
              </Checkbox>
            </div>
          </div>
        </div>
      )}

      {/* Send artifacts as file */}
      <div className="flex items-center justify-between rounded-lg bg-muted/40 px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.feishuSendArtifactsAsFile')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('agentPublish.feishuSendArtifactsAsFileHelp')}
          </p>
        </div>
        <Switch checked={feishuSendArtifactsAsFile} onChange={setFeishuSendArtifactsAsFile} />
      </div>

      {/* Fetch sender user info */}
      <div className="flex items-start justify-between gap-4 rounded-lg bg-muted/40 px-4 py-3">
        <div className="flex flex-col gap-1">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.feishuFetchUserInfo')}
          </Label>
          <p className="text-xs text-muted-foreground whitespace-pre-line">
            {t('agentPublish.feishuFetchUserInfoHelp')}
          </p>
          {feishuFetchUserInfo && (
            <pre className="mt-1 rounded bg-muted/60 px-2.5 py-2 font-mono text-xs text-muted-foreground overflow-x-auto">{`{
  "user_info": {
"email": "zhangsan@company.com",
"name": "张三",
"source": "feishu"
  }
}`}</pre>
          )}
        </div>
        <Switch
          checked={feishuFetchUserInfo}
          onChange={setFeishuFetchUserInfo}
          className="shrink-0"
        />
      </div>

      {/* 开场白（Welcome message） */}
      <div className="flex flex-col gap-3 rounded-lg bg-muted/40 px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.feishuWelcome')}
          </Label>
          <p className="text-xs text-muted-foreground whitespace-pre-line">
            {t('agentPublish.feishuWelcomeHelp')}
          </p>
        </div>

        <Textarea
          value={feishuWelcomeMessage}
          onChange={(e) => {
            const next = e.target.value
            setFeishuWelcomeMessage(next)
            // 清空开场白即整体关闭：同步复位开关，避免提交「开启但无文本」的不一致配置
            if (!next.trim()) {
              setFeishuWelcomeOnP2pEnabled(false)
              setFeishuWelcomeOnGroupAddedEnabled(false)
            }
          }}
          placeholder={t('agentPublish.feishuWelcomeMessagePlaceholder')}
          rows={8}
          className="font-mono text-sm"
        />

        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <Label className="text-sm font-medium text-foreground">
              {t('agentPublish.feishuWelcomeOnP2pEnabled')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('agentPublish.feishuWelcomeOnP2pEnabledHelp')}
            </p>
          </div>
          <Switch
            checked={feishuWelcomeOnP2pEnabled}
            onChange={setFeishuWelcomeOnP2pEnabled}
            disabled={!feishuWelcomeMessage.trim()}
          />
        </div>

        {feishuWelcomeOnP2pEnabled && (
          <div className="flex items-center justify-between pl-4">
            <div className="flex flex-col gap-0.5">
              <Label className="text-sm font-medium text-foreground">
                {t('agentPublish.feishuWelcomeP2pIdleDays')}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('agentPublish.feishuWelcomeP2pIdleDaysHelp')}
              </p>
            </div>
            <InputNumber
              min={0}
              max={365}
              value={feishuWelcomeP2pIdleDays}
              // 清空时忽略 null（保留上次有效值），避免「清空→静默变 0→每次都发」的坑；
              // 要「每次都发」需显式输入 0。
              onChange={(v) => {
                if (typeof v === 'number') setFeishuWelcomeP2pIdleDays(v)
              }}
              className="w-24"
            />
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <Label className="text-sm font-medium text-foreground">
              {t('agentPublish.feishuWelcomeOnGroupAddedEnabled')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('agentPublish.feishuWelcomeOnGroupAddedEnabledHelp')}
            </p>
          </div>
          <Switch
            checked={feishuWelcomeOnGroupAddedEnabled}
            onChange={setFeishuWelcomeOnGroupAddedEnabled}
            disabled={!feishuWelcomeMessage.trim()}
          />
        </div>

        <p className="text-xs text-muted-foreground">{t('agentPublish.feishuWelcomeEventsHint')}</p>
      </div>
    </div>
  )
}
