import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { CRITIQUE_SCENE_CHAR_BUDGET, HONESTY_LEVELS } from '@shared/critique'
import { EMPTY_SCENE_BRIEF, SCENE_BRIEF_FIELD_MAX } from '@shared/sceneMeta'
import { buildCritiquePrompt, CRITIQUE_RULES, HONESTY_INSTRUCTION } from './critique.v1'
import { buildCritiquePromptV2, type BuildCritiquePromptV2Input } from './critique.v2'

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

const bare: BuildCritiquePromptV2Input = {
  sceneText: SCENE,
  brief: null,
  meta: null,
  voice: null,
  honesty: 'direct'
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('critique.v2 prompt (F-14.8, F-14.3)', () => {
  it('keeps version 1’s rules and honesty lines exactly, sentinel included: only the user turn moved', () => {
    expect(
      CRITIQUE_RULES.startsWith('You are the editor feature inside a novel-writing app.')
    ).toBe(true)
    const built = buildCritiquePromptV2(bare)
    expect(built.version).toBe('critique.v2')
    expect(built.messages[0]?.content).toBe(`${CRITIQUE_RULES} ${DIRECT}`)
    for (const honesty of HONESTY_LEVELS) {
      const system = buildCritiquePromptV2({ ...bare, honesty }).messages[0]?.content ?? ''
      expect(system).toBe(`${CRITIQUE_RULES} ${HONESTY_INSTRUCTION[honesty]}`)
    }
  })

  it('a bare scene: the scene and the instruction in the user turn, no temperature', () => {
    const built = buildCritiquePromptV2(bare)
    expect(built.messages[1]?.content).toBe(
      `Scene text:\n"""\n${SCENE}\n"""\n\nGive your editor's notes.`
    )
    expect('temperature' in built).toBe(false)
  })

  it('opens the user turn with the brief and asks for the intent note against it, not against the notes', () => {
    const built = buildCritiquePromptV2({
      ...bare,
      brief: BRIEF,
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      voice: VOICE
    })
    expect(built.messages[0]?.content).toBe(
      `${CRITIQUE_RULES} ${DIRECT} ${VOICE}\n\nScene: location Ferry landing, POV Mara, timeline —.`
    )
    expect(built.messages[1]?.content).toBe(
      `Scene brief (the author's intent):\n"""\n${BRIEF}\n"""\n` +
        'Include one "intent" note: does the scene do what the brief says? Cite the passage ' +
        'that shows it.\n\n' +
        `Scene text:\n"""\n${SCENE}\n"""\n\n` +
        "Give your editor's notes."
    )
  })

  it('never carries the scene’s notes: the brief replaced them in this version', () => {
    const user = buildCritiquePromptV2({ ...bare, brief: BRIEF }).messages[1]?.content ?? ''
    expect(user).not.toContain("Author's notes for this scene")
    expect(
      buildCritiquePrompt({ ...bare, notes: 'Ends on the reveal.' }).messages[1]?.content
    ).toContain("Author's notes for this scene")
  })

  it('omits the brief and the intent instruction when nobody has written one', () => {
    const user = buildCritiquePromptV2(bare).messages[1]?.content ?? ''
    expect(user).not.toContain('Scene brief')
    expect(user).not.toContain('"intent" note')
  })

  it('asks for the feature output budget: the notes are only useful whole', () => {
    expect(buildCritiquePromptV2(bare).maxTokens).toBe(outputBudget('critique'))
  })

  it('stays under the critique input budget with every cap at its limit', () => {
    const built = buildCritiquePromptV2({
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
      honesty: 'brutal'
    })
    const estimate = estimateTokens(promptText(built.messages))
    expect(estimate).toBeLessThan(inputBudget('critique'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(6_522)
    expect(estimateTokens(promptText(buildCritiquePromptV2(bare).messages))).toBe(290)
  })
})
