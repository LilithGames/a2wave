import { z } from 'zod'

// ============================================================
// Skill Group — a named group of Skills, displayed and mounted as a unit.
// A Skill belongs to at most one group.
// ============================================================

export const skillGroupSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  icon: z.string().default('package'),
  /** False when the group owner cannot use every current Skill member. */
  ownerCanBindAllSkills: z.boolean().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
})

export type SkillGroup = z.infer<typeof skillGroupSchema>

export const createSkillGroupInput = z.object({
  name: z.string().min(1).max(100),
  description: z.string().nullable().optional(),
  icon: z.string().optional(),
  /** Optional: assign these Skills to the group on create. The API updates `skills.group_id` inside the transaction. */
  skillIds: z.array(z.string()).default([]),
})

export type CreateSkillGroupInput = z.infer<typeof createSkillGroupInput>

export const updateSkillGroupInput = createSkillGroupInput
  .extend({
    skillIds: createSkillGroupInput.shape.skillIds.unwrap(),
  })
  .partial()
export type UpdateSkillGroupInput = z.infer<typeof updateSkillGroupInput>
