import { describe, expect, it } from 'vitest'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { buildCritiquePromptV2, type BuildCritiquePromptV2Input } from './critique.v2'
import { buildCritiqueRegenPromptV2 } from './critiqueRegen.v2'

const SCENE =
  'The ferry landing was empty when Mara reached it. She set the lantern down and waited.'
const base: BuildCritiquePromptV2Input = {
  sceneText: SCENE,
  brief: 'Scene brief:\n- Goal: Mara wants Tomas to admit what he owes.',
  meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  honesty: 'direct'
}
const NOTE = 'Less about the pacing, more about the dialogue.'
const NOTE_CLAUSE = `The writer asked for different notes and said: "${NOTE}".`

describe('critiqueRegen.v2 prompt (F-14.8, F-14.5, F-14.3)', () => {
  it('is critique.v2 with the author’s note appended to the system turn, the user turn untouched', () => {
    const built = buildCritiqueRegenPromptV2({ ...base, note: NOTE })
    const plain = buildCritiquePromptV2(base)
    expect(built.version).toBe('critiqueRegen.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${plain.messages[0]?.content}\n\n${NOTE_CLAUSE}` },
      ...plain.messages.slice(1)
    ])
    expect(built.messages[1]?.content).toContain("Scene brief (the author's intent):")
  })

  it('is the base prompt under the regenerate version when the author asked again without a note', () => {
    const built = buildCritiqueRegenPromptV2({ ...base, note: null })
    expect(built.messages).toEqual(buildCritiquePromptV2(base).messages)
    expect(built.version).toBe('critiqueRegen.v2')
  })

  it('keeps the honesty line, the voice block, and the scene line ahead of the clause, so the cached prefix still applies', () => {
    const system = buildCritiqueRegenPromptV2({ ...base, note: NOTE }).messages[0]?.content ?? ''
    const clauseAt = system.indexOf(NOTE_CLAUSE)
    expect(system.indexOf('Be specific and direct:')).toBeLessThan(clauseAt)
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(clauseAt)
    expect(system.indexOf('Scene: location Ferry landing')).toBeLessThan(clauseAt)
    expect(system.endsWith(NOTE_CLAUSE)).toBe(true)
  })

  it('carries no violation clause: a failing fix is shown flagged, never retried', () => {
    const system = buildCritiqueRegenPromptV2({ ...base, note: NOTE }).messages[0]?.content ?? ''
    expect(system).not.toContain('Your last attempt')
    expect(system).not.toContain('keeping the manuscript')
  })

  it('passes the cap through unchanged and asks for no temperature', () => {
    const built = buildCritiqueRegenPromptV2({ ...base, note: NOTE })
    expect(built.maxTokens).toBe(buildCritiquePromptV2(base).maxTokens)
    expect('temperature' in built).toBe(false)
  })
})
