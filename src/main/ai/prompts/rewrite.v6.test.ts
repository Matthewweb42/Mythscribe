import { describe, expect, it } from 'vitest'
import { renderSceneMood } from '@shared/sceneCard'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { buildRewritePromptV4, type BuildRewritePromptV4Input } from './rewrite.v4'
import { buildRewritePromptV6, REWRITE_V6_VIBE_LINE } from './rewrite.v6'

const PASSAGE =
  'The storm broke at dusk over the dark forest. Mara counted the lightning gaps, each one ' +
  'shorter than the last.'

const input: BuildRewritePromptV4Input = {
  text: PASSAGE,
  before: 'She set the lantern down on the post.',
  after: '',
  meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
  voice: "Match the author's voice:\n- Narration is in past tense.",
  bible: null,
  steer: null,
  mood: renderSceneMood('quiet dread', 'debts come due')
}

describe('rewrite.v6 prompt (F-14.10 in Vibe, notes fixes 2026-10-15)', () => {
  it('is version 4’s request with the bolder line last in the user turn', () => {
    const built = buildRewritePromptV6(input)
    const v4 = buildRewritePromptV4(input)
    expect(built.version).toBe('rewrite.v6')
    // The cached part (the system turn) is version 4's: Write and Vibe share it.
    expect(built.messages[0]).toEqual(v4.messages[0])
    expect(built.messages[1]?.content).toBe(
      `${v4.messages[1]?.content ?? ''}\n\n${REWRITE_V6_VIBE_LINE}`
    )
    expect(
      built.messages[1]?.content.endsWith(`Rewrite the passage.\n\n${REWRITE_V6_VIBE_LINE}`)
    ).toBe(true)
    expect(built.maxTokens).toBe(v4.maxTokens)
    expect(built.messages).toMatchSnapshot()
  })

  it('names what Vibe may do, and what it keeps', () => {
    for (const part of [
      'tighten hard',
      'cut what drags',
      'reorder sentences',
      'sharpen the dialogue',
      'add a missing beat',
      'Stay within this passage',
      'point of view, tense, names and facts',
      'the author’s voice'
    ]) {
      expect(REWRITE_V6_VIBE_LINE).toContain(part)
    }
  })
})
