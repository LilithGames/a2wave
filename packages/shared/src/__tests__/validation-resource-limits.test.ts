import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { updateAgentInput } from '../schemas/agent.js'
import { updateEvaluationCaseInput, updateEvaluationSetInput } from '../schemas/evaluation.js'
import { createKbDocumentInput } from '../schemas/kb-document.js'
import { updateMcpServerInput } from '../schemas/mcp-server.js'
import { updateSkillInput } from '../schemas/skill.js'
import { updateSkillGroupInput } from '../schemas/skill-group.js'

describe('bounded collection validation', () => {
  it.each(['max', 'length'] as const)(
    'rejects an oversized array at its %s bound before parsing elements',
    (bound) => {
      const inspectElement = vi.fn(() => true)
      const schema = z.array(z.string().refine(inspectElement))[bound](2)

      const result = schema.safeParse(['a', 'b', 'c'])

      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.issues).toMatchObject([{ code: 'too_big' }])
      expect(inspectElement).not.toHaveBeenCalled()
    },
  )

  it('still validates every element of an array within its size bound', () => {
    const inspectElement = vi.fn(() => true)
    const schema = z.array(z.string().refine(inspectElement)).max(2)

    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b'])
    expect(inspectElement).toHaveBeenCalledTimes(2)
  })
})

describe('partial-update compatibility', () => {
  it.each([
    ['agent', updateAgentInput],
    ['MCP server', updateMcpServerInput],
    ['skill', updateSkillInput],
    ['skill group', updateSkillGroupInput],
    ['evaluation set', updateEvaluationSetInput],
    ['evaluation case', updateEvaluationCaseInput],
  ] as const)('does not populate omitted %s fields with create defaults', (_name, schema) => {
    expect(schema.parse({})).toEqual({})
  })

  it('preserves explicitly supplied update values without adding unrelated defaults', () => {
    expect(updateAgentInput.parse({ name: 'renamed' })).toEqual({ name: 'renamed' })
    expect(updateMcpServerInput.parse({ type: 'http' })).toEqual({ type: 'http' })
    expect(updateSkillInput.parse({ visibility: 'all-users' })).toEqual({ visibility: 'all-users' })
  })

  it('keeps omitted knowledge-base sync options absent for route-owned defaults', () => {
    expect(createKbDocumentInput.parse({ sourceType: 'upload' })).toEqual({ sourceType: 'upload' })
  })
})
