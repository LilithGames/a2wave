import { describe, expect, it, vi } from 'vitest'
import { CliError } from '../../errors.js'
import { parseFieldPaths, projectFields } from '../fields.js'
import { emit } from '../output.js'

describe('parseFieldPaths', () => {
  it('splits a comma list into dot-segmented paths', () => {
    expect(parseFieldPaths('data.id,data.name')).toEqual([
      ['data', 'id'],
      ['data', 'name'],
    ])
  })

  it('tolerates whitespace and empty entries', () => {
    expect(parseFieldPaths(' data.id , , data.name ')).toEqual([
      ['data', 'id'],
      ['data', 'name'],
    ])
  })

  it('keeps [] as an explicit array-traversal segment', () => {
    expect(parseFieldPaths('data[].id')).toEqual([['data', '[]', 'id']])
  })

  it('rejects an empty selection rather than projecting nothing', () => {
    // Silently returning `{}` would look like "the server sent nothing".
    expect(() => parseFieldPaths('')).toThrow(CliError)
    expect(() => parseFieldPaths('  ,  ')).toThrow(CliError)
  })
})

describe('projectFields', () => {
  it('keeps only the named scalar paths', () => {
    const out = projectFields({ data: { id: 'agt_1', name: 'bot', systemPrompt: 'long...' } }, [
      ['data', 'id'],
    ])
    expect(out.value).toEqual({ data: { id: 'agt_1' } })
  })

  it('maps over arrays with []', () => {
    const payload = {
      data: [
        { id: 'agt_1', name: 'a', description: 'drop me' },
        { id: 'agt_2', name: 'b', description: 'drop me' },
      ],
    }
    const out = projectFields(payload, parseFieldPaths('data[].id,data[].name'))
    expect(out.value).toEqual({
      data: [
        { id: 'agt_1', name: 'a' },
        { id: 'agt_2', name: 'b' },
      ],
    })
  })

  it('merges sibling paths into one object', () => {
    const out = projectFields({ a: { b: 1, c: 2, d: 3 } }, parseFieldPaths('a.b,a.c'))
    expect(out.value).toEqual({ a: { b: 1, c: 2 } })
  })

  it('omits a path that matches nothing and reports it', () => {
    // Erroring would be hostile: an agent composing --fields from a schema will
    // sometimes name a field that is optional and absent on this row.
    const out = projectFields({ data: { id: 'agt_1' } }, parseFieldPaths('data.id,data.nope'))
    expect(out.value).toEqual({ data: { id: 'agt_1' } })
    expect(out.unmatched).toEqual(['data.nope'])
  })

  it('reports nothing when every path matched', () => {
    const out = projectFields({ data: { id: 'x' } }, parseFieldPaths('data.id'))
    expect(out.unmatched).toEqual([])
  })

  it('preserves null and false rather than treating them as missing', () => {
    const out = projectFields({ a: { b: null, c: false } }, parseFieldPaths('a.b,a.c'))
    expect(out.value).toEqual({ a: { b: null, c: false } })
    expect(out.unmatched).toEqual([])
  })

  it('traverses an array without [] when the path continues into it', () => {
    // `data.id` on an array payload is what an agent writes by mistake; doing
    // the obvious thing beats reporting the whole selection as unmatched.
    const out = projectFields({ data: [{ id: 'a' }, { id: 'b' }] }, parseFieldPaths('data.id'))
    expect(out.value).toEqual({ data: [{ id: 'a' }, { id: 'b' }] })
  })
})

describe('emit with --fields', () => {
  /**
   * The load-bearing test of this feature.
   *
   * `redactSecrets` decides "is this a secret?" from a SIBLING key: an env
   * entry is `{value, sensitive: true}`, and the `sensitive` flag is what marks
   * `value` as needing masking (output.ts). Projecting first would strip that
   * sibling, so `--fields data.env.FOO.value` would hand the redactor a bare
   * `{value: 'sk-live'}` with no marker left and print the secret verbatim.
   *
   * Therefore: redact, THEN project. Projection can only remove fields from an
   * already-safe object, and `********` survives it unchanged.
   */
  it('redacts before projecting, so a projected path cannot leak a secret', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    emit(
      { json: true, fields: 'data.env.FOO.value' },
      { data: { env: { FOO: { value: 'sk-live-secret', sensitive: true } } } },
    )

    const out = String(spy.mock.calls.at(-1)?.[0])
    expect(out).not.toContain('sk-live-secret')
    expect(out).toContain('********')
    spy.mockRestore()
  })

  it('redacts a name-matched secret behind a projection too', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    emit({ json: true, fields: 'data.endpointApiKey' }, { data: { endpointApiKey: 'sk-live-abc' } })

    expect(String(spy.mock.calls.at(-1)?.[0])).not.toContain('sk-live-abc')
    spy.mockRestore()
  })

  it('still honours --show-secrets under a projection', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    emit(
      { json: true, fields: 'data.endpointApiKey', 'show-secrets': true },
      { data: { endpointApiKey: 'sk-live-abc' } },
    )

    expect(String(spy.mock.calls.at(-1)?.[0])).toContain('sk-live-abc')
    spy.mockRestore()
  })

  it('attaches unmatched paths under _meta so the agent can self-correct', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    emit({ json: true, fields: 'data.id,data.nope' }, { data: { id: 'agt_1' } })

    const out = JSON.parse(String(spy.mock.calls.at(-1)?.[0]))
    expect(out.data).toEqual({ id: 'agt_1' })
    expect(out._meta.unmatchedFields).toEqual(['data.nope'])
    spy.mockRestore()
  })

  it('adds no _meta when every path matched', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    emit({ json: true, fields: 'data.id' }, { data: { id: 'agt_1' } })

    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0]))._meta).toBeUndefined()
    spy.mockRestore()
  })

  it('implies --json, since projecting a human table is meaningless', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(emit({ fields: 'data.id' }, { data: { id: 'agt_1' } })).toBe(true)
    expect(JSON.parse(String(spy.mock.calls.at(-1)?.[0]))).toEqual({ data: { id: 'agt_1' } })
    spy.mockRestore()
  })

  it('cuts payload size on a realistic list', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const payload = {
      data: Array.from({ length: 20 }, (_, i) => ({
        id: `agt_${i}`,
        name: `agent-${i}`,
        description: 'An example agent used for orchestration',
        systemPrompt: 'You are a helpful assistant. '.repeat(20),
        createdAt: '2026-08-14T10:00:00.000Z',
      })),
    }

    emit({ json: true }, payload)
    const full = String(spy.mock.calls.at(-1)?.[0]).length
    emit({ json: true, fields: 'data[].id,data[].name' }, payload)
    const projected = String(spy.mock.calls.at(-1)?.[0]).length

    expect(projected).toBeLessThan(full / 5)
    spy.mockRestore()
  })
})
