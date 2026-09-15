import { describe, expect, it } from 'vitest'
import { builtinParams } from '@shared/presets'
import { buildChatPrompt, type BuildChatPromptInput } from './chat.v1'
import { buildChatRegenPrompt } from './chatRegen.v1'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

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
  preset: general
}
const VIOLATION = 'switches to present tense'
const CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` +
  "Write a different draft that keeps the manuscript's voice."

describe('chatRegen.v1 prompt (F-5.4, F-14.7)', () => {
  it('is chat.v1 with the violation clause appended to the system turn, the other turns untouched', () => {
    const base = buildChatPrompt(agent)
    const built = buildChatRegenPrompt({ ...agent, violation: VIOLATION })
    expect(built.version).toBe('chatRegen.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: `${base.messages[0]?.content}\n\n${CLAUSE}` },
      ...base.messages.slice(1)
    ])
    expect(built.messages).toHaveLength(3)
  })

  it('keeps the voice block, the preset, and the scene ahead of the clause, so the cached prefix still applies', () => {
    const system =
      buildChatRegenPrompt({ ...agent, violation: VIOLATION }).messages[0]?.content ?? ''
    const clauseAt = system.indexOf(CLAUSE)
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(clauseAt)
    expect(system.indexOf(general.styleInstruction)).toBeLessThan(clauseAt)
    expect(system.indexOf('Active scene:')).toBeLessThan(clauseAt)
    expect(system.endsWith(CLAUSE)).toBe(true)
  })

  it('passes the cap and the temperature through unchanged', () => {
    const base = buildChatPrompt(agent)
    const built = buildChatRegenPrompt({ ...agent, violation: VIOLATION })
    expect(built.maxTokens).toBe(base.maxTokens)
    expect(built.temperature).toBe(base.temperature)
  })
})
