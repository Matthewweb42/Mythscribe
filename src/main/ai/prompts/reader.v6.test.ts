import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { ALL_SLOTS, READER_V6_NOT_READ_SLOTS, readSlot } from '@shared/memory/slots'
import { TOPIC_ROSTER_MAX_TOKENS, topicLinesTokens } from '@shared/memory/topics'
import { READER_ROSTER_HEADING } from './reader.v1'
import {
  READER_SENTINEL,
  READER_TOPICS_HEADING,
  READER_V2_RECORD_ROSTER_TOKENS,
  type BuildReaderV2PromptInput
} from './reader.v2'
import { readerV3PageTokens } from './reader.v3'
import { readerV4OutputCap } from './reader.v4'
import { READER_V5_RULES, buildReaderV5Prompt } from './reader.v5'
import {
  READER_V6_PROMPT_VERSION,
  READER_V6_RULES,
  READER_V6_RULES_TOKENS,
  buildReaderV6Prompt
} from './reader.v6'

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
  near: ['r1 eyes “grey” · hair “red”', 'r2 age “forty”'],
  topicLines: ['s1 the sold map: r3 overheard 1.1 (from r2); r2 knew before 1.1'],
  anchored: ['c1 r3 knows s1 overheard from r2 ¶1'],
  paragraphs: SCENE.slice(0, 2).map((text, p) => ({ p, text })),
  cardDue: false,
  maxTokens: readerV4OutputCap({ proseTokens: 25, cardDue: false })
}

const text = (messages: { content: string }[]): string => messages.map((m) => m.content).join('\n')

describe('reader.v6 prompt (F-16.17, concrete facts only: plan ReaderNarrow.md)', () => {
  it('matches the golden messages for a first read and a window read', () => {
    const first = buildReaderV6Prompt(firstRead)
    expect(first.version).toBe(READER_V6_PROMPT_VERSION)
    expect(first.messages).toMatchSnapshot()
    expect(first.maxTokens).toBe(readerV4OutputCap({ proseTokens: 40, cardDue: true }))
    const window = buildReaderV6Prompt(windowRead)
    expect(window.messages).toMatchSnapshot()
  })

  it('is reader.v5’s layout and cap with the v6 rules, and fewer tokens than v5’s rules', () => {
    const v5 = buildReaderV5Prompt(windowRead)
    const v6 = buildReaderV6Prompt(windowRead)
    expect(v6.messages[0]?.content.startsWith(READER_SENTINEL)).toBe(true)
    expect(v6.messages[0]?.content.startsWith(READER_V6_RULES)).toBe(true)
    expect(v6.messages[0]?.content.slice(READER_V6_RULES.length)).toBe(
      v5.messages[0]?.content.slice(READER_V5_RULES.length)
    )
    expect(v6.messages[1]).toEqual(v5.messages[1])
    expect(v6.maxTokens).toBe(v5.maxTokens)
    const system = v6.messages[0]?.content ?? ''
    expect(system.indexOf(READER_ROSTER_HEADING)).toBeLessThan(
      system.indexOf(READER_TOPICS_HEADING)
    )
    expect(estimateTokens(READER_V6_RULES)).toBeLessThanOrEqual(READER_V6_RULES_TOKENS)
    expect(estimateTokens(READER_V6_RULES)).toBeLessThan(estimateTokens(READER_V5_RULES))
  })

  it('asks for every slot still read and names every slot no longer read as never a slot', () => {
    const slots = READER_V6_RULES.indexOf('SLOTS. "s" is exactly one of:')
    const never = READER_V6_RULES.indexOf('Nothing else is a slot: never')
    const asked = READER_V6_RULES.slice(slots, never)
    const refused = /Nothing else is a slot: never ([^.]+)\./.exec(READER_V6_RULES)?.[1] ?? ''
    for (const slot of ALL_SLOTS.filter((each) => !each.startsWith('detail:'))) {
      if (slot === 'knows' || slot === 'thread') {
        expect(asked, slot).toContain(`${slot}`)
        continue
      }
      if (!READER_V6_NOT_READ_SLOTS.has(slot)) {
        expect(asked, slot).toMatch(new RegExp(`\\b${slot}\\b`))
        expect(refused, slot).not.toMatch(new RegExp(`\\b${slot}\\b`))
      } else {
        expect(refused, slot).toMatch(new RegExp(`\\b${slot}\\b`))
        expect(asked, slot).not.toMatch(new RegExp(`\\b${slot} \\(`))
      }
    }
    expect([...READER_V6_NOT_READ_SLOTS].sort()).toEqual(
      ['clothing', 'history', 'objects', 'relation', 'role', 'traits'].sort()
    )
    for (const word of ['src', 'voice', 'dialogue', 'speech', 'memory', 'action']) {
      expect(refused, word).toContain(word)
      expect(readSlot(word), word).toBeNull()
    }
    // No open-ended rules left.
    for (const gone of ['lasting quality', 'who does or is it', 'how they stand to one']) {
      expect(READER_V6_RULES, gone).not.toContain(gone)
    }
  })

  it('states the rules the fourth live run’s wrong facts broke', () => {
    for (const rule of [
      // "her dark eyes" stored as Mr. Varrow's.
      'A his or her before a value is whose it is: "her dark eyes" are hers',
      // "near enough for her to overhear…", "down to dinner on the Captain's arm".
      'never a clause',
      // "at Gullhaven", "in Elsdale" as born.
      'born (when: a year or a date; where is detail:birthplace)',
      // "his second daughter".
      'never the relative: "his second daughter" is the daughter\'s',
      // The green-eyes trap.
      'nor does a he, she, his or her that two people named nearby could be',
      "A place or a thing is never anyone's location"
    ]) {
      expect(READER_V6_RULES, rule).toContain(rule)
    }
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
    const many = Array.from({ length: 60 }, (_, i) => `r${i} eyes “grey” · hair “red” · age “40”`)
    const worst = buildReaderV6Prompt({
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
