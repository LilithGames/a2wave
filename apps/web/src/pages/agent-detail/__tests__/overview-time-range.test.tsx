import { renderWithProviders, screen } from '@/test/render'
import { fireEvent } from '@testing-library/react'
import dayjs from 'dayjs'
import { describe, expect, it, vi } from 'vitest'
import {
  OverviewTimeRange,
  type RangePreset,
  rangeFromDates,
  resolvePreset,
} from '../overview-time-range'

/** Days spanned by an inclusive YYYY-MM-DD range. */
function spanDays(from: string, to: string) {
  return dayjs(to).diff(dayjs(from), 'day') + 1
}

describe('resolvePreset', () => {
  it('spans exactly seven buckets for the 7-day preset', () => {
    // Inclusive of today, so the start is six days back — using seven would
    // silently render an eight-column chart.
    const r = resolvePreset('7d')
    expect(spanDays(r.from, r.to)).toBe(7)
    expect(r.bucket).toBe('day')
  })

  it('spans exactly thirty and ninety buckets for the longer presets', () => {
    expect(spanDays(resolvePreset('30d').from, resolvePreset('30d').to)).toBe(30)
    expect(spanDays(resolvePreset('90d').from, resolvePreset('90d').to)).toBe(90)
  })

  it('uses hourly granularity for today so a single day is still legible', () => {
    const r = resolvePreset('today')
    expect(spanDays(r.from, r.to)).toBe(1)
    expect(r.bucket).toBe('hour')
  })
})

describe('rangeFromDates', () => {
  it('keeps hourly granularity for a short custom span', () => {
    const from = dayjs('2026-07-01')
    expect(rangeFromDates(from, from).bucket).toBe('hour')
    expect(rangeFromDates(from, from.add(1, 'day')).bucket).toBe('hour')
  })

  it('falls back to daily granularity once the span grows', () => {
    const from = dayjs('2026-07-01')
    expect(rangeFromDates(from, from.add(2, 'day')).bucket).toBe('day')
    expect(rangeFromDates(from, from.add(45, 'day')).bucket).toBe('day')
  })
})

describe('<OverviewTimeRange />', () => {
  function setup(preset: RangePreset = '7d') {
    const onPresetChange = vi.fn()
    const onRangeChange = vi.fn()
    renderWithProviders(
      <OverviewTimeRange
        preset={preset}
        range={resolvePreset('7d')}
        onPresetChange={onPresetChange}
        onRangeChange={onRangeChange}
      />,
    )
    return { onPresetChange, onRangeChange }
  }

  // The test i18n instance is pinned to zh (see src/i18n.ts).
  const LABEL = {
    today: '今天',
    '7d': '近 7 天',
    '30d': '近 30 天',
    '90d': '近 90 天',
    custom: '自定义',
  } as const

  it('renders every preset control', () => {
    setup()
    for (const label of Object.values(LABEL)) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('marks the active preset as pressed', () => {
    setup('30d')
    expect(screen.getByRole('button', { name: LABEL['30d'] })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: LABEL.today })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('reports the chosen preset upward', () => {
    const { onPresetChange } = setup()
    fireEvent.click(screen.getByRole('button', { name: LABEL['30d'] }))
    expect(onPresetChange).toHaveBeenCalledWith('30d')
  })

  it('shows the date picker only for the custom preset', () => {
    const { container } = renderWithProviders(
      <OverviewTimeRange
        preset="7d"
        range={resolvePreset('7d')}
        onPresetChange={vi.fn()}
        onRangeChange={vi.fn()}
      />,
    )
    expect(container.querySelector('.ant-picker')).toBeNull()

    const custom = renderWithProviders(
      <OverviewTimeRange
        preset="custom"
        range={resolvePreset('7d')}
        onPresetChange={vi.fn()}
        onRangeChange={vi.fn()}
      />,
    )
    expect(custom.container.querySelector('.ant-picker')).not.toBeNull()
  })
})
