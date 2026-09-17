import { describe, expect, it } from 'vitest'
import {
  CHAT_MAX_REFS,
  CHAT_TITLE_MAX,
  type Conversations,
  defaultConversations,
  parseStoredConversations,
  parseTagRefs,
  titleFor
} from './chat'

describe('chat model (F-5.4)', () => {
  it('reads an off-shape row as a fresh state', () => {
    expect(parseStoredConversations(undefined)).toEqual(defaultConversations())
    expect(parseStoredConversations({ active: 'x' })).toEqual(defaultConversations())
    expect(parseStoredConversations({ active: null, items: [{ id: 'c' }] })).toEqual(
      defaultConversations()
    )
  })

  it('keeps a well-formed row', () => {
    const stored: Conversations = {
      active: 'c1',
      items: [
        {
          id: 'c1',
          title: 'Why is Mara on the ridge?',
          mode: 'plan',
          paragraphs: 1,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'Why is Mara on the ridge?',
              created: '2026-09-15T10:00:00.000Z',
              proposalId: null,
              model: null,
              costUsd: null,
              mode: null,
              query: null
            }
          ],
          created: '2026-09-15T10:00:00.000Z',
          modified: '2026-09-15T10:00:00.000Z'
        }
      ]
    }
    expect(parseStoredConversations(stored)).toEqual(stored)
  })

  it('reads a message stored before F-5.7, with no query field, as query: null', () => {
    const stored = {
      active: 'c1',
      items: [
        {
          id: 'c1',
          title: 'Why is Mara on the ridge?',
          mode: 'plan',
          paragraphs: 1,
          messages: [
            {
              id: 'm1',
              role: 'user',
              content: 'Why is Mara on the ridge?',
              created: '2026-09-15T10:00:00.000Z',
              proposalId: null,
              model: null,
              costUsd: null,
              mode: null
              // no `query` field at all, as a row written before F-5.7 has.
            }
          ],
          created: '2026-09-15T10:00:00.000Z',
          modified: '2026-09-15T10:00:00.000Z'
        }
      ]
    }
    const parsed = parseStoredConversations(stored)
    expect(parsed.items[0]?.messages[0]?.query).toBeNull()
  })

  it('titles a conversation from the first line of the first message, cut to fit', () => {
    expect(titleFor('  Why is Mara on the ridge?\nSecond line ')).toBe('Why is Mara on the ridge?')
    const long = 'a'.repeat(CHAT_TITLE_MAX + 5)
    expect(titleFor(long)).toHaveLength(CHAT_TITLE_MAX)
    expect(titleFor(long).endsWith('…')).toBe(true)
  })

  it('parses #name references as normalized tag names, deduplicated and capped', () => {
    expect(parseTagRefs('Tell me about #Mara and #dark-forest, then #mara again')).toEqual([
      'mara',
      'dark-forest'
    ])
    expect(parseTagRefs('no refs here, not even an email@host')).toEqual([])
    expect(parseTagRefs('#Zoë waits')).toEqual(['zoë'])
    const many = Array.from({ length: CHAT_MAX_REFS + 3 }, (_, i) => `#tag${i}`).join(' ')
    expect(parseTagRefs(many)).toHaveLength(CHAT_MAX_REFS)
  })
})
