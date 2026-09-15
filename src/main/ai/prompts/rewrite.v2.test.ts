import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { REWRITE_CONTEXT_CHARS, REWRITE_TEXT_MAX } from '@shared/rewrite'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { STORY_BIBLE_HEADING, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import { buildRewritePrompt, REWRITE_RULES } from './rewrite.v1'
import { buildRewritePromptV2, type BuildRewritePromptV2Input } from './rewrite.v2'

const PASSAGE =
  'The storm broke at dusk over the dark forest. Mara counted the lightning gaps, each one ' +
  'shorter than the last.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'

const bare: BuildRewritePromptV2Input = {
  text: PASSAGE,
  before: '',
  after: '',
  meta: null,
  voice: null,
  bible: null
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('rewrite.v2 prompt (F-14.10, F-14.9)', () => {
  it('keeps version 1’s rules exactly, sentinel included: only the bible was added', () => {
    expect(REWRITE_RULES.startsWith('You are the rewrite feature inside a novel-writing app.')).toBe(
      true
    )
    const built = buildRewritePromptV2(bare)
    expect(built.version).toBe('rewrite.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: REWRITE_RULES },
      {
        role: 'user',
        content: `Passage to rewrite:\n"""\n${PASSAGE}\n"""\n\nRewrite the passage.`
      }
    ])
    expect('temperature' in built).toBe(false)
  })

  it('puts the voice block, the story bible, and the scene line in the system turn, in that order, and the context each side of the passage in the user turn', () => {
    const built = buildRewritePromptV2({
      ...bare,
      before: 'She set the lantern down on the post.',
      after: 'She did not wait to see his face.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      voice: "Match the author's voice:\n- Narration is in past tense.",
      bible: BIBLE
    })
    expect(built.messages[0]?.content).toBe(
      `${REWRITE_RULES} Match the author's voice:\n- Narration is in past tense.\n\n` +
        `${BIBLE}\n\n` +
        'Scene: location Ferry landing, POV Mara, timeline —.'
    )
    expect(built.messages[1]?.content).toBe(
      'Text before:\n"""\nShe set the lantern down on the post.\n"""\n\n' +
        'Text after:\n"""\nShe did not wait to see his face.\n"""\n\n' +
        `Passage to rewrite:\n"""\n${PASSAGE}\n"""\n\n` +
        'Rewrite the passage.'
    )
  })

  it('is the version-1 prompt when there is no bible, so nothing else moved with the version', () => {
    const input = {
      ...bare,
      before: 'She set the lantern down on the post.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      voice: "Match the author's voice:\n- Narration is in past tense."
    }
    expect(buildRewritePromptV2({ ...input, bible: null }).messages).toEqual(
      buildRewritePrompt(input).messages
    )
  })

  it('asks for the passage at 1.5× plus slack, clamped to the feature output budget', () => {
    expect(buildRewritePromptV2(bare).maxTokens).toBe(Math.ceil(estimateTokens(PASSAGE) * 1.5) + 40)
    expect(buildRewritePromptV2({ ...bare, text: 'x'.repeat(REWRITE_TEXT_MAX) }).maxTokens).toBe(
      Math.min(Math.ceil((REWRITE_TEXT_MAX / 4) * 1.5) + 40, outputBudget('rewrite'))
    )
  })

  it('stays under the rewrite input budget with every cap at its limit, the bible included', () => {
    const maxed: BuildRewritePromptV2Input = {
      text: 't'.repeat(REWRITE_TEXT_MAX),
      before: 'b'.repeat(REWRITE_CONTEXT_CHARS),
      after: 'a'.repeat(REWRITE_CONTEXT_CHARS),
      meta: {
        location: 'L'.repeat(200),
        pov: 'P'.repeat(200),
        timeline: 'T'.repeat(500),
        brief: EMPTY_SCENE_BRIEF
      },
      voice: 'v'.repeat(2_400),
      bible: 'g'.repeat(STORY_BIBLE_TOKEN_BUDGET * 4)
    }
    const estimate = estimateTokens(promptText(buildRewritePromptV2(maxed).messages))
    expect(estimate).toBeLessThan(inputBudget('rewrite'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(2_522)
    expect(
      estimateTokens(promptText(buildRewritePromptV2({ ...maxed, bible: null }).messages))
    ).toBe(2_121)
    expect(estimateTokens(promptText(buildRewritePromptV2(bare).messages))).toBe(153)
  })
})
