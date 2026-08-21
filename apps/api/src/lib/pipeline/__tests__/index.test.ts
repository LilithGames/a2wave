/**
 * pipeline/index barrel — buildDefaultPlugins / buildPlugins coverage.
 */
import { describe, expect, it } from 'vitest'
import type { LifecyclePlugin } from '../index.js'
import * as pipeline from '../index.js'
import { buildDefaultPlugins, buildPlugins, emit, emitStreamFrame } from '../index.js'

describe('pipeline/index barrel', () => {
  it('buildDefaultPlugins returns [core:command-dispatch, cmd:new, cmd:status]', async () => {
    const plugins = buildDefaultPlugins()
    expect(plugins).toHaveLength(3)
    expect(plugins[0]?.name).toBe('core:command-dispatch')
    expect(plugins[0]?.priority).toBe(10)
    expect(plugins.slice(1).map((p) => p.name)).toEqual(['cmd:new', 'cmd:status'])
    // Dispatcher must arbitrate before any command plugin activates.
    for (const p of plugins.slice(1)) expect(p.priority).toBe(20)
  })

  it('buildPlugins returns a defensive copy of the provided list', async () => {
    const custom: LifecyclePlugin[] = [{ name: 'obs:test' }]
    const result = buildPlugins(custom)
    expect(result).toEqual(custom)
    // Defensive copy: mutating the source array does not affect the result.
    custom.push({ name: 'obs:added-later' })
    expect(result).toHaveLength(1)
  })

  it('re-exports emit and emitStreamFrame', async () => {
    expect(typeof emit).toBe('function')
    expect(typeof emitStreamFrame).toBe('function')
  })

  it('does not export global test plugin mutators', async () => {
    expect(Object.keys(pipeline)).not.toContain('_registerTestPlugin')
    expect(Object.keys(pipeline)).not.toContain('_resetTestPlugins')
  })
})
