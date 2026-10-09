import {
  declineReviewCategory,
  type ContextReview,
  type ContextReviewEntity,
  type ExistingSheet
} from '@shared/contextLibrary'
import { REVIEW_NOTES_ID } from '@shared/reviewChat'
import type {
  ReviewDecision,
  ReviewDeckGroup,
  ReviewDeckItem
} from '@renderer/features/review/reviewDeckModel'

/**
 * The upload review on the review deck (F-9.8, 2026-10-08, one decision at a time): which cards
 * the review makes, in which groups, and what the review becomes once the author's decisions are
 * read into it at Apply. Nothing starts included: a sheet, a note, or a proposed category lands
 * only when accepted. Pure, so the rules are tested apart from the dialog.
 */

export type UploadGroup = 'categories' | 'new' | 'updates' | 'conflicts' | 'notes'

export const UPLOAD_GROUPS: ReviewDeckGroup[] = [
  { id: 'categories', label: 'New categories', noun: 'New category' },
  { id: 'new', label: 'New sheets', noun: 'New sheet' },
  { id: 'conflicts', label: 'Conflicts', noun: 'Conflict' },
  { id: 'updates', label: 'Updates', noun: 'Update' },
  { id: 'notes', label: 'Project notes', noun: 'Project notes' }
]

/** The card id of a proposed category (sheets and notes use their own ids). */
export const categoryCardId = (categoryId: string): string => `category:${categoryId}`

/** The proposed category a card id names, or null for a sheet or the notes. */
export function categoryOfCard(id: string): string | null {
  return id.startsWith('category:') ? id.slice('category:'.length) : null
}

/** Whether a sheet of the review has a field whose value differs from the sheet's. */
export const hasConflict = (item: ContextReviewEntity): boolean =>
  item.fields.some((field) => field.existing !== null)

function groupOfItem(item: ContextReviewEntity): UploadGroup {
  if (item.existingId === null) return 'new'
  return hasConflict(item) ? 'conflicts' : 'updates'
}

/** The deck's cards: proposed categories, sheets, then the notes, each with the author's decision. */
export function uploadReviewItems(
  review: ContextReview,
  decisions: Readonly<Record<string, ReviewDecision>>
): ReviewDeckItem[] {
  const decision = (id: string): ReviewDecision => decisions[id] ?? 'pending'
  return [
    ...review.categories
      .filter((category) => category.proposed)
      .map((category) => {
        const id = categoryCardId(category.id)
        return { id, group: 'categories', decision: decision(id) }
      }),
    ...review.entities.map((item) => ({
      id: item.id,
      group: groupOfItem(item),
      decision: decision(item.id)
    })),
    ...(review.notes.paragraphs.length > 0
      ? [{ id: REVIEW_NOTES_ID, group: 'notes', decision: decision(REVIEW_NOTES_ID) }]
      : [])
  ]
}

/**
 * The review as Apply writes it: a proposed category not accepted is declined (its sheets go to
 * World, as Decline does), and a sheet or the notes are included only when accepted.
 */
export function decidedReview(
  review: ContextReview,
  decisions: Readonly<Record<string, ReviewDecision>>,
  existing: readonly ExistingSheet[]
): ContextReview {
  let decided = review
  for (const category of review.categories) {
    if (category.proposed && decisions[categoryCardId(category.id)] !== 'accepted') {
      decided = declineReviewCategory(decided, category.id, existing)
    }
  }
  return {
    ...decided,
    entities: decided.entities.map((item) => ({
      ...item,
      include: decisions[item.id] === 'accepted'
    })),
    notes: { ...decided.notes, include: decisions[REVIEW_NOTES_ID] === 'accepted' }
  }
}
