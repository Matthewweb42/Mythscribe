import { describe, expect, it } from 'vitest'
import { estimateTokens, GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS, inputBudget } from '@shared/ai'
import { builtinParams } from '@shared/presets'
import {
  EMPTY_SCENE_BRIEF,
  renderSceneBriefBlock,
  SCENE_BRIEF_FIELD_MAX,
  type SceneBrief
} from '@shared/sceneMeta'
import {
  renderSceneSteer,
  SCENE_STEER_CATEGORIES,
  SCENE_STEER_HEADING,
  SCENE_STEER_NAMES_MAX
} from '@shared/sceneSteer'
import { STORY_BIBLE_GHOST_TOKEN_BUDGET, STORY_BIBLE_HEADING } from '@shared/storyBible'
import { TAG_NAME_MAX } from '@shared/tags'
import { GHOST_NOTES_CHAR_CAP } from './ghostText.v1'
import { buildGhostTextPromptV3 } from './ghostText.v3'
import { buildGhostTextPromptV4, type BuildGhostTextPromptV4Input } from './ghostText.v4'

const BEFORE =
  'The storm broke at dusk over the dark forest. Mara pulled her cloak tight and counted the ' +
  'lightning gaps, each one shorter than the last.'
const AFTER = 'The ferry would not wait.'

const BRIEF = [
  'Scene brief:',
  '- Goal: Mara wants to reach the ferry before the storm closes the crossing.',
  '- Conflict: Tomas will not row while the river is up.'
].join('\n')
const BIBLE =
  `${STORY_BIBLE_HEADING}\nCharacters: mara, tomas\n` +
  'This scene: "The ferry landing", in "Chapter 2", scene 2 of 4; tagged mara, tense.'
const STEER = `${SCENE_STEER_HEADING}\nTone: tense\nWrite in this tone.`

const general = builtinParams('general')
const minimal: BuildGhostTextPromptV4Input = {
  before: BEFORE,
  after: '',
  notes: null,
  meta: null,
  brief: null,
  steer: null,
  voice: null,
  bible: null,
  preset: general
}

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

/** Every steer category full, each name at the tag-name cap, plus one over: the worst case. */
const maxedSteer = (): string => {
  const block = renderSceneSteer(
    SCENE_STEER_CATEGORIES.flatMap((category) =>
      Array.from({ length: SCENE_STEER_NAMES_MAX + 1 }, (_, i) => ({
        category,
        name: `${i}`.padEnd(TAG_NAME_MAX, category.charAt(0))
      }))
    )
  )
  if (block === null) throw new Error('the maxed steer must render')
  return block
}

const promptText = (messages: { content: string }[]): string =>
  messages.map((m) => m.content).join('\n')

describe('ghostText.v4 prompt (F-5.3, F-14.3, F-14.9, F-14.13)', () => {
  it('puts the steer in the user turn after the brief and before the notes, leaving the system turn alone', () => {
    const input = {
      ...minimal,
      after: AFTER,
      notes: 'Ends on the cliff.',
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
      brief: BRIEF,
      bible: BIBLE
    }
    const built = buildGhostTextPromptV4({ ...input, steer: STEER })
    expect(built.version).toBe('ghostText.v4')
    expect(built.messages[0]).toEqual(buildGhostTextPromptV3(input).messages[0])
    expect(built.messages[1]?.content).toBe(
      `Scene: location Ferry landing, POV Mara, timeline —.\n${BRIEF}\n${STEER}\n` +
        'Notes: Ends on the cliff.' +
        `\n\nPassage so far:\n"""\n${BEFORE}\n"""\n\n` +
        `Text immediately after the cursor (do not repeat it):\n"""\n${AFTER}\n"""\n\n` +
        'Continue exactly at the cursor.'
    )
  })

  it('leads the user turn with the steer alone when there is no other context', () => {
    const built = buildGhostTextPromptV4({ ...minimal, steer: STEER })
    expect(built.messages[1]?.content).toBe(
      `${STEER}\n\nPassage so far:\n"""\n${BEFORE}\n"""\n\nContinue exactly at the cursor.`
    )
  })

  it('is the version-3 prompt when there is no steer, so nothing else moved with the version', () => {
    const input = {
      ...minimal,
      after: AFTER,
      notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 50),
      meta: { location: 'Ferry landing', pov: 'Mara', timeline: '' },
      brief: BRIEF,
      voice: 'Short sentences; never semicolons.',
      bible: BIBLE
    }
    const v4 = buildGhostTextPromptV4({ ...input, steer: null })
    const v3 = buildGhostTextPromptV3(input)
    expect(v4.messages).toEqual(v3.messages)
    expect(v4.maxTokens).toBe(v3.maxTokens)
    expect(v4.temperature).toBe(v3.temperature)
    expect(buildGhostTextPromptV4(minimal).messages).toEqual(
      buildGhostTextPromptV3(minimal).messages
    )
  })

  it('stays under the ghost-text input budget with every block at its cap, the steer included', () => {
    const maxed: BuildGhostTextPromptV4Input = {
      before: 'b'.repeat(GHOST_BEFORE_CHARS),
      after: 'a'.repeat(GHOST_AFTER_CHARS),
      notes: 'n'.repeat(GHOST_NOTES_CHAR_CAP + 100),
      meta: { location: 'L'.repeat(200), pov: 'P'.repeat(200), timeline: 'T'.repeat(500) },
      brief: maxedBrief(),
      steer: maxedSteer(),
      voice: null,
      bible: 'g'.repeat(STORY_BIBLE_GHOST_TOKEN_BUDGET * 4),
      preset: general
    }
    const estimate = estimateTokens(promptText(buildGhostTextPromptV4(maxed).messages))
    expect(estimate).toBeLessThan(inputBudget('ghostText'))
    // The golden estimates: a change here means the prompt or a cap changed and needs a new version.
    expect(estimate).toBe(1_362)
    expect(
      estimateTokens(promptText(buildGhostTextPromptV4({ ...maxed, steer: null }).messages))
    ).toBe(1_243)
    expect(
      estimateTokens(promptText(buildGhostTextPromptV4({ ...minimal, steer: STEER }).messages))
    ).toBe(233)
  })
})
