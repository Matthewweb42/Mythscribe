import { describe, expect, it } from 'vitest'
import { categoryFromInput, categoryOf } from './categories'
import { priceFor } from './ai'
import {
  canSplit,
  changedParagraphs,
  declineReviewCategory,
  renameReviewCategory,
  chunkParagraphs,
  CONTEXT_CHUNK_OVERHEAD_TOKENS,
  CONTEXT_OUT_TOKENS_PER_CHUNK,
  contextFieldsFor,
  contextFileState,
  contextFileTypeOf,
  estimateContextCost,
  planContextReview,
  PROJECT_NOTES_NAME,
  recordFields,
  relateValues,
  reviewHasChanges,
  settleNameClashes,
  splitParagraphs,
  splitReviewEntity,
  writesField,
  type ContextRecord,
  type ContextReview,
  type ExistingSheet
} from './contextLibrary'

let counter = 0
const record = (over: Partial<ContextRecord> & Pick<ContextRecord, 'name'>): ContextRecord => ({
  id: `r${++counter}`,
  fileId: 'f1',
  fileName: 'notes.md',
  kind: 'character',
  aliases: [],
  fields: {},
  details: [],
  ...over
})

const sheet = (
  over: Partial<ExistingSheet> & Pick<ExistingSheet, 'id' | 'name'>
): ExistingSheet => ({
  kind: 'character',
  template: 'structured',
  fields: {},
  body: null,
  image: null,
  tagId: 't1',
  ...over
})

const plan = (
  records: ContextRecord[],
  existing: ExistingSheet[] = [],
  extra: Partial<Parameters<typeof planContextReview>[0]> = {}
): ReturnType<typeof planContextReview> =>
  planContextReview({
    records,
    existing,
    categories: [],
    images: [],
    hints: [],
    notes: [],
    ...extra
  })

const reviewOf = (entities: ReturnType<typeof planContextReview>): ContextReview => ({
  fileIds: ['f1'],
  entities: entities.entities,
  notes: entities.notes,
  categories: [],
  proposalIds: [],
  chunks: 1,
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  model: 'gpt-5.4',
  promptVersion: 'contextImport.v1'
})

describe('file types and states (F-9.8)', () => {
  it('takes Word, Markdown, text, PDF, and images by extension, any case', () => {
    expect(contextFileTypeOf('World.DOCX')).toBe('docx')
    expect(contextFileTypeOf('notes.markdown')).toBe('md')
    expect(contextFileTypeOf('a.txt')).toBe('txt')
    expect(contextFileTypeOf('Atlas.pdf')).toBe('pdf')
    expect(contextFileTypeOf('map.JPG')).toBe('image')
    expect(contextFileTypeOf('book.epub')).toBeNull()
    expect(contextFileTypeOf('README')).toBeNull()
  })

  it('derives the state from the hashes', () => {
    expect(contextFileState({ type: 'image', textHash: null, processedHash: null })).toBe(
      'reference'
    )
    expect(contextFileState({ type: 'pdf', textHash: null, processedHash: null })).toBe('noText')
    expect(contextFileState({ type: 'md', textHash: 'a', processedHash: null })).toBe('new')
    expect(contextFileState({ type: 'md', textHash: 'a', processedHash: 'a' })).toBe('processed')
    expect(contextFileState({ type: 'md', textHash: 'b', processedHash: 'a' })).toBe('changed')
  })
})

describe('paragraphs, chunks, and the estimate', () => {
  it('splits on blank lines and collapses spaces', () => {
    expect(splitParagraphs('One  line\r\nstill one\r\n\r\n\r\nTwo\n \nThree')).toEqual([
      'One line\nstill one',
      'Two',
      'Three'
    ])
  })

  it('packs paragraphs into chunks and cuts only a paragraph that alone is over', () => {
    const chunks = chunkParagraphs(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(10)], 60)
    expect(chunks).toEqual(['a'.repeat(40), `${'b'.repeat(40)}\n\n${'c'.repeat(10)}`])
    const long = `${'First sentence. '.repeat(10)}`.trim()
    const cut = chunkParagraphs([long], 60)
    expect(cut.every((chunk) => chunk.length <= 60)).toBe(true)
    expect(cut.join(' ')).toBe(long)
  })

  it('keeps only the paragraphs an updated file did not have', () => {
    expect(
      changedParagraphs(['Same.', 'New one.', 'Changed  text.'], ['same.', 'Changed text'])
    ).toEqual(['New one.', 'Changed  text.'])
  })

  it('estimates from the chunk sizes on the given model', () => {
    const estimate = estimateContextCost([4_000, 400], 2, 'gpt-5.4')
    const tokensIn = 1_000 + 100 + 2 * CONTEXT_CHUNK_OVERHEAD_TOKENS
    const tokensOut = 2 * CONTEXT_OUT_TOKENS_PER_CHUNK
    expect(estimate).toEqual({
      files: 2,
      chunks: 2,
      tokensIn,
      tokensOut,
      costUsd: priceFor('gpt-5.4', tokensIn, tokensOut).costUsd,
      priced: true,
      model: 'gpt-5.4'
    })
    expect(estimateContextCost([], 0, '').priced).toBe(false)
  })
})

describe('recordFields', () => {
  it('keeps only the kind fillable fields, trimmed and non-empty, numbers as text', () => {
    expect(contextFieldsFor(categoryOf('character'))).not.toContain('notes')
    expect(
      recordFields(categoryOf('character'), {
        age: 34,
        appearance: ' Grey eyes ',
        notes: 'x',
        rules: 'y',
        gender: ''
      })
    ).toEqual({ age: '34', appearance: 'Grey eyes' })
  })
})

describe('planContextReview (F-9.8)', () => {
  it('merges records across files by name and nickname and matches the existing sheet', () => {
    const existing = [sheet({ id: 'mara', name: 'Mara Vell', fields: { age: '34' } })]
    const { entities } = plan(
      [
        record({ name: 'Mara', fields: { age: '35' }, details: ['History: ran the ferry.'] }),
        record({
          name: 'Mara Vell',
          aliases: ['Mara'],
          fileName: 'b.md',
          fields: { appearance: 'Grey eyes' }
        }),
        record({ name: 'Tomas', fields: { age: '29' } })
      ],
      existing
    )
    expect(entities).toHaveLength(2)
    const mara = entities[0]!
    expect(mara).toMatchObject({ name: 'Mara Vell', existingId: 'mara', tag: null })
    expect(mara.records.map((r) => r.name)).toEqual(['Mara', 'Mara Vell'])
    expect(mara.fields).toEqual([
      { field: 'age', upload: '35', existing: '34', include: true, choice: 'existing' },
      { field: 'appearance', upload: 'Grey eyes', existing: null, include: true, choice: 'upload' }
    ])
    expect(mara.details).toEqual(['History: ran the ferry.'])
    expect(entities[1]).toMatchObject({ name: 'Tomas', existingId: null, tag: true })
  })

  it('matches a record to a sheet by one of the sheet’s own aliases (F-4.14)', () => {
    const existing = [sheet({ id: 'rynna', name: 'Rynna Falsire', aliases: ['The High Crown'] })]
    const { entities } = plan([record({ name: 'The High Crown', fields: { age: '40' } })], existing)
    expect(entities[0]).toMatchObject({ name: 'Rynna Falsire', existingId: 'rynna' })
  })

  it('drops what the sheet already says and an existing sheet with nothing new', () => {
    const existing = [
      sheet({
        id: 'mara',
        name: 'Mara Vell',
        fields: {
          age: '34',
          appearance: 'Grey eyes, a burn scar',
          notes: 'History: ran the ferry.'
        }
      })
    ]
    const { entities } = plan(
      [
        record({
          name: 'Mara Vell',
          fields: { age: '34', appearance: 'grey eyes' },
          details: ['History: ran the ferry.']
        })
      ],
      existing
    )
    expect(entities).toEqual([])
  })

  it('joins distinct values from two files: one-line fields with a slash, long ones as paragraphs', () => {
    const { entities } = plan([
      record({ name: 'Mara', fields: { age: '34', background: 'Born upriver.' } }),
      record({ name: 'Mara', fields: { age: '35', background: 'Born upriver.' } }),
      record({ name: 'Mara', fields: { background: 'Raised by the mill.' } })
    ])
    expect(entities[0]?.fields).toEqual([
      { field: 'age', upload: '34 / 35', existing: null, include: true, choice: 'upload' },
      {
        field: 'background',
        upload: 'Born upriver.\n\nRaised by the mill.',
        existing: null,
        include: true,
        choice: 'upload'
      }
    ])
  })

  it('reads a blank sheet page for the details already there, and offers a tag to an untagged sheet', () => {
    const existing = [
      sheet({
        id: 'elm',
        kind: 'world',
        name: 'Elm Court',
        template: 'blank',
        body: 'Founded: long ago.',
        tagId: null
      })
    ]
    const { entities } = plan(
      [
        record({
          kind: 'world',
          name: 'Elm Court',
          details: ['Founded: long ago.', 'Members: ferrymen.']
        })
      ],
      existing
    )
    expect(entities[0]).toMatchObject({
      existingId: 'elm',
      tag: true,
      details: ['Members: ferrymen.']
    })
  })

  it('keeps only notes the Project notes page does not have yet', () => {
    const existing = [
      sheet({
        id: 'pn',
        kind: 'world',
        name: PROJECT_NOTES_NAME,
        template: 'blank',
        body: 'Theme: debts.'
      })
    ]
    const { notes } = plan([], existing, { notes: ['Theme: debts.', 'Outline: three acts.'] })
    expect(notes).toEqual({ existingId: 'pn', paragraphs: ['Outline: three acts.'], include: true })
  })

  it('attaches images by the model hint or a name in the file name, never to a world item', () => {
    const existing = [
      sheet({ id: 'landing', kind: 'setting', name: 'The Landing', image: 'old.png' }),
      sheet({ id: 'elm', kind: 'world', name: 'Elm Court' })
    ]
    const { entities } = plan([record({ name: 'Mara Vell', aliases: ['Mara'] })], existing, {
      images: [
        { id: 'i1', name: 'mara-portrait.png' },
        { id: 'i2', name: 'IMG_0042.jpg' },
        { id: 'i3', name: 'elm-court.png' }
      ],
      hints: [{ fileName: 'IMG_0042.jpg', name: 'The Landing' }]
    })
    expect(entities[0]?.images).toEqual([
      { fileId: 'i1', fileName: 'mara-portrait.png', include: true, replaces: false }
    ])
    expect(entities[1]).toMatchObject({
      existingId: 'landing',
      images: [{ fileId: 'i2', fileName: 'IMG_0042.jpg', include: false, replaces: true }]
    })
    expect(entities).toHaveLength(2)
  })
})

describe('splitReviewEntity', () => {
  it('splits a match back into one item per name; the sheet stays with its own name', () => {
    const existing = [sheet({ id: 'mara', name: 'Mara Vell' })]
    const review = reviewOf(
      plan(
        [
          record({ name: 'Mara Vell', fields: { age: '34' } }),
          record({ name: 'Mara the Younger', aliases: ['Mara Vell'], fields: { age: '12' } })
        ],
        existing
      )
    )
    const merged = review.entities[0]!
    expect(canSplit(merged)).toBe(true)
    const split = splitReviewEntity(review, merged.id, existing)
    expect(split.entities.map((e) => [e.name, e.existingId])).toEqual([
      ['Mara Vell', 'mara'],
      ['Mara the Younger', null]
    ])
    expect(split.entities.map((e) => e.id)).toEqual([`${merged.id}.1`, `${merged.id}.2`])
    expect(splitReviewEntity(split, split.entities[1]!.id, existing)).toBe(split)
  })
})

describe('what Apply writes', () => {
  it('writes a fill, a conflict only when the upload is picked, and reports whether anything changes', () => {
    expect(
      writesField({ field: 'age', upload: '3', existing: null, include: true, choice: 'upload' })
    ).toBe(true)
    expect(
      writesField({ field: 'age', upload: '3', existing: '4', include: true, choice: 'existing' })
    ).toBe(false)
    expect(
      writesField({ field: 'age', upload: '3', existing: '4', include: true, choice: 'upload' })
    ).toBe(true)
    expect(
      writesField({ field: 'age', upload: '3', existing: null, include: false, choice: 'upload' })
    ).toBe(false)
    const review = reviewOf(plan([record({ name: 'Ilse' })]))
    expect(reviewHasChanges(review)).toBe(true)
    expect(
      reviewHasChanges({
        ...review,
        entities: review.entities.map((e) => ({ ...e, include: false }))
      })
    ).toBe(false)
  })
})

describe('categories in the review (F-9.11)', () => {
  const ships = {
    ...categoryFromInput('c-ships', { name: 'Ships', fields: ['Crew'] }, 'ai'),
    proposed: true
  }

  it('fills a same-named sheet of another category where it is, its fields moved to details', () => {
    const weave = sheet({ id: 's-weave', kind: 'world', name: 'The Weave', tagId: 't9' })
    const result = plan(
      [
        record({
          kind: 'magic',
          name: 'The Weave',
          fields: { costs: 'A memory', description: 'Threads' }
        })
      ],
      [weave]
    )
    expect(result.entities).toHaveLength(1)
    expect(result.entities[0]).toMatchObject({ kind: 'world', existingId: 's-weave' })
    expect(result.entities[0]?.fields.map((f) => f.field)).toEqual(['description'])
    expect(result.entities[0]?.details).toEqual(['Costs and limits: A memory'])
  })

  it('reads a proposed category’s fields and drops a proposal no item ended up in', () => {
    const unused = { ...ships, id: 'c-guilds', name: 'Guilds' }
    const result = plan(
      [record({ kind: 'c-ships', name: 'The Gull', fields: { crew: '12' } })],
      [],
      {
        categories: [ships, unused]
      }
    )
    expect(result.entities[0]?.fields).toEqual([
      { field: 'crew', upload: '12', existing: null, include: true, choice: 'upload' }
    ])
    expect(result.categories.map((c) => c.id)).toEqual(['c-ships'])
  })

  it('declines a proposal: its items become World sheets, filling a same-named one', () => {
    const tides = sheet({ id: 's-tides', kind: 'world', name: 'The Tides', tagId: 't2' })
    const planned = plan(
      [
        record({ kind: 'c-ships', name: 'The Gull', fields: { crew: '12' } }),
        record({ kind: 'c-ships', name: 'The Tides' })
      ],
      [],
      { categories: [ships] }
    )
    const review = { ...reviewOf(planned), categories: planned.categories }
    const declined = declineReviewCategory(review, 'c-ships', [tides])
    expect(declined.categories).toEqual([])
    const gull = declined.entities.find((e) => e.name === 'The Gull')
    expect(gull).toMatchObject({ kind: 'world', existingId: null })
    expect(gull?.details).toEqual(['Crew: 12'])
    // "The Tides" said nothing new about the existing World sheet, so it leaves the review.
    expect(declined.entities.map((e) => e.name)).toEqual(['The Gull'])
    expect(declineReviewCategory(review, 'world', [])).toBe(review)
  })

  it('renames a proposal before it is created, and ignores an empty name', () => {
    const review = { ...reviewOf(plan([])), categories: [ships] }
    expect(renameReviewCategory(review, 'c-ships', ' Vessels ').categories[0]?.name).toBe('Vessels')
    expect(renameReviewCategory(review, 'c-ships', '  ')).toBe(review)
  })

  it('takes a proposed category’s field by its label as well as its id', () => {
    expect(recordFields(ships, { Crew: 'twelve', other: 'x' })).toEqual({ crew: 'twelve' })
  })
})

describe('only a real disagreement is a conflict (2026-10-11)', () => {
  it('reads how an uploaded value relates to the sheet’s', () => {
    // Not conflicts: the same words, an empty or placeholder field, more of the same, less of it.
    expect(relateValues('Grey eyes.', 'grey  eyes')).toBe('same')
    expect(relateValues('Captain of the Guard', 'captain of the guard!')).toBe('same')
    expect(relateValues('Café owner', 'cafe owner')).toBe('same')
    expect(relateValues("Mara's brother", 'Maras brother')).toBe('same')
    expect(relateValues('Blue eye', 'blue eyes')).toBe('same')
    expect(relateValues('', 'Tall')).toBe('empty')
    expect(relateValues('Unknown', '34')).toBe('empty')
    expect(relateValues(' - ', '34')).toBe('empty')
    expect(relateValues('Captain of the guard', 'Captain of the city guard since 1201')).toBe(
      'extends'
    )
    expect(relateValues('Grey eyes, a burn scar', 'a burn scar')).toBe('covered')
    // Conflicts: a different fact, or one turned around.
    expect(relateValues('34', '35')).toBe('differs')
    expect(relateValues('Born in Varn', 'Born in Sallow')).toBe('differs')
    expect(relateValues('Married to Tomas', 'Not married to Tomas')).toBe('differs')
    expect(relateValues('Loyal to the Crown', "Isn't loyal to the Crown")).toBe('differs')
  })

  it('offers no conflict where the upload agrees, adds detail, or fills an empty field', () => {
    const existing = [
      sheet({
        id: 'mara',
        name: 'Mara Vell',
        fields: {
          age: 'Unknown',
          gender: 'Female.',
          appearance: 'Grey eyes, a burn scar',
          background: 'Ran the ferry',
          personality: 'Stubborn'
        }
      })
    ]
    const { entities } = plan(
      [
        record({
          name: 'Mara Vell',
          fields: {
            age: '34',
            gender: 'female',
            appearance: 'Grey eyes, a burn scar on her left hand',
            background: 'ran the ferry.',
            goals: 'Pay the mill',
            personality: 'Gentle'
          }
        })
      ],
      existing
    )
    expect(entities[0]?.fields).toEqual([
      { field: 'age', upload: '34', existing: null, include: true, choice: 'upload' },
      {
        field: 'appearance',
        upload: 'Grey eyes, a burn scar on her left hand',
        existing: null,
        include: true,
        choice: 'upload'
      },
      // The one real disagreement.
      {
        field: 'personality',
        upload: 'Gentle',
        existing: 'Stubborn',
        include: true,
        choice: 'existing'
      },
      { field: 'goals', upload: 'Pay the mill', existing: null, include: true, choice: 'upload' }
    ])
  })

  it('merges two files saying the same thing, or one saying more of it, into one value', () => {
    const { entities } = plan([
      record({ name: 'Mara', fields: { gender: 'Female', appearance: 'Grey eyes' } }),
      record({ name: 'Mara', fields: { gender: 'female.', appearance: 'Grey eyes, a scar' } })
    ])
    expect(entities[0]?.fields.map((f) => [f.field, f.upload])).toEqual([
      ['gender', 'Female'],
      ['appearance', 'Grey eyes, a scar']
    ])
  })
})

describe('no new sheet under a name the story bible has (2026-10-11)', () => {
  const fathoms = sheet({
    id: 's-fathoms',
    kind: 'world',
    name: 'Fathoms',
    fields: { description: 'The drowned quarter.' }
  })

  it('joins a group to the item already filling the sheet of its name (the author’s "Fathoms")', () => {
    const { entities } = plan(
      [
        record({ kind: 'setting', name: 'Fathoms', fields: { atmosphere: 'Cold' } }),
        record({ kind: 'world', name: 'Fathoms', fields: { rules: 'No fire below' } })
      ],
      [fathoms]
    )
    expect(entities).toHaveLength(1)
    expect(entities[0]).toMatchObject({ kind: 'world', existingId: 's-fathoms' })
    expect(entities[0]?.fields.map((f) => f.field)).toEqual(['rules'])
    expect(entities[0]?.details).toEqual(['Atmosphere: Cold'])
  })

  it('turns a new sheet whose name is taken into an update, and joins two new ones of one name', () => {
    const review = reviewOf(plan([record({ kind: 'world', name: 'The Gull', fields: {} })]))
    const gull = review.entities[0]!
    const twisted: ContextReview = {
      ...review,
      entities: [
        {
          ...gull,
          id: 'a',
          name: '  fathoms ',
          records: [record({ kind: 'world', name: 'Fathoms', fields: { rules: 'No fire' } })]
        },
        {
          ...gull,
          id: 'b',
          name: 'The Gull',
          records: [record({ kind: 'world', name: 'The Gull', fields: { rules: 'Sails at dawn' } })]
        },
        {
          ...gull,
          id: 'c',
          name: 'the gull',
          records: [record({ kind: 'world', name: 'the gull', details: ['Crew: 12'] })]
        },
        { ...gull, id: 'd', name: 'Fathoms', include: false }
      ]
    }
    const settled = settleNameClashes(twisted, [fathoms])
    expect(
      settled.entities.map((item) => [item.id, item.existingId, item.name, item.include])
    ).toEqual([
      ['a', 's-fathoms', 'Fathoms', true],
      ['b', null, 'The Gull', true],
      ['d', null, 'Fathoms', false]
    ])
    expect(settled.entities[1]?.details).toEqual(['Crew: 12'])
    expect(settleNameClashes(review, [fathoms])).toBe(review)
  })

  it('declines a proposal whose item has the name of a new World sheet: one sheet, not two', () => {
    const ships = {
      ...categoryFromInput('c-ships', { name: 'Ships', fields: ['Crew'] }, 'ai'),
      proposed: true
    }
    // Neither exists yet, and they are of two categories, so the plan keeps them apart.
    const planned = plan(
      [
        record({ kind: 'world', name: 'Fathoms', fields: { rules: 'No fire below' } }),
        record({ kind: 'c-ships', name: 'Fathoms', fields: { crew: '12' } })
      ],
      [],
      { categories: [ships] }
    )
    expect(planned.entities).toHaveLength(2)
    const review = { ...reviewOf(planned), categories: planned.categories }
    const declined = declineReviewCategory(review, 'c-ships', [])
    expect(declined.entities).toHaveLength(1)
    expect(declined.entities[0]).toMatchObject({ kind: 'world', existingId: null, name: 'Fathoms' })
    expect(declined.entities[0]?.details).toEqual(['Crew: 12'])
  })
})
