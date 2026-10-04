import { describe, expect, it } from 'vitest'
import { estimateTokens } from '@shared/ai'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { SCENE_STEER_HEADING } from '@shared/sceneSteer'
import { STORY_BIBLE_HEADING } from '@shared/storyBible'
import { REWRITE_RULES } from './rewrite.v1'
import { buildRewritePromptV2 } from './rewrite.v2'
import { buildRewritePromptV3, type BuildRewritePromptV3Input } from './rewrite.v3'

const PASSAGE =
  'The storm broke at dusk over the dark forest. Mara counted the lightning gaps, each one ' +
  'shorter than the last.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara, tense.'
const STEER = `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`

const bare: BuildRewritePromptV3Input = {
  text: PASSAGE,
  before: '',
  after: '',
  meta: null,
  voice: null,
  bible: null,
  steer: null
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('rewrite.v3 prompt (F-14.10, F-14.9, F-14.13)', () => {
  it('keeps version 1’s rules exactly, sentinel included', () => {
    const built = buildRewritePromptV3({ ...bare, steer: STEER })
    expect(built.version).toBe('rewrite.v3')
    expect(built.messages[0]?.content).toBe(REWRITE_RULES)
    expect(
      built.messages[0]?.content.startsWith(
        'You are the rewrite feature inside a novel-writing app.'
      )
    ).toBe(true)
    expect('temperature' in built).toBe(false)
  })

  it('opens the user turn with the steer, before the text each side of the passage, leaving the system turn alone', () => {
    const input = {
      ...bare,
      before: 'She set the lantern down on the post.',
      after: 'She did not wait to see his face.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      voice: "Match the author's voice:\n- Narration is in past tense.",
      bible: BIBLE
    }
    const built = buildRewritePromptV3({ ...input, steer: STEER })
    expect(built.messages[0]).toEqual(buildRewritePromptV2(input).messages[0])
    expect(built.messages[1]?.content).toBe(
      `${STEER}\n\n` +
        'Text before:\n"""\nShe set the lantern down on the post.\n"""\n\n' +
        'Text after:\n"""\nShe did not wait to see his face.\n"""\n\n' +
        `Passage to rewrite:\n"""\n${PASSAGE}\n"""\n\n` +
        'Rewrite the passage.'
    )
  })

  it('is the version-2 prompt when there is no steer, so nothing else moved with the version', () => {
    const input = {
      ...bare,
      before: 'She set the lantern down on the post.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      voice: "Match the author's voice:\n- Narration is in past tense.",
      bible: BIBLE
    }
    const v3 = buildRewritePromptV3({ ...input, steer: null })
    const v2 = buildRewritePromptV2(input)
    expect(v3.messages).toEqual(v2.messages)
    expect(v3.maxTokens).toBe(v2.maxTokens)
  })

  it('costs what the golden estimates say', () => {
    // A change here means the prompt changed and needs a new version.
    expect(estimateTokens(promptText(buildRewritePromptV3(bare).messages))).toBe(153)
    expect(
      estimateTokens(promptText(buildRewritePromptV3({ ...bare, steer: STEER }).messages))
    ).toBe(172)
  })
})
