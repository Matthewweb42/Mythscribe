import { describe, expect, it } from 'vitest'
import { estimateTokens, GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS, inputBudget } from '@shared/ai'
import { builtinParams, type PresetParams } from '@shared/presets'
import {
  EMPTY_SCENE_BRIEF,
  renderSceneBriefBlock,
  SCENE_BRIEF_FIELD_MAX,
  type SceneBrief
} from '@shared/sceneMeta'
import { GHOST_NOTES_CHAR_CAP } from './ghostText.v1'
import { buildGhostTextPromptV2, type BuildGhostTextPromptV2Input } from './ghostText.v2'

const BEFORE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'
const AFTER = 'The ferry would not wait.'

const RULES =
  'You are the ghost-text continuation feature inside a novel-writing app. Continue the ' +
  'passage exactly where the cursor is, in the same voice, tense, and person as the text ' +
  'already written. Write 1 to 2 sentences and stop at a sentence end. Reply with the ' +
  'continuation only: no preamble, no meta-commentary, and no quotation marks around the ' +
  'answer. If text follows the cursor, continue naturally into it without repeating any of it.'
const NEW_ELEMENTS =
  'Do not introduce any new named character, place, or plot fact that the passage or the ' +
  'context below does not already establish.'

const BRIEF = [
  'Scene brief:',
  '- Goal: Mara wants to reach the ferry before the storm closes the crossing.',
  '- Conflict: Tomas will not row while the river is up.',
  "Next scene's goal: Tomas counts what the mill owes."
].join('\n')

const general = builtinParams('general')
const minimal: BuildGhostTextPromptV2Input = {
  before: BEFORE,
  after: '',
  notes: null,
  meta: null,
  brief: null,
  voice: null,
  preset: general
}

/** Every brief line at its cap, as `renderSceneBriefBlock` lays it out: the worst case the block can be. */
const maxedBrief = (): string => {
  const line = (n: string): string => n.repeat(SCENE_BRIEF_FIELD_MAX)
  const full: SceneBrief = {
    goal: line('g'),
    conflict: line('c'),
    turn: line('t'),
    beat: line('b'),
    after: line('a')
  }
  const block = renderSceneBriefBlock({
    current: full,
    previous: { ...EMPTY_SCENE_BRIEF, after: line('p') },
    next: { ...EMPTY_SCENE_BRIEF, goal: line('n') }
  })
  if (block === null) throw new Error('the maxed brief must render')
  return block
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('ghostText.v2 prompt (F-5.3, F-14.3)', () => {
  it('matches the golden messages for the minimal input: rules, style, new-elements rule; passage; instruction', () => {
    const built = buildGhostTextPromptV2(minimal)
    expect(built.version).toBe('ghostText.v2')
    expect(built.messages).toEqual([
      { role: 'system', content: `${RULES} ${general.styleInstruction} ${NEW_ELEMENTS}` },
      {
        role: 'user',
        content: `Passage so far:\n"""\n${BEFORE}\n"""\n\nContinue exactly at the cursor.`
      }
    ])
    expect(built.maxTokens).toBe(general.maxSuggestionTokens)
    expect(built.temperature).toBe(general.temperature)
  })

  it('leads the user turn with the metadata, then the brief, then the notes', () => {
    const built = buildGhostTextPromptV2({
      ...minimal,
      after: AFTER,
      notes: 'Ends on the cliff.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
      brief: BRIEF
    })
    expect(built.messages[1]?.content).toBe(
      `Scene: location Ferry landing, POV Mara, timeline —.\n${BRIEF}\nNotes: Ends on the cliff.` +
        `\n\nPassage so far:\n"""\n${BEFORE}\n"""\n\n` +
        `Text immediately after the cursor (do not repeat it):\n"""\n${AFTER}\n"""\n\n` +
        'Continue exactly at the cursor.'
    )
  })

  it('carries the brief alone when the scene has no metadata or notes', () => {
    const user = buildGhostTextPromptV2({ ...minimal, brief: BRIEF }).messages[1]?.content ?? ''
    expect(user.startsWith(`${BRIEF}\n\nPassage so far:`)).toBe(true)
  })

  it('is the version-1 prompt when there is no brief, so nothing else moved with the version', () => {
    const built = buildGhostTextPromptV2({
      ...minimal,
      notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 50),
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
      voice: 'Short sentences; never semicolons.'
    })
    expect(built.messages[0]?.content).toBe(
      `${RULES} Short sentences; never semicolons. ${general.styleInstruction} ${NEW_ELEMENTS}`
    )
    expect(built.messages[1]?.content).toBe(
      `Scene: location Ferry landing, POV Mara, timeline —.\nNotes: ${'n'.repeat(GHOST_NOTES_CHAR_CAP)}…` +
        `\n\nPassage so far:\n"""\n${BEFORE}\n"""\n\nContinue exactly at the cursor.`
    )
  })

  it('omits the new-elements rule when the preset allows new elements, and clamps the cap to the feature budget', () => {
    const world = builtinParams('worldBuilding')
    const built = buildGhostTextPromptV2({ ...minimal, preset: world })
    expect(built.messages[0]?.content).toBe(`${RULES} ${world.styleInstruction}`)
    expect(built.temperature).toBe(world.temperature)
    const custom: PresetParams = { ...general, maxSuggestionTokens: 60 }
    expect(buildGhostTextPromptV2({ ...minimal, preset: custom }).maxTokens).toBe(60)
  })

  it('stays under the ghost-text input budget with the caret window, notes, metadata, and a brief at every cap', () => {
    const built = buildGhostTextPromptV2({
      before: 'b'.repeat(GHOST_BEFORE_CHARS),
      after: 'a'.repeat(GHOST_AFTER_CHARS),
      notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 100),
      meta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500) },
      brief: maxedBrief(),
      voice: null,
      preset: general
    })
    const estimate = estimateTokens(promptText(built.messages))
    expect(estimate).toBeLessThan(inputBudget('ghostText'))
    // The golden estimate: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(1_093)
    expect(estimateTokens(promptText(buildGhostTextPromptV2(minimal).messages))).toBe(214)
  })
})
