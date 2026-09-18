#!/usr/bin/env node

import { createInterface } from 'node:readline'

const args = process.argv.slice(2)

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function fail(message) {
  console.error(`[fake-codex] ${message}`)
  console.error(`[fake-codex] argv: ${JSON.stringify(args)}`)
  process.exit(64)
}

function promptFromArgs() {
  if (args[0] !== 'exec') fail('expected argv to start with exec')
  if (!args.includes('--json')) fail('expected --json')
  if (!args.includes('--skip-git-repo-check')) fail('expected --skip-git-repo-check')
  const prompt = args.at(-1)
  if (!prompt || prompt.startsWith('-')) fail('expected prompt as final argv')
  return prompt
}

function decodeXml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function topicizationOutput(prompt) {
  const start = prompt.lastIndexOf('<user_query>')
  const end = prompt.indexOf('</user_query>', start)
  if (start === -1 || end === -1) fail('topicization prompt has no user_query')
  const source = JSON.parse(decodeXml(prompt.slice(start + '<user_query>'.length, end)).trim())
  const grouped = new Map()
  for (const block of source.blocks ?? []) {
    const title = block.sectionHint || 'Legacy Memory'
    const values = grouped.get(title) ?? []
    values.push(block)
    grouped.set(title, values)
  }
  return JSON.stringify({
    summary: [],
    topics: [...grouped.entries()].map(([title, blocks], index) => ({
      title,
      scope: `Stable reuse scope for ${title}.`,
      description: `Migrated legacy memory group ${index + 1}.`,
      keywords: ['legacy', `group-${index + 1}`],
      sections: [
        {
          section: 'Durable Knowledge',
          items: blocks.map((block) => ({
            sourceHash: block.hash,
            content: block.content,
          })),
        },
      ],
    })),
  })
}

function memoryMaintenanceOutput(prompt) {
  const insight = JSON.stringify({
    topics: [
      {
        title: 'E2E memory delivery',
        scope: 'Stable end-to-end memory delivery and validation behavior.',
        description: 'End-to-end memory routing and validation knowledge.',
        keywords: ['e2e-memory', 'routing', 'validation'],
        section: 'Workflows',
        items: ['E2E durable topic detail alpha.', 'E2E durable topic detail beta.'],
      },
    ],
    summary: [],
  })
  return prompt.includes('---INSIGHTS---')
    ? `## E2E memory worklog\n\n- Completed the deterministic memory chain.\n\n---INSIGHTS---\n${insight}`
    : insight
}

if (args[0] === 'app-server') {
  for await (const input of createInterface({ input: process.stdin })) {
    const request = JSON.parse(input)
    if (request.method === 'initialize') {
      line({ id: request.id, result: { userAgent: 'fake-codex' } })
    } else if (request.method === 'account/read') {
      line({ id: request.id, result: { account: { type: 'chatgpt' } } })
    } else if (request.method === 'account/rateLimits/read') {
      line({
        id: request.id,
        result: {
          rateLimits: {
            primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1800000000 },
            secondary: null,
          },
        },
      })
    } else if (request.id != null) {
      line({ id: request.id, error: { code: -32601, message: 'Method not found' } })
    }
  }
  process.exit(0)
}

const prompt = promptFromArgs()
const threadId = args[1] === 'resume' ? args[2] : `codex_e2e_${Date.now()}`
const invalidModel =
  args.includes('--model') && args[args.indexOf('--model') + 1] === '__a2wave_e2e_invalid_model__'
if (prompt.includes('fail-provider') || invalidModel) {
  line({ type: 'thread.started', thread_id: threadId })
  line({ type: 'turn.started' })
  line({ type: 'turn.failed', error: { message: 'E2E provider failure' } })
  process.exit(1)
}

const text = prompt.includes('a2wave-memory-v2-topicization')
  ? topicizationOutput(prompt)
  : prompt.includes('---INSIGHTS---') || prompt.includes('稳定复用范围')
    ? memoryMaintenanceOutput(prompt)
    : prompt.trim().startsWith('/compact')
      ? 'Codex compact native summary from fake provider'
      : `Codex native reply:${prompt}`

line({ type: 'thread.started', thread_id: threadId })
line({ type: 'turn.started' })
line({ type: 'item.completed', item: { id: 'item_msg_1', type: 'agent_message', text } })
line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
