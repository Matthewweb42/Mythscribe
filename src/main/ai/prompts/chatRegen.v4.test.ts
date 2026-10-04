import { describe, expect, it } from 'vitest'
import { builtinParams } from '@shared/presets'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { buildChatPromptV4, type BuildChatPromptV4Input } from './chat.v4'
import { buildChatRegenPromptV3 } from './chatRegen.v3'
import { buildChatRegenPromptV4 } from './chatRegen.v4'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

const SCENE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const BRIEF = 'Scene brief:\n- Goal: Mara wants to reach the landing before the storm.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'
const STEER = `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`
const general = builtinParams('general')
const agent: BuildChatPromptV4Input = {
  mode: 'agent',
  paragraphs: 2,
  sceneText: SCENE,
  sceneMeta: null,
  brief: BRIEF,
  steer: STEER,
  refs: [],
  history: [{ role: 'user', content: 'Earlier.' }],
  message: 'Bring Tomas onto the landing.',
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: BIBLE,
  preset: general
}
const VIOLATION = 'switches to present tense'
const CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` +
  "Write a different draft that keeps the manuscript's voice."

describe('chatRegen.v4 prompt (F-5.4, F-14.7, F-14.13)', () => {
  it('is chat.v4 with the violation clause appended to the system turn, after the steer, the other turns untouched', () => {
    const base = buildChatPromptV4(agent)
    const built = buildChatRegenPromptV4({ ...agent, violation: VIOLATION })
    expect(built.version).toBe('chatRegen.v4')
    expect(built.messages).toEqual([
      { role: 'system', content: `${base.messages[0]?.content}\n\n${CLAUSE}` },
      ...base.messages.slice(1)
    ])
    const system = built.messages[0]?.content ?? ''
    expect(system.indexOf(SCENE_STEER_HEADING)).toBeLessThan(system.indexOf(CLAUSE))
    expect(built.maxTokens).toBe(base.maxTokens)
    expect(built.temperature).toBe(base.temperature)
  })

  it('is the version-3 regenerate when there is no steer', () => {
    const input = { ...agent, violation: VIOLATION }
    expect(buildChatRegenPromptV4({ ...input, steer: null }).messages).toEqual(
      buildChatRegenPromptV3(input).messages
    )
  })
})
