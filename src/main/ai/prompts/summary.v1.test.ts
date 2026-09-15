import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import {
  SUMMARY_BANK_NAMES_MAX,
  SUMMARY_KEY_POINTS_MAX,
  SUMMARY_SCENE_CHAR_BUDGET
} from '@shared/summary'
import { buildSummaryPrompt, SUMMARY_RULES, type BuildSummaryPromptInput } from './summary.v1'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'

const bare: BuildSummaryPromptInput = { sceneText: SCENE, meta: null, characters: [] }

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('summary.v1 prompt (F-5.6)', () => {
  it('opens the rules with the sentence the fake server keys on, and never edits it within the version', () => {
    expect(
      SUMMARY_RULES.startsWith('You are the scene-summary feature inside a novel-writing app.')
    ).toBe(true)
  })

  it("pins the e2e fake server's SUMMARY_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const SUMMARY_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares SUMMARY_SENTINEL')
    expect(SUMMARY_RULES.startsWith(match[1]!)).toBe(true)
  })

  it('asks for a short past-tense summary, the key points, the cast, and JSON only', () => {
    expect(SUMMARY_RULES).toContain('at most 80 words')
    expect(SUMMARY_RULES).toContain('in plain past tense')
    expect(SUMMARY_RULES).toContain('do not give advice')
    expect(SUMMARY_RULES).toContain(`up to ${SUMMARY_KEY_POINTS_MAX} key points`)
    expect(SUMMARY_RULES).toContain('{"summary":"...","keyPoints":["..."],"characters":["..."]}')
  })

  it('matches the golden messages for a bare scene and carries no voice block', () => {
    const built = buildSummaryPrompt(bare)
    expect(built.version).toBe('summary.v1')
    expect(built.messages).toMatchSnapshot()
    expect(built.messages[1]?.content).toBe(
      `Scene text:\n"""\n${SCENE}\n"""\n\nSummarize the scene.`
    )
    expect(promptText(built.messages)).not.toContain("Match the author's voice:")
    expect('temperature' in built).toBe(false)
  })

  it('appends the cast and the scene line to the system turn, so the prefix stays cacheable', () => {
    const built = buildSummaryPrompt({
      ...bare,
      characters: ['mara', 'tomas'],
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF }
    })
    expect(built.messages[0]?.content).toBe(
      `${SUMMARY_RULES}\n\nCharacters in the story bible: mara, tomas.` +
        '\n\nScene: location Ferry landing, POV Mara, timeline —.'
    )
    expect(built.messages[1]?.content).toBe(buildSummaryPrompt(bare).messages[1]?.content)
  })

  it('lists at most SUMMARY_BANK_NAMES_MAX character names, however long the bank is', () => {
    const names = Array.from({ length: SUMMARY_BANK_NAMES_MAX + 10 }, (_, i) => `name-${i}`)
    const system = buildSummaryPrompt({ ...bare, characters: names }).messages[0]?.content ?? ''
    expect(system).toContain(`name-${SUMMARY_BANK_NAMES_MAX - 1}.`)
    expect(system).not.toContain(`name-${SUMMARY_BANK_NAMES_MAX}`)
  })

  it('asks for the feature output budget: the summary, its key points, and the cast as JSON', () => {
    expect(buildSummaryPrompt(bare).maxTokens).toBe(outputBudget('summary'))
    expect(buildSummaryPrompt(bare).maxTokens).toBe(300)
  })

  it('stays under the summary input budget with every cap at its limit', () => {
    const built = buildSummaryPrompt({
      sceneText: 's'.repeat(SUMMARY_SCENE_CHAR_BUDGET),
      characters: Array.from({ length: SUMMARY_BANK_NAMES_MAX }, (_, i) => `character-name-${i}`),
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
    expect(estimate).toBe(5_567)
    expect(estimateTokens(promptText(buildSummaryPrompt(bare).messages))).toBe(181)
  })
})
