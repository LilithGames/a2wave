import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../env.js', () => ({
  env: { A2WAVE_MEMORY_STORAGE: '' },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))

import { env } from '../../env.js'
import { readMemoryFile, writeMemoryFile } from '../memory-storage.js'
import {
  applyInsightToTopics,
  archiveMemoryTopic,
  detectMemoryHierarchyMode,
  estimateMemoryTokens,
  getValidatedMemoryMain,
  hashMemoryBlock,
  listMemoryTopics,
  MEMORY_MAIN_FILE,
  MEMORY_TOPIC_HARD_TOKENS,
  MemoryTopicError,
  mergeMemoryTopics,
  parseMemoryTopicFile,
  reactivateMemoryTopic,
  readMemoryTopic,
  rebuildMemoryMain,
  renderMemoryMain,
  renderMemoryTopicFile,
  replaceTopicBody,
  selectMemoryTopicForRecall,
  splitMemoryTopic,
  topicPath,
} from '../memory-topics.js'

let testRoot: string

function insight(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Campaign mail delivery',
    scope: 'Campaign mail creation, validation, and release behavior.',
    description: 'Campaign mail contracts and release checks.',
    keywords: ['campaign', 'send_mail', 'release'],
    section: 'Durable Knowledge' as const,
    items: ['Use the V3 adapter for new mail templates.', 'Validate item_id serialization.'],
    ...overrides,
  }
}

describe('memory-topics', () => {
  beforeEach(() => {
    testRoot = join(tmpdir(), `memory-topics-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(testRoot, { recursive: true })
    ;(env as { A2WAVE_MEMORY_STORAGE: string }).A2WAVE_MEMORY_STORAGE = testRoot
  })

  afterEach(() => {
    if (existsSync(testRoot)) rmSync(testRoot, { recursive: true })
  })

  it('detects empty, legacy, and topic-v2 hierarchies', async () => {
    expect(detectMemoryHierarchyMode('agt_test')).toBe('empty')

    writeMemoryFile('agt_test', MEMORY_MAIN_FILE, '# Legacy memory\n\n- One fact')
    expect(detectMemoryHierarchyMode('agt_test')).toBe('legacy_single_file')

    rebuildMemoryMain('agt_test', '- Shared startup fact.')
    expect(detectMemoryHierarchyMode('agt_test')).toBe('topic_v2')
  })

  it('creates a bounded topic and keeps its body out of MEMORY.md', async () => {
    const result = applyInsightToTopics('agt_test', insight())

    expect(result.created).toBe(true)
    expect(result.retainedInHistory).toBe(false)
    expect(result.topic?.topicId).toMatch(/^tpc_[a-f0-9]{8}$/)
    expect(result.topic?.body).toContain('Validate item_id serialization.')

    const main = readMemoryFile('agt_test', MEMORY_MAIN_FILE)
    expect(main).toContain('## Topic Catalog')
    expect(main).toContain('Campaign mail contracts and release checks.')
    expect(main).not.toContain('Validate item_id serialization.')
  })

  it('routes a matching insight to the existing topic and preserves its stable ID', async () => {
    const created = applyInsightToTopics('agt_test', insight())
    const topicId = created.topic?.topicId

    const updated = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Mail release checks',
        items: ['Run the focused adapter tests before release.'],
      }),
    )

    expect(updated.created).toBe(false)
    expect(updated.topic?.topicId).toBe(topicId)
    expect(updated.topic?.body).toContain('Run the focused adapter tests before release.')
    expect(listMemoryTopics('agt_test').topics).toHaveLength(1)
  })

  it('does not merge a distinct concern based on one shared entity keyword', async () => {
    const freeze = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'North-Star Release Freeze',
        scope: 'Deployment scheduling rules for North-Star releases.',
        description: 'The recurring North-Star deployment freeze window.',
        keywords: ['North-Star', 'deployment', 'release', 'freeze', 'UTC'],
        items: [
          'The deployment freeze starts every Friday at 18:00 UTC.',
          'The deployment freeze ends every Monday at 06:00 UTC.',
        ],
      }),
    )

    const reviewPreference = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'North-Star Release Review Preference',
        scope: 'Preferred structure for North-Star release reviews.',
        description: 'The stable ordering used in North-Star release reviews.',
        keywords: ['North-Star', 'review', 'risk', 'rollback'],
        items: ['List risks first, then list the rollback plan.'],
      }),
    )

    expect(reviewPreference.topic).toBeNull()
    expect(reviewPreference.reason).toBe('insufficient_new_topic_content')
    expect(readMemoryTopic('agt_test', freeze.topic?.topicId as string).body).not.toContain(
      'rollback plan',
    )
    expect(listMemoryTopics('agt_test').topics).toHaveLength(1)
  })

  it('does not treat the same coarse entity scope as a topic boundary', async () => {
    const releaseFreeze = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Cedar-Ridge release freeze',
        scope: 'Cedar-Ridge',
        description: 'Recurring Cedar-Ridge deployment freeze window.',
        keywords: ['Cedar-Ridge', 'deployment', 'freeze'],
        items: [
          'The deployment freeze starts every Friday at 18:00 UTC.',
          'The deployment freeze ends every Monday at 06:00 UTC.',
        ],
      }),
    )

    const reviewOrder = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Cedar-Ridge release review order',
        scope: 'Cedar-Ridge',
        description: 'Stable structure for Cedar-Ridge release reviews.',
        keywords: ['Cedar-Ridge', 'review', 'risk', 'rollback'],
        items: ['List risks before the rollback plan.', 'End the review with the approving owner.'],
      }),
    )

    expect(reviewOrder.topic?.topicId).not.toBe(releaseFreeze.topic?.topicId)
    expect(readMemoryTopic('agt_test', releaseFreeze.topic?.topicId as string).body).not.toContain(
      'rollback plan',
    )
    expect(listMemoryTopics('agt_test').topics).toHaveLength(2)
  })

  it('selects a bounded topic from a natural-language CJK recall query', async () => {
    const architecture = applyInsightToTopics(
      'agt_test',
      insight({
        title: '架构评审报告规范',
        scope: '架构评审报告的固定格式与内容要求',
        description: '架构评审报告的长期稳定写作规范',
        keywords: ['架构评审', '报告格式', '评审范围'],
        items: ['架构评审报告必须在正文开头标注评审范围。', '正文先列结论，再列风险。'],
      }),
    )
    applyInsightToTopics(
      'agt_test',
      insight({
        title: '数据库迁移排查',
        scope: '数据库迁移失败排查',
        description: '数据库迁移的长期排查准则',
        keywords: ['数据库迁移', 'schema', 'migration'],
        items: ['先保留原始报错。', '再核对 schema 与 migration。'],
      }),
    )

    const topics = listMemoryTopics('agt_test').topics
    const selected = selectMemoryTopicForRecall(
      '架构评审报告 长期约定 固定标题 正文结构 风险 建议 结论',
      topics,
    )

    expect(selected?.topicId).toBe(architecture.topic?.topicId)
    expect(selectMemoryTopicForRecall('完全无关的采购审批流程', topics)).toBeNull()
  })

  it('does not append a semantically equivalent fact to a matching topic', async () => {
    applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Architecture review conventions',
        scope: 'Architecture review report conventions.',
        description: 'Stable architecture review conventions.',
        keywords: ['architecture', 'review', 'report'],
        items: [
          '架构评审报告标题统一使用“Architecture Review · <module>”。',
          '发布前运行聚焦测试。',
        ],
      }),
    )

    const updated = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Architecture review conventions',
        scope: 'Architecture review report conventions.',
        description: 'Stable architecture review conventions.',
        keywords: ['architecture', 'review', 'report'],
        items: ['架构评审报告标题固定使用 `Architecture Review · <module>` 样式。'],
      }),
    )

    expect(updated.topic?.body.match(/Architecture Review · <module>/g)).toHaveLength(1)
  })

  it('deduplicates equivalent Chinese end-of-report requirements with reordered modifiers', async () => {
    const created = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Regression report requirements',
        scope: 'FIXLOOP regression report requirements.',
        description: 'Stable FIXLOOP regression report requirements.',
        keywords: ['FIXLOOP', 'report', 'validation'],
        items: [
          '所有 FIXLOOP-MEM-0729 回归报告必须在结尾写校验码 FL729。',
          'FIXLOOP-MEM-0729 回归报告必须包含执行摘要。',
        ],
      }),
    )

    const updated = applyInsightToTopics(
      'agt_test',
      insight({
        topicId: created.topic?.topicId,
        title: 'Regression report requirements',
        scope: 'FIXLOOP regression report requirements.',
        description: 'Stable FIXLOOP regression report requirements.',
        keywords: ['FIXLOOP', 'report', 'validation'],
        items: ['FIXLOOP-MEM-0729 回归报告结尾必须包含校验码 FL729。'],
      }),
    )

    expect(updated.topic?.body.match(/校验码 FL729/g)).toHaveLength(1)
  })

  it('deduplicates equivalent English cadence facts with synonymous units and nouns', async () => {
    const created = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Indigo-Falcon API Key Rotation Policy',
        scope: 'Indigo-Falcon API credential lifecycle requirements.',
        description: 'API key rotation and warning requirements.',
        keywords: ['Indigo-Falcon', 'API keys', 'rotation'],
        items: [
          'Indigo-Falcon API keys rotate every 45 days and require a seven-day warning.',
          'Rotation exceptions require security approval.',
        ],
      }),
    )

    const updated = applyInsightToTopics(
      'agt_test',
      insight({
        topicId: created.topic?.topicId,
        title: 'Indigo-Falcon API Key Rotation Policy',
        scope: 'Indigo-Falcon credential operations.',
        description: 'Credential rotation cadence and operator alerting requirement.',
        keywords: ['Indigo-Falcon', 'credentials', 'rotation'],
        items: [
          'Indigo-Falcon credentials follow a 45-day rotation cadence, with operators alerted one week in advance.',
        ],
      }),
    )

    expect(
      updated.topic?.body.split('\n').filter((line) => /^- Indigo-Falcon/.test(line)),
    ).toHaveLength(1)

    const changedValue = applyInsightToTopics(
      'agt_test',
      insight({
        topicId: created.topic?.topicId,
        title: 'Indigo-Falcon API Key Rotation Policy',
        scope: 'Indigo-Falcon credential operations.',
        description: 'Credential rotation cadence and operator alerting requirement.',
        keywords: ['Indigo-Falcon', 'credentials', 'rotation'],
        items: ['Indigo-Falcon API credentials rotate every 90 days with a seven-day warning.'],
      }),
    )
    expect(
      changedValue.topic?.body.split('\n').filter((line) => /^- Indigo-Falcon/.test(line)),
    ).toHaveLength(2)
  })

  it('keeps facts with different values separate during conservative deduplication', async () => {
    applyInsightToTopics('agt_test', insight())

    const updated = applyInsightToTopics(
      'agt_test',
      insight({
        items: [
          'Architecture review titles use `Architecture Review · <module>`.',
          'Architecture review titles use `Architecture Review · <service>`.',
        ],
      }),
    )

    expect(updated.topic?.body).toContain('Architecture Review · <module>')
    expect(updated.topic?.body).toContain('Architecture Review · <service>')
  })

  it('keeps directional English facts separate during conservative deduplication', async () => {
    const created = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Service call direction',
        scope: 'Stable service-to-service call relationships.',
        description: 'Service call direction contracts.',
        keywords: ['service-x', 'service-y', 'calls'],
        items: ['Service X calls Service Y.', 'Call failures are retried once.'],
      }),
    )

    const updated = applyInsightToTopics(
      'agt_test',
      insight({
        topicId: created.topic?.topicId,
        title: 'Service call direction',
        scope: 'Stable service-to-service call relationships.',
        description: 'Service call direction contracts.',
        keywords: ['service-x', 'service-y', 'calls'],
        items: ['Service Y calls Service X.'],
      }),
    )

    expect(updated.topic?.body).toContain('Service X calls Service Y.')
    expect(updated.topic?.body).toContain('Service Y calls Service X.')
  })

  it('keeps opposite ordering requirements separate during conservative deduplication', async () => {
    const created = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Release review ordering',
        scope: 'Release review output ordering.',
        description: 'Stable release review output order.',
        keywords: ['release', 'review', 'ordering'],
        items: [
          'List risks first, then list the rollback plan.',
          'End the release review with the approving owner.',
        ],
      }),
    )

    const updated = applyInsightToTopics(
      'agt_test',
      insight({
        topicId: created.topic?.topicId,
        title: 'Release review ordering',
        scope: 'Release review output ordering.',
        description: 'Stable release review output order.',
        keywords: ['release', 'review', 'ordering'],
        items: ['List the rollback plan first, then list risks.'],
      }),
    )

    expect(updated.topic?.body).toContain('List risks first, then list the rollback plan.')
    expect(updated.topic?.body).toContain('List the rollback plan first, then list risks.')
  })

  it('collapses pre-existing equivalent facts when the topic is next updated', async () => {
    const created = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Architecture review conventions',
        scope: 'Architecture review report conventions.',
        description: 'Stable architecture review conventions.',
        keywords: ['architecture', 'review', 'report'],
      }),
    )
    const topicId = created.topic?.topicId as string
    replaceTopicBody(
      'agt_test',
      topicId,
      `# Architecture review conventions

## Decisions and Conventions

- 架构评审报告标题统一使用“Architecture Review · <module>”。
- 架构评审报告标题固定使用 \`Architecture Review · <module>\` 样式。`,
    )

    const updated = applyInsightToTopics(
      'agt_test',
      insight({
        topicId,
        title: 'Architecture review conventions',
        scope: 'Architecture review report conventions.',
        description: 'Stable architecture review conventions.',
        keywords: ['architecture', 'review', 'report'],
        items: ['发布前运行架构检查。'],
      }),
    )

    expect(updated.topic?.body.match(/Architecture Review · <module>/g)).toHaveLength(1)
  })

  it('rejects an explicit unknown topic ID instead of silently creating a new topic', async () => {
    expect(() =>
      applyInsightToTopics(
        'agt_test',
        insight({ topicId: 'tpc_ffffffff', items: ['A single explicit update.'] }),
        { allowSingleNewTopicItem: true },
      ),
    ).toThrowError(expect.objectContaining({ code: 'TOPIC_NOT_FOUND' }))
  })

  it('keeps a one-item unmatched automatic insight in history instead of creating a weak topic', async () => {
    const result = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Cashier recovery',
        scope: 'First-purchase recovery routing.',
        description: 'Cashier recovery routing.',
        keywords: ['cashier', 'recovery'],
        items: ['DND wins over request preference.'],
      }),
    )

    expect(result.topic).toBeNull()
    expect(result.reason).toBe('insufficient_new_topic_content')
    expect(result.retainedInHistory).toBe(true)
    expect(detectMemoryHierarchyMode('agt_test')).toBe('empty')
  })

  it('allows an explicit high-value item to create a topic', async () => {
    const result = applyInsightToTopics(
      'agt_test',
      insight({ items: ['Always preserve the V3 compatibility boundary.'] }),
      { allowSingleNewTopicItem: true },
    )

    expect(result.created).toBe(true)
    expect(result.topic?.body).toContain('Always preserve the V3 compatibility boundary.')
  })

  it('refuses a topic write over the hard limit without changing the topic', async () => {
    const created = applyInsightToTopics('agt_test', insight())
    const topicId = created.topic?.topicId as string
    const original = readMemoryTopic('agt_test', topicId).body
    const oversized = `# Campaign mail delivery\n\n## Durable Knowledge\n\n- ${'知识'.repeat(
      MEMORY_TOPIC_HARD_TOKENS + 20,
    )}`

    const result = replaceTopicBody('agt_test', topicId, oversized)

    expect(result.reason).toBe('topic_hard_limit')
    expect(result.retainedInHistory).toBe(true)
    expect(readMemoryTopic('agt_test', topicId).body).toBe(original)
  })

  it('archives and reactivates a topic while refreshing the catalog', async () => {
    const created = applyInsightToTopics('agt_test', insight())
    const topicId = created.topic?.topicId as string

    const archived = archiveMemoryTopic('agt_test', topicId)
    expect(archived.status).toBe('archived')
    expect(listMemoryTopics('agt_test', 'active').topics).toHaveLength(0)
    expect(readMemoryFile('agt_test', MEMORY_MAIN_FILE)).not.toContain(`\`${topicId}\``)

    const reactivated = reactivateMemoryTopic('agt_test', topicId)
    expect(reactivated.status).toBe('active')
    expect(readMemoryFile('agt_test', MEMORY_MAIN_FILE)).toContain(`\`${topicId}\``)
  })

  it('restores the merge target when archiving a source fails midway', async () => {
    // Distinct scopes/keywords so each insight opens its own topic instead of
    // being merged into the previous one; two items each clears the
    // "insufficient_new_topic_content" guard on new-topic creation.
    const target = applyInsightToTopics('agt_test', insight())
    const sourceA = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Billing invoices',
        scope: 'Billing invoice lifecycle.',
        description: 'Invoice rules.',
        keywords: ['billing', 'invoice'],
        items: ['Invoices settle nightly.', 'Refunds post next day.'],
      }),
    )
    const sourceB = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Render pipeline',
        scope: 'GPU render pipeline stages.',
        description: 'Render rules.',
        keywords: ['render', 'gpu'],
        items: ['Shaders compile at boot.', 'Frame budget is 16ms.'],
      }),
    )
    const targetTopicId = target.topic?.topicId as string
    const sourceAId = sourceA.topic?.topicId as string
    const sourceBId = sourceB.topic?.topicId as string
    expect(targetTopicId && sourceAId && sourceBId).toBeTruthy()

    const targetBefore = readMemoryTopic('agt_test', targetTopicId).body
    const mainBefore = readMemoryFile('agt_test', MEMORY_MAIN_FILE)

    // mergeMemoryTopics reads every source up front, writes the target, then
    // archives the sources in a loop. Occupy source B's archive destination
    // with a *directory*, so its archive write throws EISDIR after source A
    // already archived cleanly — the same shape as a mid-loop ENOSPC/EIO.
    const sourceBArchivePath = topicPath({
      topicId: sourceBId,
      title: 'Render pipeline',
      status: 'archived',
    })
    mkdirSync(join(testRoot, 'agt_test', sourceBArchivePath), { recursive: true })

    expect(() => mergeMemoryTopics('agt_test', [sourceAId, sourceBId], targetTopicId)).toThrow()

    // The target must not be left holding merged content while a source is
    // still active — that duplicates facts and makes the retry unrecoverable.
    expect(readMemoryTopic('agt_test', targetTopicId).body).toBe(targetBefore)
    expect(readMemoryTopic('agt_test', sourceAId).status).toBe('active')
    expect(readMemoryTopic('agt_test', sourceBId).status).toBe('active')
    expect(readMemoryFile('agt_test', MEMORY_MAIN_FILE)).toBe(mainBefore)
  })

  it('splits a topic only when every source block is copied verbatim exactly once', async () => {
    const created = applyInsightToTopics('agt_test', insight())
    const sourceTopicId = created.topic?.topicId as string
    const first = '- Use the V3 adapter for new mail templates.'
    const second = '- Validate item_id serialization.'

    const replacements = splitMemoryTopic('agt_test', sourceTopicId, [
      {
        title: 'Mail adapter contract',
        scope: 'Adapter selection for campaign mail templates.',
        description: 'Stable campaign mail adapter contract.',
        keywords: ['campaign', 'adapter'],
        sections: [
          {
            section: 'Durable Knowledge',
            items: [{ sourceHash: hashMemoryBlock(first), content: first }],
          },
        ],
      },
      {
        title: 'Mail serialization checks',
        scope: 'Serialization validation for campaign mail release.',
        description: 'Campaign mail serialization checks.',
        keywords: ['campaign', 'serialization'],
        sections: [
          {
            section: 'Durable Knowledge',
            items: [{ sourceHash: hashMemoryBlock(second), content: second }],
          },
        ],
      },
    ])

    expect(replacements).toHaveLength(2)
    expect(listMemoryTopics('agt_test', 'active').topics).toHaveLength(2)
    expect(
      listMemoryTopics('agt_test', 'archived').topics.some(
        (topic) => topic.topicId === sourceTopicId,
      ),
    ).toBe(true)
    expect(replacements[0].body).toContain(first)
    expect(replacements[1].body).toContain(second)
  })

  it('leaves the source active when a split omits a source block', async () => {
    const created = applyInsightToTopics('agt_test', insight())
    const sourceTopicId = created.topic?.topicId as string
    const first = '- Use the V3 adapter for new mail templates.'

    expect(() =>
      splitMemoryTopic('agt_test', sourceTopicId, [
        {
          title: 'Mail adapter contract',
          scope: 'Adapter selection for campaign mail templates.',
          description: 'Stable campaign mail adapter contract.',
          keywords: ['campaign', 'adapter'],
          sections: [
            {
              section: 'Durable Knowledge',
              items: [{ sourceHash: hashMemoryBlock(first), content: first }],
            },
          ],
        },
        {
          title: 'Empty replacement',
          scope: 'Required second replacement for invalid coverage.',
          description: 'Intentionally invalid replacement.',
          keywords: ['invalid'],
          sections: [],
        },
      ]),
    ).toThrowError(expect.objectContaining({ code: 'TOPIC_SPLIT_COVERAGE_FAILED' }))
    expect(readMemoryTopic('agt_test', sourceTopicId).status).toBe('active')
  })

  it('rolls back every replacement when a split cannot fit the active-topic limit', async () => {
    const items = Array.from({ length: 17 }, (_, index) => `- Durable split fact ${index + 1}.`)
    const created = applyInsightToTopics(
      'agt_test',
      insight({
        title: 'Oversized split source',
        scope: 'A source topic whose explicit split exceeds the active-topic limit.',
        description: 'Coverage fixture for split rollback.',
        keywords: ['split', 'rollback'],
        items,
      }),
    )
    const sourceTopicId = created.topic?.topicId as string
    const replacements = items.map((content, index) => ({
      title: `Replacement ${index + 1}`,
      scope: `Replacement scope ${index + 1}.`,
      description: `Replacement topic ${index + 1}.`,
      keywords: ['split', `replacement-${index + 1}`],
      sections: [
        {
          section: 'Durable Knowledge' as const,
          items: [{ sourceHash: hashMemoryBlock(content), content }],
        },
      ],
    }))

    expect(() => splitMemoryTopic('agt_test', sourceTopicId, replacements)).toThrowError(
      expect.objectContaining({ code: 'ACTIVE_TOPIC_LIMIT' }),
    )

    expect(readMemoryTopic('agt_test', sourceTopicId).status).toBe('active')
    expect(listMemoryTopics('agt_test', 'active').topics).toHaveLength(1)
    expect(listMemoryTopics('agt_test', 'archived').topics).toHaveLength(0)
  })

  it('bounds evidence pointers to the newest twenty entries', async () => {
    const result = applyInsightToTopics(
      'agt_test',
      insight({
        section: 'Evidence Pointers',
        items: Array.from({ length: 25 }, (_, index) => `Run evidence ${index + 1}`),
      }),
    )

    expect(result.topic?.body).not.toContain('- Run evidence 1\n')
    expect(result.topic?.body).toContain('- Run evidence 6')
    expect(result.topic?.body).toContain('- Run evidence 25')
    expect(result.topic?.body.match(/^- Run evidence/gm)).toHaveLength(20)
  })

  it('rebuilds a tampered startup catalog before runtime injection', async () => {
    const created = applyInsightToTopics('agt_test', insight())
    const original = readMemoryFile('agt_test', MEMORY_MAIN_FILE)
    writeMemoryFile(
      'agt_test',
      MEMORY_MAIN_FILE,
      original.replace('Campaign mail contracts and release checks.', 'Injected topic body'),
    )

    const validated = getValidatedMemoryMain('agt_test')
    expect(validated).toContain('Campaign mail contracts and release checks.')
    expect(validated).not.toContain('Injected topic body')
    expect(validated).not.toContain(created.topic?.body ?? 'unreachable')
  })

  it('validates server-owned topic frontmatter against its path', async () => {
    const content = renderMemoryTopicFile(
      {
        topicId: 'tpc_a1b2c3d4',
        title: 'Release workflow',
        scope: 'Release workflow for a2wave.',
        description: 'Release preparation and validation.',
        keywords: ['release', 'validation'],
        status: 'active',
        updatedAt: '2026-07-29T00:00:00.000Z',
      },
      '# Release workflow\n\n## Workflows\n\n- Run all gates.',
    )

    expect(() =>
      parseMemoryTopicFile('memory/topics/tpc_ffffffff-release-workflow.md', content),
    ).toThrowError(MemoryTopicError)
  })

  it('rejects invalid and traversal-like topic IDs before resolving a path', async () => {
    for (const topicId of ['../../etc/passwd', 'tpc_a1b2c3d4/other', 'tpc_NOTHEX']) {
      expect(() => readMemoryTopic('agt_test', topicId)).toThrowError(
        expect.objectContaining({ code: 'INVALID_TOPIC_ID' }),
      )
    }
  })

  it('rejects an over-budget main summary instead of semantically rewriting it', async () => {
    const oversized = '摘要'.repeat(600)
    expect(estimateMemoryTokens(oversized)).toBeGreaterThan(500)
    expect(() => renderMemoryMain(oversized, [])).toThrowError(
      expect.objectContaining({ code: 'MEMORY_SUMMARY_LIMIT' }),
    )
  })
})
