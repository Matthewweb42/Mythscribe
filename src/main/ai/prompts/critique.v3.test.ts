import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { CRITIQUE_SCENE_CHAR_BUDGET, HONESTY_LEVELS } from '@shared/critique'
import { EMPTY_SCENE_BRIEF, SCENE_BRIEF_FIELD_MAX } from '@shared/sceneMeta'
import { STORY_BIBLE_HEADING, STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import { CRITIQUE_RULES, HONESTY_INSTRUCTION } from './critique.v1'
import { buildCritiquePromptV2 } from './critique.v2'
import { buildCritiquePromptV3, type BuildCritiquePromptV3Input } from './critique.v3'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'
const BRIEF = [
  'Scene brief:',
  '- Goal: Mara wants Tomas to admit what he owes.',
  '- Conflict: He will not talk while the river is up.',
  'Previous scene, reader knows after: Her brother copied the ledger.',
  "Next scene's goal: Tomas counts what the mill owes."
].join('\n')
const VOICE = "Match the author's voice:\n- Narration is in past tense."
const DIRECT = 'Be specific and direct: name the problem plainly, no softening and no flattery.'
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'

const bare: BuildCritiquePromptV3Input = {
  sceneText: SCENE,
  brief: null,
  meta: null,
  voice: null,
  bible: null,
  honesty: 'direct'
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('critique.v3 prompt (F-14.8, F-14.3, F-14.9)', () => {
  it('keeps version 1’s rules and honesty lines exactly, sentinel included', () => {
    expect(
      CRITIQUE_RULES.startsWith('You are the editor feature inside a novel-writing app.')
    ).toBe(true)
    const built = buildCritiquePromptV3(bare)
    expect(built.version).toBe('critique.v3')
    expect(built.messages[0]?.content).toBe(`${CRITIQUE_RULES} ${DIRECT}`)
    for (const honesty of HONESTY_LEVELS) {
      const system = buildCritiquePromptV3({ ...bare, honesty }).messages[0]?.content ?? ''
      expect(system).toBe(`${CRITIQUE_RULES} ${HONESTY_INSTRUCTION[honesty]}`)
    }
  })

  it("pins the e2e fake server's CRITIQUE_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const CRITIQUE_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares CRITIQUE_SENTINEL')
    expect(CRITIQUE_RULES.startsWith(match[1]!)).toBe(true)
  })

  it('a bare scene: the scene and the instruction in the user turn, no temperature', () => {
    const built = buildCritiquePromptV3(bare)
    expect(built.messages[1]?.content).toBe(
      `Scene text:\n"""\n${SCENE}\n"""\n\nGive your editor's notes.`
    )
    expect('temperature' in built).toBe(false)
  })

  it('puts the voice block, the story bible, and the scene line in the system turn in that order, and the brief in the user turn', () => {
    const built = buildCritiquePromptV3({
      ...bare,
      brief: BRIEF,
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      voice: VOICE,
      bible: BIBLE
    })
    expect(built.messages[0]?.content).toBe(
      `${CRITIQUE_RULES} ${DIRECT} ${VOICE}\n\n${BIBLE}\n\n` +
        'Scene: location Ferry landing, POV Mara, timeline —.'
    )
    expect(built.messages[1]?.content).toBe(
      `Scene brief (the author's intent):\n"""\n${BRIEF}\n"""\n` +
        'Include one "intent" note: does the scene do what the brief says? Cite the passage ' +
        'that shows it.\n\n' +
        `Scene text:\n"""\n${SCENE}\n"""\n\n` +
        "Give your editor's notes."
    )
  })

  it('is the version-2 prompt when there is no bible, so nothing else moved with the version', () => {
    const input = {
      ...bare,
      brief: BRIEF,
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      voice: VOICE
    }
    expect(buildCritiquePromptV3({ ...input, bible: null }).messages).toEqual(
      buildCritiquePromptV2(input).messages
    )
  })

  it('omits the brief and the intent instruction when nobody has written one', () => {
    const user = buildCritiquePromptV3({ ...bare, bible: BIBLE }).messages[1]?.content ?? ''
    expect(user).not.toContain('Scene brief')
    expect(user).not.toContain('"intent" note')
  })

  it('asks for the feature output budget: the notes are only useful whole', () => {
    expect(buildCritiquePromptV3(bare).maxTokens).toBe(outputBudget('critique'))
  })

  it('stays under the critique input budget with every cap at its limit, the bible included', () => {
    const maxed: BuildCritiquePromptV3Input = {
      sceneText: 's'.repeat(CRITIQUE_SCENE_CHAR_BUDGET),
      brief: ['g', 'c', 't', 'b', 'a', 'p', 'n']
        .map((c) => c.repeat(SCENE_BRIEF_FIELD_MAX + 30))
        .join('\n'),
      meta: {
        location: 'L'.repeat(200),
        pov: 'P'.repeat(200),
        timeline: 'T'.repeat(500),
        brief: EMPTY_SCENE_BRIEF
      },
      voice: 'v'.repeat(2_400),
      bible: 'g'.repeat(STORY_BIBLE_TOKEN_BUDGET * 4),
      honesty: 'brutal'
    }
    const estimate = estimateTokens(promptText(buildCritiquePromptV3(maxed).messages))
    expect(estimate).toBeLessThan(inputBudget('critique'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(6_922)
    expect(
      estimateTokens(promptText(buildCritiquePromptV3({ ...maxed, bible: null }).messages))
    ).toBe(6_522)
    expect(estimateTokens(promptText(buildCritiquePromptV3(bare).messages))).toBe(290)
  })
})
