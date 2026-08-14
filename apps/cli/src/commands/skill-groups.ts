import { defineCommand } from 'citty'
import { createClient, urlArg } from '../client.js'
import { CliError } from '../errors.js'
import { forceArgs, requireConfirmation, resolveForceFlag, toStringArray } from '../lib/args.js'
import { emit, jsonArg } from '../lib/output.js'
import { pageArgs, pageQuery } from '../lib/paginate.js'

interface SkillGroup {
  id: string
  name: string
  description?: string | null
  icon?: string | null
  /**
   * False when the group holds a Skill its own owner cannot resolve at runtime.
   * Binding such a group to an Agent silently loses those members, so it is
   * worth surfacing on every list rather than only in the picker.
   */
  ownerCanBindAllSkills?: boolean
  createdAt?: string
  updatedAt?: string
}

/** Resolve every `--skill` value (ID or name) into a skill ID. */
async function resolveSkillIds(
  client: ReturnType<typeof createClient>,
  raw: unknown,
): Promise<string[]> {
  const values = toStringArray(raw)
  const ids: string[] = []
  for (const value of values) ids.push(await client.resolveSkillId(value))
  return ids
}

export const skillGroupsCommand = defineCommand({
  meta: {
    name: 'skill-groups',
    description: 'Manage Skill Groups (the values `--group` and `skillGroups:` accept)',
  },
  subCommands: {
    list: defineCommand({
      meta: { name: 'list', description: 'List all Skill Groups', agentMeta: { risk: 'read' } },
      args: { ...jsonArg, ...pageArgs, ...urlArg },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const result = await client.get<{ data: SkillGroup[] }>(
          `/api/skill-groups?${pageQuery(args, 100)}`,
        )
        if (emit(args, result)) return
        if (result.data.length === 0) {
          console.log('No Skill Groups')
          return
        }
        for (const g of result.data) {
          const desc = g.description ? `  ${g.description}` : ''
          console.log(`${g.id}  ${g.name}${desc}`)
          if (g.ownerCanBindAllSkills === false) {
            console.log('  warning: contains members the group owner cannot bind (unbindable)')
          }
        }
      },
    }),

    get: defineCommand({
      meta: {
        name: 'get',
        description: 'Show a Skill Group and its members (ID or name)',
        agentMeta: { risk: 'read' },
      },
      args: {
        id: { type: 'positional', description: 'Skill Group ID or name', required: true },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const groupId = await client.resolveSkillGroupId(args.id as string)
        const group = await client.get<{ data: SkillGroup }>(`/api/skill-groups/${groupId}`)
        // Membership lives on a separate route; merging them here spares the
        // caller a second command to answer "what is actually in this group".
        const members = await client.get<{ data: string[] }>(`/api/skill-groups/${groupId}/skills`)
        if (emit(args, { data: { ...group.data, skillIds: members.data } })) return
        const g = group.data
        console.log(`ID:          ${g.id}`)
        console.log(`Name:        ${g.name}`)
        if (g.description) console.log(`Description: ${g.description}`)
        if (g.icon) console.log(`Icon:        ${g.icon}`)
        if (g.ownerCanBindAllSkills === false) {
          console.log('Warning:     contains members the group owner cannot bind')
        }
        console.log(
          `Skills:      ${members.data.length === 0 ? '(none)' : members.data.join(', ')}`,
        )
      },
    }),

    create: defineCommand({
      meta: { name: 'create', description: 'Create a Skill Group', agentMeta: { risk: 'write' } },
      args: {
        name: { type: 'string', description: 'Group name', required: false },
        description: { type: 'string', description: 'Description' },
        icon: { type: 'string', description: 'Icon name (default "package")' },
        skill: {
          type: 'string',
          description: 'Skill to place in the group, ID or name (repeatable)',
        },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        if (!args.name) {
          throw new CliError('--name is required when creating a Skill Group', {
            type: 'validation',
            subtype: 'missing_argument',
          })
        }
        const client = createClient({ url: args.url as string | undefined })
        const skillIds = await resolveSkillIds(client, args.skill)
        const body: Record<string, unknown> = { name: args.name as string }
        if (args.description) body.description = args.description as string
        if (args.icon) body.icon = args.icon as string
        if (skillIds.length > 0) body.skillIds = skillIds

        const result = await client.post<{ data: SkillGroup }>('/api/skill-groups', body)
        if (emit(args, result)) return
        console.log(`Skill Group created ✓  ${result.data.id}  ${result.data.name}`)
      },
    }),

    update: defineCommand({
      meta: {
        name: 'update',
        description: 'Update a Skill Group (ID or name)',
        agentMeta: { risk: 'write' },
      },
      args: {
        id: { type: 'positional', description: 'Skill Group ID or name', required: true },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        icon: { type: 'string', description: 'New icon name' },
        skill: {
          type: 'string',
          description:
            'Replace the membership with these Skills, ID or name (repeatable). Omit to leave members untouched',
        },
        'clear-skills': {
          type: 'boolean',
          description: 'Release every member Skill from the group',
        },
        ...jsonArg,
        ...urlArg,
      },
      run: async ({ args }) => {
        const client = createClient({ url: args.url as string | undefined })
        const body: Record<string, unknown> = {}
        if (args.name) body.name = args.name as string
        if (args.description !== undefined) body.description = args.description as string
        if (args.icon) body.icon = args.icon as string
        // `skillIds` REPLACES the membership server-side, so an empty array is a
        // meaningful value rather than "unset" — it needs its own flag, because
        // a bare `--skill` with no value cannot express it.
        const skillIds = await resolveSkillIds(client, args.skill)
        if (args['clear-skills'] === true) body.skillIds = []
        else if (skillIds.length > 0) body.skillIds = skillIds

        if (Object.keys(body).length === 0) {
          throw new CliError('Specify at least one field to update', {
            type: 'validation',
            subtype: 'missing_argument',
          })
        }
        const groupId = await client.resolveSkillGroupId(args.id as string)
        const result = await client.patch<{ data: SkillGroup }>(
          `/api/skill-groups/${groupId}`,
          body,
        )
        if (emit(args, result)) return
        console.log('Skill Group updated ✓')
      },
    }),

    delete: defineCommand({
      meta: {
        name: 'delete',
        description: 'Delete a Skill Group (members are released, not deleted)',
        agentMeta: { risk: 'high-risk-write' },
      },
      args: {
        id: { type: 'positional', description: 'Skill Group ID or name', required: true },
        ...forceArgs,
        ...urlArg,
      },
      run: async ({ args }) => {
        await requireConfirmation(
          'high-risk-write',
          `This will delete Skill Group "${args.id}". Member Skills are released, not deleted.`,
          resolveForceFlag(args),
        )
        const client = createClient({ url: args.url as string | undefined })
        const groupId = await client.resolveSkillGroupId(args.id as string)
        await client.del(`/api/skill-groups/${groupId}`)
        console.log('Skill Group deleted ✓')
      },
    }),
  },
})
