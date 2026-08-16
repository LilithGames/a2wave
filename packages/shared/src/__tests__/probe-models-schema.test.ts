import { describe, expect, it } from 'vitest'
import { reasoningEffortValueSchema } from '../schemas/agent.js'
import { modelCapabilitiesSchema, probeModelsResponseSchema } from '../schemas/probe-models.js'

describe('reasoning effort value', () => {
  it('accepts the level tokens the CLIs actually advertise', () => {
    for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
      expect(reasoningEffortValueSchema.safeParse(value).success).toBe(true)
    }
  })

  it.each([
    ['an empty string', ''],
    ['a leading dash that would read as another CLI flag', '-high'],
    ['whitespace that would split into a second argv entry', 'high max'],
    ['a shell metacharacter', 'high; rm -rf /'],
    ['an uppercase token no CLI advertises', 'HIGH'],
    ['a value past the length cap', 'x'.repeat(33)],
  ])('rejects %s', (_label, value) => {
    expect(reasoningEffortValueSchema.safeParse(value).success).toBe(false)
  })
})

describe('model capabilities', () => {
  it('carries the levels and default reported for one model', () => {
    const parsed = modelCapabilitiesSchema.parse({
      reasoningEfforts: [
        { value: 'low', description: 'Fast responses with lighter reasoning' },
        { value: 'high' },
      ],
      defaultReasoningEffort: 'low',
    })

    expect(parsed.reasoningEfforts?.map((option) => option.value)).toEqual(['low', 'high'])
    expect(parsed.defaultReasoningEffort).toBe('low')
  })

  it('stays valid when discovery reported no reasoning metadata at all', () => {
    expect(modelCapabilitiesSchema.parse({})).toEqual({})
  })

  it('rejects a level token that could not have come from discovery', () => {
    expect(
      modelCapabilitiesSchema.safeParse({ reasoningEfforts: [{ value: '--dangerous' }] }).success,
    ).toBe(false)
  })
})

describe('probe models response', () => {
  it('keeps the model id list as the primary payload', () => {
    const parsed = probeModelsResponseSchema.parse({ models: ['gpt-5.6-sol'] })

    expect(parsed.models).toEqual(['gpt-5.6-sol'])
    expect(parsed.modelCapabilities).toBeUndefined()
  })

  it('keys capabilities by model id so the form can follow the model select', () => {
    const parsed = probeModelsResponseSchema.parse({
      models: ['claude-opus-4-8', 'claude-haiku-4-5'],
      modelCapabilities: {
        'claude-opus-4-8': { reasoningEfforts: [{ value: 'xhigh' }] },
        // Discovery said this model supports no effort at all — an empty list is
        // a real answer and must survive parsing distinct from "unknown".
        'claude-haiku-4-5': { reasoningEfforts: [] },
      },
    })

    expect(parsed.modelCapabilities?.['claude-opus-4-8']?.reasoningEfforts).toEqual([
      { value: 'xhigh' },
    ])
    expect(parsed.modelCapabilities?.['claude-haiku-4-5']?.reasoningEfforts).toEqual([])
  })

  it('still parses a failure envelope, which carries no capabilities', () => {
    const parsed = probeModelsResponseSchema.parse({
      models: [],
      error: 'HTTP 401',
      code: 'http_error',
    })

    expect(parsed.modelCapabilities).toBeUndefined()
  })
})
