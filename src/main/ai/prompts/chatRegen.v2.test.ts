import { describe, expect, it } from 'vitest'
import { builtinParams } from '@shared/presets'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { buildChatPrompt, type BuildChatPromptInput } from './chat.v2'
import { buildChatRegenPrompt as buildRegenV1 } from './chatRegen.v1'
import { buildChatRegenPrompt } from './chatRegen.v2'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v2'

const SCENE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const general = builtinParams('general')
const agent: BuildChatPromptInput = {
  mode: 'agent',
  paragraphs: 2,
  sceneText: SCENE,
  sceneMeta: null,
  refs: [],
  history: [{ role: 'user', content: 'Earlier.' }],
  message: 'Bring Tomas onto the landing.',
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: null,
  preset: general
}
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'
const VIOLATION = 'switches to present tense'
const CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` +
  "Write a different draft that keeps the manuscript's voice."

describe('chatRegen.v2 prompt (F-5.4, F-14.7, F-14.9)', () => {
  it('is chat.v2 with the violation clause appended to the system turn, the other turns untouched', () => {
    const base = buildChatPrompt(agent)
    const built = buildChatRegenPrompt({ ...agent, violation: VIOLATION })
    expect(built.version).toBe('chatRegen.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${base.messages[0]?.content}\n\n${CLAUSE}` },
      ...base.messages.slice(1)
    ])
    expect(built.messages).toHaveLength(3)
  })

  it('keeps the voice block, the preset, the bible, and the scene ahead of the clause, so the cached prefix still applies', () => {
    const system =
      buildChatRegenPrompt({ ...agent, bible: BIBLE, violation: VIOLATION }).messages[0]?.content ??
      ''
    const clauseAt = system.indexOf(CLAUSE)
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(clauseAt)
    expect(system.indexOf(general.styleInstruction)).toBeLessThan(clauseAt)
    expect(system.indexOf(STORY_BIBLE_HEADING)).toBeLessThan(system.indexOf('Active scene:'))
    expect(system.indexOf('Active scene:')).toBeLessThan(clauseAt)
    expect(system.endsWith(CLAUSE)).toBe(true)
  })

  it('F-14.9: a null bible leaves the v1 messages exactly', () => {
    const input = { ...agent, violation: VIOLATION }
    expect(buildChatRegenPrompt(input).messages).toEqual(buildRegenV1(input).messages)
  })

  it('passes the cap and the temperature through unchanged', () => {
    const base = buildChatPrompt(agent)
    const built = buildChatRegenPrompt({ ...agent, violation: VIOLATION })
    expect(built.maxTokens).toBe(base.maxTokens)
    expect(built.temperature).toBe(base.temperature)
  })
})
