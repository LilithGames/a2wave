import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SERIES_COLORS } from '../chart-theme'

/**
 * The token chart stacks Input on Output, so the two fills sit edge to edge. When
 * both resolved to indigo (`primary` and `interactive-foreground` are one shade
 * apart — normal-vision OKLab dE 12.3, below the 15 floor) the stack read as a
 * single band, and a 16x difference between the series was invisible.
 */
describe('SERIES_COLORS', () => {
  it('gives the two stacked token series different colors', () => {
    expect(SERIES_COLORS.tokenInput).not.toBe(SERIES_COLORS.tokenOutput)
  })

  it('draws them from the dedicated categorical pair, not from brand/status roles', () => {
    // `primary` is a brand fill (a bright lime in Neo Yellow, invisible on a light
    // plot surface) and the status roles are reserved — neither is a series color.
    for (const key of ['tokenInput', 'tokenOutput'] as const) {
      expect(SERIES_COLORS[key]).toMatch(/^var\(--color-chart-series-\d\)$/)
    }
  })
})

describe('chart series tokens', () => {
  // vitest runs with cwd at apps/web; import.meta.url is not a file: URL here.
  const css = readFileSync(resolve(process.cwd(), 'src/styles/globals.css'), 'utf-8')

  it('defines both slots in every theme block', () => {
    // One theme missing the pair would fall back to an inherited value and ship a
    // chart that is only broken under that theme — the exact bug this replaced.
    const themeBlocks = css.match(/html\[data-theme="[\w-]+"\]\s*\{/g) ?? []
    const slot1 = css.match(/--color-chart-series-1:/g) ?? []
    const slot2 = css.match(/--color-chart-series-2:/g) ?? []

    // Every named theme, plus the default :root block.
    expect(slot1).toHaveLength(themeBlocks.length + 1)
    expect(slot2).toHaveLength(slot1.length)
  })
})
