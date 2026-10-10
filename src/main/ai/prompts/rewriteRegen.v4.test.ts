import { describe, expect, it } from 'vitest'
import { renderSceneMood } from '@shared/sceneCard'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { type BuildRewritePromptV4Input } from './rewrite.v4'
import { buildRewriteRegenPromptV3 } from './rewriteRegen.v3'
import { buildRewriteRegenPromptV4 } from './rewriteRegen.v4'

const STEER = `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`
const MOOD = renderSceneMood('quiet dread', '') ?? ''
const base: BuildRewritePromptV4Input = {
  text: 'The storm broke at dusk over the dark forest. Mara counted the lightning gaps.',
  before: 'She set the lantern down on the post.',
  after: '',
  meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: null,
  steer: STEER,
  mood: MOOD
}
const regen = { note: 'Less lightning, more of the rope.', violation: 'switches to present tense' }

describe('rewriteRegen.v4 prompt (F-14.10, F-5.6)', () => {
  it("is version 3's regenerate with the mood block after the steer", () => {
    const built = buildRewriteRegenPromptV4({ ...base, ...regen })
    const v3 = buildRewriteRegenPromptV3({ ...base, ...regen, steer: `${STEER}\n\n${MOOD}` })
    expect(built.version).toBe('rewriteRegen.v4')
    expect(built.messages).toEqual(v3.messages)
    expect(built.maxTokens).toBe(v3.maxTokens)
    expect(built.messages[1]?.content).toContain(
      `${STEER}\n\nScene mood: quiet dread\nKeep the edit in line with it.\n\nText before:`
    )
    expect(built.messages).toMatchSnapshot()
  })

  it("is version 3's messages exactly with no mood block", () => {
    expect(buildRewriteRegenPromptV4({ ...base, ...regen, mood: null }).messages).toEqual(
      buildRewriteRegenPromptV3({ ...base, ...regen }).messages
    )
  })
})
