import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget } from '@shared/ai'
import { parseReaderAnswer } from '@shared/memory/readerAnswer'
import { ALL_SLOTS } from '@shared/memory/slots'
import { TOPIC_ROSTER_MAX_TOKENS, topicLinesTokens } from '@shared/memory/topics'
import { READER_ROSTER_HEADING } from './reader.v1'
import {
  READER_SENTINEL,
  READER_TOPICS_HEADING,
  READER_V2_RECORD_ROSTER_TOKENS,
  READER_V2_RULES,
  buildReaderV2Prompt,
  type BuildReaderV2PromptInput
} from './reader.v2'
import {
  READER_V3_CARD_OUTPUT,
  READER_V3_OUTPUT_MAX,
  READER_V3_PAGE_TOKENS,
  READER_V3_PROMPT_VERSION,
  READER_V3_RULES,
  READER_V3_RULES_TOKENS,
  buildReaderV3Prompt,
  readerV3OutputCap,
  readerV3PageTokens
} from './reader.v3'

const ROSTER = [
  'r1 Mara Vell (Mara; Captain Vell) · character',
  'r2 Tomas Harrow (Tomas) · character',
  'r3 Orrin · character',
  'r4 the Quay · place',
  'r1 +Ry'
]
const TOPICS = ['s1 the sold map · secret', "t1 Ashby's return · thread"]

const SCENE = [
  'Tomas sold the map on the quay.',
  'Orrin overheard Tomas from behind the nets.',
  'Mara swore to find the heir.'
]

const firstRead: BuildReaderV2PromptInput = {
  roster: ROSTER,
  topics: [],
  position: 'Scene 1.1 “The Quay”, the whole scene',
  typed: 'POV r1 · place r4 · year 1811',
  card: null,
  near: [],
  topicLines: [],
  anchored: [],
  paragraphs: SCENE.map((text, p) => ({ p, text })),
  cardDue: true,
  maxTokens: readerV3OutputCap({ proseTokens: 40, cardDue: true })
}

const windowRead: BuildReaderV2PromptInput = {
  ...firstRead,
  topics: TOPICS,
  position: 'Scene 1.2 “The Nets”, the changed paragraphs',
  card: 'Tomas sells the map; Orrin hears it. · where the quay · POV r1',
  near: ['r1 eyes “grey” · hair “red”', 'r2 role “harbourmaster”'],
  topicLines: ['s1 the sold map: r3 overheard 1.1 (from r2); r2 knew before 1.1'],
  anchored: ['c1 r3 knows s1 overheard from r2 ¶1'],
  paragraphs: SCENE.slice(0, 2).map((text, p) => ({ p, text })),
  cardDue: false,
  maxTokens: readerV3OutputCap({ proseTokens: 25, cardDue: false })
}

const text = (messages: { content: string }[]): string => messages.map((m) => m.content).join('\n')

describe('reader.v3 prompt (F-16.17, the live run of 2026-10-14)', () => {
  it('matches the golden messages for a first read and a window read', () => {
    const first = buildReaderV3Prompt(firstRead)
    expect(first.version).toBe(READER_V3_PROMPT_VERSION)
    expect(first.messages).toMatchSnapshot()
    expect(first.maxTokens).toBe(readerV3OutputCap({ proseTokens: 40, cardDue: true }))
    const window = buildReaderV3Prompt(windowRead)
    expect(window.messages).toMatchSnapshot()
  })

  it('is reader.v2’s layout with the v3 rules: same sentinel, same rosters, same tail', () => {
    const v2 = buildReaderV2Prompt(windowRead).messages
    const v3 = buildReaderV3Prompt(windowRead).messages
    expect(v3[0]?.content.startsWith(READER_SENTINEL)).toBe(true)
    expect(v3[0]?.content.startsWith(READER_V3_RULES)).toBe(true)
    expect(v3[0]?.content.slice(READER_V3_RULES.length)).toBe(
      v2[0]?.content.slice(READER_V2_RULES.length)
    )
    expect(v3[1]).toEqual(v2[1])
    const system = v3[0]?.content ?? ''
    expect(system.indexOf(READER_ROSTER_HEADING)).toBeLessThan(
      system.indexOf(READER_TOPICS_HEADING)
    )
  })

  it('names the closed slot list, the subject in the quote and the value from it', () => {
    for (const rule of [
      'exactly one of these slots',
      'No other slot',
      'A place takes only location, role, traits, history and relation',
      'The quote itself names them',
      '"the sisters walked"',
      'every word from the quote',
      'A want, wish, hope or plan is no fact now',
      'count them',
      'never list who does not know'
    ]) {
      expect(READER_V3_RULES, rule).toContain(rule)
    }
    // Every base slot is named; no slot outside the closed list is offered as one.
    for (const slot of ALL_SLOTS.filter((each) => !each.startsWith('detail:'))) {
      expect(READER_V3_RULES, slot).toMatch(new RegExp(`\\b${slot}\\b`))
    }
    expect(estimateTokens(READER_V3_RULES)).toBeLessThanOrEqual(READER_V3_RULES_TOKENS)
  })

  it('asks for compact facts the parser reads at their defaults', () => {
    expect(READER_V3_RULES).toContain('Leave out voice, mode, sp, o and chg')
    const answer = parseReaderAnswer(
      '{"c":[{"p":1,"r":"r3","s":"location","v":"behind the nets","q":"Orrin overheard Tomas from behind the nets"}],"n":[]}'
    )
    expect(answer?.claims[0]).toMatchObject({
      voice: 'narration',
      mode: 'now',
      sp: null,
      o: null,
      chg: false
    })
  })

  it('sizes pages to 400 prose tokens and asks at most its 720', () => {
    expect(readerV3PageTokens(TOPICS)).toBe(READER_V3_PAGE_TOKENS)
    expect(readerV3OutputCap({ proseTokens: READER_V3_PAGE_TOKENS, cardDue: true })).toBe(
      READER_V3_OUTPUT_MAX
    )
    expect(READER_V3_OUTPUT_MAX).toBe(720)
    expect(readerV3OutputCap({ proseTokens: 100, cardDue: false })).toBe(160 + 120)
    expect(readerV3OutputCap({ proseTokens: 100, cardDue: true })).toBe(
      160 + 120 + READER_V3_CARD_OUTPUT
    )
    // A topics roster at its ceiling takes its overflow out of the page, never below 100.
    const topics: string[] = []
    for (
      let i = 1;
      topicLinesTokens([...topics, `s${i} the hidden matter ${i} · secret`]) <=
      TOPIC_ROSTER_MAX_TOKENS;
      i += 1
    ) {
      topics.push(`s${i} the hidden matter ${i} · secret`)
    }
    expect(readerV3PageTokens(topics)).toBeLessThan(READER_V3_PAGE_TOKENS)
    expect(readerV3PageTokens(topics)).toBeGreaterThanOrEqual(100)
  })

  it('stays within the 6,000-token input cap at its worst: full rosters, a full page, every block full', () => {
    const roster: string[] = []
    for (
      let i = 1;
      estimateTokens([...roster, ''].join('\n')) < READER_V2_RECORD_ROSTER_TOKENS - 20;
      i += 1
    ) {
      roster.push(`r${i} Character Number ${i} (Number ${i}) · character`)
    }
    const topics: string[] = []
    for (
      let i = 1;
      topicLinesTokens([...topics, `s${i} the hidden matter ${i} · secret`]) <=
      TOPIC_ROSTER_MAX_TOKENS;
      i += 1
    ) {
      topics.push(`s${i} the hidden matter ${i} · secret`)
    }
    const pageTokens = readerV3PageTokens(topics)
    const lines = Math.max(1, Math.floor(pageTokens / 101))
    const page = Array.from({ length: lines }, (_, p) => ({ p, text: 'word '.repeat(80).trim() }))
    const many = Array.from(
      { length: 60 },
      (_, i) => `r${i} eyes “grey” · hair “red” · role “clerk”`
    )
    const worst = buildReaderV3Prompt({
      ...windowRead,
      roster,
      topics,
      near: many,
      topicLines: many,
      anchored: many,
      paragraphs: page,
      cardDue: true,
      maxTokens: readerV3OutputCap({ proseTokens: pageTokens, cardDue: true })
    })
    expect(estimateTokens(text(worst.messages))).toBeLessThanOrEqual(inputBudget('reader'))
    const all = text(worst.messages)
    for (const line of [...roster, ...topics]) expect(all).toContain(line)
    expect(all).toContain(`¶${lines - 1} ${'word '.repeat(80).trim()}`)
    expect(worst.maxTokens).toBeLessThanOrEqual(READER_V3_OUTPUT_MAX)
  })
})
