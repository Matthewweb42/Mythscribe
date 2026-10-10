import { describe, expect, it } from 'vitest'
import { renderSceneMood } from '@shared/sceneCard'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { buildRewritePromptV3 } from './rewrite.v3'
import { buildRewritePromptV4, type BuildRewritePromptV4Input } from './rewrite.v4'

const PASSAGE =
  'The storm broke at dusk over the dark forest. Mara counted the lightning gaps, each one ' +
  'shorter than the last.'
const STEER = `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`
const MOOD = renderSceneMood('quiet dread', 'debts come due') ?? ''

const input: BuildRewritePromptV4Input = {
  text: PASSAGE,
  before: 'She set the lantern down on the post.',
  after: '',
  meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: null,
  steer: STEER,
  mood: MOOD
}

describe('rewrite.v4 prompt (F-14.10, F-5.6 mood and theme)', () => {
  it('puts the mood block after the steer in the user turn, leaving the system turn alone', () => {
    const built = buildRewritePromptV4(input)
    const v3 = buildRewritePromptV3({ ...input, steer: STEER })
    expect(built.version).toBe('rewrite.v4')
    expect(built.messages[0]).toEqual(v3.messages[0])
    expect(built.messages[1]?.content).toBe(
      `${STEER}\n\n` +
        'Scene mood: quiet dread\nScene theme: debts come due\nKeep the edit in line with them.\n\n' +
        'Text before:\n"""\nShe set the lantern down on the post.\n"""\n\n' +
        `Passage to rewrite:\n"""\n${PASSAGE}\n"""\n\n` +
        'Rewrite the passage.'
    )
    expect(built.maxTokens).toBe(v3.maxTokens)
    expect(built.messages).toMatchSnapshot()
  })

  it('opens the user turn with the mood block when the scene has no steer', () => {
    const built = buildRewritePromptV4({ ...input, steer: null })
    expect(built.messages[1]?.content.startsWith(`${MOOD}\n\nText before:`)).toBe(true)
  })

  it("is version 3's messages exactly with no mood block", () => {
    expect(buildRewritePromptV4({ ...input, mood: null }).messages).toEqual(
      buildRewritePromptV3({ ...input }).messages
    )
  })
})
