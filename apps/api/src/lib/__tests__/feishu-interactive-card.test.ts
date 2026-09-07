import { describe, expect, it } from 'vitest'
import {
  buildInteractiveCardJson,
  buildPlainCardJson,
  buildResolvedCardJson,
  type CardActionGateRow,
  decideCardAction,
  parseInteractiveCardSpec,
  summarizeCardAction,
} from '../feishu-interactive-card.js'

const block = (json: string) => `好的，请确认：\n\n\`\`\`a2wave-card\n${json}\n\`\`\``

describe('parseInteractiveCardSpec', () => {
  it('parses a valid confirm_cancel spec and strips the block', async () => {
    const out = block('{"title":"确认","components":[{"type":"confirm_cancel"}]}')
    const { spec, text } = parseInteractiveCardSpec(out)
    expect(spec).not.toBeNull()
    expect(spec?.components[0]?.type).toBe('confirm_cancel')
    expect(text).toBe('好的，请确认：')
    expect(text).not.toContain('a2wave-card')
  })

  it('returns null spec (and original text) when no block present', async () => {
    const { spec, text } = parseInteractiveCardSpec('普通回复，无卡片')
    expect(spec).toBeNull()
    expect(text).toBe('普通回复，无卡片')
  })

  it('falls back to null on invalid JSON', async () => {
    const { spec } = parseInteractiveCardSpec(block('{not json}'))
    expect(spec).toBeNull()
  })

  it('falls back to null when schema is violated (unknown component)', async () => {
    const { spec } = parseInteractiveCardSpec(block('{"components":[{"type":"slider"}]}'))
    expect(spec).toBeNull()
  })

  it('falls back to null when select has no options', async () => {
    const { spec } = parseInteractiveCardSpec(
      block('{"components":[{"type":"select","name":"x"}]}'),
    )
    expect(spec).toBeNull()
  })

  it('falls back to null when a component name is not alnum/underscore', async () => {
    const { spec } = parseInteractiveCardSpec(
      block('{"components":[{"type":"input","name":"原因"}]}'),
    )
    expect(spec).toBeNull()
  })

  it('falls back to null when component names collide', async () => {
    const { spec } = parseInteractiveCardSpec(
      block('{"components":[{"type":"input","name":"dup"},{"type":"date","name":"dup"}]}'),
    )
    expect(spec).toBeNull()
  })
})

describe('buildInteractiveCardJson', () => {
  it.each([
    [
      'Question details',
      'Analysis before the question',
      'Analysis before the question\n\nQuestion details',
    ],
    [undefined, 'Analysis before the question', 'Analysis before the question'],
    ['', 'Analysis before the question', 'Analysis before the question'],
    ['   ', 'Analysis before the question', 'Analysis before the question'],
    ['Question details', undefined, 'Question details'],
    ['Question details', '   ', 'Question details'],
    [' Same question ', ' Same question ', 'Same question'],
    ['Question', 'Question details', 'Question details\n\nQuestion'],
  ])(
    'preserves visible text when body is %j and surrounding text is %j',
    (body, text, expected) => {
      const card = buildInteractiveCardJson(
        { body, components: [{ type: 'confirm_cancel' }] },
        'fcb_body',
        text,
      )
      expect(card.body).toMatchObject({
        elements: [{ tag: 'markdown', content: expected }, { tag: 'hr' }, { tag: 'column_set' }],
      })
    },
  )

  it('keeps text around the declaration and long Markdown before the question', () => {
    const before = `## Analysis\n${'Detailed finding.\n'.repeat(350)}`
    const after = '[Download report](https://example.com/report)'
    const { spec, text } = parseInteractiveCardSpec(
      `${before}\n\`\`\`a2wave-card\n${JSON.stringify({
        body: 'Which option should we use?',
        components: [{ type: 'confirm_cancel' }],
      })}\n\`\`\`\n${after}`,
    )
    expect(spec).not.toBeNull()
    if (!spec) throw new Error('Expected a valid interactive card declaration')
    const card = buildInteractiveCardJson(spec, 'fcb_long', text)
    expect(card.body).toMatchObject({
      elements: [
        { tag: 'markdown', content: `${text}\n\nWhich option should we use?` },
        { tag: 'hr' },
        { tag: 'column_set' },
      ],
    })
    expect(text).toContain(before.trim())
    expect(text).toContain(after)
  })

  it('builds standalone callback buttons for confirm_cancel (no form)', async () => {
    const { spec } = parseInteractiveCardSpec(
      block('{"title":"标题","body":"正文","components":[{"type":"confirm_cancel"}]}'),
    )
    const card = buildInteractiveCardJson(spec!, 'fcb_1') as any
    expect(card.schema).toBe('2.0')
    expect(card.config.update_multi).toBe(true)
    expect(card.header.title.content).toBe('标题')

    const json = JSON.stringify(card)
    expect(json).not.toContain('"tag":"form"')
    // 正文与按钮之间有分割线
    expect(json).toContain('"tag":"hr"')
    // 两个按钮，value 内嵌 cb 与 action
    expect(json).toContain('"cb":"fcb_1"')
    expect(json).toContain('"action":"confirm"')
    expect(json).toContain('"action":"cancel"')
  })

  it('falls back to style.title (e.g. bot name) when spec has no title', async () => {
    const { spec } = parseInteractiveCardSpec(
      block('{"body":"正文","components":[{"type":"confirm_cancel"}]}'),
    )
    const card = buildInteractiveCardJson(spec!, 'fcb_x', undefined, { title: '栗子老师' }) as any
    expect(card.header.title.content).toBe('栗子老师')
    expect(card.header.template).toBe('blue')
  })

  it('renders debugSuffix as a trailing element even when spec.body is set', async () => {
    const { spec } = parseInteractiveCardSpec(
      block('{"body":"正文","components":[{"type":"confirm_cancel"}]}'),
    )
    const card = buildInteractiveCardJson(
      spec!,
      'fcb_d',
      '兜底',
      undefined,
      '\n\n---\n**🐞 调试信息**\n- 模型：x',
    ) as any
    const json = JSON.stringify(card)
    expect(json).toContain('🐞 调试信息')
    expect(json).toContain('- 模型：x')
    // 末元素即调试信息（在操作区之后）
    const last = card.body.elements[card.body.elements.length - 1]
    expect(last.content).toContain('🐞 调试信息')
  })

  it('prefers spec.title over style.title', async () => {
    const { spec } = parseInteractiveCardSpec(
      block('{"title":"请确认","components":[{"type":"confirm_cancel"}]}'),
    )
    const card = buildInteractiveCardJson(spec!, 'fcb_y', undefined, { title: '栗子老师' }) as any
    expect(card.header.title.content).toBe('请确认')
  })

  it('wraps input components in a form with a submit button', async () => {
    const { spec } = parseInteractiveCardSpec(
      block(
        '{"components":[{"type":"input","name":"reason","label":"原因"},{"type":"select","name":"lvl","options":[{"label":"高","value":"high"}]},{"type":"multi_select","name":"tags","options":[{"label":"A","value":"a"}]},{"type":"date","name":"due"}]}',
      ),
    )
    const card = buildInteractiveCardJson(spec!, 'fcb_2', '兜底正文') as any
    const json = JSON.stringify(card)
    expect(json).toContain('"tag":"form"')
    expect(json).toContain('"form_action_type":"submit"')
    expect(json).toContain('"action":"submit"')
    expect(json).toContain('"tag":"input"')
    expect(json).toContain('"tag":"select_static"')
    expect(json).toContain('"tag":"multi_select_static"')
    expect(json).toContain('"tag":"date_picker"')
    // 未写 body 时用兜底正文
    expect(json).toContain('兜底正文')
  })
})

describe('buildPlainCardJson', () => {
  it('wraps text as a markdown card (no interactive components)', async () => {
    const card = buildPlainCardJson('你好呀！我是栗子老师 👋') as any
    expect(card.schema).toBe('2.0')
    expect(card.config.update_multi).toBe(true)
    expect(card.body.elements[0]).toEqual({
      tag: 'markdown',
      content: '你好呀！我是栗子老师 👋',
    })
    const json = JSON.stringify(card)
    expect(json).not.toContain('"tag":"button"')
    expect(json).not.toContain('"tag":"form"')
    expect(card.header).toBeUndefined()
  })

  it('adds a colored header when style.title given and trims body', async () => {
    const card = buildPlainCardJson('  正文  ', { title: '标题' }) as any
    expect(card.header.title.content).toBe('标题')
    // 默认配色为蓝色（语义预设，深浅色自适配）
    expect(card.header.template).toBe('blue')
    expect(card.body.elements[0].content).toBe('正文')
  })

  it('honors an explicit headerTemplate and subtitle', async () => {
    const card = buildPlainCardJson('正文', {
      title: '标题',
      subtitle: '副标题',
      headerTemplate: 'wathet',
    }) as any
    expect(card.header.template).toBe('wathet')
    expect(card.header.subtitle.content).toBe('副标题')
  })

  it('produces an empty-body card when text is blank', async () => {
    const card = buildPlainCardJson('   ') as any
    expect(card.body.elements).toHaveLength(0)
  })
})

describe('summarizeCardAction', () => {
  const spec = {
    components: [
      { type: 'input' as const, name: 'reason', label: '原因' },
      { type: 'multi_select' as const, name: 'tags', label: '标签', options: [] },
    ],
  }

  it('summarizes a form submit with label mapping and array join', async () => {
    const s = summarizeCardAction(spec, 'submit', {
      reason: '太慢了',
      tags: ['a', 'b'],
    })
    expect(s.feedbackText).toContain('原因：太慢了')
    expect(s.feedbackText).toContain('标签：a、b')
    expect(s.toast).toBe('已提交')
    expect(s.resultLine).toContain('✅')
  })

  it('summarizes a cancel without resume content', async () => {
    const s = summarizeCardAction(spec, 'cancel', undefined)
    expect(s.feedbackText).toContain('取消')
    expect(s.toast).toBe('已取消')
  })

  it('summarizes a bare confirm', async () => {
    const s = summarizeCardAction(
      { components: [{ type: 'confirm_cancel' as const }] },
      'confirm',
      undefined,
    )
    expect(s.feedbackText).toContain('确认')
    expect(s.toast).toBe('已确认')
  })
})

describe('buildResolvedCardJson', () => {
  it('drops interactive components and appends the result line', async () => {
    const spec = { title: 'T', body: '正文', components: [{ type: 'confirm_cancel' as const }] }
    const card = buildResolvedCardJson(spec, '✅ 已确认') as any
    const json = JSON.stringify(card)
    expect(json).not.toContain('"tag":"button"')
    expect(json).not.toContain('"tag":"form"')
    expect(json).toContain('✅ 已确认')
    expect(json).toContain('正文')
  })

  it('keeps the persisted body and appends the debug footer at the bottom', async () => {
    // 模拟发卡时把 bodyFallback 补进 spec.body 后持久化的情形：就地更新卡片应保留原始正文，
    // 并在最底部带上调试信息（与发卡时一致）。
    const spec = { body: '请选择你的问题大类', components: [{ type: 'confirm_cancel' as const }] }
    const card = buildResolvedCardJson(
      spec,
      '✅ 已提交',
      undefined,
      '\n\n---\n**🐞 调试信息**\n- 模型：x',
    ) as any
    expect(card.body.elements[0].content).toContain('请选择你的问题大类')
    const last = card.body.elements[card.body.elements.length - 1]
    expect(last.content).toContain('🐞 调试信息')
  })
})

describe('decideCardAction', () => {
  const AGENT = 'agt_1'
  const OWNER = 'ou_owner'
  const NOW = 1_000_000
  // 默认：归属 AGENT、限定 OWNER 可点、pending、未过期。
  const baseRow = (over: Partial<CardActionGateRow> = {}): CardActionGateRow => ({
    agentId: AGENT,
    triggerOpenId: OWNER,
    status: 'pending',
    expiresAt: new Date(NOW + 60_000),
    ...over,
  })
  const decide = (over: Partial<Parameters<typeof decideCardAction>[0]>) =>
    decideCardAction({
      agentId: AGENT,
      operatorOpenId: OWNER,
      now: NOW,
      rawAction: 'confirm',
      row: baseRow(),
      ...over,
    })

  it('confirm by the owner proceeds and resumes', async () => {
    const g = decide({ rawAction: 'confirm', row: baseRow() })
    expect(g).toEqual({ kind: 'proceed', action: 'confirm', resume: true })
  })

  it('submit by the owner proceeds and resumes', async () => {
    const g = decide({ rawAction: 'submit', row: baseRow() })
    expect(g).toEqual({ kind: 'proceed', action: 'submit', resume: true })
  })

  it('cancel proceeds but does NOT resume', async () => {
    const g = decide({ rawAction: 'cancel', row: baseRow() })
    expect(g).toEqual({ kind: 'proceed', action: 'cancel', resume: false })
  })

  it('allows any operator when triggerOpenId is null (历史记录/无法获取)', async () => {
    const g = decide({
      rawAction: 'confirm',
      operatorOpenId: 'ou_someone_else',
      row: baseRow({ triggerOpenId: null }),
    })
    expect(g).toEqual({ kind: 'proceed', action: 'confirm', resume: true })
  })

  it.each([['unknown'], [undefined], [''], ['Confirm']])(
    'rejects unknown/missing action (%s) without proceeding (不误触发 resume)',
    (raw) => {
      const g = decide({ rawAction: raw as string | undefined, row: baseRow() })
      expect(g.kind).toBe('invalid-action')
    },
  )

  it('rejects a missing row as invalid-card', async () => {
    expect(decide({ rawAction: 'confirm', row: undefined }).kind).toBe('invalid-card')
    expect(decide({ rawAction: 'confirm', row: null }).kind).toBe('invalid-card')
  })

  it('rejects a row belonging to another agent as invalid-card', async () => {
    const g = decide({ rawAction: 'confirm', row: baseRow({ agentId: 'agt_other' }) })
    expect(g.kind).toBe('invalid-card')
  })

  it('rejects a non-owner click (越权) without claiming or resuming', async () => {
    const g = decide({
      rawAction: 'confirm',
      operatorOpenId: 'ou_intruder',
      row: baseRow(),
    })
    expect(g.kind).toBe('not-owner')
  })

  it('rejects an already-used card (重放/重复点击)', async () => {
    const g = decide({ rawAction: 'confirm', row: baseRow({ status: 'used' }) })
    expect(g.kind).toBe('already-used')
  })

  it('rejects an expired card (expiresAt < now)', async () => {
    const g = decide({ rawAction: 'confirm', row: baseRow({ expiresAt: new Date(NOW - 1) }) })
    expect(g.kind).toBe('expired')
  })

  it('does not treat a card expiring exactly now as expired', async () => {
    const g = decide({ rawAction: 'confirm', row: baseRow({ expiresAt: new Date(NOW) }) })
    expect(g.kind).toBe('proceed')
  })

  it('treats a null expiresAt as never-expiring', async () => {
    const g = decide({ rawAction: 'confirm', row: baseRow({ expiresAt: null }) })
    expect(g.kind).toBe('proceed')
  })

  // 顺序语义：权限校验在核销/已处理/过期判定之前——他人点一张已 used 的卡片，
  // 应优先报「非发起人」，既不暴露卡片状态，也对齐 handler 里「他人误点不核销不续跑」。
  it('checks ownership before used/expired state', async () => {
    const g = decide({
      rawAction: 'confirm',
      operatorOpenId: 'ou_intruder',
      row: baseRow({ status: 'used', expiresAt: new Date(NOW - 1) }),
    })
    expect(g.kind).toBe('not-owner')
  })

  // 动作合法性在最前：未知动作即便 row 异常也先报无效动作（与 handler 实现一致）。
  it('checks action validity before row lookup', async () => {
    expect(decide({ rawAction: 'nope', row: undefined }).kind).toBe('invalid-action')
  })
})
