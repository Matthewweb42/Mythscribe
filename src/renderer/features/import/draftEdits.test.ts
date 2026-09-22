import { describe, expect, it } from 'vitest'
import { IMPORT_TITLE_MAX, draftSummary, type ImportDraft } from '@shared/import'
import { draftFixture, importedParagraph } from './draftFixture'
import {
  findNode,
  mergeScene,
  moveNode,
  moveScene,
  nestChapter,
  renameNode,
  setExcluded,
  setPlacement,
  splitScene,
  splitTitle
} from './draftEdits'

/** The draft as `parts → chapters → scenes` titles, the shape every structural test asserts. */
const shape = (draft: ImportDraft): Record<string, Record<string, string[]>> =>
  Object.fromEntries(
    draft.parts.map((part) => [
      part.title,
      Object.fromEntries(
        part.chapters.map((chapter) => [chapter.title, chapter.scenes.map((s) => s.title)])
      )
    ])
  )

const scene = (draft: ImportDraft, id: string): { title: string; paragraphs: number } => {
  const found = findNode(draft, id)
  if (found?.kind !== 'scene') throw new Error(`no scene ${id}`)
  return { title: found.scene.title, paragraphs: found.scene.paragraphs.length }
}

describe('findNode (F-12.2)', () => {
  it('finds a part, a chapter, and a scene with their place in the draft', () => {
    const draft = draftFixture()
    expect(findNode(draft, 'p2')).toMatchObject({ kind: 'part', partIndex: 1 })
    expect(findNode(draft, 'p1c2')).toMatchObject({
      kind: 'chapter',
      partIndex: 0,
      chapterIndex: 1
    })
    expect(findNode(draft, 'p1c1s2')).toMatchObject({
      kind: 'scene',
      partIndex: 0,
      chapterIndex: 0,
      sceneIndex: 1
    })
    expect(findNode(draft, 'nope')).toBeNull()
  })
})

describe('renameNode', () => {
  it('renames each level and leaves the rest of the draft alone', () => {
    const draft = draftFixture()
    const renamed = renameNode(
      renameNode(renameNode(draft, 'p1', 'Book One'), 'p2c1', 'The Return'),
      'p1c1s1',
      'Nightfall'
    )
    expect(shape(renamed)).toEqual({
      'Book One': { 'Chapter One': ['Nightfall', 'Scene 2'], Acknowledgements: ['Scene 1'] },
      'Part Two': { 'The Return': ['Scene 1'] }
    })
    // Pure: the draft it was given is untouched.
    expect(shape(draft)).toEqual(shape(draftFixture()))
  })

  it('trims, caps at the title maximum, and ignores a blank or unchanged title', () => {
    const draft = draftFixture()
    expect(renameNode(draft, 'p1', '  Book One  ').parts[0]?.title).toBe('Book One')
    expect(renameNode(draft, 'p1', 'x'.repeat(IMPORT_TITLE_MAX + 20)).parts[0]?.title).toHaveLength(
      IMPORT_TITLE_MAX
    )
    expect(renameNode(draft, 'p1', '   ')).toBe(draft)
    expect(renameNode(draft, 'p1', 'Part One')).toBe(draft)
    expect(renameNode(draft, 'nope', 'X')).toBe(draft)
  })
})

describe('setExcluded', () => {
  it('excludes a scene, a chapter, and a part, and the summary drops what they hold', () => {
    const draft = draftFixture()
    expect(draftSummary(draft)).toMatchObject({ parts: 2, chapters: 2, scenes: 3, matter: 1 })

    const noScene = setExcluded(draft, 'p1c1s2', true)
    expect(draftSummary(noScene)).toMatchObject({ scenes: 2 })
    const noChapter = setExcluded(draft, 'p2c1', true)
    expect(draftSummary(noChapter)).toMatchObject({ parts: 1, chapters: 1, scenes: 2 })
    const noPart = setExcluded(draft, 'p1', true)
    expect(draftSummary(noPart)).toMatchObject({ parts: 1, chapters: 1, scenes: 1, matter: 0 })
  })

  it('keeps the children’s own flags, so unexcluding a container restores them', () => {
    const draft = setExcluded(draftFixture(), 'p1c1s2', true)
    const hidden = setExcluded(draft, 'p1', true)
    const back = setExcluded(hidden, 'p1', false)
    expect(draftSummary(back)).toEqual(draftSummary(draft))
    expect(setExcluded(draft, 'p1c1s2', true)).toBe(draft)
    expect(setExcluded(draft, 'nope', true)).toBe(draft)
  })
})

describe('setPlacement', () => {
  it('moves a chapter between the manuscript and the matter sections', () => {
    const draft = draftFixture()
    const front = setPlacement(draft, 'p1c1', 'front')
    expect(draftSummary(front)).toMatchObject({ parts: 1, chapters: 1, scenes: 1, matter: 2 })
    const back = setPlacement(draft, 'p1c2', 'manuscript')
    expect(draftSummary(back)).toMatchObject({ chapters: 3, scenes: 4, matter: 0 })
    expect(setPlacement(draft, 'p1c2', 'end')).toBe(draft)
    // Only chapters have a placement.
    expect(setPlacement(draft, 'p1', 'front')).toBe(draft)
  })
})

describe('moveNode', () => {
  it('moves a part, a chapter, and a scene among their siblings', () => {
    const draft = draftFixture()
    expect(moveNode(draft, 'p2', -1).parts.map((p) => p.id)).toEqual(['p2', 'p1'])
    expect(moveNode(draft, 'p1', 1).parts.map((p) => p.id)).toEqual(['p2', 'p1'])
    expect(moveNode(draft, 'p1c2', -1).parts[0]?.chapters.map((c) => c.id)).toEqual([
      'p1c2',
      'p1c1'
    ])
    expect(moveNode(draft, 'p1c1s1', 1).parts[0]?.chapters[0]?.scenes.map((s) => s.id)).toEqual([
      'p1c1s2',
      'p1c1s1'
    ])
  })

  it('does nothing at either end of the list', () => {
    const draft = draftFixture()
    expect(moveNode(draft, 'p1', -1)).toBe(draft)
    expect(moveNode(draft, 'p2', 1)).toBe(draft)
    expect(moveNode(draft, 'p1c1s1', -1)).toBe(draft)
    expect(moveNode(draft, 'nope', 1)).toBe(draft)
  })
})

describe('nestChapter', () => {
  it('moves a chapter to the previous part as its last, and to the next as its first', () => {
    const draft = draftFixture()
    expect(shape(nestChapter(draft, 'p2c1', 'prev'))).toEqual({
      'Part One': {
        'Chapter One': ['Scene 1', 'Scene 2'],
        Acknowledgements: ['Scene 1'],
        'Chapter Two': ['Scene 1']
      },
      'Part Two': {}
    })
    expect(shape(nestChapter(draft, 'p1c1', 'next'))).toEqual({
      'Part One': { Acknowledgements: ['Scene 1'] },
      'Part Two': { 'Chapter One': ['Scene 1', 'Scene 2'], 'Chapter Two': ['Scene 1'] }
    })
  })

  it('does nothing without a part that way, or for anything but a chapter', () => {
    const draft = draftFixture()
    expect(nestChapter(draft, 'p1c1', 'prev')).toBe(draft)
    expect(nestChapter(draft, 'p2c1', 'next')).toBe(draft)
    expect(nestChapter(draft, 'p1', 'next')).toBe(draft)
    expect(nestChapter(draft, 'p1c1s1', 'prev')).toBe(draft)
  })
})

describe('moveScene', () => {
  it('moves a scene into the chapter before it, across a part boundary too', () => {
    const draft = draftFixture()
    // Within the part: Scene 1 of Chapter One into… there is nothing before it.
    expect(moveScene(draft, 'p1c1s1', 'prev')).toBe(draft)
    // Across the part boundary: Part Two's only scene joins the end of Acknowledgements.
    expect(shape(moveScene(draft, 'p2c1s1', 'prev'))).toEqual({
      'Part One': {
        'Chapter One': ['Scene 1', 'Scene 2'],
        Acknowledgements: ['Scene 1', 'Scene 1']
      },
      'Part Two': { 'Chapter Two': [] }
    })
    // Forward: Chapter One's second scene opens Acknowledgements.
    const forward = moveScene(draft, 'p1c1s2', 'next')
    expect(shape(forward)).toEqual({
      'Part One': { 'Chapter One': ['Scene 1'], Acknowledgements: ['Scene 2', 'Scene 1'] },
      'Part Two': { 'Chapter Two': ['Scene 1'] }
    })
  })

  it('does nothing past the last chapter or for anything but a scene', () => {
    const draft = draftFixture()
    expect(moveScene(draft, 'p2c1s1', 'next')).toBe(draft)
    expect(moveScene(draft, 'p1c1', 'next')).toBe(draft)
  })
})

describe('mergeScene', () => {
  it('appends the paragraphs to the scene before it and keeps that scene’s title', () => {
    const merged = mergeScene(draftFixture(), 'p1c1s2')
    expect(shape(merged)['Part One']?.['Chapter One']).toEqual(['Scene 1'])
    expect(scene(merged, 'p1c1s1')).toEqual({ title: 'Scene 1', paragraphs: 3 })
    expect(draftSummary(merged).words).toBe(draftSummary(draftFixture()).words)
  })

  it('does nothing for the first scene of a chapter or a non-scene', () => {
    const draft = draftFixture()
    expect(mergeScene(draft, 'p1c1s1')).toBe(draft)
    expect(mergeScene(draft, 'p1c1')).toBe(draft)
  })
})

describe('splitScene', () => {
  it('cuts the paragraphs in two, mints an id from the counter, and titles the tail', () => {
    const split = splitScene(draftFixture(), 'p2c1s1', 2)
    const scenes = split.parts[1]?.chapters[0]?.scenes ?? []
    expect(scenes.map((s) => s.title)).toEqual(['Scene 1', splitTitle('Scene 1')])
    expect(scenes.map((s) => s.paragraphs.length)).toEqual([2, 1])
    expect(scenes[1]?.id).toBe('p2c1s1-x1')
    expect(split.nextId).toBe(2)
    // Nothing is lost or duplicated.
    expect(draftSummary(split).words).toBe(draftSummary(draftFixture()).words)
    expect(draftSummary(split).scenes).toBe(draftSummary(draftFixture()).scenes + 1)
    // A second split mints the next id.
    expect(splitScene(split, 'p2c1s1', 1).parts[1]?.chapters[0]?.scenes[1]?.id).toBe('p2c1s1-x2')
  })

  it('refuses an index outside the paragraphs after the first', () => {
    const draft = draftFixture()
    expect(splitScene(draft, 'p2c1s1', 0)).toBe(draft)
    expect(splitScene(draft, 'p2c1s1', 3)).toBe(draft)
    expect(splitScene(draft, 'p2c1s1', 1.5)).toBe(draft)
    expect(splitScene(draft, 'p1c1s2', 1)).toBe(draft) // a single paragraph cannot be split
    expect(splitScene(draft, 'p1c1', 1)).toBe(draft)
  })

  it('carries the paragraphs over as they are, provenance included', () => {
    const draft: ImportDraft = {
      ...draftFixture(),
      nextId: 7
    }
    const split = splitScene(draft, 'p1c1s1', 1)
    const tail = split.parts[0]?.chapters[0]?.scenes[1]
    expect(tail?.id).toBe('p1c1s1-x7')
    expect(tail?.paragraphs).toEqual([importedParagraph('Nobody moved.')])
  })
})
