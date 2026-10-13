import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { ROUTE_EDIT_PASSES, ROUTE_EDIT_TARGETS } from '@shared/assistantRoute'
import { ROUTE_RULES_V2, ROUTE_V2_ACTION_LINES, ROUTE_V2_EDIT_FIELDS } from './route.v2'
import {
  buildNavigatorPrompt,
  NAVIGATOR_IDEAS_HEADING,
  NAVIGATOR_IDEAS_TOKENS,
  NAVIGATOR_MAP_HEADING,
  NAVIGATOR_MAP_TOKENS,
  NAVIGATOR_MENU_TOKENS,
  NAVIGATOR_PREFIX_TOKENS,
  NAVIGATOR_PROMPT_VERSION,
  NAVIGATOR_ROSTER_HEADING,
  NAVIGATOR_ROSTER_TOKENS,
  NAVIGATOR_RULES,
  NAVIGATOR_RULES_TOKENS,
  NAVIGATOR_SENTINEL,
  NAVIGATOR_STEP_TOKENS,
  navigatorIdeas,
  navigatorMenuLine,
  navigatorRoster,
  navigatorSystem,
  parseNavigatorStep,
  renderNavigatorMap,
  stepFound,
  type NavigatorMapChapter,
  type NavigatorMenuLine,
  type NavigatorPrefix,
  type NavigatorTail
} from './navigator.v1'

/** A book of `n` chapters of four scenes each, every scene with a card line. */
function chapters(
  n: number,
  line = 'Mara waits at the quay for the boat that never comes.'
): NavigatorMapChapter[] {
  return Array.from({ length: n }, (_, c) => ({
    number: String(c + 1),
    title: `Chapter ${c + 1}`,
    scenes: Array.from({ length: 4 }, (_, s) => ({
      ref: `${c + 1}.${s + 1}`,
      title: `Scene ${s + 1}`,
      line
    }))
  }))
}

const IDEA =
  'Perhaps the captain was married once before, in Ireland, long before the war began and the ships sailed.'

const named = new Map([
  ['r1', 30],
  ['r2', 12],
  ['r3', 4]
])

const PREFIX: NavigatorPrefix = {
  roster: navigatorRoster({
    records: [
      { id: 'r1', name: 'Mara Vell', nicknames: ['Mara'], created: '1' },
      { id: 'r2', name: 'Orrin', nicknames: [], created: '2' },
      { id: 'r3', name: 'the Bell', nicknames: [], created: '3' }
    ],
    named,
    secrets: ['the sold map'],
    threads: ['the missing heir']
  }),
  ideas: navigatorIdeas(
    [
      {
        recordId: 'r1',
        name: 'Mara Vell',
        first: 'Maybe Mara has a twin in the north.',
        created: '1'
      }
    ],
    named
  ),
  map: renderNavigatorMap(chapters(6), 2)
}

const TAIL: NavigatorTail = {
  now: '3.2',
  active: 'scene "The quay"',
  selection: null,
  history: [
    { role: 'user', content: 'Who is Orrin?' },
    { role: 'assistant', content: 'Orrin is the ferryman.' }
  ],
  message: 'When does Mara first distrust Orrin?'
}

const MENU: NavigatorMenuLine[] = [
  { id: 'E1', label: 'happened', ref: 'Mara Vell', snippet: 'Mara Vell · Eyes: grey (1.1)' },
  {
    id: 'E2',
    label: 'happened',
    ref: '2.3 ¶4',
    snippet: 'Mara watched Orrin count the coins twice.'
  },
  {
    id: 'E3',
    label: 'idea',
    ref: "Mara Vell's Ideas ¶0",
    snippet: 'Maybe Mara has a twin in the north.'
  }
]

describe('navigator.v1 prompt (F-16.25)', () => {
  it('opens with the sentinel and carries route.v2’s actions and edit-pass fields word for word, within 700 tokens', () => {
    expect(NAVIGATOR_PROMPT_VERSION).toBe('navigator.v1')
    expect(NAVIGATOR_RULES.startsWith(NAVIGATOR_SENTINEL)).toBe(true)
    expect(NAVIGATOR_RULES).toContain(ROUTE_V2_ACTION_LINES)
    expect(NAVIGATOR_RULES).toContain(ROUTE_V2_EDIT_FIELDS)
    // The same words route.v2 sends, so the navigator routes F-5.26's edit passes as it did.
    expect(ROUTE_RULES_V2).toContain(ROUTE_V2_ACTION_LINES)
    expect(ROUTE_RULES_V2).toContain(ROUTE_V2_EDIT_FIELDS)
    for (const pass of ROUTE_EDIT_PASSES) expect(NAVIGATOR_RULES).toContain(`"${pass}"`)
    for (const target of ROUTE_EDIT_TARGETS) expect(NAVIGATOR_RULES).toContain(`"${target}"`)
    for (const tool of [
      'search',
      'cards',
      'read',
      'state',
      'knows',
      'timeline',
      'ideas',
      'outline',
      'todos'
    ]) {
      expect(NAVIGATOR_RULES).toContain(`{"${tool}":`)
    }
    expect(NAVIGATOR_RULES).toContain('{"use":["E3","E7"]}')
    expect(NAVIGATOR_RULES).toContain('search every earlier scene')
    expect(NAVIGATOR_RULES).toContain('Never write prose')
    expect(estimateTokens(NAVIGATOR_RULES)).toBeLessThanOrEqual(NAVIGATOR_RULES_TOKENS)
    // The golden estimate: a change here means the prompt changed and needs a new version.
    expect(estimateTokens(NAVIGATOR_RULES)).toBe(688)
  })

  it('orders the cached prefix rules → roster → Ideas → map, within 3,000, and the same for two messages in one chapter', () => {
    const system = navigatorSystem(PREFIX)
    const at = (text: string): number => system.indexOf(text)
    expect(at(NAVIGATOR_SENTINEL)).toBe(0)
    expect(at(NAVIGATOR_ROSTER_HEADING)).toBeGreaterThan(at('Never write prose'))
    expect(at(NAVIGATOR_IDEAS_HEADING)).toBeGreaterThan(at(NAVIGATOR_ROSTER_HEADING))
    expect(at(NAVIGATOR_MAP_HEADING)).toBeGreaterThan(at(NAVIGATOR_IDEAS_HEADING))
    expect(system).toContain(
      'Mara Vell (Mara)\nOrrin\nthe Bell\nSecrets: the sold map\nThreads: the missing heir'
    )
    expect(system).toContain('Mara Vell: Maybe Mara has a twin in the north.')
    expect(estimateTokens(system)).toBeLessThanOrEqual(NAVIGATOR_PREFIX_TOKENS)

    const one = buildNavigatorPrompt({ prefix: PREFIX, tail: TAIL, menu: MENU, steps: [] })
    // Another message from another scene of the same chapter: the map marks the chapter only.
    const other = buildNavigatorPrompt({
      prefix: { ...PREFIX, map: renderNavigatorMap(chapters(6), 2) },
      tail: { ...TAIL, now: '3.4', message: 'Make this scene better.', history: [] },
      menu: [],
      steps: []
    })
    expect(other.messages[0]?.content).toBe(one.messages[0]?.content)
    expect(one.messages[1]?.content).not.toBe(other.messages[1]?.content)
  })

  it('sends the tail as Now, the open document, the selection’s opening, the last turns, the message, the menu', () => {
    const built = buildNavigatorPrompt({
      prefix: PREFIX,
      tail: { ...TAIL, selection: 'Mara climbed the ridge' },
      menu: MENU,
      steps: []
    })
    expect(built.version).toBe('navigator.v1')
    expect(built.maxTokens).toBe(outputBudget('navigator'))
    expect(built.maxTokens).toBe(150)
    expect(built.messages.map((m) => m.role)).toEqual(['system', 'user'])
    expect(built.messages[1]?.content).toBe(
      'Now: 3.2\n\n' +
        'Open document: scene "The quay"\n\n' +
        'Selected passage (opening):\n"""\nMara climbed the ridge\n"""\n\n' +
        'Recent turns:\nAuthor: Who is Orrin?\nAssistant: Orrin is the ferryman.\n\n' +
        'Message:\n"""\nWhen does Mara first distrust Orrin?\n"""\n\n' +
        'Menu:\n' +
        'E1 happened Mara Vell: Mara Vell · Eyes: grey (1.1)\n' +
        'E2 happened 2.3 ¶4: Mara watched Orrin count the coins twice.\n' +
        "E3 your idea Mara Vell's Ideas ¶0: Maybe Mara has a twin in the north."
    )
    expect(built.menu).toEqual(['E1', 'E2', 'E3'])
    const none = buildNavigatorPrompt({
      prefix: PREFIX,
      tail: { now: null, active: null, selection: null, history: [], message: 'Hi' },
      menu: [],
      steps: []
    })
    expect(none.messages[1]?.content).toBe(
      'Now: nothing written yet\n\nNo document is open.\n\nNo passage is selected.\n\n' +
        'Message:\n"""\nHi\n"""\n\nMenu: empty (search to fill it).'
    )
  })

  it('adds each earlier step’s reply and what it found, and asks step 3 to end with use', () => {
    const steps = [
      {
        reply: '{"a":"query","t":"answer","call":[{"search":["distrust","suspicion"]}]}',
        found: ['E4 happened 2.1 ¶2: Mara did not trust the ferryman.'],
        notes: []
      },
      {
        reply: '{"call":[{"read":"2.1"}]}',
        found: [],
        notes: ['No scene is 9.9.']
      }
    ]
    const two = buildNavigatorPrompt({
      prefix: PREFIX,
      tail: TAIL,
      menu: MENU,
      steps: steps.slice(0, 1)
    })
    expect(two.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(two.messages[2]?.content).toBe(steps[0]?.reply)
    expect(two.messages[3]?.content).toBe(
      'Found:\nE4 happened 2.1 ¶2: Mara did not trust the ferryman.\n\n' +
        'Step 2 of 3: {"call":[…]} or {"use":[…]}.'
    )
    const three = buildNavigatorPrompt({ prefix: PREFIX, tail: TAIL, menu: MENU, steps })
    expect(three.messages).toHaveLength(6)
    expect(three.messages[5]?.content).toBe(
      'Found nothing new.\nNo scene is 9.9.\n\nStep 3 of 3: end with {"use":[…]}.'
    )
    // The prefix and the tail are sent as they were at step 1.
    expect(three.messages.slice(0, 2)).toEqual(two.messages.slice(0, 2))
  })

  it('keeps each step’s found lines within 700 tokens, the later ones going first', () => {
    const line = `E9 happened 1.1 ¶0: ${'word '.repeat(60)}`
    const kept = stepFound(
      '{"call":[]}',
      Array.from({ length: 40 }, () => line)
    )
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(40)
    expect(estimateTokens(kept.join('\n'))).toBeLessThanOrEqual(NAVIGATOR_STEP_TOKENS)
  })

  it('renders the map: full card lines within one chapter of now, one line per chapter beyond, now’s chapter marked', () => {
    const map = renderNavigatorMap(chapters(6), 2) ?? ''
    const lines = map.split('\n')
    expect(lines[0]).toBe(NAVIGATOR_MAP_HEADING)
    expect(lines).toContain("Ch 1 'Chapter 1' (1.1–1.4)")
    expect(lines).toContain("Ch 2 'Chapter 2' (2.1–2.4):")
    expect(lines).toContain("Ch 3 'Chapter 3' (3.1–3.4, now):")
    expect(lines).toContain("Ch 4 'Chapter 4' (4.1–4.4):")
    expect(lines).toContain("Ch 5 'Chapter 5' (5.1–5.4)")
    expect(lines).toContain('  3.2 Scene 2: Mara waits at the quay for the boat that never comes.')
    expect(lines).not.toContain(
      '  1.1 Scene 1: Mara waits at the quay for the boat that never comes.'
    )
    expect(renderNavigatorMap([], null)).toBeNull()
  })

  it('fits a long book’s map into 1,100 tokens: now’s chapter first, then the far chapters cut', () => {
    const long =
      'Mara waits at the quay for the boat that never comes, and the tide turns. '.repeat(3)
    // Eighty chapters fit as one line each beside now's scenes; the neighbours' scenes go.
    const eighty = renderNavigatorMap(chapters(80, long), 40) ?? ''
    expect(estimateTokens(eighty)).toBeLessThanOrEqual(NAVIGATOR_MAP_TOKENS)
    expect(eighty).toContain("Ch 41 'Chapter 41' (41.1–41.4, now):\n  41.1 Scene 1")
    expect(eighty).toContain("Ch 40 'Chapter 40' (40.1–40.4)\n")
    expect(eighty).toContain("Ch 1 'Chapter 1' (1.1–1.4)")
    // Three hundred do not: the farthest chapters are counted instead.
    const map = renderNavigatorMap(chapters(300, long), 150) ?? ''
    expect(estimateTokens(map)).toBeLessThanOrEqual(NAVIGATOR_MAP_TOKENS)
    expect(map).toContain("Ch 151 'Chapter 151' (151.1–151.4, now)")
    expect(map).toMatch(/… \d+ more chapters$/u)
    expect(map).not.toContain("Ch 1 'Chapter 1'")
  })

  it('caps the roster at 800 and the Ideas at 400, the least named left out first', () => {
    const records = Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      name: `Character Number ${i}`,
      nicknames: [`Nick ${i}`],
      created: String(i).padStart(4, '0')
    }))
    const many = new Map(records.map((record, i) => [record.id, i]))
    const roster = navigatorRoster({
      records,
      named: many,
      secrets: Array.from({ length: 50 }, (_, i) => `secret number ${i}`),
      threads: ['the missing heir']
    })
    expect(estimateTokens(roster)).toBeLessThanOrEqual(NAVIGATOR_ROSTER_TOKENS)
    expect(roster).toContain('Character Number 299')
    expect(roster).not.toContain('Character Number 0 ')
    expect(roster).toContain('Threads: the missing heir')
    const ideas = navigatorIdeas(
      records.map((record) => ({
        recordId: record.id,
        name: record.name,
        first: IDEA,
        created: record.created
      })),
      many
    )
    expect(estimateTokens(ideas ?? '')).toBeLessThanOrEqual(NAVIGATOR_IDEAS_TOKENS)
    // Fifteen words at most, then an ellipsis.
    expect(ideas).toContain(`Character Number 299: ${IDEA.split(' ').slice(0, 15).join(' ')}…`)
    expect(navigatorIdeas([], many)).toBeNull()
  })

  it('stays within the 6,000 input cap at every cap, the menu’s far items dropped first', () => {
    const menu: NavigatorMenuLine[] = Array.from({ length: 80 }, (_, i) => ({
      id: `E${i + 1}`,
      label: 'happened',
      ref: `${i}.1 ¶2`,
      snippet: 'word '.repeat(80)
    }))
    const steps = [0, 1].map(() => ({
      reply: '{"call":[{"search":["one","two","three"]}]}',
      found: stepFound('{"call":[]}', menu.map(navigatorMenuLine)),
      notes: []
    }))
    const built = buildNavigatorPrompt({
      prefix: { ...PREFIX, map: renderNavigatorMap(chapters(80), 40) },
      tail: {
        now: '40.2',
        active: `scene "${'T'.repeat(100)}"`,
        selection: 'S'.repeat(200),
        history: [
          { role: 'user', content: 'U'.repeat(300) },
          { role: 'assistant', content: 'A'.repeat(300) }
        ],
        message: 'M'.repeat(1_000)
      },
      menu,
      steps
    })
    const total = estimateTokens(built.messages.map((m) => m.content).join('\n'))
    expect(total).toBeLessThanOrEqual(inputBudget('navigator'))
    expect(built.menu[0]).toBe('E1')
    expect(built.menu.length).toBeLessThan(menu.length)
    const menuText = (built.messages[1]?.content ?? '').split('Menu:\n')[1] ?? ''
    expect(estimateTokens(menuText)).toBeLessThanOrEqual(NAVIGATOR_MENU_TOKENS)
  })
})

describe('parseNavigatorStep (F-16.25)', () => {
  it('reads step 1’s action with route.v2’s readers: a vague edit request asks on the scene', () => {
    const step = parseNavigatorStep('{"a":"editPass","t":"edit","pass":"ask","target":"scene"}', 1)
    expect(step).toEqual({
      readable: true,
      route: {
        action: 'editPass',
        instruction: null,
        edit: { pass: 'ask', target: 'scene', chapter: null }
      },
      turn: 'edit',
      calls: [],
      use: null,
      skipped: 0
    })
    // Capitalised ids, the long field names, and an unknown action read as route.v2's would.
    expect(parseNavigatorStep('{"a":"EditPass","i":"Tighten it.","pass":"LINE"}', 1).route).toEqual(
      {
        action: 'editPass',
        instruction: 'Tighten it.',
        edit: { pass: 'line', target: 'scene', chapter: null }
      }
    )
    expect(parseNavigatorStep('{"action":"critique","instruction":"pacing"}', 1).route).toEqual({
      action: 'critique',
      instruction: 'pacing',
      edit: null
    })
    expect(parseNavigatorStep('{"a":"summarise"}', 1).route?.action).toBe('chat')
  })

  it('reads the calls (an unknown tool skipped and counted, three at most) and the ids to use', () => {
    const step = parseNavigatorStep(
      JSON.stringify({
        a: 'query',
        t: 'answer',
        call: [
          { search: ['distrust', 'suspicion', 'distrust'] },
          { teleport: 'x' },
          { cards: '7.1-7.6' },
          { read: '7.4 ¶3-8' },
          { state: 'Mara' }
        ],
        use: ['E3', 'e7', 9, 'X1']
      }),
      1
    )
    expect(step.calls).toEqual([
      { tool: 'search', terms: ['distrust', 'suspicion'] },
      { tool: 'cards', arg: '7.1-7.6' },
      { tool: 'read', arg: '7.4 ¶3-8' }
    ])
    expect(step.skipped).toBe(2)
    expect(step.use).toEqual(['E3', 'E7', 'E9'])
    expect(step.turn).toBe('answer')
    // No name: the story's years, every record's Ideas; outline and to-dos take nothing.
    expect(
      parseNavigatorStep('{"call":[{"timeline":{}},{"ideas":""},{"outline":{}}]}', 2).calls
    ).toEqual([{ tool: 'timeline', arg: '' }, { tool: 'ideas', arg: '' }, { tool: 'outline' }])
  })

  it('reads steps 2 and 3 for calls and ids only, and an unreadable reply as unreadable', () => {
    const later = parseNavigatorStep('{"a":"critique","use":["E2"]}', 2)
    expect(later.route).toBeNull()
    expect(later.turn).toBeNull()
    expect(later.use).toEqual(['E2'])
    expect(parseNavigatorStep('Sure! Mara first distrusts Orrin in 2.1.', 1)).toEqual({
      readable: false,
      route: null,
      turn: null,
      calls: [],
      use: null,
      skipped: 0
    })
    expect(parseNavigatorStep('```json\n{"a":"chat","use":["E1"]}\n```', 1).use).toEqual(['E1'])
    // A search with no words is no call.
    expect(parseNavigatorStep('{"call":[{"search":[]}]}', 2)).toMatchObject({
      calls: [],
      skipped: 1
    })
  })
})
