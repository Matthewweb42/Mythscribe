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
