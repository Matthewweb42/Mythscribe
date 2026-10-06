import { describe, expect, it } from 'vitest'
import {
  IMPORT_TITLE_MAX,
  draftSummary,
  existingChanges,
  type ImportAiMarks,
  type ImportDraft
} from '@shared/import'
import type { StructureSuggestions } from '@shared/importStructure'
import { draftFixture, importedParagraph, mixedDraftFixture } from './draftFixture'
import {
  applyStructure,
  findNode,
  idsOfKind,
  mergeChapter,
  mergeChapters,
  mergeScene,
  mergeScenes,
  mergeWithNext,
  moveTo,
  removeNodes,
  shiftNode,
  moveNode,
  moveScene,
  nestChapter,
  rejectSuggestion,
  renameNode,
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

describe('removeNodes', () => {
  it('removes a scene, a chapter, and a part, and the summary drops what they held', () => {
    const draft = draftFixture()
    expect(draftSummary(draft)).toMatchObject({ parts: 2, chapters: 2, scenes: 3, matter: 1 })

    expect(draftSummary(removeNodes(draft, ['p1c1s2']))).toMatchObject({ scenes: 2 })
    const noChapter = removeNodes(draft, ['p2c1'])
    expect(draftSummary(noChapter)).toMatchObject({ parts: 1, chapters: 1, scenes: 2 })
    const noPart = removeNodes(draft, ['p1'])
    expect(draftSummary(noPart)).toMatchObject({ parts: 1, chapters: 1, scenes: 1, matter: 0 })
    expect(shape(removeNodes(draft, ['p1c1s1', 'p1c2']))).toEqual({
      'Part One': { 'Chapter One': ['Scene 2'] },
      'Part Two': { 'Chapter Two': ['Scene 1'] }
    })
  })

  it('answers the same draft when nothing it names is there', () => {
    const draft = draftFixture()
    expect(removeNodes(draft, [])).toBe(draft)
    expect(removeNodes(draft, ['nope'])).toBe(draft)
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

describe('mergeChapter (F-12.3)', () => {
  it('appends the scenes to the chapter before it in the part and keeps that chapter’s title', () => {
    const merged = mergeChapter(draftFixture(), 'p1c2')
    expect(shape(merged)).toEqual({
      'Part One': { 'Chapter One': ['Scene 1', 'Scene 2', 'Scene 1'] },
      'Part Two': { 'Chapter Two': ['Scene 1'] }
    })
    expect(merged.parts[0]?.chapters[0]?.placement).toBe('manuscript')
    expect(draftSummary(merged).words).toBe(draftSummary(draftFixture()).words)
  })

  it('does nothing for the first chapter of a part or a non-chapter', () => {
    const draft = draftFixture()
    expect(mergeChapter(draft, 'p1c1')).toBe(draft)
    expect(mergeChapter(draft, 'p2c1')).toBe(draft)
    expect(mergeChapter(draft, 'p1c1s2')).toBe(draft)
    expect(mergeChapter(draft, 'nope')).toBe(draft)
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

/**
 * The fixture's paragraphs in reading order, as the AI pass indexes them: 0–1 open Chapter One's
 * Scene 1, 2 is Scene 2, 3 is the Acknowledgements scene, 4–6 are Part Two's only scene.
 */
const suggestions = (over: Partial<StructureSuggestions> = {}): StructureSuggestions => ({
  breaks: [],
  scenes: [],
  ...over
})

/** The AI marks on a node, or undefined when the pass left it alone. */
const marks = (draft: ImportDraft, id: string): ImportAiMarks | undefined => {
  const found = findNode(draft, id)
  if (found?.kind === 'scene') return found.scene.ai
  if (found?.kind === 'chapter') return found.chapter.ai
  throw new Error(`no scene or chapter ${id}`)
}

describe('applyStructure (F-12.3)', () => {
  it('splits a scene at a break inside it and marks the new scene with the model’s reason', () => {
    const { draft, added, titled } = applyStructure(
      draftFixture(),
      suggestions({ breaks: [{ before: 1, kind: 'scene', reason: 'time skip' }] })
    )
    expect(added).toBe(1)
    expect(titled).toBe(0)
    expect(shape(draft)['Part One']?.['Chapter One']).toEqual([
      'Scene 1',
      'Scene 1 (split)',
      'Scene 2'
    ])
    expect(scene(draft, 'p1c1s1-x1')).toEqual({ title: 'Scene 1 (split)', paragraphs: 1 })
    expect(marks(draft, 'p1c1s1-x1')).toEqual({ break: true, title: false, reason: 'time skip' })
    // The scene it was cut out of is not the AI's doing.
    expect(marks(draft, 'p1c1s1')).toBeUndefined()
    expect(draftSummary(draft).words).toBe(draftSummary(draftFixture()).words)
  })

  it('splits the chapter too when the break is a chapter, taking the scene and the rest', () => {
    const { draft, added } = applyStructure(
      draftFixture(),
      suggestions({ breaks: [{ before: 5, kind: 'chapter', reason: 'new chapter' }] })
    )
    // One break, even though it made both a scene and a chapter.
    expect(added).toBe(1)
    expect(shape(draft)['Part Two']).toEqual({
      'Chapter Two': ['Scene 1'],
      'Chapter Two (split)': ['Scene 1 (split)']
    })
    expect(marks(draft, 'p2c1-x2')).toEqual({ break: true, title: false, reason: 'new chapter' })
    expect(findNode(draft, 'p2c1-x2')).toMatchObject({ kind: 'chapter', partIndex: 1 })
    expect(draft.parts[1]?.chapters[1]?.placement).toBe('manuscript')
    expect(draft.nextId).toBe(3)
  })

  it('leaves a boundary that is already there alone, the whole draft included', () => {
    const draft = draftFixture()
    // Paragraph 4 opens Part Two's chapter already; paragraph 0 opens the book.
    const applied = applyStructure(
      draft,
      suggestions({
        breaks: [
          { before: 4, kind: 'chapter', reason: 'already a chapter' },
          { before: 2, kind: 'scene', reason: 'already a scene' },
          { before: 99, kind: 'scene', reason: 'past the end' }
        ]
      })
    )
    expect(applied.draft).toBe(draft)
    expect(applied.added).toBe(0)
  })

  it('promotes a scene that starts mid-chapter to a chapter of its own', () => {
    const { draft, added } = applyStructure(
      draftFixture(),
      suggestions({ breaks: [{ before: 2, kind: 'chapter', reason: 'scene 2 opens a chapter' }] })
    )
    expect(added).toBe(1)
    expect(shape(draft)['Part One']).toEqual({
      'Chapter One': ['Scene 1'],
      'Chapter One (split)': ['Scene 2'],
      Acknowledgements: ['Scene 1']
    })
    expect(marks(draft, 'p1c1-x1')?.break).toBe(true)
  })

  it('applies several breaks from the highest index down, so the lower ones still point right', () => {
    const { draft, added } = applyStructure(
      draftFixture(),
      suggestions({
        breaks: [
          { before: 5, kind: 'scene', reason: 'b' },
          { before: 6, kind: 'scene', reason: 'c' }
        ]
      })
    )
    expect(added).toBe(2)
    const scenes = draft.parts[1]?.chapters[0]?.scenes ?? []
    expect(scenes.map((s) => s.id)).toEqual(['p2c1s1', 'p2c1s1-x2', 'p2c1s1-x1'])
    expect(scenes.map((s) => s.paragraphs.length)).toEqual([1, 1, 1])
    expect(draftSummary(draft).words).toBe(draftSummary(draftFixture()).words)
  })

  it('titles a default-titled scene, keeps the author’s title, and dedupes the tags', () => {
    const { draft, titled } = applyStructure(
      renameNode(draftFixture(), 'p2c1s1', 'The Road'),
      suggestions({
        scenes: [
          { start: 2, title: '  Morning Grey  ', tags: ['rain', 'rain', 'mist'] },
          { start: 4, title: 'Northward', tags: ['mara'] },
          { start: 3, title: null, tags: [] }
        ]
      })
    )
    expect(titled).toBe(1)
    expect(scene(draft, 'p1c1s2').title).toBe('Morning Grey')
    expect(marks(draft, 'p1c1s2')).toEqual({ break: false, title: true, reason: null })
    expect(findNode(draft, 'p1c1s2')).toMatchObject({ scene: { tags: ['rain', 'mist'] } })
    // A title the author gave the scene stands; its tag candidates are still kept.
    expect(scene(draft, 'p2c1s1').title).toBe('The Road')
    expect(marks(draft, 'p2c1s1')).toBeUndefined()
    expect(findNode(draft, 'p2c1s1')).toMatchObject({ scene: { tags: ['mara'] } })
  })

  // Regression for F-12.3 verification: `isDefaultSceneTitle` (src/shared/import.ts) is
  // `/^[A-Za-z]+ \d+( \(split\))*$/`, which also matches a title the author chose that happens
  // to be one word plus a number (the plan specified `/^Scene \d+( \(split\))?$/`, tied to the
  // literal minted word). The spec: "An AI-supplied title replaces only default `Scene N` /
  // `(split)` titles" — a heading the author wrote should stand, same as the "Morning Grey" case
  // above with a two-word title. This fails today: "Round 2" is silently replaced.
  it('does not replace an author title that only looks like a default one (Word N)', () => {
    const { draft, titled } = applyStructure(
      renameNode(draftFixture(), 'p1c1s2', 'Round 2'),
      suggestions({ scenes: [{ start: 2, title: 'Morning Grey', tags: [] }] })
    )
    expect(titled).toBe(0)
    expect(scene(draft, 'p1c1s2').title).toBe('Round 2')
    expect(marks(draft, 'p1c1s2')).toBeUndefined()
  })

  it('titles the scene a break just created, keeping the break mark', () => {
    const { draft, added, titled } = applyStructure(
      draftFixture(),
      suggestions({
        breaks: [{ before: 1, kind: 'scene', reason: 'time skip' }],
        scenes: [{ start: 1, title: 'Nobody Moves', tags: [] }]
      })
    )
    expect({ added, titled }).toEqual({ added: 1, titled: 1 })
    expect(scene(draft, 'p1c1s1-x1').title).toBe('Nobody Moves')
    expect(marks(draft, 'p1c1s1-x1')).toEqual({ break: true, title: true, reason: 'time skip' })
  })

  it('ignores a scene index that is not the start of a scene, and changes nothing for nothing', () => {
    const draft = draftFixture()
    const applied = applyStructure(
      draft,
      suggestions({ scenes: [{ start: 1, title: 'Mid-scene', tags: [] }] })
    )
    expect(applied.draft).toBe(draft)
    expect(applyStructure(draft, suggestions()).draft).toBe(draft)
    // Pure: the draft it was given is untouched.
    expect(shape(draft)).toEqual(shape(draftFixture()))
  })
})

describe('rejectSuggestion (F-12.3)', () => {
  it('merges an AI scene back into the one before it, text and all', () => {
    const { draft } = applyStructure(
      draftFixture(),
      suggestions({ breaks: [{ before: 1, kind: 'scene', reason: 'time skip' }] })
    )
    const back = rejectSuggestion(draft, 'p1c1s1-x1')
    expect(shape(back)['Part One']?.['Chapter One']).toEqual(['Scene 1', 'Scene 2'])
    expect(scene(back, 'p1c1s1')).toEqual({ title: 'Scene 1', paragraphs: 2 })
    expect(draftSummary(back).words).toBe(draftSummary(draftFixture()).words)
  })

  it('merges an AI chapter back into the chapter before it', () => {
    const { draft } = applyStructure(
      draftFixture(),
      suggestions({ breaks: [{ before: 5, kind: 'chapter', reason: 'new chapter' }] })
    )
    const back = rejectSuggestion(draft, 'p2c1-x2')
    expect(shape(back)['Part Two']).toEqual({ 'Chapter Two': ['Scene 1', 'Scene 1 (split)'] })
    // Only the chapter was rejected: the scene the same break cut stays, still badged.
    expect(marks(back, 'p2c1s1-x1')?.break).toBe(true)
  })

  it('does nothing for a part, an unknown id, or a node with nothing before it', () => {
    const draft = draftFixture()
    expect(rejectSuggestion(draft, 'p1')).toBe(draft)
    expect(rejectSuggestion(draft, 'nope')).toBe(draft)
    expect(rejectSuggestion(draft, 'p1c1s1')).toBe(draft)
    expect(rejectSuggestion(draft, 'p1c1')).toBe(draft)
  })
})

/** Every paragraph's text in reading order: what no merge, move, or split may lose or reorder. */
const text = (draft: ImportDraft): string[] =>
  draft.parts.flatMap((part) =>
    part.chapters.flatMap((chapter) =>
      chapter.scenes.flatMap((sc) =>
        sc.paragraphs.map((paragraph) => paragraph.content?.[0]?.text ?? '')
      )
    )
  )

describe('mergeScenes (F-12.2 rework)', () => {
  it('merges ticked scenes in reading order into the first, wherever they sit', () => {
    const draft = draftFixture()
    // Ticked out of order and across parts: reading order decides.
    const merged = mergeScenes(draft, ['p2c1s1', 'p1c1s1'])
    expect(shape(merged)).toEqual({
      'Part One': { 'Chapter One': ['Scene 1', 'Scene 2'], Acknowledgements: ['Scene 1'] },
      'Part Two': { 'Chapter Two': [] }
    })
    expect(scene(merged, 'p1c1s1').paragraphs).toBe(5)
    expect(draftSummary(merged).words).toBe(draftSummary(draft).words)
  })

  it('needs two scenes', () => {
    const draft = draftFixture()
    expect(mergeScenes(draft, ['p1c1s1'])).toBe(draft)
    expect(mergeScenes(draft, ['p1c1s1', 'nope'])).toBe(draft)
  })

  it('records the existing scenes it swallows, so Import counts them merged, not deleted', () => {
    const draft = mixedDraftFixture()
    const merged = mergeScenes(draft, ['e-s1', 'e-s2'])
    const found = findNode(merged, 'e-s1')
    expect(found?.kind === 'scene' ? found.scene.absorbed : null).toEqual(['e-s2'])
    expect(existingChanges(merged)).toEqual({
      deletedScenes: [],
      mergedScenes: ['e-s2'],
      deletedChapters: [],
      deletedParts: []
    })
    // A new scene that takes in an existing one carries what that one had absorbed too.
    const ahead = moveTo(merged, 'p1c1s1', 'e-s1', 'before')
    const chained = mergeScenes(ahead, ['e-s1', 'p1c1s1'])
    const held = findNode(chained, 'p1c1s1')
    expect(held?.kind === 'scene' ? held.scene.absorbed : null).toEqual(['e-s1', 'e-s2'])
    expect(existingChanges(chained).mergedScenes).toEqual(['e-s1', 'e-s2'])
    const swallowed = mergeScenes(draft, ['e-s2', 'p1c1s1'])
    const first = findNode(swallowed, 'e-s2')
    expect(first?.kind === 'scene' ? first.scene.existing : null).toBe(true)
    expect(existingChanges(swallowed).mergedScenes).toEqual([])
  })
})

describe('mergeChapters and mergeWithNext', () => {
  it('appends the later chapters’ scenes to the first chapter', () => {
    const draft = draftFixture()
    const merged = mergeChapters(draft, ['p2c1', 'p1c1'])
    expect(shape(merged)).toEqual({
      'Part One': {
        'Chapter One': ['Scene 1', 'Scene 2', 'Scene 1'],
        Acknowledgements: ['Scene 1']
      },
      'Part Two': {}
    })
    expect(mergeChapters(draft, ['p1c1'])).toBe(draft)
  })

  it('merges a scene with the next one in reading order, across a chapter too', () => {
    const draft = draftFixture()
    const once = mergeWithNext(draft, 'p1c1s1')
    expect(shape(once)['Part One']?.['Chapter One']).toEqual(['Scene 1'])
    const across = mergeWithNext(draft, 'p1c1s2')
    expect(shape(across)['Part One']).toEqual({
      'Chapter One': ['Scene 1', 'Scene 2'],
      Acknowledgements: []
    })
    expect(text(across)).toEqual(text(draft))
    expect(mergeWithNext(draft, 'p2c1s1')).toBe(draft)
  })

  it('merges a chapter with the next chapter, and does nothing for a part', () => {
    const draft = draftFixture()
    expect(shape(mergeWithNext(draft, 'p1c1'))['Part One']).toEqual({
      'Chapter One': ['Scene 1', 'Scene 2', 'Scene 1']
    })
    expect(mergeWithNext(draft, 'p2c1')).toBe(draft)
    expect(mergeWithNext(draft, 'p1')).toBe(draft)
  })
})

describe('shiftNode', () => {
  it('moves among siblings first, then across into the neighbouring chapter or part', () => {
    const draft = draftFixture()
    expect(idsOfKind(shiftNode(draft, 'p1c1s2', -1), 'scene')).toEqual([
      'p1c1s2',
      'p1c1s1',
      'p1c2s1',
      'p2c1s1'
    ])
    // The first scene of Chapter Two goes up to the end of the chapter before it.
    const up = shiftNode(draft, 'p2c1s1', -1)
    expect(findNode(up, 'p2c1s1')).toMatchObject({ chapter: { id: 'p1c2' }, sceneIndex: 1 })
    // The last chapter of Part One goes down to the start of Part Two.
    const down = shiftNode(draft, 'p1c2', 1)
    expect(findNode(down, 'p1c2')).toMatchObject({ part: { id: 'p2' }, chapterIndex: 0 })
    expect(shiftNode(draft, 'p1', -1)).toBe(draft)
    expect(shiftNode(draft, 'p1c1s1', -1)).toBe(draft)
    expect(shiftNode(draft, 'p2c1s1', 1)).toBe(draft)
  })
})

describe('moveTo (drag and drop)', () => {
  it('drops a scene before or after another scene, or into a chapter at its end', () => {
    const draft = draftFixture()
    const before = moveTo(draft, 'p2c1s1', 'p1c1s1', 'before')
    expect(idsOfKind(before, 'scene')).toEqual(['p2c1s1', 'p1c1s1', 'p1c1s2', 'p1c2s1'])
    const after = moveTo(draft, 'p1c1s1', 'p1c1s2', 'after')
    expect(idsOfKind(after, 'scene')).toEqual(['p1c1s2', 'p1c1s1', 'p1c2s1', 'p2c1s1'])
    const into = moveTo(draft, 'p1c1s1', 'p2c1', 'into')
    expect(findNode(into, 'p1c1s1')).toMatchObject({ chapter: { id: 'p2c1' }, sceneIndex: 1 })
  })

  it('drops a chapter among chapters or into a part, and a part among parts', () => {
    const draft = draftFixture()
    expect(idsOfKind(moveTo(draft, 'p2c1', 'p1c1', 'before'), 'chapter')).toEqual([
      'p2c1',
      'p1c1',
      'p1c2'
    ])
    expect(findNode(moveTo(draft, 'p1c1', 'p2', 'into'), 'p1c1')).toMatchObject({
      part: { id: 'p2' },
      chapterIndex: 1
    })
    expect(idsOfKind(moveTo(draft, 'p2', 'p1', 'before'), 'part')).toEqual(['p2', 'p1'])
  })

  it('refuses a drop that does not fit the levels, or on itself', () => {
    const draft = draftFixture()
    expect(moveTo(draft, 'p1c1', 'p1c1s1', 'before')).toBe(draft)
    expect(moveTo(draft, 'p1c1s1', 'p1', 'into')).toBe(draft)
    expect(moveTo(draft, 'p1c1s1', 'p2c1s1', 'into')).toBe(draft)
    expect(moveTo(draft, 'p1', 'p2', 'into')).toBe(draft)
    expect(moveTo(draft, 'p1c1s1', 'p1c1s1', 'after')).toBe(draft)
    expect(moveTo(draft, 'nope', 'p1c1s1', 'after')).toBe(draft)
  })
})

describe('existing nodes in the combined outline', () => {
  it('names what Import would delete when existing rows are removed', () => {
    const draft = mixedDraftFixture()
    expect(existingChanges(draft)).toEqual({
      deletedScenes: [],
      mergedScenes: [],
      deletedChapters: [],
      deletedParts: []
    })
    expect(existingChanges(removeNodes(draft, ['e-c1']))).toEqual({
      deletedScenes: ['e-s1', 'e-s2'],
      mergedScenes: [],
      deletedChapters: ['e-c1'],
      deletedParts: []
    })
  })

  it('keeps an existing chapter in the manuscript and counts only new nodes in the summary', () => {
    const draft = mixedDraftFixture()
    expect(setPlacement(draft, 'e-c1', 'front')).toBe(draft)
    expect(draftSummary(draft)).toMatchObject({ parts: 2, chapters: 2, scenes: 3 })
    // An existing scene moved into a matter chapter is flattened into it: merged, not deleted.
    const flattened = moveTo(draft, 'e-s1', 'p1c2', 'into')
    expect(existingChanges(flattened).mergedScenes).toEqual(['e-s1'])
  })
})
