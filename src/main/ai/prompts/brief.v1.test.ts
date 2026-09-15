import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { BRIEF_SCENE_CHAR_BUDGET, EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'
import { buildBriefPrompt, BRIEF_RULES, type BuildBriefPromptInput } from './brief.v1'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'
const RULES =
  'You are the scene-brief feature inside a novel-writing app. Read the scene below and say ' +
  'what it is doing, so the author can correct you: goal (what the point-of-view character ' +
  'wants here), conflict (what stands in the way), turn (how the scene ends differently from ' +
  'how it began), beat (the emotional beat it lands on), after (what the reader knows at the ' +
  'end that they did not before). One plain sentence each, at most 200 characters, in your ' +
  'own words: do not quote the scene, do not summarise it, and do not give advice. Use "" ' +
  'for anything the scene does not show. Reply with JSON only: ' +
  '{"goal":"...","conflict":"...","turn":"...","beat":"...","after":"..."}.'

const bare: BuildBriefPromptInput = { sceneText: SCENE, meta: null }

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('brief.v1 prompt (F-14.3)', () => {
  it('opens the rules with the sentence the fake server keys on, and never edits it within the version', () => {
    expect(BRIEF_RULES).toBe(RULES)
    expect(
      BRIEF_RULES.startsWith('You are the scene-brief feature inside a novel-writing app.')
    ).toBe(true)
  })

  it("pins the e2e fake server's BRIEF_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const BRIEF_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares BRIEF_SENTINEL')
    expect(BRIEF_RULES.startsWith(match[1]!)).toBe(true)
  })

  it('names the five fields, the per-line cap, and the empty-string answer, so a thin scene is not invented over', () => {
    for (const field of ['goal', 'conflict', 'turn', 'beat', 'after']) {
      expect(BRIEF_RULES).toContain(field)
    }
    expect(BRIEF_RULES).toContain('at most 200 characters')
    expect(BRIEF_RULES).toContain('Use "" for anything the scene does not show.')
    expect(BRIEF_RULES).toContain(
      '{"goal":"...","conflict":"...","turn":"...","beat":"...","after":"..."}'
    )
  })

  it('a bare scene: the rules alone system-side, the scene and the instruction in the user turn, no temperature', () => {
    const built = buildBriefPrompt(bare)
    expect(built.version).toBe('brief.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: RULES },
      { role: 'user', content: `Scene text:\n"""\n${SCENE}\n"""\n\nDraft the brief.` }
    ])
    expect('temperature' in built).toBe(false)
  })

  it('appends the scene line to the system turn when the scene has metadata, so the prefix stays cacheable', () => {
    const built = buildBriefPrompt({
      ...bare,
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF }
    })
    expect(built.messages[0]?.content).toBe(
      `${RULES}\n\nScene: location Ferry landing, POV Mara, timeline —.`
    )
    expect(built.messages[1]?.content).toBe(buildBriefPrompt(bare).messages[1]?.content)
  })

  it('carries no voice block: the brief states intent, not prose', () => {
    expect(promptText(buildBriefPrompt(bare).messages)).not.toContain("Match the author's voice:")
  })

  it('asks for the feature output budget: five short lines of JSON', () => {
    expect(buildBriefPrompt(bare).maxTokens).toBe(outputBudget('brief'))
    expect(buildBriefPrompt(bare).maxTokens).toBe(200)
  })

  it('stays under the brief input budget with every cap at its limit', () => {
    const built = buildBriefPrompt({
      sceneText: 's'.repeat(BRIEF_SCENE_CHAR_BUDGET),
      meta: {
        location: 'L'.repeat(200),
        pov: 'P'.repeat(200),
        timeline: 'T'.repeat(500),
        brief: EMPTY_SCENE_BRIEF
      }
    })
    const estimate = estimateTokens(promptText(built.messages))
    expect(estimate).toBeLessThan(inputBudget('brief'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(5_410)
    expect(estimateTokens(promptText(buildBriefPrompt(bare).messages))).toBe(220)
  })
})
