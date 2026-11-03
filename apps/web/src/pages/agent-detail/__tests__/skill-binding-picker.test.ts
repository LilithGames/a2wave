import { describe, expect, it } from 'vitest'
import {
  type SkillPickerGroup,
  type SkillPickerSkill,
  buildSkillBindingPickerState,
} from '../config-tab'

const skills: SkillPickerSkill[] = [
  {
    id: 'skl_owner',
    name: 'Owner private',
    userId: 'usr_owner',
    visibility: 'private',
    groupId: 'skg_owner',
  },
  {
    id: 'skl_shared',
    name: 'Shared',
    userId: 'usr_admin',
    visibility: 'all-users',
    groupId: 'skg_owner',
  },
  {
    id: 'skl_foreign',
    name: 'Foreign private',
    userId: 'usr_other',
    visibility: 'private',
    groupId: 'skg_unsafe',
  },
  {
    id: 'skl_editor',
    name: 'Editor private',
    userId: 'usr_editor',
    visibility: 'private',
  },
  {
    id: 'skl_existing_foreign',
    name: 'Existing foreign private',
    userId: 'usr_other',
    visibility: 'private',
  },
]

const groups: SkillPickerGroup[] = [
  {
    id: 'skg_owner',
    name: 'Owner group',
    userId: 'usr_owner',
    ownerCanBindAllSkills: true,
  },
  {
    id: 'skg_unsafe',
    name: 'Unsafe owner group',
    userId: 'usr_owner',
    ownerCanBindAllSkills: false,
  },
  {
    id: 'skg_hidden_unsafe',
    name: 'Hidden unsafe owner group',
    userId: 'usr_owner',
    ownerCanBindAllSkills: false,
  },
  {
    id: 'skg_editor',
    name: 'Editor group',
    userId: 'usr_editor',
    ownerCanBindAllSkills: true,
  },
  {
    id: 'skg_existing_foreign',
    name: 'Existing foreign group',
    userId: 'usr_editor',
    ownerCanBindAllSkills: true,
  },
]

describe('Skill binding picker scope', () => {
  it('offers only owner/shared resources while retaining inaccessible existing references', () => {
    const state = buildSkillBindingPickerState({
      skills,
      groups,
      existingSkillIds: ['skl_existing_foreign', 'skl_missing'],
      existingGroupIds: ['skg_existing_foreign', 'skg_missing'],
      agentOwnerId: 'usr_owner',
      scope: 'owner-or-shared',
    })

    expect(state.skills.map((skill) => skill.id)).toEqual([
      'skl_owner',
      'skl_shared',
      'skl_existing_foreign',
    ])
    expect(state.groups.map((group) => group.id)).toEqual(['skg_owner', 'skg_existing_foreign'])
    expect(state.unavailableExistingSkillIds).toEqual(['skl_existing_foreign', 'skl_missing'])
    expect(state.unavailableExistingGroupIds).toEqual(['skg_existing_foreign', 'skg_missing'])
  })

  it('keeps every caller-visible option for an active-admin Agent owner', () => {
    const state = buildSkillBindingPickerState({
      skills,
      groups,
      existingSkillIds: ['skl_missing'],
      existingGroupIds: ['skg_missing'],
      agentOwnerId: 'usr_admin_owner',
      scope: 'all-visible',
    })

    expect(state.skills).toEqual(skills)
    expect(state.groups).toEqual(groups)
    expect(state.unavailableExistingSkillIds).toEqual(['skl_missing'])
    expect(state.unavailableExistingGroupIds).toEqual(['skg_missing'])
  })

  it('rejects a group marked unsafe even when its hidden private member is absent', () => {
    const visibleSkills = skills.filter((skill) => skill.groupId !== 'skg_unsafe')
    const state = buildSkillBindingPickerState({
      skills: visibleSkills,
      groups,
      existingSkillIds: [],
      existingGroupIds: [],
      agentOwnerId: 'usr_owner',
      scope: 'owner-or-shared',
    })

    expect(state.groups.map((group) => group.id)).toEqual(['skg_owner'])
  })
})
