import { describe, expect, it } from 'vitest'
import { DEFAULT_MODELS, inputBudget, priceFor } from './ai'
import { type ImportDraft, isDefaultSceneTitle } from './import'
import {
  chunkParagraphs,
  estimateStructureCost,
  flattenDraft,
  IMPORT_CHUNK_WORDS,
  ImportDetectResult,
  shortenParagraph,
  STRUCTURE_CHUNK_OVERHEAD_TOKENS,
  STRUCTURE_OUT_TOKENS_PER_CHUNK,
  STRUCTURE_PARAGRAPH_HEAD,
  STRUCTURE_PARAGRAPH_TAIL,
  STRUCTURE_TOKENS_PER_WORD,
  StructureSuggestions
} from './importStructure'

const paragraph = (
  text: string
): { type: string; attrs: { origin: string }; content: { type: string; text: string }[] } => ({
  type: 'paragraph',
  attrs: { origin: 'imported' },
  content: [{ type: 'text', text }]
})

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')

const draft: ImportDraft = {
  source: { name: 'book.md', format: 'md', words: 0, paragraphs: 0 },
  nextId: 1,
  parts: [
    {
      id: 'p1',
      title: 'Part One',
      excluded: false,
      chapters: [
        {
          id: 'p1c1',
          title: 'Chapter One',
          excluded: false,
          placement: 'manuscript',
          scenes: [
            {
              id: 'p1c1s1',
              title: 'Scene 1',
              excluded: false,
              tags: [],
              paragraphs: [paragraph('First.'), paragraph('Second one here.')]
            },
            {
              id: 'p1c1s2',
              title: 'Scene 2',
              excluded: true,
              tags: [],
              paragraphs: [paragraph('Skipped.')]
            },
            { id: 'p1c1s3', title: 'Scene 3', excluded: false, tags: [], paragraphs: [] },
            {
              id: 'p1c1s4',
              title: 'Scene 4',
              excluded: false,
              tags: [],
              paragraphs: [paragraph('Third.')]
            }
          ]
        },
        {
          id: 'p1c2',
          title: 'Chapter Two',
          excluded: false,
          placement: 'manuscript',
          scenes: [
            {
              id: 'p1c2s1',
              title: 'Scene 1',
              excluded: false,
              tags: [],
              paragraphs: [paragraph('Fourth.')]
            }
          ]
        }
      ]
    },
    {
      id: 'p2',
      title: 'Gone',
      excluded: true,
      chapters: []
    }
  ]
}

describe('estimateStructureCost', () => {
  it('prices words × 1.35 plus a per-chunk overhead at the fast model rate', () => {
    const estimate = estimateStructureCost(6_000, DEFAULT_MODELS.fast)
    expect(estimate.chunks).toBe(3)
    expect(estimate.tokensIn).toBe(
      Math.ceil(6_000 * STRUCTURE_TOKENS_PER_WORD) + 3 * STRUCTURE_CHUNK_OVERHEAD_TOKENS
    )
    expect(estimate.tokensOut).toBe(3 * STRUCTURE_OUT_TOKENS_PER_CHUNK)
    expect(estimate.costUsd).toBe(
      priceFor(DEFAULT_MODELS.fast, estimate.tokensIn, estimate.tokensOut).costUsd
    )
    expect(estimate.priced).toBe(true)
  })

  it('has one chunk for a short manuscript, none for an empty one, and no price for an unknown model', () => {
    expect(estimateStructureCost(12, 'gpt-5.4-mini').chunks).toBe(1)
    expect(estimateStructureCost(0, 'gpt-5.4-mini')).toMatchObject({ chunks: 0, costUsd: 0 })
    expect(estimateStructureCost(500, 'something-else')).toMatchObject({
      priced: false,
      costUsd: 0
    })
  })

  it('keeps a full chunk under the feature input budget', () => {
    const oneChunk =
      Math.ceil(IMPORT_CHUNK_WORDS * STRUCTURE_TOKENS_PER_WORD) + STRUCTURE_CHUNK_OVERHEAD_TOKENS
    expect(oneChunk).toBeLessThan(inputBudget('importStructure'))
  })
})

describe('flattenDraft', () => {
  it('numbers the paragraphs in reading order, skipping excluded nodes and empty scenes', () => {
    const flat = flattenDraft(draft)
    expect(flat.map((p) => p.text)).toEqual(['First.', 'Second one here.', 'Third.', 'Fourth.'])
    expect(flat.map((p) => p.index)).toEqual([0, 1, 2, 3])
    expect(flat.map((p) => p.sceneId)).toEqual(['p1c1s1', 'p1c1s1', 'p1c1s4', 'p1c2s1'])
    expect(flat.map((p) => p.local)).toEqual([0, 1, 0, 0])
    expect(flat.map((p) => p.sceneStart)).toEqual([true, false, true, true])
    expect(flat.map((p) => p.chapterStart)).toEqual([true, false, false, true])
    expect(flat[1]?.words).toBe(3)
    expect(flat[3]).toMatchObject({
      chapterTitle: 'Chapter Two',
      sceneTitle: 'Scene 1',
      partId: 'p1'
    })
  })

  it('never sends the project’s own scenes (the combined outline, F-12.2)', () => {
    const first = draft.parts[0]
    if (!first) throw new Error('fixture')
    const mixed: ImportDraft = {
      ...draft,
      parts: [
        {
          ...first,
          chapters: first.chapters.map((chapter, index) =>
            index === 0
              ? {
                  ...chapter,
                  scenes: chapter.scenes.map((scene) =>
                    scene.id === 'p1c1s1' ? { ...scene, existing: true } : scene
                  )
                }
              : chapter
          )
        },
        ...draft.parts.slice(1)
      ]
    }
    const flat = flattenDraft(mixed)
    expect(flat.map((p) => p.text)).toEqual(['Third.', 'Fourth.'])
    // The chapter already started with the existing scene, so the next one does not start it.
    expect(flat.map((p) => p.chapterStart)).toEqual([false, true])
  })
})

describe('chunkParagraphs', () => {
  it('fills each chunk up to the word cap and never splits a paragraph', () => {
    const flat = flattenDraft({
      ...draft,
      parts: [
        {
          id: 'p1',
          title: 'P',
          excluded: false,
          chapters: [
            {
              id: 'c',
              title: 'C',
              excluded: false,
              placement: 'manuscript',
              scenes: [
                {
                  id: 's',
                  title: 'Scene 1',
                  excluded: false,
                  tags: [],
                  paragraphs: [
                    paragraph(words(1_000)),
                    paragraph(words(1_000)),
                    paragraph(words(1_000)),
                    paragraph(words(IMPORT_CHUNK_WORDS + 5)),
                    paragraph(words(10))
                  ]
                }
              ]
            }
          ]
        }
      ]
    })
    expect(chunkParagraphs(flat)).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 3 },
      { start: 3, end: 4 },
      { start: 4, end: 5 }
    ])
    expect(chunkParagraphs([])).toEqual([])
    expect(chunkParagraphs(flattenDraft(draft))).toEqual([{ start: 0, end: 4 }])
  })
})

describe('shortenParagraph', () => {
  it('keeps a short paragraph whole and sends head … tail of a long one', () => {
    expect(shortenParagraph('short')).toBe('short')
    const long =
      'a'.repeat(STRUCTURE_PARAGRAPH_HEAD) + 'X'.repeat(100) + 'b'.repeat(STRUCTURE_PARAGRAPH_TAIL)
    const shortened = shortenParagraph(long)
    expect(shortened).toBe(
      `${'a'.repeat(STRUCTURE_PARAGRAPH_HEAD)} … ${'b'.repeat(STRUCTURE_PARAGRAPH_TAIL)}`
    )
    expect(shortened).not.toContain('X')
  })
})

describe('isDefaultSceneTitle', () => {
  it('matches the minted titles and their splits, not a heading', () => {
    expect(isDefaultSceneTitle('Scene 12')).toBe(true)
    expect(isDefaultSceneTitle('Section 3')).toBe(false)
    expect(isDefaultSceneTitle('Round 2')).toBe(false)
    expect(isDefaultSceneTitle('Scene 2 (split)')).toBe(true)
    expect(isDefaultSceneTitle('The Harbour')).toBe(false)
    expect(isDefaultSceneTitle('Scene')).toBe(false)
    expect(isDefaultSceneTitle('Chapter 1: Dawn')).toBe(false)
  })
})

describe('schemas', () => {
  it('parse the suggestions and both result branches', () => {
    expect(
      StructureSuggestions.parse({
        breaks: [{ before: 3, kind: 'scene', reason: 'time skip' }],
        scenes: [{ start: 0, title: null, tags: ['Mara'] }]
      }).breaks
    ).toHaveLength(1)
    expect(
      StructureSuggestions.safeParse({
        breaks: [{ before: -1, kind: 'scene', reason: '' }],
        scenes: []
      }).success
    ).toBe(false)
    expect(
      StructureSuggestions.safeParse({
        breaks: [{ before: 1, kind: 'part', reason: '' }],
        scenes: []
      }).success
    ).toBe(false)
    expect(
      ImportDetectResult.safeParse({
        ok: false,
        code: 'CANCELLED',
        message: 'Stopped',
        nextStep: 'x'
      }).success
    ).toBe(true)
  })
})
