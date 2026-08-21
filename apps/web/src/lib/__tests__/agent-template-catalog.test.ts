import { describe, expect, it } from 'vitest'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import { AGENT_TEMPLATE_CATALOG, localizeAgentTemplate } from '../agent-template-catalog'

const localeAgents = {
  en: en.agents as Record<string, string>,
  zh: zh.agents as Record<string, string>,
}

describe('agent template catalog', () => {
  it('has unique, localized catalog entries', () => {
    expect(AGENT_TEMPLATE_CATALOG).toHaveLength(10)
    expect(new Set(AGENT_TEMPLATE_CATALOG.map((template) => template.key)).size).toBe(
      AGENT_TEMPLATE_CATALOG.length,
    )

    for (const template of AGENT_TEMPLATE_CATALOG) {
      for (const language of ['en', 'zh'] as const) {
        expect(localeAgents[language][template.nameKey.replace('agents.', '')]).toBeTruthy()
        expect(localeAgents[language][template.descriptionKey.replace('agents.', '')]).toBeTruthy()
        if (template.formDescriptionKey) {
          expect(
            localeAgents[language][template.formDescriptionKey.replace('agents.', '')],
          ).toBeTruthy()
        }
        expect(template.prompts[language].trim().length).toBeGreaterThan(100)
      }
    }
  })

  it('gives every template a chip color that actually resolves to a token', () => {
    /**
     * Regression: two templates carried `bg-danger-subtle`, and no such token
     * exists — the semantic name is `destructive`. Tailwind emitted nothing, so
     * both chips rendered pure white on a white card: an invisible tile that
     * read as a rendering bug rather than a color choice. Nothing caught it
     * because chip classes had no test at all.
     *
     * The allowlist is the point: a chip may only use a surface token the theme
     * registry actually defines, so a typo fails here instead of silently
     * shipping a blank square.
     */
    // `bg-accent` is deliberately absent: it resolves to the same value as
    // `--color-muted` in the light themes, which is the blank card's chip.
    const allowedChips = new Set([
      'bg-primary/10',
      'bg-primary-subtle',
      'bg-destructive-subtle',
      'bg-warning-subtle',
      'bg-success-subtle',
    ])

    for (const template of AGENT_TEMPLATE_CATALOG) {
      expect(
        allowedChips.has(template.chipClassName),
        `${template.key}: unknown chip class ${template.chipClassName}`,
      ).toBe(true)
    }
  })

  it('does not tint a template chip with the blank card surface', () => {
    /**
     * The Agents list renders "start from blank" alongside the catalog with a
     * `bg-muted` chip, and `--color-accent` resolves to that same value in the
     * light themes — so a template using either was indistinguishable from the
     * blank entry, the two cards that most need to look different. The
     * allowlist above already excludes both; this states the *reason*
     * separately, so widening that list does not quietly undo it.
     */
    for (const template of AGENT_TEMPLATE_CATALOG) {
      expect(
        ['bg-muted', 'bg-accent'],
        `${template.key} collides with the blank chip`,
      ).not.toContain(template.chipClassName)
    }
  })

  it('pairs the repo-trigger reviewer with the git trigger channels', () => {
    const definition = AGENT_TEMPLATE_CATALOG.find(
      (template) => template.key === 'repo-trigger-review',
    )
    if (!definition) throw new Error('repo-trigger-review template is missing')

    // The trigger lives on the Publish page, so landing the user anywhere else
    // after creation leaves an Agent that can never fire.
    expect(definition.gotoPublishAfterCreate).toBe(true)

    // Deliberately workspace-free: the Agent can review the forge's own diff,
    // so requiring an SCM source would block the plain "watch this repo"
    // case. The form copy is what tells the user a code source is better, so
    // it has to exist in both languages.
    expect(definition.workspaceType).toBeUndefined()
    expect(definition.formDescriptionKey).toBeTruthy()

    for (const language of ['en', 'zh'] as const) {
      const formCopy =
        localeAgents[language][definition.formDescriptionKey?.replace('agents.', '') ?? '']
      expect(formCopy, `${language} form description`).toBeTruthy()
      // Both halves of the guidance must survive translation: where to turn the
      // trigger on, and that a code source improves the result.
      expect(formCopy).toMatch(/GitLab|GitHub/)
      expect(formCopy).toMatch(language === 'zh' ? /代码源/ : /code source/i)
    }

    // It must not duplicate the on-demand reviewer: this one is written for an
    // Agent that already knows which request it was woken for.
    const changeReview = AGENT_TEMPLATE_CATALOG.find((t) => t.key === 'change-review')
    expect(definition.prompts.zh).not.toBe(changeReview?.prompts.zh)
    expect(definition.prompts.en).not.toBe(changeReview?.prompts.en)
  })

  it('tells the repo-trigger reviewer to comment its result back to the request', () => {
    /**
     * Without this the Agent produced a review and left it in the run record,
     * where the reviewer it was written for never looks. The prompt has to name
     * the concrete command per forge — `glab` for GitLab, `gh` for GitHub — and
     * keep the read-only boundary, since commenting is not approving.
     */
    const definition = AGENT_TEMPLATE_CATALOG.find(
      (template) => template.key === 'repo-trigger-review',
    )
    if (!definition) throw new Error('repo-trigger-review template is missing')

    for (const prompt of Object.values(definition.prompts)) {
      expect(prompt).toContain('glab mr note')
      expect(prompt).toContain('gh pr comment')
    }

    // Commenting must not be read as permission to land the change.
    expect(definition.prompts.en).toMatch(/never approve, merge/i)
    expect(definition.prompts.zh).toContain('不要 approve')

    /**
     * `readOnly` must stay false, and that is not an oversight.
     *
     * It is an execution policy the engines enforce — Claude Code maps it to
     * `--permission-mode plan`, Pi to `--tools read,grep,find,ls` — so a
     * read-only Agent cannot run `glab` or `gh` at all. Flipping this back to
     * true would leave a template that reviews correctly and then fails to
     * deliver on every run, with the form still promising the comment. The
     * comment-only boundary lives in the prompt instead, asserted above.
     */
    expect(definition.readOnly).toBe(false)
  })

  it('guards the repo-trigger reviewer against triggering itself', () => {
    /**
     * The `commented` event fires on a change in comment count, and the Agent's
     * own comment increments that same count — so posting a review re-wakes the
     * Agent, which posts again, forever. The poller cannot tell the two apart
     * (see `git-trigger-diff.ts`: `request.comments > prior.comments`), so the
     * break has to live in the prompt: stamp every comment with a fixed marker,
     * read the thread first, and stop when the newest comment carries it.
     *
     * The marker string is asserted literally. Changing it in one language only
     * would leave that half of the loop wide open, and the symptom — an Agent
     * quietly commenting in a cycle — surfaces as a token bill, not an error.
     */
    const definition = AGENT_TEMPLATE_CATALOG.find(
      (template) => template.key === 'repo-trigger-review',
    )
    if (!definition) throw new Error('repo-trigger-review template is missing')

    for (const [language, prompt] of Object.entries(definition.prompts)) {
      expect(prompt, `${language}: missing loop-breaking marker`).toContain('=comments_by_a2wave=')
      // It must also tell the Agent to *read* the thread; stamping alone does
      // nothing if it never looks at what is already there.
      expect(prompt, `${language}: never lists existing comments`).toMatch(
        /glab mr note list|gh pr view/,
      )
    }
  })

  it('holds the repo-trigger reviewer to a P0/P1 bar with concrete evidence', () => {
    /**
     * Production runs of this template produced long comments padded with style
     * and naming nits, which buried the one finding that mattered and trained
     * maintainers to skim past the whole thread. Severity alone is not enough:
     * without a demanded trigger condition an Agent will happily report
     * "this looks risky", which is unactionable and unfalsifiable. So the
     * prompt has to name the two levels *and* require a reproducible trigger.
     */
    const definition = AGENT_TEMPLATE_CATALOG.find(
      (template) => template.key === 'repo-trigger-review',
    )
    if (!definition) throw new Error('repo-trigger-review template is missing')

    for (const [language, prompt] of Object.entries(definition.prompts)) {
      expect(prompt, `${language}: no P0 bar`).toContain('P0')
      expect(prompt, `${language}: no P1 bar`).toContain('P1')
      // Saying "only P0/P1" without saying to drop the rest leaves the Agent
      // free to keep reporting nits under a different heading.
      expect(prompt, `${language}: never tells the Agent to drop lower severities`).toMatch(
        language === 'zh' ? /P2/ : /P2/,
      )
    }
  })

  it('makes the repo-trigger reviewer chase callers rather than skim the diff', () => {
    /**
     * A diff says what changed, never what that break. The failure this guards
     * is the shallow pass: the Agent reads the added lines, finds them locally
     * consistent, and reports clean — while a renamed signature left a caller
     * unconverted two directories away. The prompt therefore has to send it
     * out of the diff and into the call sites, and to say so in both languages.
     */
    const definition = AGENT_TEMPLATE_CATALOG.find(
      (template) => template.key === 'repo-trigger-review',
    )
    if (!definition) throw new Error('repo-trigger-review template is missing')

    expect(definition.prompts.zh).toMatch(/调用方|调用点/)
    expect(definition.prompts.en).toMatch(/caller|call site/i)

    // Concurrency and rollback are the two classes that a diff-only read misses
    // most reliably, and both are P0/P1 by nature.
    expect(definition.prompts.zh).toMatch(/并发|竞态/)
    expect(definition.prompts.en).toMatch(/concurren|race/i)
    expect(definition.prompts.zh).toMatch(/回滚|兼容/)
    expect(definition.prompts.en).toMatch(/rollback|compatib/i)
  })

  it('keeps the repo-trigger reviewer honest about unrun validation', () => {
    /**
     * The template already says not to claim a passing test it never ran. The
     * other half of the same honesty problem is verbosity: runs were pasting
     * full command lines, stack traces and environment workarounds into the MR,
     * so the actual findings sank below the fold. Keep the comment about the
     * code; the debugging narrative belongs in the run record.
     */
    const definition = AGENT_TEMPLATE_CATALOG.find(
      (template) => template.key === 'repo-trigger-review',
    )
    if (!definition) throw new Error('repo-trigger-review template is missing')

    expect(definition.prompts.zh).toMatch(/没跑就写没跑|未执行/)
    expect(definition.prompts.en).toMatch(/did not run|say so/i)
  })

  it('seeds the system prompt in English regardless of UI language', () => {
    /**
     * The system prompt is injected into the underlying CLI, not read by the
     * user, and those models follow English instructions best — so a Chinese
     * console must not quietly hand the Provider a weaker prompt. Names and
     * descriptions are the opposite: those *are* read by the user and stay
     * localized, which is why both halves are asserted here together.
     *
     * The prompt stays fully editable after creation, so this is a default and
     * not a restriction.
     */
    const definition = AGENT_TEMPLATE_CATALOG.find((template) => template.key === 'codebase-qa')
    if (!definition) throw new Error('codebase-qa template is missing')

    const localizedZh = localizeAgentTemplate(definition, (key: string) => `zh:${key}`)
    const localizedEn = localizeAgentTemplate(definition, (key: string) => `en:${key}`)

    // User-facing copy follows the UI.
    expect(localizedZh.name).toBe('zh:agents.templateCodebaseQa')
    expect(localizedEn.name).toBe('en:agents.templateCodebaseQa')

    // The injected prompt does not.
    expect(localizedZh.systemPrompt).toBe(localizedEn.systemPrompt)
    expect(localizedZh.systemPrompt).toContain('codebase Q&A expert')
    expect(localizedZh.systemPrompt).not.toContain('代码库问答专家')

    // Mustache placeholders survive localization in either case.
    expect(localizedZh.systemPrompt).toContain('{{context}}')
    expect(localizedEn.systemPrompt).toContain('{{context}}')
  })

  it('keeps every template English at the point of injection', () => {
    // Applies to the whole catalog, not just the one probed above.
    for (const definition of AGENT_TEMPLATE_CATALOG) {
      const zh = localizeAgentTemplate(definition, (key: string) => key)
      expect(zh.systemPrompt, `${definition.key} injected a non-English prompt`).toBe(
        definition.prompts.en,
      )
    }
  })

  it('uses only supported runtime variables', () => {
    const supportedVariables = new Set(['message', 'context', 'model', 'agent_provider'])
    for (const template of AGENT_TEMPLATE_CATALOG) {
      for (const prompt of Object.values(template.prompts)) {
        const variables = [...prompt.matchAll(/{{\s*([^}\s]+)\s*}}/g)].map((match) => match[1])
        expect(variables.every((variable) => supportedVariables.has(variable))).toBe(true)
      }
    }
  })

  it('contains no production identifiers, locations, contacts, or endpoints', () => {
    const allPrompts = AGENT_TEMPLATE_CATALOG.flatMap((template) =>
      Object.values(template.prompts),
    ).join('\n')
    const forbidden = [
      /\b(?:agt|prv|skl|mcp|scm|kbd|run|oc|ou)_[A-Za-z0-9_-]+\b/,
      /https?:\/\//i,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
      /\/(?:app|data|home|opt|private|tmp|Users|var)\//,
      /\b(?:a2wave-prod|lilith|neptune|paimon|ubuntu22)\b/i,
    ]

    for (const pattern of forbidden) expect(allPrompts).not.toMatch(pattern)
  })

  it('uses portable resource hints instead of deployment resource IDs', () => {
    const scmTemplates = AGENT_TEMPLATE_CATALOG.filter(
      (template) => template.workspaceType === 'scm',
    )
    expect(scmTemplates.map((template) => template.key)).toEqual([
      'codebase-qa',
      'change-review',
      'documentation-maintenance',
    ])
    expect(scmTemplates.every((template) => template.scmSubType === 'git')).toBe(true)
    expect(
      AGENT_TEMPLATE_CATALOG.every(
        (template) =>
          !('scmSourceId' in template) &&
          !('providerId' in template) &&
          !('mcpServerIds' in template),
      ),
    ).toBe(true)
  })
})
