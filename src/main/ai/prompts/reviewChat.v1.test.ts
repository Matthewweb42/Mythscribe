import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import type { ContextReview, ContextReviewEntity } from '@shared/contextLibrary'
import {
  REVIEW_CHAT_HISTORY_TURNS,
  REVIEW_CHAT_ITEMS_CHARS,
  REVIEW_CHAT_MAX_TOKENS,
  REVIEW_CHAT_RETRY_MAX_TOKENS
} from '@shared/reviewChat'
import {
  buildReviewChatPrompt,
  REVIEW_CHAT_RETRY_TURN,
  REVIEW_CHAT_RULES,
  reviewItemLine,
  reviewListing
} from './reviewChat.v1'

const item = (over: Partial<ContextReviewEntity> = {}): ContextReviewEntity => ({
  id: 'e1',
  kind: 'character',
  name: 'Rynna Falsire',
  existingId: null,
  include: true,
  tag: true,
  records: [
    {
      id: 'r1',
      fileId: 'f1',
      fileName: 'lore.md',
      kind: 'character',
      name: 'Rynna Falsire',
      aliases: ['Rynna'],
      fields: { age: '31' },
      details: ['History: heir to the Falsire seat.']
    },
    {
      id: 'r2',
      fileId: 'f2',
      fileName: 'court.docx',
      kind: 'character',
      name: 'High Crown Falsire',
      aliases: [],
      fields: {},
      details: []
    }
  ],
  fields: [
    { field: 'age', upload: '31', existing: '30', include: true, choice: 'existing' },
    { field: 'appearance', upload: 'Grey eyes', existing: null, include: true, choice: 'upload' }
  ],
  details: ['History: heir to the Falsire seat.', 'Rule: speaks at council.', 'Kin: Tomas.'],
  includeDetails: true,
  images: [],
  ...over
})

const review = (entities: ContextReviewEntity[], notes: string[] = []): ContextReview => ({
  fileIds: ['f1', 'f2'],
  entities,
  notes: { existingId: null, paragraphs: notes, include: true },
  proposalIds: [],
  chunks: 2,
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  model: 'gpt-5.4',
  promptVersion: 'contextImport.v1'
})

const fixture = {
  review: review(
    [
      item(),
      item({
        id: 'e2',
        kind: 'character',
        name: 'Kael',
        existingId: 'kael',
        tag: null,
        records: [],
        fields: [],
        details: [],
        include: false,
        images: [{ fileId: 'f3', fileName: 'kael.png', include: true, replaces: false }]
      })
    ],
    ['Ashfall War: the war that burned the southern forests.', 'Theme: inheritance as a debt.']
  ),
  history: [
    { role: 'user' as const, content: 'Is Kael a person?' },
    { role: 'assistant' as const, content: 'The notes call Kael a city.' }
  ],
  message: '  Kael is a place, not a character.  '
}

describe('reviewChat.v1 prompt (F-9.9)', () => {
  it('matches the golden messages for the fixture and asks for its cap', () => {
    const built = buildReviewChatPrompt(fixture)
    expect(built.version).toBe('reviewChat.v1')
    expect(built.maxTokens).toBe(REVIEW_CHAT_MAX_TOKENS)
    expect(REVIEW_CHAT_RETRY_MAX_TOKENS).toBeLessThanOrEqual(outputBudget('reviewChat'))
    expect(built.messages).toMatchSnapshot()
    expect(estimateTokens(built.messages.map((m) => m.content).join('\n'))).toBeLessThan(
      inputBudget('reviewChat')
    )
  })

  it('leads with the rules, then the review, the turns, and the message trimmed', () => {
    const built = buildReviewChatPrompt(fixture)
    expect(built.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'user',
      'assistant',
      'user'
    ])
    expect(built.messages[0]?.content).toBe(REVIEW_CHAT_RULES)
    expect(built.messages.at(-1)?.content).toBe('Kael is a place, not a character.')
  })

  it('lists an item on one line: names, files, fields with conflicts, two details, its state', () => {
    expect(reviewItemLine(item())).toBe(
      'e1 · character · Rynna Falsire · new sheet · also: Rynna, High Crown Falsire · ' +
        'from lore.md, court.docx · fields: Age=31 (conflict); Appearance=Grey eyes · ' +
        'details: History: heir to the Falsire seat. | Rule: speaks at council. (+1 more)'
    )
    expect(reviewListing(fixture.review)).toContain(
      'e2 · character · Kael · existing sheet · picture: kael.png · left out'
    )
    expect(reviewListing(fixture.review)).toContain(
      'Project notes:\n1. Ashfall War: the war that burned the southern forests.\n2. Theme'
    )
  })

  it('cuts the listing at its cap with a count, and sends only the last turns', () => {
    const many = Array.from({ length: 400 }, (_, i) => item({ id: `e${i}` }))
    const listing = reviewListing(review(many))
    const items = listing.slice(0, listing.indexOf('\n\nProject notes'))
    expect(items.length).toBeLessThan(REVIEW_CHAT_ITEMS_CHARS + 100)
    expect(items).toMatch(/\(\d+ more items not shown\)$/)
    const history = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `turn ${i}`
    }))
    const built = buildReviewChatPrompt({ ...fixture, history })
    expect(built.messages.slice(2, -1).map((m) => m.content)).toEqual(
      history.slice(-REVIEW_CHAT_HISTORY_TURNS).map((t) => t.content)
    )
  })

  it('adds the retry turn and the larger cap for the one retry', () => {
    const built = buildReviewChatPrompt({ ...fixture, retry: true })
    expect(built.messages.at(-1)?.content).toBe(REVIEW_CHAT_RETRY_TURN)
    expect(built.maxTokens).toBe(REVIEW_CHAT_RETRY_MAX_TOKENS)
  })
})
