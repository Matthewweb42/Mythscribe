import { describe, expect, it } from 'vitest'
import { builtinParams } from '@shared/presets'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { buildGhostTextPromptV4, type BuildGhostTextPromptV4Input } from './ghostText.v4'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'
import { buildGhostTextRegenPromptV3 } from './ghostTextRegen.v3'
import { buildGhostTextRegenPromptV4 } from './ghostTextRegen.v4'

const BEFORE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'
const BRIEF = 'Scene brief:\n- Goal: Mara wants to reach the ferry before the crossing closes.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'
const STEER = `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`
const general = builtinParams('general')
const minimal: BuildGhostTextPromptV4Input = {
  before: BEFORE,
  after: '',
  notes: null,
  meta: null,
  brief: null,
  steer: null,
  voice: null,
  bible: null,
  preset: general
}
const VIOLATION = 'switches to present tense'
const CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` +
  "Write a different continuation that keeps the manuscript's voice."

describe('ghostTextRegen.v4 prompt (F-14.7, F-14.13)', () => {
  it('is ghostText.v4 with the violation clause appended to the system turn, the steer staying in the user turn', () => {
    const input = { ...minimal, brief: BRIEF, steer: STEER, bible: BIBLE }
    const base = buildGhostTextPromptV4(input)
    const built = buildGhostTextRegenPromptV4({ ...input, violation: VIOLATION })
    expect(built.version).toBe('ghostTextRegen.v4')
    expect(built.messages).toEqual([
      { role: 'system', content: `${base.messages[0]?.content} ${CLAUSE}` },
      base.messages[1]
    ])
    expect(built.messages[1]?.content).toContain(STEER)
    expect(built.messages[0]?.content).not.toContain(SCENE_STEER_HEADING)
  })

  it('is the version-3 regenerate when there is no steer', () => {
    const input = {
      ...minimal,
      brief: BRIEF,
      voice: 'Short sentences.',
      bible: BIBLE,
      violation: VIOLATION
    }
    expect(buildGhostTextRegenPromptV4({ ...input, steer: null }).messages).toEqual(
      buildGhostTextRegenPromptV3(input).messages
    )
  })

  it('passes the caps and the temperature through unchanged', () => {
    const action = builtinParams('action')
    const base = buildGhostTextPromptV4({ ...minimal, preset: action })
    const built = buildGhostTextRegenPromptV4({ ...minimal, preset: action, violation: VIOLATION })
    expect(built.maxTokens).toBe(base.maxTokens)
    expect(built.temperature).toBe(base.temperature)
  })
})
