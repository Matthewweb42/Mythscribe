import { describe, expect, it } from 'vitest'
import type {
  ContextRecord,
  ContextReview,
  ContextReviewEntity,
  ExistingSheet
} from './contextLibrary'
import { categoryFromInput } from './categories'
import {
  applyReviewOps,
  itemAliases,
  resolveKind,
  ReviewOp,
  type ReviewOp as Op
} from './reviewChat'

const record = (id: string, name: string, over: Partial<ContextRecord> = {}): ContextRecord => ({
  id,
  fileId: 'f1',
  fileName: 'lore.md',
  kind: 'character',
  name,
  aliases: [],
  fields: {},
  details: [],
  ...over
})

const item = (
  id: string,
  records: ContextRecord[],
  over: Partial<ContextReviewEntity> = {}
): ContextReviewEntity => ({
  id,
  kind: records[0]?.kind ?? 'character',
  name: records[0]?.name ?? id,
  existingId: null,
  include: true,
  tag: true,
  records,
  fields: [],
  details: records.flatMap((r) => r.details),
  includeDetails: true,
  images: [],
  ...over
})

const sheet = (over: Partial<ExistingSheet>): ExistingSheet => ({
  id: 's1',
  kind: 'character',
  name: 'Sheet',
  template: 'structured',
  fields: {},
  body: null,
  image: null,
  tagId: 't1',
  ...over
})

function fixture(): ContextReview {
  return {
    fileIds: ['f1'],
    entities: [
      item('e1', [record('r1', 'Rynna', { fields: { age: '31' } })], {
        fields: [{ field: 'age', upload: '31', existing: null, include: false, choice: 'upload' }]
      }),
      item('e2', [
        record('r2', 'High Crown Falsire', {
          aliases: ['the High Crown'],
          details: ['Rule: speaks at council.']
        })
      ]),
      item(
        'e3',
        [
          record('r3', 'Kael', {
            fields: { appearance: 'Walled, grey stone' },
            details: ['Overview: a harbour city.']
          })
        ],
        {
          images: [{ fileId: 'img', fileName: 'kael.png', include: true, replaces: false }]
        }
      )
    ],
    notes: {
      existingId: null,
      paragraphs: ['Ashfall War: burned the south.', 'Theme: debts.'],
      include: true
    },
    categories: [],
    proposalIds: ['p1'],
    chunks: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    model: 'gpt-5.4',
    promptVersion: 'contextImport.v1'
  }
}

const run = (ops: Op[], existing: ExistingSheet[] = [], review = fixture()) =>
  applyReviewOps(review, ops, existing)

const byId = (review: ContextReview, id: string): ContextReviewEntity | undefined =>
  review.entities.find((e) => e.id === id)

describe('ReviewOp (F-9.9)', () => {
  it('reads a kind as the model may spell it and refuses an unknown one', () => {
    expect(ReviewOp.parse({ op: 'kind', item: 'e1', kind: ' Setting ' })).toEqual({
      op: 'kind',
      item: 'e1',
      kind: 'setting'
    })
    // F-9.11: any spelling parses; `resolveKind` reads it against the review's categories.
    expect(ReviewOp.safeParse({ op: 'kind', item: 'e1', kind: '' }).success).toBe(false)
    expect(ReviewOp.safeParse({ op: 'merge', items: ['e1'] }).success).toBe(false)
  })
})

describe('applyReviewOps (F-9.9)', () => {
  it('merges two new items under the main name asked for, the others becoming its names', () => {
    const before = fixture()
    const { review, changes } = run(
      [{ op: 'merge', items: ['e1', 'e2'], name: 'Rynna Falsire' }],
      [],
      before
    )
    expect(review.entities.map((e) => e.id)).toEqual(['e1', 'e3'])
    const merged = byId(review, 'e1')!
    expect(merged.name).toBe('Rynna Falsire')
    expect(itemAliases(merged)).toEqual(['Rynna', 'High Crown Falsire', 'the High Crown'])
    expect(merged.details).toEqual(['Rule: speaks at council.'])
    // The author's earlier pick on the same field and value survives the rebuild.
    expect(merged.fields).toEqual([
      { field: 'age', upload: '31', existing: null, include: false, choice: 'upload' }
    ])
    expect(changes).toEqual([
      { text: 'Merged “High Crown Falsire” into “Rynna Falsire”.', itemIds: ['e1'], skipped: false }
    ])
    // Pure: the review passed in is unchanged.
    expect(before.entities).toHaveLength(3)
  })

  it('merges into the existing sheet when one item fills it, and refuses two existing sheets', () => {
    const rynna = sheet({ id: 'rynna', name: 'Rynna Falsire', fields: { age: '30' } })
    const withSheet = fixture()
    withSheet.entities[1] = {
      ...withSheet.entities[1]!,
      existingId: 'rynna',
      name: 'Rynna Falsire'
    }
    const { review } = run([{ op: 'merge', items: ['e1', 'e2'] }], [rynna], withSheet)
    const merged = byId(review, 'e2')!
    expect(review.entities.map((e) => e.id)).toEqual(['e2', 'e3'])
    expect(merged.existingId).toBe('rynna')
    expect(merged.name).toBe('Rynna Falsire')
    expect(merged.fields[0]).toMatchObject({ field: 'age', upload: '31', existing: '30' })

    const both = fixture()
    both.entities[0] = { ...both.entities[0]!, existingId: 'a' }
    both.entities[1] = { ...both.entities[1]!, existingId: 'b' }
    const refused = run([{ op: 'merge', items: ['e1', 'e2'] }], [], both)
    expect(refused.review).toBe(both)
    expect(refused.changes[0]).toMatchObject({ skipped: true })
    expect(refused.changes[0]?.text).toContain('already separate sheets')
  })

  it('splits a merged item again, and skips one with a single name', () => {
    const merged = run([{ op: 'merge', items: ['e1', 'e2'], name: 'Rynna Falsire' }]).review
    const { review, changes } = run([{ op: 'split', item: 'e1' }], [], merged)
    expect(review.entities.map((e) => e.name)).toEqual(['Rynna', 'High Crown Falsire', 'Kael'])
    expect(changes[0]).toMatchObject({ skipped: false, itemIds: ['e1.1', 'e1.2'] })
    expect(run([{ op: 'split', item: 'e3' }]).changes[0]).toMatchObject({ skipped: true })
  })

  it('changes a kind: fields the kind lacks become details, a picture stays only where it can', () => {
    const { review, changes } = run([{ op: 'kind', item: 'e3', kind: 'world' }])
    const kael = byId(review, 'e3')!
    expect(kael.kind).toBe('world')
    expect(kael.existingId).toBeNull()
    expect(kael.records[0]?.kind).toBe('world')
    expect(kael.details).toEqual(['Appearance: Walled, grey stone', 'Overview: a harbour city.'])
    expect(kael.images).toEqual([])
    expect(changes[0]?.text).toBe('“Kael” is now a world-building item (a new sheet).')

    const asSetting = byId(run([{ op: 'kind', item: 'e3', kind: 'setting' }]).review, 'e3')!
    expect(asSetting.images).toHaveLength(1)
  })

  it('moves an item into any library category by id, name, or singular, and skips an unknown one (F-9.11)', () => {
    for (const kind of ['culture', 'Cultures', 'CULTURE']) {
      const { review, changes } = run([{ op: 'kind', item: 'e3', kind }])
      expect(byId(review, 'e3')?.kind).toBe('culture')
      expect(changes[0]?.text).toBe('“Kael” is now a culture (a new sheet).')
    }
    const { review, changes } = run([{ op: 'kind', item: 'e3', kind: 'spaceship' }])
    expect(byId(review, 'e3')?.kind).toBe('character')
    expect(changes[0]).toMatchObject({ skipped: true })
    expect(changes[0]?.text).toContain('there is no category “spaceship”')
  })

  it('moves an item into a category proposed in the review (F-9.11)', () => {
    const withShips = fixture()
    withShips.categories = [
      { ...categoryFromInput('c-ships', { name: 'Ships', fields: ['Crew'] }, 'ai'), proposed: true }
    ]
    const { review } = run([{ op: 'kind', item: 'e3', kind: 'ships' }], [], withShips)
    expect(byId(review, 'e3')?.kind).toBe('c-ships')
    expect(resolveKind(withShips, 'c-ships')).toBe('c-ships')
    expect(resolveKind(withShips, 'ship')).toBe('c-ships')
    expect(resolveKind(withShips, 'boats')).toBeNull()
  })

  it('fills an existing sheet of the new kind by name, or joins the same-named item', () => {
    const city = sheet({ id: 'kael-city', kind: 'setting', name: 'Kael', tagId: null })
    const filled = byId(run([{ op: 'kind', item: 'e3', kind: 'setting' }], [city]).review, 'e3')!
    expect(filled.existingId).toBe('kael-city')
    expect(filled.tag).toBe(true)

    const two = fixture()
    two.entities.push(item('e4', [record('r4', 'Kael', { kind: 'setting', details: ['Port.'] })]))
    const { review, changes } = run([{ op: 'kind', item: 'e3', kind: 'setting' }], [], two)
    expect(review.entities.map((e) => e.id)).toEqual(['e1', 'e2', 'e4'])
    expect(byId(review, 'e4')!.records.map((r) => r.id)).toEqual(['r4', 'r3'])
    expect(changes[0]).toMatchObject({ itemIds: ['e4'], skipped: false })
  })

  it('moves an item into Project notes, under its name', () => {
    const { review, changes } = run([{ op: 'toNotes', item: 'e3' }])
    expect(byId(review, 'e3')).toBeUndefined()
    expect(review.notes.paragraphs.slice(2)).toEqual(['Kael, Overview: a harbour city.'])
    expect(changes[0]).toMatchObject({ itemIds: ['notes'], skipped: false })
  })

  it('makes a sheet from notes, joins an item of that name, and skips a note that is not there', () => {
    const made = run([{ op: 'fromNotes', notes: [1], kind: 'world', name: 'Ashfall War' }])
    const war = made.review.entities.at(-1)!
    expect(war).toMatchObject({ id: 'c2', kind: 'world', name: 'Ashfall War', existingId: null })
    expect(war.details).toEqual(['Ashfall War: burned the south.'])
    expect(made.review.notes.paragraphs).toEqual(['Theme: debts.'])
    expect(made.changes[0]?.text).toBe('Made “Ashfall War” a world-building item from the note.')

    const joined = run([{ op: 'fromNotes', notes: [2], kind: 'character', name: 'the high crown' }])
    expect(byId(joined.review, 'e2')!.details).toEqual([
      'Rule: speaks at council.',
      'Theme: debts.'
    ])

    expect(
      run([{ op: 'fromNotes', notes: [9], kind: 'world', name: 'X' }]).changes[0]
    ).toMatchObject({ skipped: true })
  })

  it('renames a new sheet only, and never onto a name already taken', () => {
    const renamed = run([{ op: 'rename', item: 'e1', name: 'Rynna Falsire' }])
    expect(byId(renamed.review, 'e1')!.name).toBe('Rynna Falsire')
    expect(itemAliases(byId(renamed.review, 'e1')!)).toEqual(['Rynna'])

    const existing = fixture()
    existing.entities[0] = { ...existing.entities[0]!, existingId: 's1' }
    expect(run([{ op: 'rename', item: 'e1', name: 'X' }], [], existing).changes[0]?.text).toContain(
      'rename it in the story bible'
    )
    expect(run([{ op: 'rename', item: 'e1', name: 'kael' }]).changes[0]?.text).toContain(
      'merge them'
    )
    expect(
      run([{ op: 'rename', item: 'e1', name: 'Mara' }], [sheet({ name: 'Mara' })]).changes[0]?.text
    ).toContain('already has “Mara”')
  })

  it('sets the other names as a whole list, without the main name or repeats', () => {
    const { review, changes } = run([
      { op: 'aliases', item: 'e2', aliases: ['High Crown', ' high crown ', 'High Crown Falsire'] }
    ])
    expect(byId(review, 'e2')!.records[0]?.aliases).toEqual(['High Crown'])
    expect(changes[0]?.text).toBe('“High Crown Falsire” is also called “High Crown”.')
  })

  it('includes or leaves out an item or the Project notes, and skips an unknown id', () => {
    const { review, changes } = run([
      { op: 'include', item: 'e1', include: false },
      { op: 'include', item: 'notes', include: false },
      { op: 'include', item: 'e9', include: true }
    ])
    expect(byId(review, 'e1')!.include).toBe(false)
    expect(review.notes.include).toBe(false)
    expect(changes.map((c) => c.skipped)).toEqual([false, false, true])
  })

  it('applies operations in order, each on the review the one before left', () => {
    const { review } = run([
      { op: 'merge', items: ['e1', 'e2'], name: 'Rynna Falsire' },
      { op: 'aliases', item: 'e1', aliases: ['Rynna', 'High Crown Falsire'] },
      { op: 'include', item: 'e2', include: false }
    ])
    expect(review.entities.map((e) => e.id)).toEqual(['e1', 'e3'])
    expect(itemAliases(byId(review, 'e1')!)).toEqual(['Rynna', 'High Crown Falsire'])
  })
})
