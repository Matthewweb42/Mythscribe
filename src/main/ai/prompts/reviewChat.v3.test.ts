import { describe, expect, it } from 'vitest'
import { REVIEW_CHAT_MAX_TOKENS, REVIEW_CHAT_RETRY_MAX_TOKENS } from '@shared/reviewChat'
import type { FilingReview } from '@shared/filing'
import { REVIEW_CHAT_RULES } from './reviewChat.v1'
import { buildReviewChatPromptV3, filingItemLineV3, REVIEW_CHAT_RULES_V3 } from './reviewChat.v3'

const review: FilingReview = {
  docId: 'n-1',
  docTitle: 'Bestiary',
  docHash: 'h',
  items: [
    {
      id: 'f1',
      recordId: null,
      name: 'The Fen-Wight',
      categoryId: 'creature',
      known: [],
      aliases: ['wight'],
      lines: [
        {
          id: 'l1',
          text: 'Colour: pale',
          quote: 'a pale thing',
          para: 3,
          kind: 'add',
          replaces: null,
          use: true
        }
      ],
      sameAs: null,
      image: { nodeId: 'img', name: 'wight.png' },
      include: true
    },
    {
      id: 'f2',
      recordId: 'r-mara',
      name: 'Mara Vell',
      categoryId: 'character',
      known: ['Mara Vell'],
      aliases: ['Mara'],
      lines: [
        {
          id: 'l2',
          text: 'Eyes: grey',
          quote: 'Mara Vell has grey eyes',
          para: 1,
          kind: 'conflict',
          replaces: { index: 0, text: 'Eyes: green' },
          use: false
        }
      ],
      sameAs: { given: 'Mara', rule: 'subset' },
      image: null,
      include: false
    }
  ],
  categories: [],
  dropped: { quote: 0, duplicate: 0, dismissed: 0, alias: 0 },
  proposalIds: [],
  chunks: 1,
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  model: '',
  promptVersion: 'contextImport.v3'
}

describe('reviewChat.v3 prompt (F-16.9)', () => {
  it('matches the golden messages: rules, the filing listing, the turns, the message', () => {
    const built = buildReviewChatPromptV3({
      review,
      history: [
        { role: 'user', content: 'Merge the wight' },
        { role: 'assistant', content: 'Done.' }
      ],
      message: 'Leave Mara out.'
    })
    expect(built.version).toBe('reviewChat.v3')
    expect(built.maxTokens).toBe(REVIEW_CHAT_MAX_TOKENS)
    expect(built.messages).toMatchSnapshot()
  })

  it('keeps version 1’s opening sentence and offers no Project notes operations', () => {
    expect(REVIEW_CHAT_RULES_V3.startsWith(REVIEW_CHAT_RULES.slice(0, 56))).toBe(true)
    expect(REVIEW_CHAT_RULES_V3).not.toMatch(/toNotes|fromNotes|"split"/u)
  })

  it('lists each item on one line with its lines, conflicts, same-as note and state', () => {
    expect(filingItemLineV3(review.items[1]!)).toBe(
      'f2 · character · Mara Vell · adds to the record · new nicknames: Mara · lines: Eyes: grey (conflict) · filed as “Mara”: same as Mara Vell? · left out'
    )
  })

  it('asks once more with a larger cap', () => {
    const retry = buildReviewChatPromptV3({ review, history: [], message: 'Tidy up', retry: true })
    expect(retry.maxTokens).toBe(REVIEW_CHAT_RETRY_MAX_TOKENS)
    expect(retry.messages).toHaveLength(4)
  })
})
