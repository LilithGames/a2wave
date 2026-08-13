import { describe, expect, it } from 'vitest'
import { resolveProcessInstanceId } from '../process-instance.js'

describe('resolveProcessInstanceId', () => {
  it('uses a trimmed operator identity when configured', () => {
    expect(resolveProcessInstanceId(' replica-a ', 'generated-host')).toBe('replica-a')
  })

  it('falls back to the container or pod hostname', () => {
    expect(resolveProcessInstanceId('  ', 'generated-host')).toBe('generated-host')
  })
})
