/**
 * `a2wave docs [topic]` — the agent guide, shipped inside the binary.
 *
 * `schema` answers "what parameters does this command take"; `docs` answers the
 * questions no per-command lookup can — the loop, the output contract, the risk
 * vocabulary, how name resolution costs an extra fetch, and which command to
 * reach for INSTEAD of the plausible neighbour.
 */
import { defineCommand } from 'citty'
import { AGENT_GUIDE, guideSection, guideSections } from '../lib/guide.js'

export const docsCommand = defineCommand({
  meta: {
    name: 'docs',
    description: 'Print the agent guide, or one section of it',
    agentMeta: {
      risk: 'read',
      notFor: ['Per-command parameters — that is `a2wave schema <command>`'],
      examples: ['a2wave docs', 'a2wave docs --list', 'a2wave docs the-loop'],
    },
  },
  args: {
    topic: {
      type: 'positional',
      description: 'Section slug (omit for the whole guide; --list shows the slugs)',
      required: false,
    },
    list: { type: 'boolean', description: 'List the section slugs and stop' },
  },
  run: ({ args }) => {
    if (args.list === true) {
      // Slug plus title, so a caller picks a section without fetching the guide
      // it is trying to avoid fetching.
      for (const section of guideSections()) {
        console.log(`${section.topic}\t${section.title}`)
      }
      return
    }

    const topic = (args.topic as string | undefined)?.trim()
    console.log(topic ? guideSection(topic).body.trimEnd() : AGENT_GUIDE.trimEnd())
  },
})
