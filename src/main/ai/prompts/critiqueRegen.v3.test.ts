import { describe, expect, it } from 'vitest'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { buildCritiquePromptV3, type BuildCritiquePromptV3Input } from './critique.v3'
import { buildCritiqueRegenPromptV2 } from './critiqueRegen.v2'
import { buildCritiqueRegenPromptV3 } from './critiqueRegen.v3'

const SCENE =
  'The ferry landing was empty when Mara reached it. She set the lantern down and waited.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'
const base: BuildCritiquePromptV3Input = {
  sceneText: SCENE,
  brief: 'Scene brief:\n- Goal: Mara wants Tomas to admit what he owes.',
  meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: BIBLE,
  honesty: 'direct'
}
const NOTE = 'Less about the pacing, more about the dialogue.'
const NOTE_CLAUSE = `The writer asked for different notes and said: "${NOTE}".`

describe('critiqueRegen.v3 prompt (F-14.8, F-14.5, F-14.3, F-14.9)', () => {
  it('is critique.v3 with the author’s note appended to the system turn, the user turn untouched', () => {
    const built = buildCritiqueRegenPromptV3({ ...base, note: NOTE })
    const plain = buildCritiquePromptV3(base)
    expect(built.version).toBe('critiqueRegen.v3')
    expect(built.messages).toEqual([
      { role: 'system', content: `${plain.messages[0]?.content}\n\n${NOTE_CLAUSE}` },
      ...plain.messages.slice(1)
    ])
    expect(built.messages[1]?.content).toContain("Scene brief (the author's intent):")
  })

  it('is the base prompt under the regenerate version when the author asked again without a note', () => {
    const built = buildCritiqueRegenPromptV3({ ...base, note: null })
    expect(built.messages).toEqual(buildCritiquePromptV3(base).messages)
    expect(built.version).toBe('critiqueRegen.v3')
  })

  it('keeps the honesty line, the voice block, the story bible, and the scene line ahead of the clause, so the cached prefix still applies', () => {
    const system = buildCritiqueRegenPromptV3({ ...base, note: NOTE }).messages[0]?.content ?? ''
    const clauseAt = system.indexOf(NOTE_CLAUSE)
    expect(system.indexOf('Be specific and direct:')).toBeLessThan(clauseAt)
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(clauseAt)
    expect(system.indexOf(STORY_BIBLE_HEADING)).toBeLessThan(
      system.indexOf('Scene: location Ferry landing')
    )
    expect(system.indexOf('Scene: location Ferry landing')).toBeLessThan(clauseAt)
    expect(system.endsWith(NOTE_CLAUSE)).toBe(true)
  })

  it('is the version-2 regenerate when there is no bible', () => {
    const input = { ...base, bible: null, note: NOTE }
    expect(buildCritiqueRegenPromptV3(input).messages).toEqual(
      buildCritiqueRegenPromptV2(input).messages
    )
  })

  it('carries no violation clause: a failing fix is shown flagged, never retried', () => {
    const system = buildCritiqueRegenPromptV3({ ...base, note: NOTE }).messages[0]?.content ?? ''
    expect(system).not.toContain('Your last attempt')
    expect(system).not.toContain('keeping the manuscript')
  })

  it('passes the cap through unchanged and asks for no temperature', () => {
    const built = buildCritiqueRegenPromptV3({ ...base, note: NOTE })
    expect(built.maxTokens).toBe(buildCritiquePromptV3(base).maxTokens)
    expect('temperature' in built).toBe(false)
  })
})
