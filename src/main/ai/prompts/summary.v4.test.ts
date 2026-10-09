import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import {
  SUMMARY_BANK_TAGS_MAX,
  SUMMARY_KNOWN_NAMES_MAX,
  SUMMARY_NEW_THREADS_MAX,
  SUMMARY_RELATIONS_MAX,
  SUMMARY_SCENE_CHAR_BUDGET,
  SUMMARY_THREADS_MAX
} from '@shared/summary'
import { buildSummaryPromptV3, SUMMARY_RULES_V3 } from './summary.v3'
import {
  buildSummaryPromptV4,
  SUMMARY_RULES_V4,
  SUMMARY_THREAD_NAMES_MAX,
  type BuildSummaryPromptV4Input
} from './summary.v4'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'

const none = { character: [], setting: [], world: [] }
const noBank = { tone: [], content: [], plotThread: [], custom: [] }
const bare: BuildSummaryPromptV4Input = {
  sceneText: SCENE,
  meta: null,
  known: none,
  bank: noBank,
  threads: []
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('summary.v4 prompt (F-9.14)', () => {
  it("keeps version 1's opening sentence: the e2e fake server keys on it", () => {
    expect(
      SUMMARY_RULES_V4.startsWith('You are the scene-summary feature inside a novel-writing app.')
    ).toBe(true)
  })

  it("is version 3's rules with the card, relationship, and thread clauses before the reply shape", () => {
    const v3Body = SUMMARY_RULES_V3.slice(0, SUMMARY_RULES_V3.indexOf(' Reply with JSON only: '))
    expect(SUMMARY_RULES_V4.startsWith(`${v3Body} Then the scene card:`)).toBe(true)
    expect(SUMMARY_RULES_V4).toContain(`Then up to ${SUMMARY_RELATIONS_MAX} relationships`)
    expect(SUMMARY_RULES_V4).toContain(
      '(family, partner, friend, ally, enemy, rival, mentor, serves, member-of, owns, located-in, other)'
    )
    expect(SUMMARY_RULES_V4).toContain(`Then up to ${SUMMARY_THREADS_MAX} plot-thread events`)
    expect(SUMMARY_RULES_V4).toContain(`at most ${SUMMARY_NEW_THREADS_MAX} new`)
    expect(SUMMARY_RULES_V4).toContain('(opened, advanced, resolved, dropped)')
    // The "no assuming" rule, word for word.
    expect(SUMMARY_RULES_V4).toContain('Record only what the text states')
    expect(SUMMARY_RULES_V4).toContain('rather than guess')
    expect(SUMMARY_RULES_V4).toContain('"tags":[{"name":"...","category":"tone"}],"card":{')
    expect(
      SUMMARY_RULES_V4.endsWith(
        '"threads":[{"name":"...","event":"opened","question":"...","quote":"..."}]}.'
      )
    ).toBe(true)
  })

  it("matches the golden messages for a bare scene, with version 3's user turn", () => {
    const built = buildSummaryPromptV4(bare)
    expect(built.version).toBe('summary.v4')
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content).toBe(SUMMARY_RULES_V4)
    expect(built.messages[1]).toEqual(buildSummaryPromptV3(bare).messages[1])
  })

  it('puts the thread line after the tag bank and before the scene line', () => {
    const built = buildSummaryPromptV4({
      ...bare,
      known: { character: ['Mara'], setting: [], world: [] },
      bank: { tone: ['dread'], content: [], plotThread: ['the-debt'], custom: [] },
      threads: ['The Debt', 'The Missing Bell'],
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF }
    })
    expect(built.messages[0]?.content).toBe(
      `${SUMMARY_RULES_V4}\n\nStory-bible names in this scene: characters Mara.` +
        '\n\nTag bank: tone dread; plotThread the-debt.' +
        '\n\nThreads: The Debt, The Missing Bell.' +
        '\n\nScene: location Ferry landing, POV Mara, timeline —.'
    )
  })

  it('lists at most SUMMARY_THREAD_NAMES_MAX thread names', () => {
    const threads = Array.from({ length: SUMMARY_THREAD_NAMES_MAX + 3 }, (_, i) => `Thread ${i}`)
    const system = buildSummaryPromptV4({ ...bare, threads }).messages[0]?.content ?? ''
    expect(system).toContain(`Thread ${SUMMARY_THREAD_NAMES_MAX - 1}.`)
    expect(system).not.toContain(`Thread ${SUMMARY_THREAD_NAMES_MAX},`)
  })

  it('asks for the feature output budget: the summary, facts, tags, card, relations, and threads as one JSON object', () => {
    expect(buildSummaryPromptV4(bare).maxTokens).toBe(outputBudget('summary'))
    expect(buildSummaryPromptV4(bare).maxTokens).toBe(1_000)
  })

  it('stays under the summary input budget with every cap at its limit', () => {
    const built = buildSummaryPromptV4({
      sceneText: 's'.repeat(SUMMARY_SCENE_CHAR_BUDGET),
      known: {
        character: Array.from({ length: SUMMARY_KNOWN_NAMES_MAX }, (_, i) => `Character Name ${i}`),
        setting: [],
        world: []
      },
      bank: {
        tone: Array.from({ length: SUMMARY_BANK_TAGS_MAX }, (_, i) => `a-long-tone-name-${i}`),
        content: [],
        plotThread: [],
        custom: []
      },
      threads: Array.from(
        { length: SUMMARY_THREAD_NAMES_MAX },
        (_, i) => `A Long Thread Name ${i}`
      ),
      meta: {
        location: 'L'.repeat(200),
        pov: 'P'.repeat(200),
        timeline: 'T'.repeat(500),
        brief: EMPTY_SCENE_BRIEF
      }
    })
    const estimate = estimateTokens(promptText(built.messages))
    expect(estimate).toBeLessThan(inputBudget('summary'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(6_458)
    expect(estimateTokens(promptText(buildSummaryPromptV4(bare).messages))).toBe(742)
  })
})
