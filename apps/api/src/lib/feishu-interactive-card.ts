/**
 * 飞书交互卡片（卡片 JSON 2.0）——Agent 在回复中声明交互组件，平台渲染为可点击/可填写的
 * 卡片；用户操作经飞书长连接的 `card.action.trigger` 回调回传，平台 resume 同一 session 续跑。
 *
 * 本模块只负责「纯逻辑」：
 *   - 规范提示词文本（注入到 Agent system prompt）
 *   - 解析 Agent 输出里的 ```a2wave-card``` 声明块（失败即降级为普通文本回复）
 *   - 把声明构建成卡片 JSON 2.0（按钮 / 表单 + 输入 / 单选 / 多选 / 日期）
 *   - 把回调里的 form_value / action 汇总成给 Agent 的反馈文本
 *
 * 不碰 DB、不发网络请求——这些由 feishu-service.ts 串联（建回调记录、发卡、收回调、续跑）。
 *
 * 字段依据飞书官方「卡片 JSON 2.0」文档：
 *   - button.behaviors callback（value 仅支持 object）、表单提交按钮 form_action_type:'submit'
 *   - form 容器 { tag:'form', name, elements }
 *   - 回调 event：action.value / action.form_value（按组件 name 取值，多选为数组）
 *     https://open.feishu.cn/document/feishu-cards/card-callback-communication
 */
import { z } from 'zod'

// ──────────────────────────────────────────────────────────────────────────────
// Agent-facing spec（Agent 在 ```a2wave-card``` 块里输出的 JSON）
// ──────────────────────────────────────────────────────────────────────────────

const optionSchema = z.object({
  label: z.string().min(1).max(100),
  value: z.string().min(1).max(200),
})

// 飞书要求表单组件 name 为字母/数字/下划线，且需在卡片内唯一；否则发卡失败或 form_value 字段歧义。
const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]+$/, 'name 只能包含字母、数字、下划线')

const componentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('confirm_cancel'),
    confirm_label: z.string().min(1).max(20).optional(),
    cancel_label: z.string().min(1).max(20).optional(),
  }),
  z.object({
    type: z.literal('input'),
    name: nameSchema,
    label: z.string().max(50).optional(),
    placeholder: z.string().max(100).optional(),
    required: z.boolean().optional(),
    default_value: z.string().max(1000).optional(),
  }),
  z.object({
    type: z.literal('select'),
    name: nameSchema,
    label: z.string().max(50).optional(),
    placeholder: z.string().max(100).optional(),
    required: z.boolean().optional(),
    options: z.array(optionSchema).min(1).max(50),
  }),
  z.object({
    type: z.literal('multi_select'),
    name: nameSchema,
    label: z.string().max(50).optional(),
    placeholder: z.string().max(100).optional(),
    required: z.boolean().optional(),
    options: z.array(optionSchema).min(1).max(50),
  }),
  z.object({
    type: z.literal('date'),
    name: nameSchema,
    label: z.string().max(50).optional(),
    placeholder: z.string().max(100).optional(),
    required: z.boolean().optional(),
  }),
])

export const interactiveCardSpecSchema = z
  .object({
    title: z.string().max(100).optional(),
    body: z.string().max(5000).optional(),
    submit_label: z.string().min(1).max(20).optional(),
    components: z.array(componentSchema).min(1).max(10),
  })
  .superRefine((spec, ctx) => {
    // 组件 name 必须在卡片内唯一，否则 form_value 字段会相互覆盖、续跑输入错乱。
    const seen = new Set<string>()
    for (const c of spec.components) {
      if (c.type === 'confirm_cancel') continue
      if (seen.has(c.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate component name: ${c.name}`,
          path: ['components'],
        })
      }
      seen.add(c.name)
    }
  })

export type InteractiveCardSpec = z.infer<typeof interactiveCardSpecSchema>
export type InteractiveCardComponent = z.infer<typeof componentSchema>

/** 回调按钮 value 内嵌的最小载荷——只放回调记录 id 与动作，session 关联信息全部落 DB（防伪/防重放）。 */
export interface CardCallbackValue {
  /** feishu_card_callbacks.id */
  cb: string
  /** 用户动作：确认 / 取消 / 表单提交 */
  action: 'confirm' | 'cancel' | 'submit'
}

// ──────────────────────────────────────────────────────────────────────────────
// 规范提示词（回复格式为 interactive_card 时追加到 system prompt）
// ──────────────────────────────────────────────────────────────────────────────

export const INTERACTIVE_CARD_FENCE = 'a2wave-card'

export const INTERACTIVE_CARD_PROMPT = `## 交互卡片（向用户收集反馈以推进当前会话）

当你需要用户**确认**某个操作、或**填写/选择**信息后才能继续时，可以在回复末尾输出一个交互卡片声明块。
系统会把它渲染成飞书可交互卡片；用户操作后，结果会作为新的一轮输入回到**同一个会话**，你据此继续。

**优先用组件代替"用文字让用户打字回答"**：当你正在请用户在**有限选项**里做选择（如选类别、选方向、二选一），或请用户**确认是否继续**时，应直接给出 \`select\`/\`multi_select\`/\`confirm_cancel\` 卡片，把候选项做成可点选项——不要只用文字罗列 1./2./3. 让用户手敲。这样用户点一下即可，体验更顺、也更不易答错。仅当答案是开放式、无法预设选项时，才用 \`input\` 或纯文本提问。

格式（用 \`\`\`${INTERACTIVE_CARD_FENCE} 围起一段 JSON）：

\`\`\`${INTERACTIVE_CARD_FENCE}
{
  "title": "可选标题",
  "body": "可选说明文字（Markdown）",
  "submit_label": "提交",
  "components": [
    { "type": "confirm_cancel", "confirm_label": "确认", "cancel_label": "取消" },
    { "type": "input", "name": "reason", "label": "原因", "placeholder": "请输入", "required": false },
    { "type": "select", "name": "level", "label": "级别", "options": [ { "label": "高", "value": "high" }, { "label": "低", "value": "low" } ] },
    { "type": "multi_select", "name": "tags", "label": "标签", "options": [ { "label": "A", "value": "a" }, { "label": "B", "value": "b" } ] },
    { "type": "date", "name": "due", "label": "截止日期" }
  ]
}
\`\`\`

规则：
- 组件类型只能是：\`confirm_cancel\`（确认/取消按钮）、\`input\`（文本输入）、\`select\`（下拉单选）、\`multi_select\`（下拉多选）、\`date\`（日期）。
- 除 \`confirm_cancel\` 外，每个组件必须有唯一的 \`name\`（英文/数字）；\`select\`/\`multi_select\` 必须给 \`options\`。
- 含输入类组件时，系统会生成一个「提交」按钮收集全部字段。
- 一条消息最多放一个卡片块、最多 10 个组件；只在确实需要用户反馈时使用，普通回复直接输出文本即可。
- 卡片块之外可以照常写正文；正文会与 \`body\` 一起保留在同一张卡片中，正文在前、\`body\` 在后。\`body\` 只需补充问答说明，不必重复正文。`

// ──────────────────────────────────────────────────────────────────────────────
// 解析 Agent 输出
// ──────────────────────────────────────────────────────────────────────────────

const FENCE_RE = new RegExp(`\`\`\`${INTERACTIVE_CARD_FENCE}[^\\n]*\\n([\\s\\S]*?)\`\`\``, 'i')

export interface ParsedInteractiveCard {
  /** 解析成功的卡片声明；未命中或非法 → null（调用方降级为普通文本回复） */
  spec: InteractiveCardSpec | null
  /** 去掉卡片块后的可视文本（spec 为 null 时即原文） */
  text: string
}

/**
 * 从 Agent 输出里提取 ```a2wave-card``` 声明块。
 * 任何失败（无块 / JSON 非法 / schema 不符）都返回 spec=null + 原始/剥离文本，绝不抛错。
 */
export function parseInteractiveCardSpec(output: string): ParsedInteractiveCard {
  if (!output) return { spec: null, text: output ?? '' }
  const match = output.match(FENCE_RE)
  if (!match) return { spec: null, text: output }

  const stripped = output.replace(match[0], '').trim()
  try {
    const parsed = interactiveCardSpecSchema.safeParse(JSON.parse(match[1]))
    if (!parsed.success) return { spec: null, text: output }
    return { spec: parsed.data, text: stripped }
  } catch {
    return { spec: null, text: output }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 构建卡片 JSON 2.0
// ──────────────────────────────────────────────────────────────────────────────

type CardJson = Record<string, unknown>

function plainText(content: string): CardJson {
  return { tag: 'plain_text', content }
}

// ──────────────────────────────────────────────────────────────────────────────
// 默认视觉样式（克制、专业、深浅色自适配）
//
// 设计取向：企业飞书机器人卡片，refined/克制——一条语义预设色的标题栏建立身份与层次，
// 正文用 markdown（自动适配深/浅色），「说明 → 操作/结果」之间用分割线分隔。
// 全程不硬编码 hex：标题栏配色用飞书语义预设（自动深浅色适配），文字交给 markdown。
// ──────────────────────────────────────────────────────────────────────────────

/** 卡片视觉样式的可调旋钮。title 缺省则不渲染标题栏。 */
export interface CardStyle {
  /** 标题栏主标题（如机器人名）。 */
  title?: string
  /** 标题栏副标题（小字，置于主标题下）。 */
  subtitle?: string
  /**
   * 标题栏配色，用飞书语义预设色（blue / wathet / turquoise / green / yellow /
   * orange / red / carmine / violet / purple / indigo / grey），自动适配深/浅色模式。
   */
  headerTemplate?: string
}

/** 默认标题栏配色：蓝色，专业且辨识度高，深浅色自适配。 */
export const DEFAULT_CARD_HEADER_TEMPLATE = 'blue'

/** 卡片全局 config：多端一致更新 + 宽屏。 */
const CARD_CONFIG = { update_multi: true, wide_screen_mode: true } as const

/** 水平分割线，用于在「正文」与「操作区 / 结果」之间做视觉分隔。 */
const DIVIDER: CardJson = { tag: 'hr' }

/** 构建标题栏；无标题则返回 undefined（卡片不带 header）。 */
function buildHeader(style?: CardStyle): CardJson | undefined {
  if (!style?.title) return undefined
  const header: CardJson = {
    title: plainText(style.title),
    template: style.headerTemplate ?? DEFAULT_CARD_HEADER_TEMPLATE,
  }
  if (style.subtitle) header.subtitle = plainText(style.subtitle)
  return header
}

/**
 * 调试信息后缀 → 卡片底部一个独立 markdown 元素。debugSuffix 由 feishu-service 的
 * buildDebugInfoSuffix 生成（形如 "\n\n---\n**🐞 调试信息**\n- ..."），这里去掉首部空白
 * 后作为卡片最后一个元素，使其稳定显示在卡片底部（不受 spec.body 覆盖 bodyFallback 影响）。
 */
function debugFooterElement(debugSuffix?: string): CardJson | null {
  const s = debugSuffix?.trim()
  return s ? { tag: 'markdown', content: s } : null
}

/** 统一组装卡片骨架（schema / config / body[/ header]），收敛重复结构。 */
function assembleCard(elements: CardJson[], style?: CardStyle): CardJson {
  const card: CardJson = { schema: '2.0', config: { ...CARD_CONFIG }, body: { elements } }
  const header = buildHeader(style)
  if (header) card.header = header
  return card
}

function buttonRow(buttons: CardJson[]): CardJson {
  return {
    tag: 'column_set',
    horizontal_spacing: '8px',
    columns: buttons.map((b) => ({ tag: 'column', width: 'auto', elements: [b] })),
  }
}

function toInputElement(
  c: Exclude<InteractiveCardComponent, { type: 'confirm_cancel' }>,
): CardJson {
  const placeholder = c.placeholder ? plainText(c.placeholder) : undefined
  switch (c.type) {
    case 'input':
      return {
        tag: 'input',
        name: c.name,
        ...(c.label ? { label: plainText(c.label), label_position: 'top' } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(c.default_value ? { default_value: c.default_value } : {}),
        required: c.required ?? false,
      }
    case 'select':
      return {
        tag: 'select_static',
        name: c.name,
        ...(placeholder ? { placeholder } : {}),
        required: c.required ?? false,
        options: c.options.map((o) => ({ text: plainText(o.label), value: o.value })),
      }
    case 'multi_select':
      return {
        tag: 'multi_select_static',
        name: c.name,
        ...(placeholder ? { placeholder } : {}),
        required: c.required ?? false,
        options: c.options.map((o) => ({ text: plainText(o.label), value: o.value })),
      }
    case 'date':
      return {
        tag: 'date_picker',
        name: c.name,
        ...(placeholder ? { placeholder } : {}),
        required: c.required ?? false,
      }
  }
}

/** select/multi_select/date 自身不带 label，给它们前置一行加粗说明。 */
function maybeLabel(c: InteractiveCardComponent): CardJson | null {
  if (c.type === 'confirm_cancel' || c.type === 'input') return null
  return c.label ? { tag: 'markdown', content: `**${c.label}**` } : null
}

/** Preserve the reply context alongside the question, without duplicating identical text. */
export function resolveInteractiveCardBody(body?: string, surroundingText?: string): string {
  const text = surroundingText?.trim() ?? ''
  const details = body?.trim() ?? ''
  if (!text) return details
  if (!details || details === text) return text
  return `${text}\n\n${details}`
}

/** Build a card with the surrounding reply text followed by the question details. */
export function buildInteractiveCardJson(
  spec: InteractiveCardSpec,
  cbId: string,
  surroundingText?: string,
  style?: CardStyle,
  debugSuffix?: string,
): CardJson {
  const elements: CardJson[] = []

  const body = resolveInteractiveCardBody(spec.body, surroundingText)
  if (body) elements.push({ tag: 'markdown', content: body })

  const confirm = spec.components.find((c) => c.type === 'confirm_cancel') as
    | Extract<InteractiveCardComponent, { type: 'confirm_cancel' }>
    | undefined
  const inputs = spec.components.filter(
    (c): c is Exclude<InteractiveCardComponent, { type: 'confirm_cancel' }> =>
      c.type !== 'confirm_cancel',
  )

  const value = (action: CardCallbackValue['action']): CardJson => ({
    cb: cbId,
    action,
  })

  // 正文与操作区之间加一条分割线，强化「说明 → 操作」的视觉层次。
  if (elements.length > 0 && (inputs.length > 0 || confirm)) elements.push(DIVIDER)

  if (inputs.length > 0) {
    // 表单：输入组件 + 一个提交按钮。提交时回调携带 form_value（按 name 取值）。
    const formElements: CardJson[] = []
    for (const c of inputs) {
      const label = maybeLabel(c)
      if (label) formElements.push(label)
      formElements.push(toInputElement(c))
    }
    formElements.push({
      tag: 'button',
      text: plainText(spec.submit_label ?? confirm?.confirm_label ?? '提交'),
      type: 'primary',
      name: 'a2w_submit',
      form_action_type: 'submit',
      behaviors: [{ type: 'callback', value: value('submit') }],
    })
    elements.push({ tag: 'form', name: 'a2w_form', elements: formElements })
    // 取消按钮放在表单之外（不参与表单提交）。
    if (confirm) {
      elements.push(
        buttonRow([
          {
            tag: 'button',
            text: plainText(confirm.cancel_label ?? '取消'),
            type: 'default',
            behaviors: [{ type: 'callback', value: value('cancel') }],
          },
        ]),
      )
    }
  } else if (confirm) {
    // 仅确认/取消：两个独立回调按钮。
    elements.push(
      buttonRow([
        {
          tag: 'button',
          text: plainText(confirm.confirm_label ?? '确认'),
          type: 'primary',
          behaviors: [{ type: 'callback', value: value('confirm') }],
        },
        {
          tag: 'button',
          text: plainText(confirm.cancel_label ?? '取消'),
          type: 'default',
          behaviors: [{ type: 'callback', value: value('cancel') }],
        },
      ]),
    )
  }

  // Keep debug information below the actions, separate from the reply body.
  const debugFooter = debugFooterElement(debugSuffix)
  if (debugFooter) elements.push(debugFooter)

  // 标题优先用 Agent 声明的 spec.title，否则回退到默认样式标题（如机器人名）。
  return assembleCard(elements, spec.title ? { ...style, title: spec.title } : style)
}

/**
 * interactive_card 模式下「无交互声明」的普通回复也要渲染成卡片：把整段文本作为 markdown
 * 正文包成卡片 JSON 2.0（不含任何交互组件）。保证该模式下「无论如何都是卡片」，Agent 仅在
 * 需要时额外声明交互组件（见 buildInteractiveCardJson）。
 */
export function buildPlainCardJson(text: string, style?: CardStyle): CardJson {
  const elements: CardJson[] = []
  const body = text?.trim()
  if (body) elements.push({ tag: 'markdown', content: body })
  return assembleCard(elements, style)
}

/**
 * 用户操作后用于「就地更新」的卡片：保留标题/正文，去掉交互组件，追加一行结果说明。
 * 配合 card.action.trigger 的同步响应实现「toast + 禁用按钮（组件消失）」。
 */
export function buildResolvedCardJson(
  spec: InteractiveCardSpec,
  resultLine: string,
  style?: CardStyle,
  debugSuffix?: string,
): CardJson {
  const elements: CardJson[] = []
  if (spec.body?.trim()) {
    elements.push({ tag: 'markdown', content: spec.body.trim() })
    elements.push(DIVIDER)
  }
  elements.push({ tag: 'markdown', content: resultLine })
  // 调试信息固定在卡片最底部，与发卡时一致。
  const debugFooter = debugFooterElement(debugSuffix)
  if (debugFooter) elements.push(debugFooter)
  return assembleCard(elements, spec.title ? { ...style, title: spec.title } : style)
}

// ──────────────────────────────────────────────────────────────────────────────
// 回调汇总（→ 给 Agent 的反馈文本 + 给用户的就地结果行）
// ──────────────────────────────────────────────────────────────────────────────

/** 把组件 name → 中文 label 的映射取出，便于回显。 */
function labelMap(spec: InteractiveCardSpec): Map<string, string> {
  const m = new Map<string, string>()
  for (const c of spec.components) {
    if (c.type !== 'confirm_cancel' && c.label) m.set(c.name, c.label)
  }
  return m
}

export interface CardActionSummary {
  /** 喂给 Agent 续跑的输入文本 */
  feedbackText: string
  /** 卡片就地更新展示给用户的结果行 */
  resultLine: string
  /** toast 文案 */
  toast: string
}

/**
 * 把一次回调（确认/取消/表单提交）汇总成反馈。
 * @param action     button value 里的 action
 * @param formValue  回调 action.form_value（表单提交时存在），按组件 name 取值
 */
export function summarizeCardAction(
  spec: InteractiveCardSpec,
  action: CardCallbackValue['action'],
  formValue: Record<string, unknown> | undefined,
): CardActionSummary {
  if (action === 'cancel') {
    return {
      feedbackText: '用户在卡片上选择了「取消」。',
      resultLine: '🚫 已取消',
      toast: '已取消',
    }
  }

  const labels = labelMap(spec)
  const lines: string[] = []
  if (formValue && typeof formValue === 'object') {
    for (const [name, raw] of Object.entries(formValue)) {
      const label = labels.get(name) ?? name
      const val = Array.isArray(raw) ? raw.join('、') : String(raw ?? '')
      lines.push(`- ${label}：${val || '（空）'}`)
    }
  }

  const head = action === 'confirm' ? '用户在卡片上点击了「确认」。' : '用户提交了卡片表单。'
  const feedbackText = lines.length ? `${head}\n填写内容：\n${lines.join('\n')}` : head
  const resultLine = lines.length ? `✅ 已提交\n${lines.join('\n')}` : '✅ 已确认'
  return { feedbackText, resultLine, toast: action === 'confirm' ? '已确认' : '已提交' }
}

// ──────────────────────────────────────────────────────────────────────────────
// 卡片点击判定（核销前的同步决策，纯函数便于测试）
// ──────────────────────────────────────────────────────────────────────────────

/** decideCardAction 需要的回调行最小结构——不依赖 DB schema 类型，便于纯函数测试。 */
export interface CardActionGateRow {
  /** 卡片绑定的 agentId */
  agentId: string
  /** 发卡时的触发者 open_id；为空表示不限制点击者（历史记录 / 无法获取） */
  triggerOpenId: string | null
  /** 'pending' | 'used' */
  status: string
  /** 过期时间；为空表示不过期 */
  expiresAt: Date | null
}

export interface CardActionGateInput {
  /** 当前 agentId，用于校验 row 是否归属本 agent */
  agentId: string
  /** button value 里的 action，可能是未知 / 缺失值（函数内校验） */
  rawAction: string | undefined
  /** 点击者 open_id（回调 operator.open_id） */
  operatorOpenId: string | undefined
  /** feishu_card_callbacks 行；查不到为 null/undefined */
  row: CardActionGateRow | null | undefined
  /** 判定基准时间（Date.now()），便于测试注入 */
  now: number
}

/**
 * decideCardAction 的决策枚举：除 proceed 外都是终止态，各自对应一种用户提示。
 * proceed 表示通过全部前置校验、可进入原子核销；resume 指明该动作是否需要续跑。
 */
export type CardActionGate =
  | { kind: 'invalid-action' }
  | { kind: 'invalid-card' }
  | { kind: 'not-owner' }
  | { kind: 'already-used' }
  | { kind: 'expired' }
  | { kind: 'proceed'; action: CardCallbackValue['action']; resume: boolean }

/**
 * 卡片点击在「原子核销」之前的全部同步判定（纯函数，无任何副作用）：
 *   1. 动作合法性——只认 confirm/cancel/submit，未知/缺失动作不放行（否则会误触发 resume 续跑）
 *   2. 卡片归属——查无记录 / 不属于当前 agent → invalid-card
 *   3. 仅发起人可点——triggerOpenId 非空且与点击者不符 → not-owner（判在核销之前，他人误点不核销不续跑）
 *   4. 已处理——status === 'used' → already-used
 *   5. 过期——expiresAt < now → expired
 * 通过则返回 proceed，并给出 action 与是否续跑（cancel 不续跑）。
 *
 * 真正的副作用（过期置 used、原子核销 pending→used、resume 拉起）由调用方按决策执行——
 * 原子核销依赖 DB 受影响行数判定竞态，无法在纯函数内表达，故不在此处。
 */
export function decideCardAction(input: CardActionGateInput): CardActionGate {
  const { agentId, rawAction, operatorOpenId, row, now } = input
  if (rawAction !== 'confirm' && rawAction !== 'cancel' && rawAction !== 'submit') {
    return { kind: 'invalid-action' }
  }
  if (!row || row.agentId !== agentId) return { kind: 'invalid-card' }
  if (row.triggerOpenId && operatorOpenId !== row.triggerOpenId) return { kind: 'not-owner' }
  if (row.status === 'used') return { kind: 'already-used' }
  if (row.expiresAt && row.expiresAt.getTime() < now) return { kind: 'expired' }
  return { kind: 'proceed', action: rawAction, resume: rawAction !== 'cancel' }
}
