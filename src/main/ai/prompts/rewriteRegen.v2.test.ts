import { describe, expect, it } from 'vitest'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v2'
import { buildRewritePrompt, type BuildRewritePromptInput } from './rewrite.v2'
import { buildRewriteRegenPrompt as buildRegenV1 } from './rewriteRegen.v1'
import { buildRewriteRegenPrompt } from './rewriteRegen.v2'

const PASSAGE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const base: BuildRewritePromptInput = {
  text: PASSAGE,
  before: 'She set the lantern down on the post.',
  after: '',
  meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: null
}
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'
const VIOLATION = 'switches to present tense'
const VIOLATION_CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` + "Rewrite it again, keeping the manuscript's voice."
const NOTE = 'Less lightning, more of the rope.'
const NOTE_CLAUSE = `The writer asked for a different rewrite and said: "${NOTE}".`

describe('rewriteRegen.v2 prompt (F-14.10, F-14.5, F-14.7, F-14.9)', () => {
  it('is rewrite.v2 with the violation clause appended to the system turn, the user turn untouched', () => {
    const built = buildRewriteRegenPrompt({ ...base, note: null, violation: VIOLATION })
    const plain = buildRewritePrompt(base)
    expect(built.version).toBe('rewriteRegen.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${plain.messages[0]?.content}\n\n${VIOLATION_CLAUSE}` },
      ...plain.messages.slice(1)
    ])
  })

  it('names the author’s note when they asked again, and puts the note before the violation when both apply', () => {
    const noteOnly = buildRewriteRegenPrompt({ ...base, note: NOTE, violation: null })
    const plain = buildRewritePrompt(base)
    expect(noteOnly.messages[0]?.content).toBe(`${plain.messages[0]?.content}\n\n${NOTE_CLAUSE}`)
    const both = buildRewriteRegenPrompt({ ...base, note: NOTE, violation: VIOLATION })
    expect(both.messages[0]?.content).toBe(
      `${plain.messages[0]?.content}\n\n${NOTE_CLAUSE} ${VIOLATION_CLAUSE}`
    )
  })

  it('keeps the voice block, the story bible, and the scene line ahead of the clauses, so the cached prefix still applies', () => {
    const system =
      buildRewriteRegenPrompt({ ...base, bible: BIBLE, note: NOTE, violation: VIOLATION })
        .messages[0]?.content ?? ''
    const clauseAt = system.indexOf(NOTE_CLAUSE)
    expect(system.indexOf("Match the author's voice:")).toBeLessThan(clauseAt)
    expect(system.indexOf(STORY_BIBLE_HEADING)).toBeLessThan(
      system.indexOf('Scene: location Ferry landing')
    )
    expect(system.indexOf('Scene: location Ferry landing')).toBeLessThan(clauseAt)
    expect(system.endsWith(VIOLATION_CLAUSE)).toBe(true)
  })

  it('F-14.9: a null bible leaves the v1 messages exactly', () => {
    const input = { ...base, note: NOTE, violation: VIOLATION }
    expect(buildRewriteRegenPrompt(input).messages).toEqual(buildRegenV1(input).messages)
  })

  it('passes the cap through unchanged and asks for no temperature', () => {
    const built = buildRewriteRegenPrompt({ ...base, note: null, violation: VIOLATION })
    expect(built.maxTokens).toBe(buildRewritePrompt(base).maxTokens)
    expect('temperature' in built).toBe(false)
  })
})
