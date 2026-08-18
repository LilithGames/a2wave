/**
 * core:command-dispatch plugin 集成测——dispatcher 仲裁 + allowedContexts fall-through
 * + emptyTextFallback 注入。
 *
 * 主要从旧 plugin.test.ts 迁移非 channel/validator/keepPrefix case。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AuthenticatedCtx, LifecyclePlugin, MatchedCtx } from '../../types.js'
import { createCommandDispatchPlugin } from '../dispatch-plugin.js'
import { createCommandPlugin } from '../factory.js'
import type { CommandPlugin } from '../types.js'

function makeCtx(
  rawText: string,
  messageContext: { chatType: 'p2p' | 'group'; isThreadReply: boolean } = {
    chatType: 'p2p',
    isThreadReply: false,
  },
): AuthenticatedCtx & Partial<MatchedCtx> {
  return {
    channelId: 'feishu',
    rawEvent: {},
    rawText,
    sender: { userId: 'usr_x' },
    messageKey: 'msg_x',
    meta: {},
    channelConfig: null,
    messageContext,
    agent: { id: 'agt_1', userId: null },
    agentConfig: {} as never,
    engineType: 'claude-code',
  }
}

const newPlugin = createCommandPlugin({
  commandName: 'new',
  prefixes: ['/new'],
  allowedContexts: ['p2p'],
  emptyTextFallback: '新会话已开始',
  applySession: () => ({ override: null }),
})

describe('commandDispatchPlugin metadata', () => {
  let plugin: LifecyclePlugin
  beforeEach(() => {
    plugin = createCommandDispatchPlugin([newPlugin])
  })
  it('exposes name "core:command-dispatch"', async () => {
    expect(plugin.name).toBe('core:command-dispatch')
  })
  it('priority is 10 (smaller than cmd plugin priority 20 so dispatcher runs first)', async () => {
    expect(plugin.priority).toBe(10)
  })
})

describe('commandDispatchPlugin.onAuthenticated — prefix match', () => {
  const dispatch = createCommandDispatchPlugin([newPlugin])

  it('matches /new and writes matchedCommand + strippedText + pendingCommandPlugin', async () => {
    const ctx = makeCtx('/new please')
    const r = await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect(r).toBeNull()
    expect((ctx as MatchedCtx).matchedCommand).toBe('new')
    expect((ctx as MatchedCtx).strippedText).toBe('please')
    expect((ctx as MatchedCtx).pendingCommandPlugin?.commandName).toBe('new')
  })

  it('does nothing when no prefix matches', async () => {
    const ctx = makeCtx('plain text')
    const r = await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect(r).toBeNull()
    expect((ctx as MatchedCtx).matchedCommand).toBeUndefined()
    expect((ctx as MatchedCtx).pendingCommandPlugin).toBeUndefined()
    // strippedText 默认就是 rawText
    expect((ctx as MatchedCtx).strippedText).toBe('plain text')
  })
})

describe('commandDispatchPlugin.onAuthenticated — emptyTextFallback 注入', () => {
  const dispatch = createCommandDispatchPlugin([newPlugin])

  it('bare /new + emptyTextFallback declared → strippedText 注入 fallback', async () => {
    const ctx = makeCtx('/new')
    await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).matchedCommand).toBe('new')
    expect((ctx as MatchedCtx).strippedText).toBe('新会话已开始')
  })

  it('/new with trailing text → preserves user text (fallback NOT used)', async () => {
    const ctx = makeCtx('/new hello world')
    await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).strippedText).toBe('hello world')
  })

  it('bare command without emptyTextFallback → strippedText 留空', async () => {
    const cmd = createCommandPlugin({ commandName: 'silent', prefixes: ['/silent'] })
    const d = createCommandDispatchPlugin([cmd])
    const ctx = makeCtx('/silent')
    await d.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).matchedCommand).toBe('silent')
    expect((ctx as MatchedCtx).strippedText).toBe('')
  })
})

describe('commandDispatchPlugin.onAuthenticated — allowedContexts fall-through', () => {
  // /new applies to every direct message, quoted replies included; in a group chat and in
  // a group reply chain it behaves as if unmatched — no pendingCommandPlugin, strippedText
  // untouched — so downstream handles the whole message as ordinary text.

  const dispatch = createCommandDispatchPlugin([newPlugin])

  it('allowed context (p2p top-level): 完整命中', async () => {
    const ctx = makeCtx('/new go', { chatType: 'p2p', isThreadReply: false })
    await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).matchedCommand).toBe('new')
    expect((ctx as MatchedCtx).strippedText).toBe('go')
    expect((ctx as MatchedCtx).pendingCommandPlugin).toBeDefined()
  })

  it('disallowed context (group): 不处理命令，原文透传', async () => {
    const ctx = makeCtx('/new go', { chatType: 'group', isThreadReply: false })
    await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).matchedCommand).toBeUndefined()
    expect((ctx as MatchedCtx).pendingCommandPlugin).toBeUndefined()
    expect((ctx as MatchedCtx).strippedText).toBe('/new go')
  })

  // A quoted reply in a direct message used to derive 'thread' and fall through,
  // so `/new` reached the engine as literal prompt text: no session reset, and the
  // Agent answered the string "/new". P2P keys its session on chat_id, so a quote
  // splits no independent line off — there is nothing to fall through to.
  it('allowed context (p2p quoted reply): matches, a quote is not a thread', async () => {
    const ctx = makeCtx('/new go', { chatType: 'p2p', isThreadReply: true })
    await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).matchedCommand).toBe('new')
    expect((ctx as MatchedCtx).strippedText).toBe('go')
    expect((ctx as MatchedCtx).pendingCommandPlugin).toBeDefined()
  })

  it('disallowed context (group thread): 不处理命令，原文透传', async () => {
    const ctx = makeCtx('/new go', { chatType: 'group', isThreadReply: true })
    await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).pendingCommandPlugin).toBeUndefined()
    expect((ctx as MatchedCtx).strippedText).toBe('/new go')
  })

  it('disallowed context + bare 形态：不处理命令，原文透传', async () => {
    const ctx = makeCtx('/new', { chatType: 'group', isThreadReply: false })
    await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).matchedCommand).toBeUndefined()
    expect((ctx as MatchedCtx).strippedText).toBe('/new')
  })

  it('undeclared allowedContexts = no restriction', async () => {
    const noRestrict: CommandPlugin = createCommandPlugin({
      commandName: 'noRestrict',
      prefixes: ['/x'],
    })
    const d = createCommandDispatchPlugin([noRestrict])
    const ctx = makeCtx('/x', { chatType: 'group', isThreadReply: true })
    await d.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).matchedCommand).toBe('noRestrict')
  })
})

describe('commandDispatchPlugin.onAuthenticated — short-circuit & defaults', () => {
  const dispatch = createCommandDispatchPlugin([newPlugin])

  it('empty rawText → no match, strippedText 默认 rawText', async () => {
    const ctx = makeCtx('')
    const r = await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect(r).toBeNull()
    expect((ctx as MatchedCtx).matchedCommand).toBeUndefined()
    expect((ctx as MatchedCtx).strippedText).toBe('')
  })

  it('whitespace-only rawText → no match', async () => {
    const ctx = makeCtx('     ')
    await dispatch.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).matchedCommand).toBeUndefined()
  })

  it('empty cmdPlugins list → 永远不匹配', async () => {
    const d = createCommandDispatchPlugin([])
    const ctx = makeCtx('/new go')
    await d.onAuthenticated?.(ctx as AuthenticatedCtx)
    expect((ctx as MatchedCtx).matchedCommand).toBeUndefined()
  })
})
