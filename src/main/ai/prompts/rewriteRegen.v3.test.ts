import { describe, expect, it } from 'vitest'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'
import { buildRewritePromptV3, type BuildRewritePromptV3Input } from './rewrite.v3'
import { buildRewriteRegenPromptV2 } from './rewriteRegen.v2'
import { buildRewriteRegenPromptV3 } from './rewriteRegen.v3'

const PASSAGE = 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'
const STEER = `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`
const base: BuildRewritePromptV3Input = {
  text: PASSAGE,
  before: 'She set the lantern down on the post.',
  after: '',
  meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: BIBLE,
  steer: STEER
}
const VIOLATION = 'switches to present tense'
const VIOLATION_CLAUSE =
  `${REGEN_CLAUSE_PREFIX} ${VIOLATION}. ` + "Rewrite it again, keeping the manuscript's voice."
const NOTE = 'Less lightning, more of the rope.'
const NOTE_CLAUSE = `The writer asked for a different rewrite and said: "${NOTE}".`

describe('rewriteRegen.v3 prompt (F-14.10, F-14.5, F-14.7, F-14.13)', () => {
  it('is rewrite.v3 with the clauses appended to the system turn, the steer staying in the user turn', () => {
    const built = buildRewriteRegenPromptV3({ ...base, note: NOTE, violation: VIOLATION })
    const plain = buildRewritePromptV3(base)
    expect(built.version).toBe('rewriteRegen.v3')
    expect(built.messages).toEqual([
      {
        role: 'system',
        content: `${plain.messages[0]?.content}\n\n${NOTE_CLAUSE} ${VIOLATION_CLAUSE}`
      },
      ...plain.messages.slice(1)
    ])
    expect(built.messages[1]?.content.startsWith(STEER)).toBe(true)
    expect(built.maxTokens).toBe(plain.maxTokens)
  })

  it('is the version-2 regenerate when there is no steer', () => {
    const input = { ...base, note: null, violation: VIOLATION }
    expect(buildRewriteRegenPromptV3({ ...input, steer: null }).messages).toEqual(
      buildRewriteRegenPromptV2(input).messages
    )
  })
})
