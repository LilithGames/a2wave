import i18n from '@/i18n'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import type { RunTriggerSource } from '@a2wave/shared'
/**
 * The caller chip is the only place a run row says which channel started it.
 *
 * `SOURCE_LABEL` is typed as a total Record over the shared enum, so a missing
 * channel is a build error rather than a raw i18n key on screen — but "the key
 * exists" and "the key has copy in both languages" are different claims, and
 * only the second one is what a user sees. These tests pin the second.
 */
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'
import { RunCallerPrefix, SOURCE_LABEL } from '../run-caller-prefix'

function renderPrefix(props: {
  name?: string | null
  callerAgentName?: string | null
  source?: RunTriggerSource | null
}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <RunCallerPrefix
        name={props.name ?? null}
        callerAgentName={props.callerAgentName ?? null}
        source={props.source ?? null}
      />
    </I18nextProvider>,
  )
}

/** Walks a dotted i18n key against a locale bundle. */
function lookup(bundle: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => {
    if (node && typeof node === 'object') return (node as Record<string, unknown>)[part]
    return undefined
  }, bundle)
}

describe('RunCallerPrefix', () => {
  it('labels every trigger source in both languages', () => {
    // Includes glab / gh: a poll-started run must not render as an unlabelled
    // line of prompt text.
    for (const [source, key] of Object.entries(SOURCE_LABEL)) {
      for (const [language, bundle] of [
        ['zh', zh],
        ['en', en],
      ] as const) {
        const copy = lookup(bundle as unknown as Record<string, unknown>, key)
        expect(typeof copy, `${language} copy missing for ${source} (${key})`).toBe('string')
        expect(copy as string).not.toBe('')
      }
    }
  })

  it('renders the git trigger channels with their own labels', async () => {
    await i18n.changeLanguage('zh')
    const { rerender } = renderPrefix({ name: null, source: 'glab' })
    expect(screen.getByText('GitLab 触发')).toBeInTheDocument()

    rerender(
      <I18nextProvider i18n={i18n}>
        <RunCallerPrefix name={null} source="gh" />
      </I18nextProvider>,
    )
    expect(screen.getByText('GitHub 触发')).toBeInTheDocument()
  })

  it('joins the forge author with the channel label', async () => {
    // The glab poller stamps the MR author as triggerUserName, so a run row
    // reads ⟨Zhang Li·GitLab 触发⟩ and names who caused it.
    await i18n.changeLanguage('zh')
    renderPrefix({ name: 'Zhang Li', source: 'glab' })
    expect(screen.getByText('Zhang Li·GitLab 触发')).toBeInTheDocument()
  })

  it('renders user, caller Agent, and source when all provenance is known', async () => {
    await i18n.changeLanguage('zh')
    renderPrefix({ name: '张鑫', callerAgentName: 'SDK Manager大神', source: 'a2a' })
    expect(screen.getByText('张鑫·SDK Manager大神·A2A')).toBeInTheDocument()
  })

  it('falls back to caller Agent and source when the user is unknown', async () => {
    await i18n.changeLanguage('zh')
    renderPrefix({ name: null, callerAgentName: 'SDK Manager大神', source: 'a2a' })
    expect(screen.getByText('SDK Manager大神·A2A')).toBeInTheDocument()
  })

  it('falls back to source when no user or caller Agent is known', async () => {
    await i18n.changeLanguage('zh')
    renderPrefix({ name: null, callerAgentName: null, source: 'a2a' })
    expect(screen.getByText('A2A')).toBeInTheDocument()
  })

  it('still names the channel when the forge reported no author', async () => {
    await i18n.changeLanguage('zh')
    renderPrefix({ name: null, source: 'gh' })
    expect(screen.getByText('GitHub 触发')).toBeInTheDocument()
  })

  it('renders nothing when neither name nor source is known', () => {
    const { container } = renderPrefix({ name: null, source: null })
    expect(container).toBeEmptyDOMElement()
  })
})
