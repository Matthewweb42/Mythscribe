import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import {
  SUMMARY_BANK_TAGS_MAX,
  SUMMARY_KNOWN_NAMES_MAX,
  SUMMARY_NEW_TAGS_MAX,
  SUMMARY_SCENE_CHAR_BUDGET,
  SUMMARY_TAGS_MAX
} from '@shared/summary'
import { buildSummaryPromptV2, SUMMARY_RULES_V2 } from './summary.v2'
import {
  buildSummaryPromptV3,
  SUMMARY_RULES_V3,
  type BuildSummaryPromptV3Input
} from './summary.v3'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'

const none = { character: [], setting: [], world: [] }
const noBank = { tone: [], content: [], plotThread: [], custom: [] }
const bare: BuildSummaryPromptV3Input = { sceneText: SCENE, meta: null, known: none, bank: noBank }

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('summary.v3 prompt (F-4.13)', () => {
  it("keeps version 1's opening sentence: the e2e fake server keys on it", () => {
    expect(
      SUMMARY_RULES_V3.startsWith('You are the scene-summary feature inside a novel-writing app.')
    ).toBe(true)
  })

  it("is version 2's rules with the tags clause before the reply shape and tags in the shape", () => {
    const v2Body = SUMMARY_RULES_V2.slice(0, SUMMARY_RULES_V2.indexOf(' Reply with JSON only: '))
    expect(SUMMARY_RULES_V3.startsWith(`${v2Body} Then give up to ${SUMMARY_TAGS_MAX} tags`)).toBe(
      true
    )
    expect(SUMMARY_RULES_V3).toContain('its tones, themes, and plot threads')
    expect(SUMMARY_RULES_V3).toContain(
      '(character, setting, worldBuilding, tone, plotThread, custom; a theme is custom)'
    )
    expect(SUMMARY_RULES_V3).toContain(`at most ${SUMMARY_NEW_TAGS_MAX} names that are in neither.`)
    expect(SUMMARY_RULES_V3.endsWith(',"tags":[{"name":"...","category":"tone"}]}.')).toBe(true)
    expect(SUMMARY_RULES_V3).toContain('"facts":[{"entity":"..."')
  })

  it("matches the golden messages for a bare scene, with version 2's user turn", () => {
    const built = buildSummaryPromptV3(bare)
    expect(built.version).toBe('summary.v3')
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content).toBe(SUMMARY_RULES_V3)
    expect(built.messages[1]).toEqual(buildSummaryPromptV2(bare).messages[1])
  })

  it('puts the tag bank after the known names and before the scene line', () => {
    const built = buildSummaryPromptV3({
      ...bare,
      known: { character: ['Mara'], setting: [], world: [] },
      bank: { tone: ['dread', 'hope'], content: [], plotThread: ['the-debt'], custom: ['grief'] },
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF }
    })
    expect(built.messages[0]?.content).toBe(
      `${SUMMARY_RULES_V3}\n\nStory-bible names in this scene: characters Mara.` +
        '\n\nTag bank: tone dread, hope; plotThread the-debt; custom grief.' +
        '\n\nScene: location Ferry landing, POV Mara, timeline —.'
    )
  })

  it('lists at most SUMMARY_BANK_TAGS_MAX bank names in all, spent in category order', () => {
    const names = (prefix: string, length: number): string[] =>
      Array.from({ length }, (_, i) => `${prefix}-${i}`)
    const system =
      buildSummaryPromptV3({
        ...bare,
        bank: {
          tone: names('tone', SUMMARY_BANK_TAGS_MAX - 1),
          content: names('content', 5),
          plotThread: names('plot', 5),
          custom: []
        }
      }).messages[0]?.content ?? ''
    expect(system).toContain(`tone-${SUMMARY_BANK_TAGS_MAX - 2}; content content-0.`)
    expect(system).not.toContain('content-1')
    expect(system).not.toContain('plot-')
  })

  it('asks for the feature output budget: the summary, six facts, and eight tags as one JSON object', () => {
    expect(buildSummaryPromptV3(bare).maxTokens).toBe(outputBudget('summary'))
    expect(buildSummaryPromptV3(bare).maxTokens).toBe(800)
  })

  it('stays under the summary input budget with every cap at its limit', () => {
    const built = buildSummaryPromptV3({
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
    expect(estimate).toBe(6_083)
    expect(estimateTokens(promptText(buildSummaryPromptV3(bare).messages))).toBe(483)
  })
})
