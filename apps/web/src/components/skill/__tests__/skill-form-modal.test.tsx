import i18n from '@/i18n'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * Smoke test for the Skill form modal.
 *
 * Locks the create-vs-edit contract: in CREATE mode only the Content fields are
 * shown (no skill exists yet to attach files to, so no Files tab); in EDIT mode
 * the Content / Files tabs both appear.
 */
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mutationStub = () => ({
  mutateAsync: vi.fn().mockResolvedValue({ data: { id: 'skl_new' } }),
  mutate: vi.fn(),
  isPending: false,
  isSuccess: false,
  isError: false,
  error: null,
  reset: vi.fn(),
})

const useSkillMock = vi.fn(() => ({ data: undefined, isLoading: false }))

vi.mock('@/hooks/use-skills', () => ({
  useSkill: (...args: unknown[]) => useSkillMock(...(args as [])),
  useSkills: vi.fn(() => ({ data: { data: [] } })),
  useCreateSkill: vi.fn(() => mutationStub()),
  useUpdateSkill: vi.fn(() => mutationStub()),
  useDeleteSkill: vi.fn(() => mutationStub()),
  useReuploadSkill: vi.fn(() => mutationStub()),
  useUploadSkillFiles: vi.fn(() => mutationStub()),
  useSkillFiles: vi.fn(() => ({ data: { entries: [] }, isLoading: false })),
  useCheckRemoteSkillUpdate: vi.fn(() => mutationStub()),
  useRemoteSkillUpdate: vi.fn(() => mutationStub()),
}))

vi.mock('@/hooks/use-auth', () => ({
  useCurrentUser: () => ({ data: { id: 'usr_admin', role: 'admin' } }),
}))

import { SkillFormModal } from '../skill-form-modal'

function renderModal(skillId?: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  })
  return render(<SkillFormModal open onOpenChange={() => {}} skillId={skillId} />, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  })
}

describe('SkillFormModal', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    useSkillMock.mockReturnValue({ data: undefined, isLoading: false })
  })

  it('shows the create title and no Files tab in create mode', () => {
    renderModal()
    expect(screen.getByText(/新建 Skill/)).not.toBeNull()
    // Name field present (Content pane rendered outright in create mode).
    expect(screen.getByPlaceholderText('Skill 名称')).not.toBeNull()
    expect(screen.getByText('可见范围')).not.toBeNull()
    expect(screen.getByText('仅自己')).not.toBeNull()
    // No tab switcher in create mode (Content is rendered outright, no Files tab).
    expect(screen.queryByText('文件')).toBeNull()
  })

  it('shows the Content/Files segmented switcher in edit mode', () => {
    useSkillMock.mockReturnValue({
      data: {
        id: 'skl_1',
        name: 'My Skill',
        description: '',
        content: '',
        userId: 'usr_admin',
        visibility: 'private',
      } as never,
      isLoading: false,
    })
    renderModal('skl_1')
    // The switcher is an antd Segmented (radio-style), not role="tab".
    expect(screen.getByText('内容')).not.toBeNull()
    expect(screen.getByText('文件')).not.toBeNull()
  })

  it('keeps platform built-in Skill visibility fixed to all users', () => {
    useSkillMock.mockReturnValue({
      data: {
        id: 'skl_builtin_memory',
        name: 'a2wave-memory',
        description: '',
        content: '',
        userId: null,
        visibility: 'all-users',
      } as never,
      isLoading: false,
    })

    renderModal('skl_builtin_memory')

    expect(
      screen.getByText('平台内置 Skill 始终对所有登录用户可用，其可见范围不能改为仅自己。'),
    ).not.toBeNull()
    expect(screen.getByRole('combobox')).toHaveAttribute('disabled')
  })

  it('keeps remote provenance and the update entry point in edit mode', () => {
    useSkillMock.mockReturnValue({
      data: {
        id: 'skl_remote',
        name: 'Remote Skill',
        description: '',
        content: '',
        remoteSource: {
          provider: 'github',
          catalog: null,
          inputUrl: 'https://github.com/acme/skills',
          repository: 'acme/skills',
          repositoryUrl: 'https://github.com/acme/skills',
          requestedRef: 'main',
          path: 'skills/demo',
          revision: 'a'.repeat(40),
          digest: `sha256:${'b'.repeat(64)}`,
        },
        sourceDirty: true,
        // biome-ignore lint/suspicious/noExplicitAny: focused remote provenance fixture
      } as any,
      isLoading: false,
    })

    renderModal('skl_remote')

    expect(screen.getByText('acme/skills')).not.toBeNull()
    expect(screen.getByText('本地已修改')).not.toBeNull()
    expect(screen.getByRole('button', { name: '检查更新' })).not.toBeNull()
  })
})
