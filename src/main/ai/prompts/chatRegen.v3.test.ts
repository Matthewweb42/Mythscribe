import { describe, expect, it } from 'vitest'
import { builtinParams } from '@shared/presets'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { buildChatPromptV3, type BuildChatPromptV3Input } from './chat.v3'
import { buildChatRegenPromptV2 } from './chatRegen.v2'
import { buildChatRegenPromptV3 } from './chatRegen.v3'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

const SCENE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const BRIEF = 'Scene brief:\n- Goal: Mara wants to reach the landing before the storm.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'
const general = builtinParams('general')
const agent: BuildChatPromptV3Input = {
  mode: 'agent',
  paragraphs: 2,
  sceneText: SCENE,
  sceneMeta: null,
  brief: BRIEF,
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

describe('chatRegen.v3 prompt (F-5.4, F-14.7, F-14.3, F-14.9)', () => {
  it('is chat.v3 with the violation clause appended to the system turn, the other turns untouched', () => {
    const base = buildChatPromptV3(agent)
    const built = buildChatRegenPromptV3({ ...agent, violation: VIOLATION })
    expect(built.version).toBe('chatRegen.v3')
    expect(built.messages).toEqual([
      { role: 'system', content: `${base.messages[0]?.content}\n\n${CLAUSE}` },
      ...base.messages.slice(1)
    ])
    expect(built.messages).toHaveLength(3)
  })

  it('keeps the voice block, the preset, the bible, the brief, and the scene ahead of the clause, so the cached prefix still applies', () => {
    const system =
      buildChatRegenPromptV3({ ...agent, violation: VIOLATION }).messages[0]?.content ?? ''
    const clauseAt = system.indexOf(CLAUSE)
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(clauseAt)
    expect(system.indexOf(general.styleInstruction)).toBeLessThan(clauseAt)
    expect(system.indexOf(STORY_BIBLE_HEADING)).toBeGreaterThan(0)
    expect(system.indexOf(STORY_BIBLE_HEADING)).toBeLessThan(system.indexOf(BRIEF))
    expect(system.indexOf(BRIEF)).toBeLessThan(system.indexOf('Active scene:'))
    expect(system.indexOf('Active scene:')).toBeLessThan(clauseAt)
    expect(system.endsWith(CLAUSE)).toBe(true)
  })

  it('is the version-2 regenerate when there is no bible', () => {
    const input = { ...agent, bible: null, violation: VIOLATION }
    expect(buildChatRegenPromptV3(input).messages).toEqual(buildChatRegenPromptV2(input).messages)
  })

  it('passes the cap and the temperature through unchanged', () => {
    const base = buildChatPromptV3(agent)
    const built = buildChatRegenPromptV3({ ...agent, violation: VIOLATION })
    expect(built.maxTokens).toBe(base.maxTokens)
    expect(built.temperature).toBe(base.temperature)
  })
})
