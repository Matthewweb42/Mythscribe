import { describe, expect, it } from 'vitest'
import {
  EMPTY_SCENE_BRIEF,
  EMPTY_SCENE_META,
  SCENE_BRIEF_FIELD_MAX,
  SCENE_BRIEF_FIELDS,
  SCENE_META_FIELD_MAX,
  SCENE_META_TIMELINE_MAX,
  SceneMeta,
  type SceneBrief,
  emptySceneMeta,
  isBriefEmpty,
  parseStoredSceneMeta,
  renderSceneBriefBlock
} from './sceneMeta'

const BRIEF: SceneBrief = {
  goal: 'Mara wants to cross tonight.',
  conflict: 'The river is up and Tomas will not row.',
  turn: 'She agrees to wait for morning.',
  beat: 'Dread giving way to resolve.',
  after: 'The crossing is off until dawn.'
}

describe('SceneMeta', () => {
  it('accepts empty and filled metadata and refuses over-length fields', () => {
    expect(SceneMeta.parse(EMPTY_SCENE_META)).toEqual(EMPTY_SCENE_META)
    const filled = {
      location: 'dark-forest',
      pov: 'mara',
      timeline: 'Day 3, after the storm',
      brief: BRIEF
    }
    expect(SceneMeta.parse(filled)).toEqual(filled)
    expect(SceneMeta.safeParse({ ...filled, location: 'x'.repeat(SCENE_META_FIELD_MAX + 1) }).success).toBe(false)
    expect(SceneMeta.safeParse({ ...filled, pov: 'x'.repeat(SCENE_META_FIELD_MAX + 1) }).success).toBe(false)
    expect(SceneMeta.safeParse({ ...filled, timeline: 'x'.repeat(SCENE_META_TIMELINE_MAX + 1) }).success).toBe(false)
    expect(SceneMeta.safeParse({ location: 'x', pov: 'y' }).success).toBe(false)
    expect(
      SceneMeta.safeParse({ ...filled, brief: { ...BRIEF, goal: 'x'.repeat(SCENE_BRIEF_FIELD_MAX + 1) } })
        .success
    ).toBe(false)
  })

  it('reads a row stored before F-14.3 (no brief) with an empty brief, as a fresh object', () => {
    const stored = { location: 'dark-forest', pov: 'mara', timeline: 'Day 3' }
    const parsed = SceneMeta.parse(stored)
    expect(parsed).toEqual({ ...stored, brief: EMPTY_SCENE_BRIEF })
    expect(parsed.brief).not.toBe(EMPTY_SCENE_BRIEF)
  })

  it('emptySceneMeta shares no object with EMPTY_SCENE_META', () => {
    const meta = emptySceneMeta()
    expect(meta).toEqual(EMPTY_SCENE_META)
    expect(meta).not.toBe(EMPTY_SCENE_META)
    expect(meta.brief).not.toBe(EMPTY_SCENE_META.brief)
  })
})

describe('parseStoredSceneMeta', () => {
  it('reads null as empty metadata, as a fresh object', () => {
    const meta = parseStoredSceneMeta(null)
    expect(meta).toEqual(EMPTY_SCENE_META)
    expect(meta).not.toBe(EMPTY_SCENE_META)
    expect(meta.brief).not.toBe(EMPTY_SCENE_META.brief)
  })

  it('reads valid JSON, with and without a brief', () => {
    const filled = { location: 'dark-forest', pov: 'mara', timeline: 'Day 3' }
    expect(parseStoredSceneMeta(JSON.stringify(filled))).toEqual({
      ...filled,
      brief: EMPTY_SCENE_BRIEF
    })
    expect(parseStoredSceneMeta(JSON.stringify({ ...filled, brief: BRIEF }))).toEqual({
      ...filled,
      brief: BRIEF
    })
  })

  it('reads invalid JSON, JSON that fails the schema, and over-length fields as empty', () => {
    expect(parseStoredSceneMeta('{not json')).toEqual(EMPTY_SCENE_META)
    expect(parseStoredSceneMeta(JSON.stringify({ location: 'x' }))).toEqual(EMPTY_SCENE_META)
    expect(parseStoredSceneMeta(JSON.stringify({ location: 1, pov: '', timeline: '' }))).toEqual(
      EMPTY_SCENE_META
    )
    expect(
      parseStoredSceneMeta(
        JSON.stringify({ location: 'x'.repeat(SCENE_META_FIELD_MAX + 1), pov: '', timeline: '' })
      )
    ).toEqual(EMPTY_SCENE_META)
    expect(
      parseStoredSceneMeta(JSON.stringify({ location: '', pov: '', timeline: '', brief: { goal: 1 } }))
    ).toEqual(EMPTY_SCENE_META)
  })
})

describe('isBriefEmpty', () => {
  it('is true for the empty brief and for whitespace-only fields, false once any field has text', () => {
    expect(isBriefEmpty(EMPTY_SCENE_BRIEF)).toBe(true)
    expect(isBriefEmpty({ ...EMPTY_SCENE_BRIEF, beat: '   ' })).toBe(true)
    expect(isBriefEmpty({ ...EMPTY_SCENE_BRIEF, after: 'Dawn.' })).toBe(false)
  })

  it('SCENE_BRIEF_FIELDS covers every key of the brief once, in order', () => {
    expect(SCENE_BRIEF_FIELDS.map((f) => f.key)).toEqual(Object.keys(EMPTY_SCENE_BRIEF))
  })
})

describe('renderSceneBriefBlock', () => {
  it('renders the current brief line by line with the neighbours after it', () => {
    expect(
      renderSceneBriefBlock({
        current: BRIEF,
        previous: { ...EMPTY_SCENE_BRIEF, after: 'Tomas owes the mill.' },
        next: { ...EMPTY_SCENE_BRIEF, goal: 'Reach the far bank before the search party.' }
      })
    ).toBe(
      'Scene brief:\n' +
        '- Goal: Mara wants to cross tonight.\n' +
        '- Conflict: The river is up and Tomas will not row.\n' +
        '- Turn: She agrees to wait for morning.\n' +
        '- Emotional beat: Dread giving way to resolve.\n' +
        '- Reader knows after: The crossing is off until dawn.\n' +
        'Previous scene, reader knows after: Tomas owes the mill.\n' +
        "Next scene's goal: Reach the far bank before the search party."
    )
  })

  it('omits empty lines, trims, and falls back to the previous scene’s turn when it has no after line', () => {
    expect(
      renderSceneBriefBlock({
        current: { ...EMPTY_SCENE_BRIEF, goal: '  Cross tonight.  ' },
        previous: { ...EMPTY_SCENE_BRIEF, turn: 'The bell rang once.' },
        next: EMPTY_SCENE_BRIEF
      })
    ).toBe('Scene brief:\n- Goal: Cross tonight.\nPrevious scene, reader knows after: The bell rang once.')
  })

  it('renders only the neighbours when the current brief is empty, and null when there is nothing', () => {
    expect(
      renderSceneBriefBlock({
        current: EMPTY_SCENE_BRIEF,
        previous: null,
        next: { ...EMPTY_SCENE_BRIEF, goal: 'Find the boat.' }
      })
    ).toBe("Next scene's goal: Find the boat.")
    expect(renderSceneBriefBlock({ current: EMPTY_SCENE_BRIEF, previous: null, next: null })).toBeNull()
    expect(
      renderSceneBriefBlock({
        current: EMPTY_SCENE_BRIEF,
        previous: EMPTY_SCENE_BRIEF,
        next: EMPTY_SCENE_BRIEF
      })
    ).toBeNull()
  })
})
