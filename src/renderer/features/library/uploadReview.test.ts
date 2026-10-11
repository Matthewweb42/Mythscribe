import { describe, expect, it } from 'vitest'
import { BUILTIN_CATEGORIES } from '@shared/categories'
import type { ContextReview, ExistingSheet } from '@shared/contextLibrary'
import { contextReviewFixture } from './libraryFixture'
import { categoryCardId, decidedReview, uploadReviewItems } from './uploadReview'

/** The fixture with Tomas filed under a category the AI proposed. */
function withShips(): ContextReview {
  const review = contextReviewFixture()
  const base = BUILTIN_CATEGORIES[0]
  if (base === undefined) throw new Error('no built-in category')
  return {
    ...review,
    categories: [
      { ...base, id: 'c-ships', name: 'Ships', noun: 'ship', builtIn: false, proposed: true }
    ],
    entities: review.entities.map((item) =>
      item.id === 'e2' ? { ...item, kind: 'c-ships' } : item
    )
  }
}

describe('the upload review on the deck (2026-10-08)', () => {
  it('makes one card per proposed category, sheet, and the notes, every one accepted until the author skips it (2026-10-10)', () => {
    const items = uploadReviewItems(withShips(), { e1: 'skipped' })
    expect(items).toEqual([
      { id: categoryCardId('c-ships'), group: 'categories', decision: 'accepted' },
      { id: 'e1', group: 'conflicts', decision: 'skipped' },
      { id: 'e2', group: 'new', decision: 'accepted' },
      { id: 'notes', group: 'notes', decision: 'accepted' }
    ])
  })

  it('writes everything not skipped, and files a skipped category’s sheets under World', () => {
    const kept = decidedReview(withShips(), {}, [])
    expect(kept.categories.map((category) => category.id)).toEqual(['c-ships'])
    expect(kept.entities.map((item) => [item.id, item.include, item.kind])).toEqual([
      ['e1', true, 'character'],
      ['e2', true, 'c-ships']
    ])
    expect(kept.notes.include).toBe(true)

    const decided = decidedReview(
      withShips(),
      { [categoryCardId('c-ships')]: 'skipped', e1: 'skipped', notes: 'skipped' },
      []
    )
    expect(decided.entities.map((item) => [item.id, item.include, item.kind])).toEqual([
      ['e1', false, 'character'],
      ['e2', true, 'world']
    ])
    expect(decided.categories).toEqual([])
    expect(decided.notes.include).toBe(false)
  })

  it('never sends Apply a new sheet under a name the story bible has: it fills that sheet (2026-10-11)', () => {
    const sheet = (id: string, name: string, tagId: string | null): ExistingSheet => ({
      id,
      kind: 'character',
      name,
      template: 'structured',
      fields: {},
      body: null,
      image: null,
      tagId
    })
    // "tomas" was made since the review was planned (in another window, or by the review chat).
    const existing = [sheet('mara', 'Mara Vell', 't1'), sheet('tomas', ' tomas', null)]
    const decided = decidedReview(contextReviewFixture(), {}, existing)
    expect(decided.entities.map((item) => [item.id, item.existingId, item.name])).toEqual([
      ['e1', 'mara', 'Mara Vell'],
      ['e2', 'tomas', ' tomas']
    ])
    // Nothing to add but the tag the untagged sheet lacks: the item says so instead of creating.
    expect(decided.entities[1]).toMatchObject({ tag: true, include: true })
    // A skipped card is left as it was: Apply leaves it out anyway.
    const skipped = decidedReview(contextReviewFixture(), { e2: 'skipped' }, existing)
    expect(skipped.entities[1]).toMatchObject({ id: 'e2', existingId: null, include: false })
  })
})
