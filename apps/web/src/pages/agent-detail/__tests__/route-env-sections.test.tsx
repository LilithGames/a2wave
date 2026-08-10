/**
 * Component tests for the summary-card + dialog interaction shared by
 * `<RouteSection>` and `<EnvSection>`.
 *
 * What we lock here:
 * - The card stays a *summary*: editor fields (remote URL inputs, env key/value
 *   rows) are absent until the dialog is opened. This is the whole point of the
 *   layout — if the editor leaked back into the card, the two-column row would
 *   go ragged again and the regression would be purely visual, i.e. invisible
 *   to every other test.
 * - Configured targets/variables render as preview chips, capped so a long list
 *   cannot stretch the card.
 * - The empty-state button both seeds a blank row AND opens the dialog, so the
 *   user lands on a usable form in one click rather than an empty dialog.
 * - Each card exposes exactly ONE action; the empty state used to show a
 *   redundant second button that opened the same dialog.
 * - A2A routing has no on/off switch: it is enabled iff targets are configured,
 *   and the section reports that derived value upward.
 */
import { renderWithProviders, screen, userEvent } from '@/test/render'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { EnvSection } from '../env-section'
import { RouteSection } from '../route-section'
import type { EnvEntry, RemoteEntry } from '../types'

const remote = (over: Partial<RemoteEntry> = {}): RemoteEntry => ({
  id: `re_${Math.random().toString(36).slice(2)}`,
  name: 'qa-bot',
  url: 'https://example.com/api/a2a/agt_x',
  description: '',
  apiKey: '',
  showApiKey: false,
  ...over,
})

const envEntry = (over: Partial<EnvEntry> = {}): EnvEntry => ({
  id: `env_${Math.random().toString(36).slice(2)}`,
  key: 'API_BASE',
  value: 'https://example.com',
  sensitive: false,
  ...over,
})

const AGENTS = [
  { id: 'agt_1', name: 'Alpha', icon: '🤖' },
  { id: 'agt_2', name: 'Beta', icon: null },
]

function renderRoute(over: Partial<Parameters<typeof RouteSection>[0]> = {}) {
  const props = {
    setRouteEnabled: vi.fn(),
    localAgentIds: [] as string[],
    setLocalAgentIds: vi.fn(),
    showLocalChildOutput: false,
    setShowLocalChildOutput: vi.fn(),
    showRemoteChildOutput: false,
    setShowRemoteChildOutput: vi.fn(),
    remoteEntries: [] as RemoteEntry[],
    addRemoteEntry: vi.fn(),
    updateRemoteEntry: vi.fn(),
    removeRemoteEntry: vi.fn(),
    publishedA2aAgents: AGENTS,
    ...over,
  }
  renderWithProviders(<RouteSection {...props} />)
  return props
}

describe('RouteSection', () => {
  it('exposes exactly one action button when empty', () => {
    // The empty state used to render an "add remote" button *and* a "configure"
    // button that both just opened the same dialog.
    renderRoute()

    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByTestId('route-configure')).toBeInTheDocument()
  })

  it('exposes exactly one action button when configured', () => {
    renderRoute({ remoteEntries: [remote()] })

    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('reports routing as enabled only when targets are configured', () => {
    // No switch exists: enablement is derived, so an agent can never be
    // "enabled" with zero targets (which the save path drops to null anyway).
    const empty = renderRoute()
    expect(empty.setRouteEnabled).toHaveBeenLastCalledWith(false)

    const configured = renderRoute({ remoteEntries: [remote()] })
    expect(configured.setRouteEnabled).toHaveBeenLastCalledWith(true)
  })

  it('keeps remote-agent editor fields out of the summary card', () => {
    renderRoute({ remoteEntries: [remote()] })

    // The card shows a chip, not the URL input that lives in the dialog.
    expect(screen.getByText('qa-bot')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/A2A endpoint|A2A 端点/)).not.toBeInTheDocument()
  })

  it('reveals the remote-agent editor only after opening the dialog', async () => {
    const user = userEvent.setup()
    renderRoute({ remoteEntries: [remote()] })

    await user.click(screen.getByTestId('route-configure'))

    // `toBeVisible` is unusable here: antd keeps the modal wrapper
    // `display: none` until its open transition ends, and jsdom never runs
    // transitions. Presence in the DOM is the real signal.
    expect(await screen.findByDisplayValue('https://example.com/api/a2a/agt_x')).toBeInTheDocument()
  })

  it('treats legacy rows as direct A2A 0.3 endpoints', async () => {
    const user = userEvent.setup()
    renderRoute({ remoteEntries: [remote()] })

    await user.click(screen.getByTestId('route-configure'))

    expect(await screen.findByText(/^(Direct endpoint|直连端点)$/)).toBeInTheDocument()
    expect(screen.getByText('A2A 0.3')).toBeInTheDocument()
    expect(
      screen.getByText(/Direct endpoints use blocking SendMessage|直连端点没有 Agent Card/),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', {
        name: /Send caller provenance|发送调用来源信息/,
      }),
    ).not.toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/\.well-known\/agent-card\.json/)).not.toBeInTheDocument()
  })

  it('shows Agent Card discovery for standards-compliant remote services', async () => {
    const user = userEvent.setup()
    renderRoute({
      remoteEntries: [
        remote({
          connectionMode: 'agent_card',
          protocolVersion: '1.0',
          url: 'https://example.com/.well-known/agent-card.json',
        }),
      ],
    })

    await user.click(screen.getByTestId('route-configure'))

    expect(await screen.findByText(/Agent Card discovery|Agent Card 发现/)).toBeInTheDocument()
    expect(
      screen.getByDisplayValue('https://example.com/.well-known/agent-card.json'),
    ).toBeInTheDocument()
    expect(screen.queryByText('A2A 1.0')).not.toBeInTheDocument()
    expect(
      screen.queryByText(/Direct endpoints use blocking SendMessage|直连端点没有 Agent Card/),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('checkbox', {
        name: /Send caller provenance|发送调用来源信息/,
      }),
    ).not.toBeInTheDocument()
  })

  it('offers caller provenance as a separate opt-in for direct A2A 1.0', async () => {
    const user = userEvent.setup()
    const entry = remote({
      connectionMode: 'direct',
      protocolVersion: '1.0',
      callerProvenance: false,
    })
    const props = renderRoute({ remoteEntries: [entry] })

    await user.click(screen.getByTestId('route-configure'))

    const checkbox = await screen.findByRole('checkbox', {
      name: /Send caller provenance|发送调用来源信息/,
    })
    expect(checkbox).not.toBeChecked()
    await user.click(checkbox)
    expect(props.updateRemoteEntry).toHaveBeenCalledWith(entry.id, 'callerProvenance', true)
  })

  it('counts local and remote targets separately in the summary', () => {
    renderRoute({ localAgentIds: ['agt_1'], remoteEntries: [remote()] })

    // Local target resolves to its agent name; remote falls back to its label.
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(screen.getByText('qa-bot')).toBeInTheDocument()
  })

  it('caps preview chips and shows an overflow count', () => {
    renderRoute({
      remoteEntries: [
        remote({ name: 'r1' }),
        remote({ name: 'r2' }),
        remote({ name: 'r3' }),
        remote({ name: 'r4' }),
        remote({ name: 'r5' }),
        remote({ name: 'r6' }),
      ],
    })

    expect(screen.getByText('r4')).toBeInTheDocument()
    expect(screen.queryByText('r5')).not.toBeInTheDocument()
    expect(screen.getByText('+2')).toBeInTheDocument()
  })

  it('ignores blank rows when deciding the card is empty', () => {
    // A row the user added but never filled in must not count as a target,
    // otherwise the card would claim routing is configured while it is not.
    const props = renderRoute({ remoteEntries: [remote({ name: '', url: '' })] })

    expect(props.setRouteEnabled).toHaveBeenLastCalledWith(false)
    expect(screen.queryByText('qa-bot')).not.toBeInTheDocument()
  })

  it.each([
    ['name without URL', { name: 'qa-bot', url: '' }],
    ['URL without name', { name: '', url: 'https://example.com/api/a2a/agt_x' }],
  ])('does not count a half-filled remote (%s) as a target', (_label, over) => {
    // The save path keeps a remote only when BOTH fields are set. If the card
    // counted it on either field, it would show "1 remote" and report routing
    // as enabled while save persisted null — the row vanishing on reload with
    // the form still looking clean.
    const props = renderRoute({ remoteEntries: [remote(over)] })

    expect(props.setRouteEnabled).toHaveBeenLastCalledWith(false)
    expect(screen.getByTestId('route-configure')).toHaveTextContent(
      /添加路由 Agent|Add Route Agent/,
    )
  })

  it('does not seed a row when reopening with a half-filled draft', async () => {
    // The draft is still in `remoteEntries`, so reopening must not append a
    // second blank row on top of it.
    const user = userEvent.setup()
    const props = renderRoute({ remoteEntries: [remote({ name: 'qa-bot', url: '' })] })

    await user.click(screen.getByTestId('route-configure'))

    expect(props.addRemoteEntry).not.toHaveBeenCalled()
  })

  it('seeds a blank remote row when starting from the empty state', async () => {
    const user = userEvent.setup()
    const props = renderRoute()

    await user.click(screen.getByTestId('route-configure'))

    expect(props.addRemoteEntry).toHaveBeenCalledTimes(1)
  })

  it('does not seed an extra row when targets already exist', async () => {
    const user = userEvent.setup()
    const props = renderRoute({ remoteEntries: [remote()] })

    await user.click(screen.getByTestId('route-configure'))

    expect(props.addRemoteEntry).not.toHaveBeenCalled()
  })
})

describe('EnvSection', () => {
  function Harness({ initial }: { initial: EnvEntry[] }) {
    const [entries, setEntries] = useState(initial)
    const [visible, setVisible] = useState(new Set<string>())
    return (
      <EnvSection
        envEntries={entries}
        setEnvEntries={setEntries}
        visibleEnvIds={visible}
        setVisibleEnvIds={setVisible}
      />
    )
  }

  it('shows variable names as chips without exposing their values', () => {
    renderWithProviders(
      <Harness initial={[envEntry({ key: 'API_BASE', value: 'https://secret.internal' })]} />,
    )

    expect(screen.getByText('API_BASE')).toBeInTheDocument()
    // The value belongs in the dialog only — the card must not leak it.
    expect(screen.queryByDisplayValue('https://secret.internal')).not.toBeInTheDocument()
  })

  it('offers no bulk-copy affordance on the summary card', () => {
    // The card used to carry a copy button that emitted `export KEY=value` for
    // every variable in plaintext — sensitive ones included — putting
    // credentials on the clipboard in one click.
    renderWithProviders(
      <Harness initial={[envEntry({ key: 'API_TOKEN', value: 'super-secret' })]} />,
    )

    // Only the single configure action remains.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByTestId('env-configure')).toBeInTheDocument()
  })

  it('reveals the key/value editor only after opening the dialog', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={[envEntry()]} />)

    await user.click(screen.getByTestId('env-configure'))

    expect(await screen.findByDisplayValue('https://example.com')).toBeInTheDocument()
  })

  it('treats a keyless row as unconfigured', () => {
    renderWithProviders(<Harness initial={[envEntry({ key: '  ', value: 'x' })]} />)

    // The single action falls back to "add variable" while nothing is named.
    expect(screen.getByTestId('env-configure')).toHaveTextContent(/添加变量|Add Variable/)
  })

  it('adds a blank row and opens the editor from the empty state', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={[]} />)

    await user.click(screen.getByTestId('env-configure'))

    // One blank key input is now present inside the opened dialog.
    const key = await screen.findByPlaceholderText('KEY')
    expect(key).toHaveValue('')
  })

  it('auto-marks a sensitive-looking key so its value is masked on reopen', async () => {
    const user = userEvent.setup()
    renderWithProviders(<Harness initial={[]} />)

    await user.click(screen.getByTestId('env-configure'))
    await user.type(await screen.findByPlaceholderText('KEY'), 'API_TOKEN')

    // SENSITIVE_PATTERNS matches TOKEN, so the row flips to masked without the
    // user having to click the eye — the behaviour that makes the chip-only
    // summary card safe to show.
    const value = screen.getByPlaceholderText('value')
    expect(value).toHaveStyle({ WebkitTextSecurity: 'disc' })
  })
})
