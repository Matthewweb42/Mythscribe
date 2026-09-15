import { describe, expect, it } from 'vitest'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'
import { buildRewritePromptV2, type BuildRewritePromptV2Input } from './rewrite.v2'
import { buildRewriteRegenPrompt } from './rewriteRegen.v1'
import { buildRewriteRegenPromptV2 } from './rewriteRegen.v2'

const PASSAGE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'
const base: BuildRewritePromptV2Input = {
  text: PASSAGE,
  before: 'She set the lantern down on the post.',
  after: '',
  meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: BIBLE
}
const VIOLATION = 'switches to present tense'
const VIOLATION_CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` + "Rewrite it again, keeping the manuscript's voice."
const NOTE = 'Less lightning, more of the rope.'
const NOTE_CLAUSE = `The writer asked for a different rewrite and said: "${NOTE}".`

describe('rewriteRegen.v2 prompt (F-14.10, F-14.5, F-14.7, F-14.9)', () => {
  it('is rewrite.v2 with the violation clause appended to the system turn, the user turn untouched', () => {
    const built = buildRewriteRegenPromptV2({ ...base, note: null, violation: VIOLATION })
    const plain = buildRewritePromptV2(base)
    expect(built.version).toBe('rewriteRegen.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${plain.messages[0]?.content}\n\n${VIOLATION_CLAUSE}` },
      ...plain.messages.slice(1)
    ])
  })

  it('names the author’s note when they asked again, and puts the note before the violation when both apply', () => {
    const noteOnly = buildRewriteRegenPromptV2({ ...base, note: NOTE, violation: null })
    const plain = buildRewritePromptV2(base)
    expect(noteOnly.messages[0]?.content).toBe(`${plain.messages[0]?.content}\n\n${NOTE_CLAUSE}`)
    const both = buildRewriteRegenPromptV2({ ...base, note: NOTE, violation: VIOLATION })
    expect(both.messages[0]?.content).toBe(
      `${plain.messages[0]?.content}\n\n${NOTE_CLAUSE} ${VIOLATION_CLAUSE}`
    )
  })

  it('keeps the voice block, the story bible, and the scene line ahead of the clauses, so the cached prefix still applies', () => {
    const system =
      buildRewriteRegenPromptV2({ ...base, note: NOTE, violation: VIOLATION }).messages[0]
        ?.content ?? ''
    const clauseAt = system.indexOf(NOTE_CLAUSE)
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(clauseAt)
    expect(system.indexOf(STORY_BIBLE_HEADING)).toBeLessThan(
      system.indexOf('Scene: location Ferry landing')
    )
    expect(system.indexOf('Scene: location Ferry landing')).toBeLessThan(clauseAt)
    expect(system.endsWith(VIOLATION_CLAUSE)).toBe(true)
  })

  it('is the version-1 regenerate when there is no bible', () => {
    const input = { ...base, bible: null, note: NOTE, violation: VIOLATION }
    expect(buildRewriteRegenPromptV2(input).messages).toEqual(
      buildRewriteRegenPrompt(input).messages
    )
  })

  it('passes the cap through unchanged and asks for no temperature', () => {
    const built = buildRewriteRegenPromptV2({ ...base, note: null, violation: VIOLATION })
    expect(built.maxTokens).toBe(buildRewritePromptV2(base).maxTokens)
    expect('temperature' in built).toBe(false)
  })
})
