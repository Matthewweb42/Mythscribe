import { describe, expect, it } from 'vitest'
import { BUILTIN_CATEGORIES } from '@shared/categories'
import type { ContextReview } from '@shared/contextLibrary'
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
  it('makes one card per proposed category, sheet, and the notes, grouped by what they do', () => {
    const items = uploadReviewItems(withShips(), { e1: 'accepted' })
    expect(items).toEqual([
      { id: categoryCardId('c-ships'), group: 'categories', decision: 'pending' },
      { id: 'e1', group: 'conflicts', decision: 'accepted' },
      { id: 'e2', group: 'new', decision: 'pending' },
      { id: 'notes', group: 'notes', decision: 'pending' }
    ])
  })

  it('writes only what was accepted, and files an unaccepted category’s sheets under World', () => {
    const decided = decidedReview(withShips(), { e2: 'accepted', notes: 'skipped' }, [])
    expect(decided.entities.map((item) => [item.id, item.include, item.kind])).toEqual([
      ['e1', false, 'character'],
      ['e2', true, 'world']
    ])
    expect(decided.categories).toEqual([])
    expect(decided.notes.include).toBe(false)

    const kept = decidedReview(
      withShips(),
      { [categoryCardId('c-ships')]: 'accepted', e2: 'accepted', notes: 'accepted' },
      []
    )
    expect(kept.categories.map((category) => category.id)).toEqual(['c-ships'])
    expect(kept.entities.find((item) => item.id === 'e2')?.kind).toBe('c-ships')
    expect(kept.notes.include).toBe(true)
  })
})
