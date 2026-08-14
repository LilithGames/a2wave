import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { parseKeyValues, readJsonFile } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'

/**
 * Channels that persist a config object, mirroring `channelConfigSchemas` in
 * apps/api/src/routes/agents.ts. `api` / `a2a` / `oauth` carry no saveable
 * config, so the route answers 400 `UNKNOWN_CHANNEL` for them — naming the valid
 * set here turns that into an error the caller can act on without a round-trip.
 */
const CONFIGURABLE_CHANNELS = [
  'feishu',
  'slack',
  'discord',
  'chat_app',
  'schedule',
  'glab',
  'gh',
] as const

/**
 * Coerce a `--set k=v` value into the JSON type the channel schema expects.
 *
 * Every shell flag arrives as a string, but `showThinking=false` must reach zod
 * as a boolean or validation rejects it — and the resulting 400 blames the
 * field rather than the quoting. Only the unambiguous literals are converted;
 * anything else stays a string, so a numeric-looking token (a Feishu app id) is
 * not silently retyped.
 */
function coerceScalar(raw: string): string | number | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  return raw
}

export const channelsCommand = defineCommand({
  meta: {
    name: 'channels',
    description: 'Configure a single publish channel without republishing the Agent',
  },
  subCommands: {
    set: defineCommand({
      meta: {
        name: 'set',
        description:
          'Save one channel’s config. Configuring is not publishing: a draft stays a draft',
        agentMeta: { risk: 'write' },
      },
      args: {
        agent: { type: 'positional', description: 'Agent ID or name', required: true },
        channel: {
          type: 'positional',
          description: `Channel to configure: ${CONFIGURABLE_CHANNELS.join(' | ')}`,
          required: true,
        },
        set: {
          type: 'string',
          description: 'Config field as key=value (repeatable); true/false/integers are typed',
        },
        'config-file': {
          type: 'string',
          description: 'Read the whole config object from a JSON file',
        },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const channel = args.channel as string
        if (!CONFIGURABLE_CHANNELS.includes(channel as 'feishu')) {
          throw new CliError(
            `Channel "${channel}" has no saveable config (options: ${CONFIGURABLE_CHANNELS.join(' | ')})`,
            { type: 'validation', subtype: 'unknown_channel' },
          )
        }

        const fromFile = args['config-file'] as string | undefined
        const pairs = parseKeyValues(args.set, 'set')
        if ((fromFile === undefined) === (pairs === undefined)) {
          throw new CliError('Provide exactly one of --set key=value or --config-file <json>', {
            type: 'validation',
            subtype: 'missing_argument',
          })
        }

        const config = fromFile
          ? readJsonFile(fromFile)
          : Object.fromEntries(
              Object.entries(pairs as Record<string, string>).map(([k, v]) => [k, coerceScalar(v)]),
            )

        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.agent as string)
        // The whole config object is replaced, so a partial `--set` drops the
        // fields it omits. Say so rather than letting a "one field" edit quietly
        // clear a credential the caller never mentioned.
        const result = await client.patch<{ data: unknown }>(
          `/api/agents/${agentId}/channels/${channel}`,
          { config },
        )
        if (emit(args, result)) return
        console.log(`Channel "${channel}" configured ✓`)
        console.log(
          'This replaced the whole config object and did NOT publish. Enable it with: a2wave agents publish',
        )
      },
    }),

    'chat-app': defineCommand({
      meta: {
        name: 'chat-app',
        description: 'Show the published chat page profile (404 when the channel is off)',
        agentMeta: { risk: 'read' },
      },
      args: {
        agent: { type: 'positional', description: 'Agent ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const agentId = await client.resolveAgentId(args.agent as string)
        const result = await client.get<{
          data: {
            id: string
            name: string
            description?: string | null
            welcomeMessage?: string | null
            suggestedQuestions?: string[]
            allowAttachments?: boolean
            showThinking?: boolean
            creator?: { name: string } | null
          }
        }>(`/api/agents/${agentId}/chat-app`)
        if (emit(args, result)) return

        const d = result.data
        console.log(`ID:          ${d.id}`)
        console.log(`Name:        ${d.name}`)
        if (d.description) console.log(`Description: ${d.description}`)
        if (d.creator) console.log(`Creator:     ${d.creator.name}`)
        if (d.welcomeMessage) console.log(`Welcome:     ${d.welcomeMessage}`)
        if (d.suggestedQuestions?.length)
          console.log(`Suggested:   ${d.suggestedQuestions.join(' | ')}`)
        console.log(`Attachments: ${d.allowAttachments === false ? 'disabled' : 'enabled'}`)
        console.log(`Thinking:    ${d.showThinking === false ? 'hidden' : 'shown'}`)
      },
    }),
  },
})
