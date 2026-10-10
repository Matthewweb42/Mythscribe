import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { SUMMARY_SCENE_CHAR_BUDGET } from '@shared/summary'
import {
  buildSummaryPromptV4,
  SUMMARY_RULES_V4,
  type BuildSummaryPromptV4Input
} from './summary.v4'
import { buildSummaryPromptV5, SUMMARY_RULES_V5 } from './summary.v5'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'

const bare: BuildSummaryPromptV4Input = {
  sceneText: SCENE,
  meta: null,
  known: { character: [], setting: [], world: [] },
  bank: { tone: [], content: [], plotThread: [], custom: [] },
  threads: []
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('summary.v5 prompt (F-5.6, mood and theme)', () => {
  it("keeps version 1's opening sentence: the e2e fake server keys on it", () => {
    expect(
      SUMMARY_RULES_V5.startsWith('You are the scene-summary feature inside a novel-writing app.')
    ).toBe(true)
  })

  it("is version 4's rules with the mood-and-theme clause and two keys after the card", () => {
    expect(SUMMARY_RULES_V5).toContain(
      'Then deduce the mood (its emotional atmosphere) and the theme (the idea it explores) of ' +
        'the scene as a whole, each a short phrase of at most 60 characters; they are your ' +
        'reading, not tags. Then up to 4 relationships'
    )
    expect(SUMMARY_RULES_V5).toContain('"changed":"..."},"mood":"...","theme":"...","relations":[')
    // Nothing else moved: taking the two insertions out gives version 4 back.
    expect(
      SUMMARY_RULES_V5.replace(
        ' Then deduce the mood (its emotional atmosphere) and the theme (the idea it explores) of ' +
          'the scene as a whole, each a short phrase of at most 60 characters; they are your ' +
          'reading, not tags.',
        ''
      ).replace('"mood":"...","theme":"...",', '')
    ).toBe(SUMMARY_RULES_V4)
  })

  it("matches the golden messages, with version 4's context and user turn", () => {
    const full: BuildSummaryPromptV4Input = {
      ...bare,
      known: { character: ['Mara'], setting: [], world: [] },
      bank: { tone: ['dread'], content: [], plotThread: [], custom: [] },
      threads: ['The Debt'],
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF }
    }
    const built = buildSummaryPromptV5(full)
    const v4 = buildSummaryPromptV4(full)
    expect(built.version).toBe('summary.v5')
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content).toBe(
      `${SUMMARY_RULES_V5}${(v4.messages[0]?.content ?? '').slice(SUMMARY_RULES_V4.length)}`
    )
    expect(built.messages[1]).toEqual(v4.messages[1])
  })

  it("keeps version 4's output budget and stays under the input budget at every cap", () => {
    expect(buildSummaryPromptV5(bare).maxTokens).toBe(outputBudget('summary'))
    const maxed = buildSummaryPromptV5({
      ...bare,
      sceneText: 's'.repeat(SUMMARY_SCENE_CHAR_BUDGET),
      meta: {
        location: 'L'.repeat(200),
        pov: 'P'.repeat(200),
        timeline: 'T'.repeat(500),
        brief: EMPTY_SCENE_BRIEF
      }
    })
    expect(estimateTokens(promptText(maxed.messages))).toBeLessThan(inputBudget('summary'))
  })
})
