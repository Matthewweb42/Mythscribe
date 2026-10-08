import { describe, expect, it } from 'vitest'
import { BUILTIN_CATEGORIES, categoryFromInput } from '@shared/categories'
import type { ContextReview } from '@shared/contextLibrary'
import { REVIEW_CHAT_MAX_TOKENS, REVIEW_CHAT_RETRY_MAX_TOKENS } from '@shared/reviewChat'
import { REVIEW_CHAT_RULES } from './reviewChat.v1'
import { buildReviewChatPromptV2, REVIEW_CHAT_RULES_V2, reviewListingV2 } from './reviewChat.v2'

const ships = categoryFromInput('c-ships', { name: 'Ships', fields: ['Crew'] }, 'ai')

const review: ContextReview = {
  fileIds: ['f1'],
  entities: [
    {
      id: 'e1',
      kind: 'c-ships',
      name: 'The Gull',
      existingId: null,
      include: true,
      tag: true,
      records: [
        {
          id: 'r1',
          fileId: 'f1',
          fileName: 'fleet.md',
          kind: 'c-ships',
          name: 'The Gull',
          aliases: [],
          fields: { crew: 'twelve' },
          details: []
        }
      ],
      fields: [
        { field: 'crew', upload: 'twelve', existing: null, include: true, choice: 'upload' }
      ],
      details: [],
      includeDetails: true,
      images: []
    }
  ],
  categories: [{ ...ships, proposed: true }],
  notes: { existingId: null, paragraphs: ['Theme: debts.'], include: true },
  proposalIds: [],
  chunks: 1,
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  model: 'gpt-5.4',
  promptVersion: 'contextImport.v2'
}

describe('reviewChat.v2 prompt (F-9.11)', () => {
  it('matches the golden messages', () => {
    const built = buildReviewChatPromptV2({ review, history: [], message: 'Ships are fine.' })
    expect(built.version).toBe('reviewChat.v2')
    expect(built.maxTokens).toBe(REVIEW_CHAT_MAX_TOKENS)
    expect(built.messages).toMatchSnapshot()
  })

  it('keeps version 1’s opening sentence and lists the library as kinds', () => {
    expect(REVIEW_CHAT_RULES_V2.startsWith(REVIEW_CHAT_RULES.slice(0, 80))).toBe(true)
    for (const category of BUILTIN_CATEGORIES) {
      expect(REVIEW_CHAT_RULES_V2).toContain(`${category.id} (${category.hint})`)
    }
  })

  it('lists the review’s categories first and labels fields by the proposed template', () => {
    const listing = reviewListingV2(review)
    expect(listing.startsWith('More kinds: c-ships (Ships, proposed)\n\nPending review:\n')).toBe(
      true
    )
    expect(listing).toContain(
      'e1 · c-ships · The Gull · new sheet · from fleet.md · fields: Crew=twelve'
    )
    expect(reviewListingV2({ ...review, categories: [] }).startsWith('Pending review:')).toBe(true)
  })

  it('asks the larger cap on the retry', () => {
    const built = buildReviewChatPromptV2({ review, history: [], message: 'x', retry: true })
    expect(built.maxTokens).toBe(REVIEW_CHAT_RETRY_MAX_TOKENS)
    expect(built.messages).toHaveLength(4)
  })
})
