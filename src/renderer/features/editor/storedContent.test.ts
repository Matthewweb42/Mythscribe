import { createDocument, getSchema } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { describe, expect, it } from 'vitest'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import { AI_FILED_ATTR, AI_WRITTEN_ATTR, NOT_CANON_ATTR } from '@shared/memory/pageMarks'
import { AI_ORIGIN_MARK, IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'
import { TAG_RANGE_MARK } from '@shared/tagRanges'
import { EMPTY_DOC, TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { buildExtensions, manuscriptSchema, pageSchema } from './extensions'

/**
 * Every stored Tiptap JSON shape loads with `errorOnInvalidContent: true` (story memory P1's
 * merge condition, plan P1 §2.4): a corpus of the shapes each column holds, parsed through the
 * schema of the editor that opens it. A shape a schema cannot load would open as an empty
 * document and be saved over on the next keystroke, so this is the guard against losing text.
 * - `node.content` of manuscript documents: the manuscript schema (inline tags, tag ranges, the
 *   AI-origin mark, the imported origin, scene breaks, headings, quotes, alignment). The
 *   manuscript has no image node: pictures are reference pins and sheet images, never content.
 * - `node.notes`: the notes schema (the manuscript's core without its tools).
 * - Research documents (F-16.8) and, from slice 3, Pinned and Ideas: the page schema, with what
 *   the Research converters write (Word, Markdown, text and PDF pages) and the page marks.
 * Slice 6 adds the documents the switch-over converts.
 */

const SCENE_BREAK = '* * *'
const text = (value: string, marks?: TiptapNodeT['marks']): TiptapNodeT =>
  marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks }
const doc = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'doc', content })

/** Shapes every editor's schema holds: what the starter, the importers and plain typing write. */
const COMMON: Record<string, TiptapNodeT> = {
  empty: EMPTY_DOC,
  'typed paragraphs with marks and a hard break': doc(
    {
      type: 'paragraph',
      attrs: { textAlign: null, [PARAGRAPH_ORIGIN_ATTR]: null },
      content: [
        text('Mara '),
        text('waited', [{ type: 'bold' }, { type: 'italic' }]),
        { type: 'hardBreak' },
        text('on ', [{ type: 'underline' }]),
        text('the ', [{ type: 'strike' }]),
        text('ridge.', [{ type: 'code' }])
      ]
    },
    { type: 'paragraph' }
  ),
  'headings, a quote, alignment and a scene break': doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('One')] },
    { type: 'heading', attrs: { level: 3, textAlign: 'center' }, content: [text('Three')] },
    {
      type: 'blockquote',
      content: [{ type: 'paragraph', attrs: { textAlign: 'justify' }, content: [text('Said.')] }]
    },
    { type: 'sceneBreak' },
    { type: 'paragraph', attrs: { textAlign: 'right' }, content: [text('After.')] }
  ),
  'imported paragraphs (the manuscript importer and the Research converters)': doc(
    { type: 'heading', attrs: { level: 1 }, content: [text('Chapter One')] },
    {
      type: 'paragraph',
      attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
      content: [text('The bell rang '), text('twice', [{ type: 'italic' }]), text('.')]
    },
    { type: 'sceneBreak' },
    {
      type: 'paragraph',
      attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
      content: [text('Tide tables for 1891.')]
    }
  )
}

/** Shapes only a manuscript document holds. */
const MANUSCRIPT: Record<string, TiptapNodeT> = {
  'an inline tag token': doc({
    type: 'paragraph',
    content: [
      text('Then '),
      { type: INLINE_TAG_NODE_TYPE, attrs: { id: 't-1', name: 'mara' } },
      text(' left.')
    ]
  }),
  'a tag range': doc({
    type: 'paragraph',
    content: [
      text('The storm', [{ type: TAG_RANGE_MARK, attrs: { tagId: 't-2' } }]),
      text(' broke.')
    ]
  }),
  'accepted AI text': doc({
    type: 'paragraph',
    content: [
      text('Written. '),
      text('The wind picked up.', [
        { type: AI_ORIGIN_MARK, attrs: { proposalId: 'p-1', accepted: 19 } }
      ])
    ]
  })
}

/** Shapes only a page holds (F-16.6, F-16.8). */
const PAGE: Record<string, TiptapNodeT> = {
  'Not canon, filed and written paragraphs': doc(
    { type: 'paragraph', attrs: { [NOT_CANON_ATTR]: true }, content: [text('Maybe she drowned.')] },
    {
      type: 'paragraph',
      attrs: {
        [NOT_CANON_ATTR]: false,
        [AI_FILED_ATTR]: { doc: 'n-1', para: 3, quote: 'Mara is 35.' },
        [AI_WRITTEN_ATTR]: null
      },
      content: [text('Age: 35')]
    },
    {
      type: 'paragraph',
      attrs: { [AI_WRITTEN_ATTR]: { turn: 'turn-2', date: '2026-10-11' } },
      content: [text('Eyes: grey')]
    }
  ),
  'what the page editor saves (every attribute present)': doc({
    type: 'paragraph',
    attrs: {
      textAlign: null,
      [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN,
      [NOT_CANON_ATTR]: true,
      [AI_FILED_ATTR]: null,
      [AI_WRITTEN_ATTR]: null
    },
    content: [text('Converted line.')]
  })
}

const NOTES_SCHEMA = getSchema(
  buildExtensions({ sceneBreak: SCENE_BREAK, onSave: () => undefined })
)

/** Loads `json` strictly and answers the document as the schema keeps it. */
function load(json: TiptapNodeT, schema: Schema): TiptapNodeT {
  const node = createDocument(json, schema, undefined, { errorOnInvalidContent: true })
  return TiptapNode.parse(node.toJSON())
}

/** The paragraph attributes a loaded document kept, in order. */
function paragraphAttrs(json: TiptapNodeT): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const visit = (node: TiptapNodeT): void => {
    if (node.type === 'paragraph') found.push(node.attrs ?? {})
    for (const child of node.content ?? []) visit(child)
  }
  visit(json)
  return found
}

describe('stored documents load with errorOnInvalidContent (P1 §2.4)', () => {
  const manuscript = manuscriptSchema(SCENE_BREAK)
  const page = pageSchema(SCENE_BREAK)

  it.each(Object.entries({ ...COMMON, ...MANUSCRIPT }))('manuscript: %s', (_name, json) => {
    const loaded = load(json, manuscript)
    expect(loaded.content?.length).toBe(json.content?.length)
    expect(JSON.stringify(loaded)).not.toContain(NOT_CANON_ATTR)
  })

  it.each(Object.entries(COMMON))('notes: %s', (_name, json) => {
    expect(load(json, NOTES_SCHEMA).content?.length).toBe(json.content?.length)
  })

  it.each(Object.entries({ ...COMMON, ...PAGE }))('page: %s', (_name, json) => {
    expect(load(json, page).content?.length).toBe(json.content?.length)
  })

  it('keeps every page mark through a load', () => {
    const [notCanon, filed, written] = paragraphAttrs(
      load(PAGE['Not canon, filed and written paragraphs'] ?? EMPTY_DOC, page)
    )
    expect(notCanon).toMatchObject({ notCanon: true, aiFiled: null, aiWritten: null })
    expect(filed).toMatchObject({ aiFiled: { doc: 'n-1', para: 3, quote: 'Mara is 35.' } })
    expect(written).toMatchObject({ aiWritten: { turn: 'turn-2', date: '2026-10-11' } })
  })

  it('refuses what no schema holds, so the corpus would catch a dropped node or mark', () => {
    const unknownNode = doc({ type: 'image', attrs: { src: 'x.png' } })
    expect(() => load(unknownNode, manuscript)).toThrow()
    const tagInNotes = MANUSCRIPT['an inline tag token'] ?? EMPTY_DOC
    expect(() => load(tagInNotes, NOTES_SCHEMA)).toThrow()
    expect(() => load(tagInNotes, page)).toThrow()
  })
})
