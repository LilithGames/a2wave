import { describe, expect, it } from 'vitest'
import { slugify } from '../slug.js'

describe('slugify', () => {
  it('converts ASCII name to lowercase slug', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('replaces multiple special characters with single hyphen', () => {
    expect(slugify('foo---bar')).toBe('foo-bar')
    expect(slugify('a @ b # c')).toBe('a-b-c')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  hello  ')).toBe('hello')
    expect(slugify('---hello---')).toBe('hello')
  })

  it('handles alphanumeric names', () => {
    expect(slugify('agent42')).toBe('agent42')
  })

  it('preserves CJK characters', () => {
    expect(slugify('代码审查')).toBe('代码审查')
  })

  it('handles mixed CJK and ASCII', () => {
    expect(slugify('Code 审查 Agent')).toBe('code-审查-agent')
  })

  // Regression: the web workspace-path preview used a plain [^a-z0-9] regex, which
  // stripped CJK and rendered `mr-<id>` while the API actually created
  // `mr-自动评审-<id>`. Both sides now share this implementation.
  it('preserves CJK so the workspace path preview matches the real directory', () => {
    expect(slugify('MR 自动评审')).toBe('mr-自动评审')
  })

  it('preserves Japanese kana', () => {
    expect(slugify('テスト')).toBe('テスト')
  })

  it('preserves Korean hangul', () => {
    expect(slugify('에이전트')).toBe('에이전트')
  })

  it('falls back to hex hash for pure symbols', () => {
    expect(slugify('!@#$%')).toMatch(/^id-[0-9a-f]+$/)
  })

  it('falls back to hex hash for empty string', () => {
    expect(slugify('')).toMatch(/^id-[0-9a-f]+$/)
  })

  it('produces deterministic fallback hash', () => {
    expect(slugify('!!!')).toBe(slugify('!!!'))
  })

  it('handles single character', () => {
    expect(slugify('a')).toBe('a')
  })

  it('handles already slugified input', () => {
    expect(slugify('my-agent-42')).toBe('my-agent-42')
  })
})
