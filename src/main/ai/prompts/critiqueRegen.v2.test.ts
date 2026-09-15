import { describe, expect, it } from 'vitest'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { buildCritiquePrompt, type BuildCritiquePromptInput } from './critique.v2'
import { buildCritiqueRegenPrompt as buildRegenV1 } from './critiqueRegen.v1'
import { buildCritiqueRegenPrompt } from './critiqueRegen.v2'

const SCENE =
  'The ferry landing was empty when Mara reached it. She set the lantern down and waited.'
const base: BuildCritiquePromptInput = {
  sceneText: SCENE,
  notes: 'Mara confronts Tomas at the ferry.',
  meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: null,
  honesty: 'direct'
}
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'
const NOTE = 'Less about the pacing, more about the dialogue.'
const NOTE_CLAUSE = `The writer asked for different notes and said: "${NOTE}".`

describe('critiqueRegen.v2 prompt (F-14.8, F-14.5, F-14.9)', () => {
  it('is critique.v2 with the author’s note appended to the system turn, the user turn untouched', () => {
    const built = buildCritiqueRegenPrompt({ ...base, note: NOTE })
    const plain = buildCritiquePrompt(base)
    expect(built.version).toBe('critiqueRegen.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${plain.messages[0]?.content}\n\n${NOTE_CLAUSE}` },
      ...plain.messages.slice(1)
    ])
  })

  it('is the base prompt under the regenerate version when the author asked again without a note', () => {
    const built = buildCritiqueRegenPrompt({ ...base, note: null })
    expect(built.messages).toEqual(buildCritiquePrompt(base).messages)
    expect(built.version).toBe('critiqueRegen.v2')
  })

  it('keeps the honesty line, the voice block, the story bible, and the scene line ahead of the clause, so the cached prefix still applies', () => {
    const system =
      buildCritiqueRegenPrompt({ ...base, bible: BIBLE, note: NOTE }).messages[0]?.content ?? ''
    const clauseAt = system.indexOf(NOTE_CLAUSE)
    expect(system.indexOf('Be specific and direct:')).toBeLessThan(clauseAt)
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(clauseAt)
    expect(system.indexOf(STORY_BIBLE_HEADING)).toBeLessThan(
      system.indexOf('Scene: location Ferry landing')
    )
    expect(system.indexOf('Scene: location Ferry landing')).toBeLessThan(clauseAt)
    expect(system.endsWith(NOTE_CLAUSE)).toBe(true)
  })

  it('F-14.9: a null bible leaves the v1 messages exactly', () => {
    const input = { ...base, note: NOTE }
    expect(buildCritiqueRegenPrompt(input).messages).toEqual(buildRegenV1(input).messages)
  })

  it('carries no violation clause: a failing fix is shown flagged, never retried', () => {
    const system = buildCritiqueRegenPrompt({ ...base, note: NOTE }).messages[0]?.content ?? ''
    expect(system).not.toContain('The last suggestion')
    expect(system).not.toContain('keeping the manuscript')
  })

  it('passes the cap through unchanged and asks for no temperature', () => {
    const built = buildCritiqueRegenPrompt({ ...base, note: NOTE })
    expect(built.maxTokens).toBe(buildCritiquePrompt(base).maxTokens)
    expect('temperature' in built).toBe(false)
  })
})
