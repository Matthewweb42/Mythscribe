import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  CRITIQUE_NOTES_CHAR_CAP,
  CRITIQUE_SCENE_CHAR_BUDGET,
  HONESTY_LEVELS
} from '@shared/critique'
import {
  buildCritiquePrompt,
  CRITIQUE_RULES,
  HONESTY_INSTRUCTION,
  type BuildCritiquePromptInput
} from './critique.v1'
import { EMPTY_SCENE_BRIEF } from '@shared/sceneMeta'

const SCENE =
  'The ferry landing was empty when Mara reached it. The rope hung slack in the water and the ' +
  'bell had lost its clapper years ago. She set the lantern down on the post and waited.'
const NOTES = 'Mara confronts Tomas at the ferry. Ends with the reveal about the elm.'
const VOICE = "Match the author's voice:\n- Narration is in past tense."
const RULES =
  "You are the editor feature inside a novel-writing app. Give the author editor's notes on " +
  'the scene below: at most 8 notes, each one in a single category out of pacing, clarity, ' +
  'showTell, pov, filterWords, repetition, attribution, intent. Every note quotes the passage ' +
  'it is about, copied from the scene word for word and at most 240 characters; a note whose ' +
  'quote is not in the scene is thrown away, praise included. Say in one or two sentences ' +
  'what is wrong, or what a praised passage does well: no summary of the scene, no general ' +
  'writing advice. An issue may carry a fix, which replaces the quoted passage and nothing ' +
  "else, in the author's voice, same point of view and tense; when you have no fix, and for " +
  'praise, the fix is null. Reply with JSON only: ' +
  '{"notes":[{"kind":"issue"|"praise","category":"...","quote":"...","why":"...","fix":"..."|null}]}.'
const DIRECT = 'Be specific and direct: name the problem plainly, no softening and no flattery.'

const bare: BuildCritiquePromptInput = {
  sceneText: SCENE,
  notes: null,
  meta: null,
  voice: null,
  honesty: 'direct'
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('critique.v1 prompt (F-14.8)', () => {
  it('opens the rules with the sentence the fake server keys on, and never edits it within the version', () => {
    expect(CRITIQUE_RULES).toBe(RULES)
    expect(
      CRITIQUE_RULES.startsWith('You are the editor feature inside a novel-writing app.')
    ).toBe(true)
  })

  it("pins the e2e fake server's CRITIQUE_SENTINEL to this version's opening (the e2e tsconfig cannot import from src/main)", () => {
    const spec = readFileSync(join(__dirname, '../../../../e2e/smoke.spec.ts'), 'utf8')
    const match = /const CRITIQUE_SENTINEL = '([^']+)'/.exec(spec)
    if (!match) throw new Error('e2e/smoke.spec.ts no longer declares CRITIQUE_SENTINEL')
    expect(CRITIQUE_RULES.startsWith(match[1]!)).toBe(true)
  })

  it('names every category and the citation rule, so an uncited note is the exception and not the shape', () => {
    expect(CRITIQUE_RULES).toContain(
      'pacing, clarity, showTell, pov, filterWords, repetition, attribution, intent'
    )
    expect(CRITIQUE_RULES).toContain('a note whose quote is not in the scene is thrown away')
  })

  it('a bare scene: the rules and the honesty line alone system-side, the scene and the instruction in the user turn, no temperature', () => {
    const built = buildCritiquePrompt(bare)
    expect(built.version).toBe('critique.v1')
    expect(built.messages).toEqual([
      { role: 'system', content: `${RULES} ${DIRECT}` },
      { role: 'user', content: `Scene text:\n"""\n${SCENE}\n"""\n\nGive your editor's notes.` }
    ])
    expect('temperature' in built).toBe(false)
  })

  it('has a line per honesty level, each one right after the rules', () => {
    for (const honesty of HONESTY_LEVELS) {
      const system = buildCritiquePrompt({ ...bare, honesty }).messages[0]?.content ?? ''
      expect(system).toBe(`${RULES} ${HONESTY_INSTRUCTION[honesty]}`)
    }
    expect(new Set(Object.values(HONESTY_INSTRUCTION)).size).toBe(HONESTY_LEVELS.length)
  })

  it('puts the voice block and the scene line in the system turn after the honesty line, and the brief in the user turn', () => {
    const built = buildCritiquePrompt({
      ...bare,
      notes: NOTES,
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '', brief: EMPTY_SCENE_BRIEF },
      voice: VOICE
    })
    expect(built.messages[0]?.content).toBe(
      `${RULES} ${DIRECT} ${VOICE}\n\nScene: location Ferry landing, POV Mara, timeline —.`
    )
    expect(built.messages[1]?.content).toBe(
      `Author's notes for this scene (its intent):\n"""\n${NOTES}\n"""\n` +
        'Include one "intent" note: does the scene do what these notes say? Cite the passage ' +
        'that shows it.\n\n' +
        `Scene text:\n"""\n${SCENE}\n"""\n\n` +
        "Give your editor's notes."
    )
  })

  it('omits the brief and the intent instruction when the scene has no notes', () => {
    const user = buildCritiquePrompt(bare).messages[1]?.content ?? ''
    expect(user).not.toContain("Author's notes for this scene")
    expect(user).not.toContain('"intent" note')
  })

  it('asks for the feature output budget: the notes are only useful whole', () => {
    expect(buildCritiquePrompt(bare).maxTokens).toBe(outputBudget('critique'))
  })

  it('stays under the critique input budget with every cap at its limit', () => {
    const built = buildCritiquePrompt({
      sceneText: 's'.repeat(CRITIQUE_SCENE_CHAR_BUDGET),
      notes: 'n'.repeat(CRITIQUE_NOTES_CHAR_CAP),
      meta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500), brief: EMPTY_SCENE_BRIEF },
      voice: 'v'.repeat(2_400),
      honesty: 'brutal'
    })
    const estimate = estimateTokens(promptText(built.messages))
    expect(estimate).toBeLessThan(inputBudget('critique'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(6_245)
    expect(estimateTokens(promptText(buildCritiquePrompt(bare).messages))).toBe(290)
  })
})
