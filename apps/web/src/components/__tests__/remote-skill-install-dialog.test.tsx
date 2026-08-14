import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders, screen } from '@/test/render'
import { RemoteSkillInstallDialog } from '../remote-skill-install-dialog'

const { inspectMutateAsync, installMutateAsync, inspectReset, installReset } = vi.hoisted(() => ({
  inspectMutateAsync: vi.fn(),
  installMutateAsync: vi.fn(),
  inspectReset: vi.fn(),
  installReset: vi.fn(),
}))

vi.mock('antd', () => ({
  Alert: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  Checkbox: ({
    id,
    checked,
    disabled,
    onChange,
  }: {
    id?: string
    checked: boolean
    disabled?: boolean
    onChange: (event: { target: { checked: boolean } }) => void
  }) => (
    <input
      id={id}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange({ target: { checked: event.target.checked } })}
    />
  ),
  Input: ({
    id,
    value,
    disabled,
    placeholder,
    onChange,
    onPressEnter,
  }: React.InputHTMLAttributes<HTMLInputElement> & { onPressEnter?: () => void }) => (
    <input
      id={id}
      value={value}
      disabled={disabled}
      placeholder={placeholder}
      onChange={onChange}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onPressEnter?.()
      }}
    />
  ),
  Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <dialog open>{children}</dialog> : null,
  Select: ({
    id,
    value,
    disabled,
    options,
    onChange,
  }: {
    id?: string
    value?: string
    disabled?: boolean
    options: Array<{ value: string; label: string }>
    onChange: (value: string | undefined) => void
  }) => (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      <option value="" />
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}))

vi.mock('@/hooks/use-skills', () => ({
  useInspectRemoteSkills: () => ({
    mutateAsync: inspectMutateAsync,
    reset: inspectReset,
    isPending: false,
    error: null,
  }),
  useInstallRemoteSkills: () => ({
    mutateAsync: installMutateAsync,
    reset: installReset,
    isPending: false,
    error: null,
  }),
}))

vi.mock('@/hooks/use-auth', () => ({
  useCurrentUser: () => ({ data: { id: 'usr_admin', role: 'admin' } }),
}))

describe('RemoteSkillInstallDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    inspectMutateAsync.mockResolvedValue({
      data: {
        inputUrl: 'https://skills.sh/acme/tools/demo-skill',
        repository: 'acme/tools',
        repositoryUrl: 'https://github.com/acme/tools',
        requestedRef: 'main',
        revision: 'a'.repeat(40),
        catalog: 'skills_sh',
        candidates: [
          {
            name: 'demo-skill',
            description: 'A demo remote Skill',
            path: 'skills/demo-skill',
            digest: `sha256:${'b'.repeat(64)}`,
            fileCount: 2,
            totalBytes: 128,
          },
        ],
      },
    })
    installMutateAsync.mockResolvedValue({
      data: [{ id: 'skl_remote', name: 'demo-skill' }],
    })
  })

  it('previews and installs the selected immutable snapshot', async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onInstalled = vi.fn()
    renderWithProviders(
      <RemoteSkillInstallDialog
        open
        onOpenChange={onOpenChange}
        groups={[]}
        onInstalled={onInstalled}
      />,
    )

    await user.type(
      screen.getByLabelText('skills.sh 或 GitHub URL'),
      'https://skills.sh/acme/tools/demo-skill',
    )
    await user.click(screen.getByRole('button', { name: '预览' }))

    expect(await screen.findByText('demo-skill')).toBeInTheDocument()
    expect(screen.getByText(/commit aaaaaaaa/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '安装（1）' }))

    expect(inspectMutateAsync).toHaveBeenCalledWith('https://skills.sh/acme/tools/demo-skill')
    expect(installMutateAsync).toHaveBeenCalledWith({
      url: 'https://skills.sh/acme/tools/demo-skill',
      requestedRef: 'main',
      revision: 'a'.repeat(40),
      selections: [
        {
          path: 'skills/demo-skill',
          digest: `sha256:${'b'.repeat(64)}`,
        },
      ],
      groupId: undefined,
      visibility: 'private',
    })
    expect(onInstalled).toHaveBeenCalledWith([{ id: 'skl_remote', name: 'demo-skill' }])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('disables installation until at least one candidate is selected', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <RemoteSkillInstallDialog open onOpenChange={vi.fn()} groups={[]} onInstalled={vi.fn()} />,
    )

    await user.type(
      screen.getByLabelText('skills.sh 或 GitHub URL'),
      'https://skills.sh/acme/tools/demo-skill',
    )
    await user.click(screen.getByRole('button', { name: '预览' }))
    const checkbox = await screen.findByRole('checkbox')
    await user.click(checkbox)

    expect(screen.getByRole('button', { name: '安装（0）' })).toBeDisabled()
  })
})
