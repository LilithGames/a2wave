import { message } from '@/lib/antd-static'
import { api } from '@/lib/api'
import { formatApiError } from '@/lib/api-error'
import { useQueryClient } from '@tanstack/react-query'
import { Collapse, Input, Modal, Tabs, Upload } from 'antd'
import { Link, Settings2, Upload as UploadIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

interface ImportResult {
  agent: { id: string; name: string }
  mcpServers: Array<{ id: string; name: string }>
  skills: Array<{ id: string; name: string }>
  warnings: string[]
}

/**
 * Surface every warning the import reported.
 *
 * The server clears credentials it cannot restore — masked env values, Slack and
 * Discord tokens — and says so here. The dialog closes on success, so an unreported
 * warning is one the user never sees: the cleared secret is masked back to dots on
 * the edit page and looks configured, and the first sign of trouble is a run failing
 * to authenticate. These are already user-facing prose from the API, like the error
 * strings `formatApiError` passes through.
 */
export function reportImportWarnings(warnings: string[] | undefined) {
  for (const warning of warnings ?? []) message.warning(warning)
}

/**
 * Everything both import paths do once the server accepts the bundle.
 *
 * Extracted so the two callsites cannot drift: the warning surface in particular is
 * easy to lose in one branch and keep in the other, and neither dialog handler can be
 * driven from a component test (the antd Modal footer does not render under jsdom).
 */
export function handleImportSuccess(
  result: ImportResult,
  deps: {
    t: (key: string, opts?: Record<string, unknown>) => string
    invalidate: (key: string) => void
    onSuccess?: (result: ImportResult) => void
    onClose: () => void
  },
) {
  message.success(deps.t('agentImport.success', { name: result.agent.name }))
  reportImportWarnings(result.warnings)
  for (const key of ['agents', 'skills', 'mcp-servers']) deps.invalidate(key)
  deps.onSuccess?.(result)
  deps.onClose()
}

interface ImportAgentDialogProps {
  open: boolean
  onClose: () => void
  onSuccess?: (result: ImportResult) => void
}

export function ImportAgentDialog({ open, onClose, onSuccess }: ImportAgentDialogProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [loading, setLoading] = useState(false)
  const [url, setUrl] = useState('')
  const [headerKey, setHeaderKey] = useState('')
  const [headerValue, setHeaderValue] = useState('')
  const [activeTab, setActiveTab] = useState('file')
  const invalidate = (key: string) => queryClient.invalidateQueries({ queryKey: [key] })

  const handleFileUpload = async (file: File) => {
    setLoading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const result = await api.upload<ImportResult>('/agents/import', formData)
      handleImportSuccess(result.data, { t, invalidate, onSuccess, onClose })
    } catch (err) {
      message.error(formatApiError(err, t))
    } finally {
      setLoading(false)
    }
    return false // prevent default upload behavior
  }

  const handleUrlImport = async () => {
    if (!url.trim()) return
    setLoading(true)
    try {
      const customHeaders: Record<string, string> | undefined =
        headerKey.trim() && headerValue.trim()
          ? { [headerKey.trim()]: headerValue.trim() }
          : undefined
      const result = await api.post<ImportResult>('/agents/import-url', {
        url: url.trim(),
        headers: customHeaders,
      })
      handleImportSuccess(result.data, { t, invalidate, onSuccess, onClose })
      setUrl('')
      setHeaderKey('')
      setHeaderValue('')
    } catch (err) {
      message.error(formatApiError(err, t))
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    if (!loading) {
      onClose()
      setUrl('')
      setHeaderKey('')
      setHeaderValue('')
    }
  }

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      title={t('agentImport.title')}
      footer={activeTab === 'url' ? undefined : null}
      onOk={activeTab === 'url' ? handleUrlImport : undefined}
      okText={t('agentImport.importBtn')}
      okButtonProps={{ disabled: !url.trim() || loading, loading }}
      cancelText={t('common.cancel')}
      confirmLoading={loading}
      width={480}
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          {
            key: 'file',
            label: t('agentImport.tabFile'),
            children: (
              <Upload.Dragger
                accept=".zip"
                showUploadList={false}
                beforeUpload={handleFileUpload}
                disabled={loading}
                className="!border-dashed"
              >
                <div className="py-6 text-center">
                  <UploadIcon className="h-10 w-10 text-muted-foreground/40 mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">{t('agentImport.dragHint')}</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">
                    {t('agentImport.fileType')}
                  </p>
                </div>
              </Upload.Dragger>
            ),
          },
          {
            key: 'url',
            label: t('agentImport.tabUrl'),
            children: (
              <div className="space-y-3 py-2">
                <p className="text-sm text-muted-foreground">{t('agentImport.urlHint')}</p>
                <Input
                  prefix={<Link className="h-4 w-4 text-muted-foreground/50" />}
                  placeholder="https://a2wave.example.com/api/agents/shared/xxx"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={loading}
                />
                <Collapse
                  ghost
                  size="small"
                  items={[
                    {
                      key: 'headers',
                      label: (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Settings2 className="h-3 w-3" />
                          {t('agentImport.advancedHeaders')}
                        </span>
                      ),
                      children: (
                        <div className="flex gap-2">
                          <Input
                            placeholder="Authorization"
                            value={headerKey}
                            onChange={(e) => setHeaderKey(e.target.value)}
                            disabled={loading}
                            className="flex-1"
                            size="small"
                          />
                          <Input
                            placeholder="Bearer token..."
                            value={headerValue}
                            onChange={(e) => setHeaderValue(e.target.value)}
                            disabled={loading}
                            className="flex-[2]"
                            size="small"
                          />
                        </div>
                      ),
                    },
                  ]}
                />
              </div>
            ),
          },
        ]}
      />
    </Modal>
  )
}
