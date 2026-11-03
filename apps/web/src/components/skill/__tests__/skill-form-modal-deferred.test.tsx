import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
/**
 * Regression test for the deferred-detail-query bug.
 *
 * Opening an existing Skill while its detail request is still in flight used to
 * render an editable form backed by blank `defaultValues`. A user could fill in
 * just the name and save, and the update would null out description/content —
 * fields they never saw, let alone cleared.
 */
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '@/i18n'

const mutationStub = () => ({
  mutateAsync: vi.fn().mockResolvedValue({ data: { id: 'skl_new' } }),
  mutate: vi.fn(),
  isPending: false,
  isSuccess: false,
  isError: false,
  error: null,
  reset: vi.fn(),
})

const useSkillMock = vi.fn(() => ({ data: undefined, isPending: false, error: null }))

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

describe('SkillFormModal — deferred detail query', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
    useSkillMock.mockReturnValue({ data: undefined, isPending: false, error: null })
  })

  it('does not render an editable form while the skill is still loading', () => {
    useSkillMock.mockReturnValue({ data: undefined, isPending: true, error: null })
    renderModal('skl_1')
    // No name input means there is nothing the user can fill in and submit.
    expect(screen.queryByPlaceholderText('Skill 名称')).toBeNull()
    // ...and no save button either.
    expect(screen.queryByText('保存更改')).toBeNull()
  })

  it('renders the form once the skill has loaded', () => {
    useSkillMock.mockReturnValue({
      data: {
        id: 'skl_1',
        name: 'My Skill',
        description: 'd',
        content: 'c',
        userId: 'usr_admin',
        visibility: 'private',
      } as never,
      isPending: false,
      error: null,
    })
    renderModal('skl_1')
    expect(screen.getByPlaceholderText('Skill 名称')).not.toBeNull()
  })

  it('still renders the form immediately in create mode', () => {
    // Create mode has no entity to wait for — the gate must not block it.
    useSkillMock.mockReturnValue({ data: undefined, isPending: true, error: null })
    renderModal()
    expect(screen.getByPlaceholderText('Skill 名称')).not.toBeNull()
  })
})
