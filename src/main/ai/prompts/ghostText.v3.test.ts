import { describe, expect, it } from 'vitest'
import { estimateTokens, GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS, inputBudget } from '@shared/ai'
import { builtinParams, type PresetParams } from '@shared/presets'
import {
  EMPTY_SCENE_BRIEF,
  renderSceneBriefBlock,
  SCENE_BRIEF_FIELD_MAX,
  type SceneBrief
} from '@shared/sceneMeta'
import { STORY_BIBLE_GHOST_TOKEN_BUDGET, STORY_BIBLE_HEADING } from '@shared/storyBible'
import { GHOST_NOTES_CHAR_CAP } from './ghostText.v1'
import { buildGhostTextPromptV2 } from './ghostText.v2'
import { buildGhostTextPromptV3, type BuildGhostTextPromptV3Input } from './ghostText.v3'

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
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'

const general = builtinParams('general')
const minimal: BuildGhostTextPromptV3Input = {
  before: BEFORE,
  after: '',
  notes: null,
  meta: null,
  brief: null,
  voice: null,
  bible: null,
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

describe('ghostText.v3 prompt (F-5.3, F-14.3, F-14.9)', () => {
  it('matches the golden messages for the minimal input: rules, style, new-elements rule; passage; instruction', () => {
    const built = buildGhostTextPromptV3(minimal)
    expect(built.version).toBe('ghostText.v3')
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

  it('closes the system turn with the story bible, after the voice block and the preset, leaving the user turn alone', () => {
    const built = buildGhostTextPromptV3({
      ...minimal,
      voice: 'Short sentences; never semicolons.',
      bible: BIBLE
    })
    expect(built.messages[0]?.content).toBe(
      `${RULES} Short sentences; never semicolons. ${general.styleInstruction} ${NEW_ELEMENTS}` +
        `\n\n${BIBLE}`
    )
    expect(built.messages[1]?.content).toBe(
      `Passage so far:\n"""\n${BEFORE}\n"""\n\nContinue exactly at the cursor.`
    )
  })

  it('leads the user turn with the metadata, then the brief, then the notes, as version 2 does', () => {
    const built = buildGhostTextPromptV3({
      ...minimal,
      after: AFTER,
      notes: 'Ends on the cliff.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
      brief: BRIEF,
      bible: BIBLE
    })
    expect(built.messages[1]?.content).toBe(
      `Scene: location Ferry landing, POV Mara, timeline —.\n${BRIEF}\nNotes: Ends on the cliff.` +
        `\n\nPassage so far:\n"""\n${BEFORE}\n"""\n\n` +
        `Text immediately after the cursor (do not repeat it):\n"""\n${AFTER}\n"""\n\n` +
        'Continue exactly at the cursor.'
    )
  })

  it('is the version-2 prompt when there is no bible, so nothing else moved with the version', () => {
    const input = {
      ...minimal,
      after: AFTER,
      notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 50),
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
      brief: BRIEF,
      voice: 'Short sentences; never semicolons.'
    }
    expect(buildGhostTextPromptV3({ ...input, bible: null }).messages).toEqual(
      buildGhostTextPromptV2(input).messages
    )
  })

  it('omits the new-elements rule when the preset allows new elements, and clamps the cap to the feature budget', () => {
    const world = builtinParams('worldBuilding')
    const built = buildGhostTextPromptV3({ ...minimal, preset: world, bible: BIBLE })
    expect(built.messages[0]?.content).toBe(`${RULES} ${world.styleInstruction}\n\n${BIBLE}`)
    expect(built.temperature).toBe(world.temperature)
    const custom: PresetParams = { ...general, maxSuggestionTokens: 60 }
    expect(buildGhostTextPromptV3({ ...minimal, preset: custom }).maxTokens).toBe(60)
  })

  it('stays under the ghost-text input budget with the caret window, notes, metadata, a brief at every cap, and the bible at its ghost budget', () => {
    const maxed: BuildGhostTextPromptV3Input = {
      before: 'b'.repeat(GHOST_BEFORE_CHARS),
      after: 'a'.repeat(GHOST_AFTER_CHARS),
      notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 100),
      meta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500) },
      brief: maxedBrief(),
      voice: null,
      bible: 'g'.repeat(STORY_BIBLE_GHOST_TOKEN_BUDGET * 4),
      preset: general
    }
    const estimate = estimateTokens(promptText(buildGhostTextPromptV3(maxed).messages))
    expect(estimate).toBeLessThan(inputBudget('ghostText'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(1_243)
    expect(
      estimateTokens(promptText(buildGhostTextPromptV3({ ...maxed, bible: null }).messages))
    ).toBe(1_093)
    expect(estimateTokens(promptText(buildGhostTextPromptV3(minimal).messages))).toBe(214)
  })
})
