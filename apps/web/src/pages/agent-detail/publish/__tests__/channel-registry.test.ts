import { describe, expect, it } from 'vitest'
import en from '@/locales/en.json'
import zh from '@/locales/zh.json'
import {
  CHANNEL_FILTERS,
  CHANNEL_REGISTRY,
  isChannelKey,
  VALID_PUBLISH_TABS,
} from '../channel-registry'

/** Resolves a dotted i18n key against a locale bundle. */
function lookup(bundle: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, part) => {
    if (node && typeof node === 'object') return (node as Record<string, unknown>)[part]
    return undefined
  }, bundle)
}

describe('channel registry', () => {
  it('covers all eleven publish channels exactly once', () => {
    expect(CHANNEL_REGISTRY).toHaveLength(11)
    expect(new Set(CHANNEL_REGISTRY.map((c) => c.key)).size).toBe(11)
    expect([...VALID_PUBLISH_TABS].sort()).toEqual(
      [
        'a2a',
        'api',
        'chat_app',
        'discord',
        'feishu',
        'gh',
        'glab',
        'oauth',
        'qq_official',
        'schedule',
        'slack',
      ].sort(),
    )
  })

  it('marks only the REST API channel as always-on', () => {
    // buildChannels() unconditionally seeds ['api'], so that card must not
    // render a switch the user could flip to a state the payload ignores.
    const alwaysOn = CHANNEL_REGISTRY.filter((c) => c.alwaysOn).map((c) => c.key)
    expect(alwaysOn).toEqual(['api'])
  })

  it('lists REST API first', () => {
    // The grid renders registry order, and the always-on baseline channel is
    // the anchor users look for first. `ChannelGrid` additionally keeps it
    // ahead of an onboarding-pinned channel.
    expect(CHANNEL_REGISTRY[0]?.key).toBe('api')
  })

  it('buckets every channel into a filter that exists', () => {
    const filterValues = new Set(CHANNEL_FILTERS.map((f) => f.value))
    for (const channel of CHANNEL_REGISTRY) {
      expect(filterValues).toContain(channel.category)
    }
    // Every non-"all" filter must match at least one card, or it renders an
    // always-empty chip.
    for (const filter of CHANNEL_FILTERS) {
      if (filter.value === 'all') continue
      expect(CHANNEL_REGISTRY.some((c) => c.category === filter.value)).toBe(true)
    }
  })

  it.each(['en', 'zh'] as const)('resolves every i18n key in %s', (locale) => {
    const bundle = (locale === 'en' ? en : zh) as unknown as Record<string, unknown>
    for (const channel of CHANNEL_REGISTRY) {
      for (const key of [channel.titleKey, channel.descKey, channel.switchLabelKey]) {
        expect(lookup(bundle, key), `${key} missing in ${locale}.json`).toEqual(expect.any(String))
      }
    }
    for (const filter of CHANNEL_FILTERS) {
      expect(lookup(bundle, filter.labelKey), `${filter.labelKey} missing`).toEqual(
        expect.any(String),
      )
    }
  })

  it('narrows unknown publishTab values', () => {
    expect(isChannelKey('feishu')).toBe(true)
    expect(isChannelKey('chat_app')).toBe(true)
    expect(isChannelKey('nope')).toBe(false)
    expect(isChannelKey(null)).toBe(false)
    expect(isChannelKey('')).toBe(false)
  })
})
