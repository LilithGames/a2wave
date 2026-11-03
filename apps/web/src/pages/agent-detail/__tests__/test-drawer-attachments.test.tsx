import { renderWithProviders, screen, userEvent, waitFor } from '@/test/render'
/**
 * 测试抽屉附件上传 UI：回形针按钮渲染、选文件后出现 chip 并调用 /attachments 上传。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

const uploadMock = vi.fn()
vi.mock('@/lib/api', () => ({
  api: {
    upload: (...args: unknown[]) => uploadMock(...args),
  },
}))

vi.mock('@/hooks/use-chat-history', () => ({
  useAgentChats: () => ({ data: [], refetch: vi.fn() }),
  useChatMessages: () => ({ data: undefined, refetch: vi.fn() }),
}))

vi.mock('@/hooks/use-artifacts', () => ({
  useArtifacts: () => ({ data: [] }),
  getArtifactDownloadUrl: (id: string) => `/api/artifacts/${id}/download`,
}))

import { TestDrawer } from '../test-drawer'

// URL.createObjectURL isn't in jsdom.
beforeAll(() => {
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview')
  globalThis.URL.revokeObjectURL = vi.fn()
})

function renderDrawer() {
  return renderWithProviders(
    <TestDrawer open onClose={() => {}} agentId="agt_1" agentStatus="active" agentIcon="" />,
  )
}

describe('TestDrawer attachments', () => {
  it('renders the attach (paperclip) button', () => {
    renderDrawer()
    expect(screen.getByLabelText('添加图片或文件')).toBeInTheDocument()
  })

  it('shows a chip and uploads when a png is selected', async () => {
    uploadMock.mockResolvedValue({
      data: { token: 'att_x', name: 'pic.png', mimeType: 'image/png', size: 3 },
    })
    renderDrawer()

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input).toBeTruthy()

    const file = new File([new Uint8Array([1, 2, 3])], 'pic.png', { type: 'image/png' })
    await userEvent.upload(input, file)

    // chip with the filename appears
    await waitFor(() => expect(screen.getByTitle('pic.png')).toBeInTheDocument())
    // upload was called against the attachments endpoint
    expect(uploadMock).toHaveBeenCalledWith('/attachments', expect.any(FormData))
  })

  it('rejects an unsupported type without uploading', async () => {
    uploadMock.mockClear()
    renderDrawer()

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['x'], 'note.exe', { type: 'application/octet-stream' })
    await userEvent.upload(input, file)

    expect(uploadMock).not.toHaveBeenCalled()
  })
})
