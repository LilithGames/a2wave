import { Input, Modal, QRCode, Select, Switch } from 'antd'
import { QrCode, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { useQQOfficialRegistration } from '@/hooks/use-agents'
import { message } from '@/lib/antd-static'

type ReplyMode = 'reply' | 'new' | 'none'

export interface QQOfficialChannelSectionProps {
  agentId?: string
  appId: string
  onAppIdChange: (value: string) => void
  appSecret: string
  onAppSecretChange: (value: string) => void
  groupTriggerOnAt?: boolean
  onGroupTriggerOnAtChange?: (value: boolean) => void
  groupReplyMode?: ReplyMode
  onGroupReplyModeChange?: (value: ReplyMode) => void
  c2cReplyMode?: ReplyMode
  onC2cReplyModeChange?: (value: ReplyMode) => void
  sendArtifactsAsFile?: boolean
  onSendArtifactsAsFileChange?: (value: boolean) => void
}

type RegistrationTask = {
  taskId: string
  bindKey: string
  qrCodeUrl: string
  intervalMs: number
}

export function QQOfficialChannelSection(props: QQOfficialChannelSectionProps) {
  const { t } = useTranslation()
  const registration = useQQOfficialRegistration()
  const { mutateAsync, isPending } = registration
  const [task, setTask] = useState<RegistrationTask | null>(null)
  const [qrOpen, setQrOpen] = useState(false)

  const startRegistration = async () => {
    if (!props.agentId) return
    try {
      const response = await mutateAsync({ agentId: props.agentId, action: 'start' })
      const next = response.data as RegistrationTask
      setTask(next)
      setQrOpen(true)
    } catch {
      // The API client already surfaces the request error.
    }
  }

  useEffect(() => {
    if (!qrOpen || !task || !props.agentId) return
    const agentId = props.agentId
    let cancelled = false
    let timer: number | undefined
    const poll = async () => {
      try {
        const response = await mutateAsync({
          agentId,
          action: 'poll',
          taskId: task.taskId,
          bindKey: task.bindKey,
        })
        if (cancelled) return
        const result = response.data as
          | { status: 'pending' | 'expired' }
          | { status: 'completed'; appId: string; appSecret: string }
        if (result.status === 'completed') {
          props.onAppIdChange(result.appId)
          props.onAppSecretChange(result.appSecret)
          setQrOpen(false)
          setTask(null)
          message.success(t('agentPublish.qqOfficialQrCompleted'))
          return
        }
        if (result.status === 'expired') {
          setQrOpen(false)
          setTask(null)
          message.warning(t('agentPublish.qqOfficialQrExpired'))
          return
        }
        timer = window.setTimeout(poll, task.intervalMs)
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, task.intervalMs)
      }
    }
    timer = window.setTimeout(poll, task.intervalMs)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [props.agentId, props.onAppIdChange, props.onAppSecretChange, qrOpen, mutateAsync, t, task])

  const replyOptions = [
    { value: 'reply', label: t('agentPublish.qqOfficialReplyQuote') },
    { value: 'new', label: t('agentPublish.qqOfficialReplyNew') },
    { value: 'none', label: t('agentPublish.qqOfficialReplyNone') },
  ]

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-border bg-muted/20 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium">{t('agentPublish.qqOfficialQrTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('agentPublish.qqOfficialQrDescription')}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={() => void startRegistration()}
            disabled={isPending || !props.agentId}
            aria-label={t('agentPublish.qqOfficialQrStart')}
          >
            {isPending ? (
              <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <QrCode className="mr-2 h-4 w-4" />
            )}
            {t('agentPublish.qqOfficialQrStart')}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="qq-official-app-id">{t('agentPublish.qqOfficialAppId')}</Label>
          <Input
            id="qq-official-app-id"
            value={props.appId}
            onChange={(event) => props.onAppIdChange(event.target.value)}
            placeholder="102000000"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="qq-official-app-secret">{t('agentPublish.qqOfficialAppSecret')}</Label>
          <Input.Password
            id="qq-official-app-secret"
            value={props.appSecret}
            onChange={(event) => props.onAppSecretChange(event.target.value)}
            autoComplete="new-password"
          />
        </div>
      </div>

      <div className="space-y-3">
        <SettingSwitch
          label={t('agentPublish.qqOfficialGroupAt')}
          checked={props.groupTriggerOnAt ?? true}
          onChange={props.onGroupTriggerOnAtChange}
        />
        <SettingSwitch
          label={t('agentPublish.qqOfficialSendArtifacts')}
          checked={props.sendArtifactsAsFile ?? true}
          onChange={props.onSendArtifactsAsFileChange}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ['qqOfficialGroupReplyMode', props.groupReplyMode, props.onGroupReplyModeChange],
            ['qqOfficialC2cReplyMode', props.c2cReplyMode, props.onC2cReplyModeChange],
          ] as const
        ).map(([key, value, onChange]) => (
          <div className="space-y-2" key={key}>
            <Label>{t(`agentPublish.${key}`)}</Label>
            <Select
              className="w-full"
              value={value ?? 'reply'}
              options={replyOptions}
              onChange={onChange}
            />
          </div>
        ))}
      </div>

      <Modal
        open={qrOpen}
        title={t('agentPublish.qqOfficialQrModalTitle')}
        footer={null}
        onCancel={() => setQrOpen(false)}
        destroyOnHidden
      >
        <div className="flex flex-col items-center gap-4 py-4">
          {task ? (
            <div data-testid="qq-official-registration-qr">
              <QRCode value={task.qrCodeUrl} size={220} type="svg" />
            </div>
          ) : null}
          <p className="text-center text-sm text-muted-foreground">
            {t('agentPublish.qqOfficialQrWaiting')}
          </p>
        </div>
      </Modal>
    </div>
  )
}

function SettingSwitch(props: {
  label: string
  checked: boolean
  onChange?: (value: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
      <span className="text-sm">{props.label}</span>
      <Switch checked={props.checked} onChange={props.onChange} />
    </div>
  )
}
