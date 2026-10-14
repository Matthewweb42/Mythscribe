import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { parseReaderAnswer } from '@shared/memory/readerAnswer'
import { ALL_SLOTS, readSlot } from '@shared/memory/slots'
import { TOPIC_ROSTER_MAX_TOKENS, topicLinesTokens } from '@shared/memory/topics'
import { READER_ROSTER_HEADING } from './reader.v1'
import {
  READER_SENTINEL,
  READER_TOPICS_HEADING,
  READER_V2_RECORD_ROSTER_TOKENS,
  type BuildReaderV2PromptInput
} from './reader.v2'
import {
  READER_V3_CARD_OUTPUT,
  READER_V3_PAGE_TOKENS,
  READER_V3_RULES,
  buildReaderV3Prompt,
  readerV3OutputCap,
  readerV3PageTokens
} from './reader.v3'
import {
  READER_V4_PROMPT_VERSION,
  READER_V4_RULES,
  READER_V4_RULES_TOKENS,
  buildReaderV4Prompt,
  readerV4OutputCap
} from './reader.v4'

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
  maxTokens: readerV4OutputCap({ proseTokens: 40, cardDue: true })
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
  maxTokens: readerV4OutputCap({ proseTokens: 25, cardDue: false })
}

const text = (messages: { content: string }[]): string => messages.map((m) => m.content).join('\n')

describe('reader.v4 prompt (F-16.17, the second live run of 2026-10-14)', () => {
  it('matches the golden messages for a first read and a window read', () => {
    const first = buildReaderV4Prompt(firstRead)
    expect(first.version).toBe(READER_V4_PROMPT_VERSION)
    expect(first.messages).toMatchSnapshot()
    expect(first.maxTokens).toBe(readerV4OutputCap({ proseTokens: 40, cardDue: true }))
    const window = buildReaderV4Prompt(windowRead)
    expect(window.messages).toMatchSnapshot()
  })

  it('is reader.v3’s layout with the v4 rules: same sentinel, same rosters, same tail', () => {
    const v3 = buildReaderV3Prompt(windowRead).messages
    const v4 = buildReaderV4Prompt(windowRead).messages
    expect(v4[0]?.content.startsWith(READER_SENTINEL)).toBe(true)
    expect(v4[0]?.content.startsWith(READER_V4_RULES)).toBe(true)
    expect(v4[0]?.content.slice(READER_V4_RULES.length)).toBe(
      v3[0]?.content.slice(READER_V3_RULES.length)
    )
    expect(v4[1]).toEqual(v3[1])
    const system = v4[0]?.content ?? ''
    expect(system.indexOf(READER_ROSTER_HEADING)).toBeLessThan(
      system.indexOf(READER_TOPICS_HEADING)
    )
  })

  it('puts the closed slot list first and alone, and names the invented slots as never slots', () => {
    const slots = READER_V4_RULES.indexOf('SLOTS. "s" is exactly one of:')
    const fields = READER_V4_RULES.indexOf('FIELDS, never slots: "voice"')
    expect(slots).toBeGreaterThan(0)
    expect(slots).toBeLessThan(READER_V4_RULES.indexOf('Rules:'))
    expect(fields).toBeGreaterThan(slots)
    // Every base slot is named in the list; no slot outside the closed list is offered as one.
    const list = READER_V4_RULES.slice(slots, READER_V4_RULES.indexOf('Rules:'))
    for (const slot of ALL_SLOTS.filter((each) => !each.startsWith('detail:'))) {
      expect(list, slot).toMatch(new RegExp(`\\b${slot}\\b`))
    }
    // The second live run's invented slots are named as never slots, and none reads as one.
    const never = /Nothing else is a slot: never ([^.]+)\./.exec(list)?.[1] ?? ''
    for (const word of ['voice', 'dialogue', 'speech', 'memory', 'secret', 'action', 'event']) {
      expect(never, word).toContain(word)
      expect(readSlot(word), word).toBeNull()
    }
    expect(estimateTokens(READER_V4_RULES)).toBeLessThanOrEqual(READER_V4_RULES_TOKENS)
  })

  it('states what each value must be: an age, a thing, a place they are at, no absence, one slot', () => {
    for (const rule of [
      'each fact once, in one slot',
      '"Lottie was not there" are no facts',
      'an age is an age (never "four daughters")',
      'an object is a thing (never a feeling, an attention or an act)',
      'a location is a place the quote puts them at, in or going to',
      'never where they died',
      '"my father was a clergyman"',
      'theirs only as kinship, relation or history',
      'The quote itself names them',
      '"the sisters walked"',
      'every word from the quote',
      'A want, wish, hope or plan is no fact now',
      'count them',
      'never list who does not know',
      'Leave out voice, mode, sp, o and chg'
    ]) {
      expect(READER_V4_RULES, rule).toContain(rule)
    }
    const answer = parseReaderAnswer(
      '{"c":[{"p":1,"r":"r3","s":"location","v":"behind the nets","q":"Orrin overheard Tomas from behind the nets"}],"n":[]}'
    )
    expect(answer?.claims[0]).toMatchObject({ voice: 'narration', mode: 'now', chg: false })
  })

  it('gives a full page and its card room: 160 + 1.4 per prose token + 240, at most 1,000', () => {
    expect(outputBudget('reader')).toBe(1_000)
    expect(readerV4OutputCap({ proseTokens: READER_V3_PAGE_TOKENS, cardDue: true })).toBe(
      160 + 560 + READER_V3_CARD_OUTPUT
    )
    // v3 clipped the same page to its 720; v4 asks what its own estimate says the page needs.
    expect(readerV3OutputCap({ proseTokens: READER_V3_PAGE_TOKENS, cardDue: true })).toBe(720)
    expect(readerV4OutputCap({ proseTokens: 100, cardDue: false })).toBe(160 + 140)
    expect(readerV4OutputCap({ proseTokens: 2_000, cardDue: true })).toBe(outputBudget('reader'))
    expect(readerV3PageTokens(TOPICS)).toBe(READER_V3_PAGE_TOKENS)
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
    const worst = buildReaderV4Prompt({
      ...windowRead,
      roster,
      topics,
      near: many,
      topicLines: many,
      anchored: many,
      paragraphs: page,
      cardDue: true,
      maxTokens: readerV4OutputCap({ proseTokens: pageTokens, cardDue: true })
    })
    expect(estimateTokens(text(worst.messages))).toBeLessThanOrEqual(inputBudget('reader'))
    const all = text(worst.messages)
    for (const line of [...roster, ...topics]) expect(all).toContain(line)
    expect(all).toContain(`¶${lines - 1} ${'word '.repeat(80).trim()}`)
    expect(worst.maxTokens).toBeLessThanOrEqual(outputBudget('reader'))
  })
})
