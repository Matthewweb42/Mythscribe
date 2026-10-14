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
              agent: null,
              edit: null,
              card: null,
              scribe: null,
              costParts: null,
              contradictions: null
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

  it('keeps every conversation and a turn’s text when its action or its agent part no longer parses (F-16.2)', () => {
    const turn = (id: string, content: string): Record<string, unknown> => ({
      id,
      role: 'assistant',
      content,
      created: '2026-10-11T10:00:00.000Z',
      proposalId: null,
      model: 'deepseek/deepseek-v4-pro',
      costUsd: 0.002,
      usage: null,
      mode: 'plan',
      query: null,
      directions: null,
      action: null,
      agent: null,
      edit: null,
      card: null,
      scribe: null,
      costParts: null,
      contradictions: null
    })
    const conversation = (id: string, messages: Record<string, unknown>[]): unknown => ({
      id,
      title: id,
      paragraphs: 1,
      messages,
      created: '2026-10-11T10:00:00.000Z',
      modified: '2026-10-11T10:00:00.000Z'
    })
    const stored = {
      active: 'c2',
      items: [
        conversation('c1', [turn('m1', 'Mara is on the ridge.')]),
        conversation('c2', [
          {
            ...turn('m2', 'Her eyes are grey in 2.1 and brown in 9.4.'),
            // An action retired at the story-memory switch-over (F-16.31).
            action: 'continuityRetired',
            // An agent part whose edit kind this build no longer has.
            agent: {
              access: 'write',
              steps: [],
              changes: [
                {
                  id: 'e1',
                  edit: { kind: 'retiredEdit', nodeId: 'n1', title: 'Scene' },
                  status: 'applied',
                  violation: null,
                  error: null
                }
              ]
            }
          },
          turn('m3', 'Anything else?')
        ])
      ]
    }
    const parsed = parseStoredConversations(stored)
    expect(parsed.active).toBe('c2')
    expect(parsed.items.map((item) => item.id)).toEqual(['c1', 'c2'])
    const kept = parsed.items[1]?.messages
    expect(kept?.map((message) => message.content)).toEqual([
      'Her eyes are grey in 2.1 and brown in 9.4.',
      'Anything else?'
    ])
    expect(kept?.[0]?.action).toBeNull()
    expect(kept?.[0]?.agent).toBeNull()
    expect(kept?.[0]?.model).toBe('deepseek/deepseek-v4-pro')
  })

  it('reads an instant card and a Ms Scribe part leniently (F-16.24, F-16.25; P3-D19)', () => {
    const base = {
      id: 'm1',
      role: 'assistant',
      content: 'Eyes: grey (1.1)',
      created: '2026-10-13T10:00:00.000Z',
      proposalId: null,
      model: null,
      costUsd: 0,
      usage: null,
      mode: 'plan'
    }
    const card = {
      kind: 'slot',
      recordId: 'mara',
      name: 'Mara',
      slot: 'eyes',
      label: 'Eyes',
      value: 'grey',
      claimId: 'c1',
      quote: 'Mara’s grey eyes',
      ref: '1.1',
      nodeId: 'n1',
      para: 0,
      since: null,
      lastStated: false,
      asOfRef: '1.1',
      readFirst: null
    }
    const scribe = {
      turn: 'answer',
      citations: [
        {
          n: 1,
          evidence: 'E3',
          label: 'happened',
          ref: '1.1 ¶0',
          title: 'The quay',
          open: { kind: 'scene', id: 'n1', para: 0 },
          quote: 'Orrin overheard Tomas',
          checked: 'quote'
        }
      ],
      notChecked: [[0, 5]],
      unsupported: [],
      scope: null,
      notFound: false,
      retried: false,
      widened: null,
      misses: 0
    }
    const conversation = (messages: unknown[]): unknown => ({
      active: 'c1',
      items: [
        {
          id: 'c1',
          title: 'c1',
          paragraphs: 1,
          messages,
          created: '2026-10-13T10:00:00.000Z',
          modified: '2026-10-13T10:00:00.000Z'
        }
      ]
    })
    // A v1 row, written before either part existed.
    const v1 = parseStoredConversations(conversation([base])).items[0]?.messages[0]
    expect(v1?.card).toBeNull()
    expect(v1?.scribe).toBeNull()
    expect(v1?.costParts).toBeNull()
    const parts = [
      { part: 'navigator', costUsd: 0.0002 },
      { part: 'answer', costUsd: 0.012 },
      { part: 'check', costUsd: 0.0001 }
    ]
    const kept = parseStoredConversations(
      conversation([{ ...base, card, scribe, costParts: parts }])
    ).items[0]?.messages[0]
    expect(kept?.card).toEqual(card)
    // A turn stored before slice 5 reads its check cost as 0 and its citations with no document.
    expect(kept?.scribe).toEqual({
      ...scribe,
      checkUsd: 0,
      citations: scribe.citations.map((citation) => ({ ...citation, doc: null }))
    })
    expect(kept?.costParts).toEqual(parts)
    // Cost parts this build cannot read leave the turn and its total as they are.
    const unread = parseStoredConversations(
      conversation([{ ...base, costParts: [{ part: 'retired', costUsd: 1 }] }])
    ).items[0]?.messages[0]
    expect(unread?.content).toBe('Eyes: grey (1.1)')
    expect(unread?.costParts).toBeNull()
    // A card kind or a citation this build does not know: the turn keeps its text.
    const odd = parseStoredConversations(
      conversation([
        {
          ...base,
          card: { kind: 'retiredCard', recordId: 'mara' },
          scribe: { ...scribe, citations: [{ n: 0, evidence: 'X9' }] }
        }
      ])
    ).items[0]?.messages[0]
    expect(odd?.content).toBe('Eyes: grey (1.1)')
    expect(odd?.card).toBeNull()
    expect(odd?.scribe).toBeNull()
  })

  it('keeps the chat history when a turn’s mode is retired or one turn is broken (F-16.2)', () => {
    const turn = (id: string, mode: unknown): Record<string, unknown> => ({
      id,
      role: 'assistant',
      content: `Turn ${id}`,
      created: '2026-10-11T10:00:00.000Z',
      proposalId: null,
      model: null,
      costUsd: null,
      mode
    })
    const conversation = (id: string, messages: unknown[], mode?: unknown): unknown => ({
      id,
      title: id,
      ...(mode === undefined ? {} : { mode }),
      paragraphs: 1,
      messages,
      created: '2026-10-11T10:00:00.000Z',
      modified: '2026-10-11T10:00:00.000Z'
    })
    const parsed = parseStoredConversations({
      active: 'c2',
      items: [
        // A turn mode and a conversation mode retired at the switch-over read as absent.
        conversation('c1', [turn('m1', 'retiredMode'), turn('m2', 'plan')], 'retiredMode'),
        // One broken turn (no content) is dropped; the rest of its conversation is kept.
        conversation('c2', [turn('m3', 'plan'), { id: 'm4', role: 'assistant' }]),
        // A conversation that is not one at all is dropped, never the whole history.
        { id: 'c3' }
      ]
    })
    expect(parsed.active).toBe('c2')
    expect(parsed.items.map((item) => item.id)).toEqual(['c1', 'c2'])
    expect(parsed.items[0]?.messages.map((message) => message.mode)).toEqual([null, 'plan'])
    expect(parsed.items[0]?.mode).toBeUndefined()
    expect(parsed.items[1]?.messages.map((message) => message.content)).toEqual(['Turn m3'])
    // The active tab falls back to the first kept conversation when its own was dropped.
    expect(
      parseStoredConversations({ active: 'c3', items: [conversation('c1', []), { id: 'c3' }] })
        .active
    ).toBe('c1')
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
              agent: null,
              edit: null,
              card: null,
              scribe: null,
              costParts: null,
              contradictions: null
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
              agent: null,
              edit: null,
              card: null,
              scribe: null,
              costParts: null,
              contradictions: null
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
      expect(routeActionFor('plan', action, 'v2')).toBe(action === 'continuity' ? action : 'chat')
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
