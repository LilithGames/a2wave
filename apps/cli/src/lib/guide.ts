/**
 * The agent guide shipped inside the binary and surfaced by `a2wave docs`.
 *
 * Deliberately NOT AGENTS.md. Half of that file is contributor-facing —
 * directory layout, release flow, which gate script to run — and none of it
 * helps a caller decide what to invoke. What an agent needs is the loop, the
 * output contract, the risk vocabulary, how names resolve, how pagination
 * works, and a command map with NEGATIVE routing: "this command is not the one
 * for that job, here is the one that is". Negative routing prevents more agent
 * errors than positive description, because the failure mode is reaching for a
 * plausible-sounding neighbour, not failing to find anything at all.
 *
 * The command map's leaf list is generated from the citty tree at build time by
 * scripts/gen-guide.mjs, and a gate test asserts the two still agree — so the
 * map cannot describe a CLI that no longer exists.
 */
import { CliError } from '../errors.js'
import { AGENT_GUIDE } from '../generated/agent-guide.js'

export { AGENT_GUIDE }

export interface GuideSection {
  /** Slug used as the `docs <topic>` argument. */
  topic: string
  title: string
  body: string
}

/**
 * Split the guide on its `## ` headings.
 *
 * Parsing the markdown rather than keeping a parallel section table is what
 * stops the two drifting: there is one document, and the topic list is derived
 * from it.
 */
export function guideSections(markdown: string = AGENT_GUIDE): GuideSection[] {
  const sections: GuideSection[] = []
  let current: GuideSection | undefined
  for (const line of markdown.split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      if (current) sections.push(current)
      const title = heading[1].trim()
      current = { topic: slugify(title), title, body: `${line}\n` }
      continue
    }
    if (current) current.body += `${line}\n`
  }
  if (current) sections.push(current)
  return sections
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** One section by topic slug, or a CliError naming the ones that exist. */
export function guideSection(topic: string, markdown: string = AGENT_GUIDE): GuideSection {
  const sections = guideSections(markdown)
  const found = sections.find((s) => s.topic === topic)
  if (found) return found
  throw new CliError(
    `Unknown docs topic: "${topic}". Available topics:\n${sections
      .map((s) => `  ${s.topic}`)
      .join('\n')}`,
    { type: 'validation', subtype: 'unknown_topic', hint: 'a2wave docs' },
  )
}
