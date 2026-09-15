import { describe, expect, it } from 'vitest'
import { builtinParams } from '@shared/presets'
import { buildChatPromptV2, type BuildChatPromptV2Input } from './chat.v2'
import { buildChatRegenPromptV2 } from './chatRegen.v2'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

const SCENE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const BRIEF = 'Scene brief:\n- Goal: Mara wants to reach the landing before the storm.'
const general = builtinParams('general')
const agent: BuildChatPromptV2Input = {
  mode: 'agent',
  paragraphs: 2,
  sceneText: SCENE,
  sceneMeta: null,
  brief: BRIEF,
  refs: [],
  history: [{ role: 'user', content: 'Earlier.' }],
  message: 'Bring Tomas onto the landing.',
  voice: "Match the author's voice:\n- Narration is in past tense.",
  preset: general
}
const VIOLATION = 'switches to present tense'
const CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` +
  "Write a different draft that keeps the manuscript's voice."

describe('chatRegen.v2 prompt (F-5.4, F-14.7, F-14.3)', () => {
  it('is chat.v2 with the violation clause appended to the system turn, the other turns untouched', () => {
    const base = buildChatPromptV2(agent)
    const built = buildChatRegenPromptV2({ ...agent, violation: VIOLATION })
    expect(built.version).toBe('chatRegen.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${base.messages[0]?.content}\n\n${CLAUSE}` },
      ...base.messages.slice(1)
    ])
    expect(built.messages).toHaveLength(3)
  })

  it('keeps the voice block, the preset, the brief, and the scene ahead of the clause, so the cached prefix still applies', () => {
    const system =
      buildChatRegenPromptV2({ ...agent, violation: VIOLATION }).messages[0]?.content ?? ''
    const clauseAt = system.indexOf(CLAUSE)
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(clauseAt)
    expect(system.indexOf(general.styleInstruction)).toBeLessThan(clauseAt)
    expect(system.indexOf(BRIEF)).toBeGreaterThan(0)
    expect(system.indexOf(BRIEF)).toBeLessThan(system.indexOf('Active scene:'))
    expect(system.indexOf('Active scene:')).toBeLessThan(clauseAt)
    expect(system.endsWith(CLAUSE)).toBe(true)
  })

  it('passes the cap and the temperature through unchanged', () => {
    const base = buildChatPromptV2(agent)
    const built = buildChatRegenPromptV2({ ...agent, violation: VIOLATION })
    expect(built.maxTokens).toBe(base.maxTokens)
    expect(built.temperature).toBe(base.temperature)
  })
})
