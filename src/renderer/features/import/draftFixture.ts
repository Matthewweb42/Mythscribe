import type { ImportDraft } from '@shared/import'
import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'

/** A paragraph as main's readers build it (F-12.2): imported provenance on every one. */
export function importedParagraph(text: string): TiptapNodeT {
  return {
    type: 'paragraph',
    attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
    content: [{ type: 'text', text }]
  }
}

/**
 * A draft shaped like one main builds from a two-part manuscript: Part One with a chapter of two
 * scenes and an end-matter chapter, Part Two with one chapter of one three-paragraph scene. Ids
 * follow main's deterministic scheme so the tests read like the real thing.
 */
export function draftFixture(): ImportDraft {
  return {
    source: { name: 'novel.docx', format: 'docx', words: 22, paragraphs: 7 },
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
                paragraphs: [
                  importedParagraph('The storm broke at dusk.'),
                  importedParagraph('Nobody moved.')
                ],
                tags: []
              },
              {
                id: 'p1c1s2',
                title: 'Scene 2',
                excluded: false,
                paragraphs: [importedParagraph('Morning came grey.')],
                tags: []
              }
            ]
          },
          {
            id: 'p1c2',
            title: 'Acknowledgements',
            excluded: false,
            placement: 'end',
            scenes: [
              {
                id: 'p1c2s1',
                title: 'Scene 1',
                excluded: false,
                paragraphs: [importedParagraph('Thanks to everyone.')],
                tags: []
              }
            ]
          }
        ]
      },
      {
        id: 'p2',
        title: 'Part Two',
        excluded: false,
        chapters: [
          {
            id: 'p2c1',
            title: 'Chapter Two',
            excluded: false,
            placement: 'manuscript',
            scenes: [
              {
                id: 'p2c1s1',
                title: 'Scene 1',
                excluded: false,
                paragraphs: [
                  importedParagraph('They rode north.'),
                  importedParagraph('The road narrowed.'),
                  importedParagraph('Then it ended.')
                ],
                tags: []
              }
            ]
          }
        ]
      }
    ]
  }
}

/** A paragraph as the author wrote it in the project: no imported origin. */
export function ownParagraph(text: string): TiptapNodeT {
  return { type: 'paragraph', content: [{ type: 'text', text }] }
}

/**
 * The combined outline main builds when importing into a project with a manuscript: the
 * project's own part (`e-p1` → `e-c1` → `e-s1`, `e-s2`, all `existing`) ahead of
 * `draftFixture()`'s imported parts, with `existing` listing the ids Import may delete.
 */
export function mixedDraftFixture(): ImportDraft {
  const imported = draftFixture()
  return {
    ...imported,
    parts: [
      {
        id: 'e-p1',
        title: 'Part 1',
        excluded: false,
        existing: true,
        chapters: [
          {
            id: 'e-c1',
            title: 'Chapter 1',
            excluded: false,
            existing: true,
            placement: 'manuscript',
            scenes: [
              {
                id: 'e-s1',
                title: 'Opening',
                excluded: false,
                existing: true,
                paragraphs: [ownParagraph('Mara climbed.')],
                tags: []
              },
              {
                id: 'e-s2',
                title: 'Ridge',
                excluded: false,
                existing: true,
                paragraphs: [ownParagraph('The wind rose.')],
                tags: []
              }
            ]
          }
        ]
      },
      ...imported.parts
    ],
    existing: { parts: ['e-p1'], chapters: ['e-c1'], scenes: ['e-s1', 'e-s2'] }
  }
}
