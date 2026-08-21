/**
 * Pipeline L1 barrel + default plugin factory.
 *
 * 唯一规定 plugin 顺序的地方：所有 channel 入口（feishu / a2a / api）必须从这里读，
 * 不要在别处手搓 LifecyclePlugin[]。测试可通过 channel 入口的 extraPlugins 显式注入。
 */
import { newCommandPlugin } from './commands/defs/new.js'
import { statusCommandPlugin } from './commands/defs/status.js'
import { createCommandDispatchPlugin } from './commands/dispatch-plugin.js'
import type { CommandPlugin } from './commands/types.js'
import type { LifecyclePlugin } from './types.js'

export { emit, emitStreamFrame } from './emit.js'
export * from './types.js'

/**
 * 注册的 CommandPlugin 列表——dispatcher 通过闭包持有，
 * 在 onAuthenticated 阶段做前缀仲裁。
 */
const commandPlugins: readonly CommandPlugin[] = [newCommandPlugin, statusCommandPlugin]
const commandDispatch = createCommandDispatchPlugin(commandPlugins)

/**
 * 默认 plugin 列表：
 *   - `core:command-dispatch`（priority 10）做前缀仲裁
 *   - 各 CommandPlugin（priority 20）在 onBeforeRun 阶段读 ctx.matchedCommand 激活自己的副作用
 */
export function buildDefaultPlugins(): readonly LifecyclePlugin[] {
  return [commandDispatch, ...commandPlugins]
}

/** 测试 / 灰度专用：注入指定 plugin 子集。 */
export function buildPlugins(plugins: readonly LifecyclePlugin[]): readonly LifecyclePlugin[] {
  return [...plugins]
}
