import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  OBSERVED_ATTRIBUTES,
  OBSERVED_FACT_QUOTE_MAX,
  OBSERVED_FACT_VALUE_MAX
} from '@shared/observedFacts'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import {
  SUMMARY_FACTS_MAX,
  SUMMARY_KEY_POINTS_MAX,
  SUMMARY_KNOWN_NAMES_MAX,
  SUMMARY_SCENE_CHAR_BUDGET
} from '@shared/summary'
import { buildSummaryPrompt, SUMMARY_RULES } from './summary.v1'
import {
  buildSummaryPromptV2,
  SUMMARY_RULES_V2,
  type BuildSummaryPromptV2Input
} from './summary.v2'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'

const none = { character: [], setting: [], world: [] }
const bare: BuildSummaryPromptV2Input = { sceneText: SCENE, meta: null, known: none }

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('summary.v2 prompt (F-5.16)', () => {
  it("keeps version 1's opening sentence byte for byte: the e2e fake server keys on it", () => {
    const sentinel = 'You are the scene-summary feature inside a novel-writing app.'
    expect(SUMMARY_RULES_V2.startsWith(sentinel)).toBe(true)
    expect(SUMMARY_RULES.startsWith(sentinel)).toBe(true)
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const SUMMARY_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares SUMMARY_SENTINEL')
    expect(SUMMARY_RULES_V2.startsWith(match[1]!)).toBe(true)
  })

  it('asks for the summary as version 1 does, then for durable facts with a kind, a listed attribute, and a quote', () => {
    expect(SUMMARY_RULES_V2).toContain('at most 80 words')
    expect(SUMMARY_RULES_V2).toContain('in plain past tense')
    expect(SUMMARY_RULES_V2).toContain(`up to ${SUMMARY_KEY_POINTS_MAX} key points`)
    expect(SUMMARY_RULES_V2).toContain(`up to ${SUMMARY_FACTS_MAX} facts`)
    expect(SUMMARY_RULES_V2).toContain('that stay true beyond this scene')
    expect(SUMMARY_RULES_V2).toContain('events belong in the key points')
    // The vocabulary is the shared one, so a new attribute is a new prompt version by construction.
    expect(SUMMARY_RULES_V2).toContain(`character: ${OBSERVED_ATTRIBUTES.character.join(', ')}`)
    expect(SUMMARY_RULES_V2).toContain(`setting: ${OBSERVED_ATTRIBUTES.setting.join(', ')}`)
    expect(SUMMARY_RULES_V2).toContain(`world: ${OBSERVED_ATTRIBUTES.world.join(', ')}`)
    expect(SUMMARY_RULES_V2).toContain(`the value in at most ${OBSERVED_FACT_VALUE_MAX} characters`)
    expect(SUMMARY_RULES_V2).toContain(
      `copied exactly, at most ${OBSERVED_FACT_QUOTE_MAX} characters`
    )
    expect(SUMMARY_RULES_V2).toContain('a fact whose quote is not in the scene is thrown away')
    expect(SUMMARY_RULES_V2).toContain(
      '{"summary":"...","keyPoints":["..."],"characters":["..."],"facts":[{"entity":"...",' +
        '"kind":"character","attribute":"age","value":"...","quote":"..."}]}'
    )
  })

  it("matches the golden messages for a bare scene, with version 1's user turn and no voice block", () => {
    const built = buildSummaryPromptV2(bare)
    expect(built.version).toBe('summary.v2')
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[0]?.content).toBe(SUMMARY_RULES_V2)
    expect(built.messages[1]).toEqual(
      buildSummaryPrompt({ sceneText: SCENE, meta: null, characters: [] }).messages[1]
    )
    expect(promptText(built.messages)).not.toContain("Match the author's voice:")
    expect('temperature' in built).toBe(false)
  })

  it('lists the known names by kind and then the scene line in the system turn, so the prefix stays cacheable', () => {
    const built = buildSummaryPromptV2({
      ...bare,
      known: { character: ['Mara', 'Tomas'], setting: ['Ferry landing'], world: ['the Toll'] },
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF }
    })
    expect(built.messages[0]?.content).toBe(
      `${SUMMARY_RULES_V2}\n\nStory-bible names in this scene: characters Mara, Tomas; ` +
        'settings Ferry landing; world the Toll.' +
        '\n\nScene: location Ferry landing, POV Mara, timeline —.'
    )
    expect(built.messages[1]?.content).toBe(buildSummaryPromptV2(bare).messages[1]?.content)
  })

  it('leaves out a kind with no name, and the whole line with none at all', () => {
    const system = buildSummaryPromptV2({
      ...bare,
      known: { character: [], setting: ['Ferry landing'], world: [] }
    }).messages[0]?.content
    expect(system).toBe(
      `${SUMMARY_RULES_V2}\n\nStory-bible names in this scene: settings Ferry landing.`
    )
    expect(buildSummaryPromptV2(bare).messages[0]?.content).not.toContain('Story-bible names')
  })

  it('lists at most SUMMARY_KNOWN_NAMES_MAX names in all, spent in kind order', () => {
    const names = (prefix: string, length: number): string[] =>
      Array.from({ length }, (_, i) => `${prefix}-${i}`)
    const system =
      buildSummaryPromptV2({
        ...bare,
        known: {
          character: names('person', SUMMARY_KNOWN_NAMES_MAX - 1),
          setting: names('place', 5),
          world: names('thing', 5)
        }
      }).messages[0]?.content ?? ''
    expect(system).toContain(`person-${SUMMARY_KNOWN_NAMES_MAX - 2}; settings place-0.`)
    expect(system).not.toContain('place-1')
    expect(system).not.toContain('thing-')
  })

  it('asks for the feature output budget: the summary plus up to six facts as one JSON object', () => {
    expect(buildSummaryPromptV2(bare).maxTokens).toBe(outputBudget('summary'))
    expect(buildSummaryPromptV2(bare).maxTokens).toBe(1_000)
  })

  it('stays under the summary input budget with every cap at its limit', () => {
    const built = buildSummaryPromptV2({
      sceneText: 's'.repeat(SUMMARY_SCENE_CHAR_BUDGET),
      known: {
        character: Array.from({ length: SUMMARY_KNOWN_NAMES_MAX }, (_, i) => `Character Name ${i}`),
        setting: [],
        world: []
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
    expect(estimate).toBe(5_756)
    expect(estimateTokens(promptText(buildSummaryPromptV2(bare).messages))).toBe(367)
  })
})
