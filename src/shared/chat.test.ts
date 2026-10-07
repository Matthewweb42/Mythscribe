import { describe, expect, it } from 'vitest'
import { ROUTE_ACTIONS } from './assistantRoute'
import {
  CHAT_MAX_REFS,
  CHAT_TITLE_MAX,
  PLAN_ROUTE_ACTIONS,
  type Conversations,
  agentAccessFor,
  appliesEditsItself,
  defaultConversations,
  parseStoredConversations,
  parseTagRefs,
  routeActionFor,
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
              usage: null,
              mode: null,
              query: null,
              directions: null,
              action: null,
              agent: null
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

  it('reads a turn stored before F-5.9, with no usage field, as usage: null', () => {
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
              role: 'assistant',
              content: 'She is waiting for the signal.',
              created: '2026-09-15T10:00:00.000Z',
              proposalId: 'p1',
              model: 'gpt-5.4-mini',
              costUsd: 0.0012,
              mode: 'plan',
              query: null,
              directions: null,
              action: null,
              agent: null
              // no `usage` field at all, as a turn written before F-5.9 has.
            }
          ],
          created: '2026-09-15T10:00:00.000Z',
          modified: '2026-09-15T10:00:00.000Z'
        }
      ]
    }
    const parsed = parseStoredConversations(stored)
    expect(parsed.items[0]?.messages[0]?.usage).toBeNull()
  })

  it('keeps the tokens of a turn written with them (F-5.9)', () => {
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
              role: 'assistant',
              content: 'She is waiting for the signal.',
              created: '2026-09-15T10:00:00.000Z',
              proposalId: 'p1',
              model: 'gpt-5.4-mini',
              costUsd: 0.0012,
              usage: { inputTokens: 300, outputTokens: 20 },
              mode: 'plan',
              query: null,
              directions: null,
              action: null,
              agent: null
            }
          ],
          created: '2026-09-15T10:00:00.000Z',
          modified: '2026-09-15T10:00:00.000Z'
        }
      ]
    }
    expect(parseStoredConversations(stored).items[0]?.messages[0]?.usage).toEqual({
      inputTokens: 300,
      outputTokens: 20
    })
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

describe('chat modes (decided by the author 2026-10-07)', () => {
  it('gives Plan the read-only tools and Ask and Auto the edit tools', () => {
    expect(agentAccessFor('plan')).toBe('read')
    expect(agentAccessFor('ask')).toBe('write')
    expect(agentAccessFor('auto')).toBe('write')
  })

  it('applies edits itself only in Auto', () => {
    expect(appliesEditsItself('auto')).toBe(true)
    expect(appliesEditsItself('ask')).toBe(false)
    expect(appliesEditsItself('plan')).toBe(false)
  })

  it('never routes a Plan turn to a feature that edits, and keeps every pick in Ask and Auto', () => {
    expect(PLAN_ROUTE_ACTIONS).toEqual(['chat', 'query', 'whatNext', 'betaReader'])
    for (const action of ROUTE_ACTIONS) {
      expect(routeActionFor('ask', action)).toBe(action)
      expect(routeActionFor('auto', action)).toBe(action)
      expect(routeActionFor('plan', action)).toBe(
        PLAN_ROUTE_ACTIONS.includes(action) ? action : 'chat'
      )
    }
    for (const action of [
      'rewrite',
      'proofread',
      'critique',
      'continuity',
      'synopsis',
      'notes'
    ] as const) {
      expect(routeActionFor('plan', action)).toBe('chat')
    }
  })

  it('still loads a conversation stored with a per-conversation mode, or without one', () => {
    const conversation = {
      id: 'c',
      title: 'Old',
      paragraphs: 1,
      messages: [],
      created: '2026-10-01T00:00:00.000Z',
      modified: '2026-10-01T00:00:00.000Z'
    }
    for (const mode of ['auto', 'query', 'agent', 'plan', undefined]) {
      const parsed = parseStoredConversations({ active: 'c', items: [{ ...conversation, mode }] })
      expect(parsed.items).toHaveLength(1)
    }
  })
})
