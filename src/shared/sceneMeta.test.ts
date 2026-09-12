import { describe, expect, it } from 'vitest'
import {
  EMPTY_SCENE_META,
  SCENE_META_FIELD_MAX,
  SCENE_META_TIMELINE_MAX,
  SceneMeta,
  parseStoredSceneMeta
} from './sceneMeta'

describe('SceneMeta', () => {
  it('accepts empty and filled metadata and refuses over-length fields', () => {
    expect(SceneMeta.parse(EMPTY_SCENE_META)).toEqual(EMPTY_SCENE_META)
    const filled = { location: 'dark-forest', pov: 'mara', timeline: 'Day 3, after the storm' }
    expect(SceneMeta.parse(filled)).toEqual(filled)
    expect(SceneMeta.safeParse({ ...filled, location: 'x'.repeat(SCENE_META_FIELD_MAX + 1) }).success).toBe(false)
    expect(SceneMeta.safeParse({ ...filled, pov: 'x'.repeat(SCENE_META_FIELD_MAX + 1) }).success).toBe(false)
    expect(SceneMeta.safeParse({ ...filled, timeline: 'x'.repeat(SCENE_META_TIMELINE_MAX + 1) }).success).toBe(false)
    expect(SceneMeta.safeParse({ location: 'x', pov: 'y' }).success).toBe(false)
  })
})

describe('parseStoredSceneMeta', () => {
  it('reads null as empty metadata, as a fresh object', () => {
    const meta = parseStoredSceneMeta(null)
    expect(meta).toEqual(EMPTY_SCENE_META)
    expect(meta).not.toBe(EMPTY_SCENE_META)
  })

  it('reads valid JSON', () => {
    const filled = { location: 'dark-forest', pov: 'mara', timeline: 'Day 3' }
    expect(parseStoredSceneMeta(JSON.stringify(filled))).toEqual(filled)
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
  })
})
