import { describe, expect, it } from 'vitest'
import { CliError } from '../../errors.js'
import { guideSection, guideSections } from '../guide.js'

const markdown = `# Title

Preamble that belongs to no section.

## The loop

Step one.

## Names, IDs, and the hidden fetch

Resolve once.
`

describe('guideSections', () => {
  it('splits on ## headings and slugs the titles', () => {
    expect(guideSections(markdown).map((s) => s.topic)).toEqual([
      'the-loop',
      'names-ids-and-the-hidden-fetch',
    ])
  })

  it('keeps the heading in each body, so a section reads standalone', () => {
    // `docs <topic>` prints the body verbatim. Without its own heading the
    // output starts mid-thought and a caller cannot tell what it asked for.
    expect(guideSections(markdown)[0].body).toContain('## The loop')
  })

  it('drops the preamble, which belongs to no topic', () => {
    expect(guideSections(markdown).some((s) => s.body.includes('Preamble'))).toBe(false)
  })
})

describe('guideSection', () => {
  it('returns the requested section', () => {
    expect(guideSection('the-loop', markdown).title).toBe('The loop')
  })

  it('lists the real topics when the slug is wrong', () => {
    // An agent guesses a slug from the heading it remembers; the recovery it
    // needs is the actual list, not "not found".
    const err = (() => {
      try {
        guideSection('loop', markdown)
      } catch (e) {
        return e
      }
    })()
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).message).toContain('the-loop')
    expect((err as CliError).type).toBe('validation')
  })
})
