import { describe, expect, it } from 'vitest'
import { estimateTokens, GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS, inputBudget } from '@shared/ai'
import { builtinParams, type PresetParams } from '@shared/presets'
import { STORY_BIBLE_GHOST_TOKEN_BUDGET, STORY_BIBLE_HEADING } from '@shared/storyBible'
import { buildGhostTextPrompt as buildV1 } from './ghostText.v1'
import { buildGhostTextPrompt, GHOST_NOTES_CHAR_CAP } from './ghostText.v2'

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
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara.'

const general = builtinParams('general')
const minimal = {
  before: BEFORE,
  after: '',
  notes: null,
  meta: null,
  voice: null,
  bible: null,
  preset: general
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('ghostText.v2 prompt (F-5.3, F-14.9)', () => {
  it('matches the golden messages for the minimal input: rules, style, new-elements rule; passage; instruction', () => {
    const built = buildGhostTextPrompt(minimal)
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

  it('adds the text after the cursor as its own block', () => {
    const built = buildGhostTextPrompt({ ...minimal, after: AFTER })
    expect(built.messages[1]?.content).toBe(
      `Passage so far:\n"""\n${BEFORE}\n"""\n\n` +
        `Text immediately after the cursor (do not repeat it):\n"""\n${AFTER}\n"""\n\n` +
        'Continue exactly at the cursor.'
    )
  })

  it('leads the user turn with the scene metadata and the notes, in that order, with an em dash for an empty field', () => {
    const built = buildGhostTextPrompt({
      ...minimal,
      notes: 'Ends on the cliff.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' }
    })
    expect(built.messages[1]?.content).toBe(
      'Scene: location Ferry landing, POV Mara, timeline —.\nNotes: Ends on the cliff.\n\n' +
        `Passage so far:\n"""\n${BEFORE}\n"""\n\nContinue exactly at the cursor.`
    )
    const notesOnly = buildGhostTextPrompt({ ...minimal, notes: 'Ends on the cliff.' })
    expect(notesOnly.messages[1]?.content.startsWith('Notes: Ends on the cliff.\n\nPassage')).toBe(
      true
    )
  })

  it('caps the notes at GHOST_NOTES_CHAR_CAP and marks the cut', () => {
    const built = buildGhostTextPrompt({ ...minimal, notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 50) })
    const user = built.messages[1]?.content ?? ''
    expect(user.startsWith(`Notes: ${'n'.repeat(GHOST_NOTES_CHAR_CAP)}…\n\n`)).toBe(true)
  })

  it('places a voice block between the rules and the style instruction, system-side', () => {
    const built = buildGhostTextPrompt({ ...minimal, voice: 'Short sentences; never semicolons.' })
    expect(built.messages[0]?.content).toBe(
      `${RULES} Short sentences; never semicolons. ${general.styleInstruction} ${NEW_ELEMENTS}`
    )
  })

  it('F-14.9: closes the system turn with the story bible, after the voice block and the preset, leaving the user turn alone', () => {
    const built = buildGhostTextPrompt({
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
    expect(built.messages[0]?.content).toContain(STORY_BIBLE_HEADING)
  })

  it('F-14.9: a null bible leaves the v1 messages exactly, so a project with no story facts pays nothing', () => {
    const input = {
      ...minimal,
      after: AFTER,
      notes: 'Ends on the cliff.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
      voice: 'Short sentences; never semicolons.'
    }
    expect(buildGhostTextPrompt({ ...input, bible: null }).messages).toEqual(
      buildV1(input).messages
    )
  })

  it('omits the new-elements rule when the preset allows new elements, and clamps the cap to the feature budget', () => {
    const world = builtinParams('worldBuilding')
    const built = buildGhostTextPrompt({ ...minimal, preset: world })
    expect(built.messages[0]?.content).toBe(`${RULES} ${world.styleInstruction}`)
    expect(built.temperature).toBe(world.temperature)
    const custom: PresetParams = { ...general, maxSuggestionTokens: 60 }
    expect(buildGhostTextPrompt({ ...minimal, preset: custom }).maxTokens).toBe(60)
  })

  it('stays under the ghost-text input budget for a maxed-out caret window, notes, metadata, and bible', () => {
    const maxed = {
      before: 'b'.repeat(GHOST_BEFORE_CHARS),
      after: 'a'.repeat(GHOST_AFTER_CHARS),
      notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 100),
      meta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500) },
      voice: null,
      bible: 'g'.repeat(STORY_BIBLE_GHOST_TOKEN_BUDGET * 4),
      preset: general
    }
    const estimate = estimateTokens(promptText(buildGhostTextPrompt(maxed).messages))
    expect(estimate).toBeLessThan(inputBudget('ghostText'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(858)
    expect(
      estimateTokens(promptText(buildGhostTextPrompt({ ...maxed, bible: null }).messages))
    ).toBe(707)
    expect(estimateTokens(promptText(buildGhostTextPrompt(minimal).messages))).toBe(214)
  })
})
