import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { ALL_SLOTS, NOT_READ_SLOTS, readSlot, slotIsRead } from '@shared/memory/slots'
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
import { READER_V5_RULES } from './reader.v5'
import { READER_V6_RULES, buildReaderV6Prompt } from './reader.v6'
import {
  READER_V7_PROMPT_VERSION,
  READER_V7_RULES,
  READER_V7_RULES_TOKENS,
  buildReaderV7Prompt
} from './reader.v7'

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

describe('reader.v7 prompt (F-16.17, suggestions you approve: plan Suggestions.md)', () => {
  it('matches the golden messages for a first read and a window read', () => {
    const first = buildReaderV7Prompt(firstRead)
    expect(first.version).toBe(READER_V7_PROMPT_VERSION)
    expect(first.messages).toMatchSnapshot()
    expect(first.maxTokens).toBe(readerV4OutputCap({ proseTokens: 40, cardDue: true }))
    const window = buildReaderV7Prompt(windowRead)
    expect(window.messages).toMatchSnapshot()
  })

  it('is reader.v6’s layout and cap with the v7 rules, still fewer tokens than v5’s rules', () => {
    const v6 = buildReaderV6Prompt(windowRead)
    const v7 = buildReaderV7Prompt(windowRead)
    expect(v7.messages[0]?.content.startsWith(READER_SENTINEL)).toBe(true)
    expect(v7.messages[0]?.content.startsWith(READER_V7_RULES)).toBe(true)
    expect(v7.messages[0]?.content.slice(READER_V7_RULES.length)).toBe(
      v6.messages[0]?.content.slice(READER_V6_RULES.length)
    )
    expect(v7.messages[1]).toEqual(v6.messages[1])
    expect(v7.maxTokens).toBe(v6.maxTokens)
    const system = v7.messages[0]?.content ?? ''
    expect(system.indexOf(READER_ROSTER_HEADING)).toBeLessThan(
      system.indexOf(READER_TOPICS_HEADING)
    )
    expect(estimateTokens(READER_V7_RULES)).toBeLessThanOrEqual(READER_V7_RULES_TOKENS)
    expect(estimateTokens(READER_V7_RULES)).toBeGreaterThan(estimateTokens(READER_V6_RULES))
    expect(estimateTokens(READER_V7_RULES)).toBeLessThan(estimateTokens(READER_V5_RULES))
  })

  it('asks for every slot read, traits and history included, and names every slot not read as never a slot', () => {
    const slots = READER_V7_RULES.indexOf('SLOTS. "s" is exactly one of:')
    const never = READER_V7_RULES.indexOf('Nothing else is a slot: never')
    const asked = READER_V7_RULES.slice(slots, never)
    const refused = /Nothing else is a slot: never ([^.]+)\./.exec(READER_V7_RULES)?.[1] ?? ''
    for (const slot of ALL_SLOTS.filter((each) => !each.startsWith('detail:'))) {
      if (slot === 'knows' || slot === 'thread') {
        expect(asked, slot).toContain(`${slot}`)
        continue
      }
      if (slotIsRead(slot)) {
        expect(asked, slot).toMatch(new RegExp(`\\b${slot}\\b`))
        expect(refused, slot).not.toMatch(new RegExp(`\\b${slot}\\b`))
      } else {
        expect(refused, slot).toMatch(new RegExp(`\\b${slot}\\b`))
        expect(asked, slot).not.toMatch(new RegExp(`\\b${slot} \\(`))
      }
    }
    expect([...NOT_READ_SLOTS].sort()).toEqual(['clothing', 'objects', 'relation', 'role'])
    for (const word of ['src', 'voice', 'dialogue', 'speech', 'memory', 'action']) {
      expect(refused, word).toContain(word)
      expect(readSlot(word), word).toBeNull()
    }
    // reader.v5's rules for the two slots back, the relation rule still gone.
    for (const rule of ['a lasting quality', 'who does or is it', 'told as fact']) {
      expect(READER_V7_RULES, rule).toContain(rule)
    }
    expect(READER_V7_RULES).not.toContain('how they stand to one')
  })

  it('keeps the rules the fourth live run’s wrong facts broke, and v5’s for traits and history', () => {
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
      "a place or a thing is never anyone's location",
      // The third live run: "he asked Miss Pell" stored as hers, a passing mood as a trait.
      '("he asked Miss Pell" is his, not hers)',
      "never one act, one evening's mood",
      'never where they died: that is history'
    ]) {
      expect(READER_V7_RULES, rule).toContain(rule)
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
    const worst = buildReaderV7Prompt({
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
