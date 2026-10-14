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
import { readerV3PageTokens } from './reader.v3'
import { READER_V4_RULES, buildReaderV4Prompt, readerV4OutputCap } from './reader.v4'
import {
  READER_V5_PROMPT_VERSION,
  READER_V5_RULES,
  READER_V5_RULES_TOKENS,
  buildReaderV5Prompt
} from './reader.v5'

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

describe('reader.v5 prompt (F-16.17, the third live run of 2026-10-14)', () => {
  it('matches the golden messages for a first read and a window read', () => {
    const first = buildReaderV5Prompt(firstRead)
    expect(first.version).toBe(READER_V5_PROMPT_VERSION)
    expect(first.messages).toMatchSnapshot()
    expect(first.maxTokens).toBe(readerV4OutputCap({ proseTokens: 40, cardDue: true }))
    const window = buildReaderV5Prompt(windowRead)
    expect(window.messages).toMatchSnapshot()
  })

  it('is reader.v4’s layout and cap with the v5 rules: same sentinel, same rosters, same tail', () => {
    const v4 = buildReaderV4Prompt(windowRead)
    const v5 = buildReaderV5Prompt(windowRead)
    expect(v5.messages[0]?.content.startsWith(READER_SENTINEL)).toBe(true)
    expect(v5.messages[0]?.content.startsWith(READER_V5_RULES)).toBe(true)
    expect(v5.messages[0]?.content.slice(READER_V5_RULES.length)).toBe(
      v4.messages[0]?.content.slice(READER_V4_RULES.length)
    )
    expect(v5.messages[1]).toEqual(v4.messages[1])
    expect(v5.maxTokens).toBe(v4.maxTokens)
    const system = v5.messages[0]?.content ?? ''
    expect(system.indexOf(READER_ROSTER_HEADING)).toBeLessThan(
      system.indexOf(READER_TOPICS_HEADING)
    )
  })

  it('names the voice field "src", never a field called voice, and lists src and voice as never slots', () => {
    expect(READER_V5_RULES).toContain('FIELDS, never slots: "src"')
    expect(READER_V5_RULES).not.toContain('"voice"')
    expect(READER_V5_RULES).toContain('"src":"dialogue","sp":"r5"')
    expect(READER_V5_RULES).toContain('Leave out src, mode, sp, o and chg')
    const slots = READER_V5_RULES.indexOf('SLOTS. "s" is exactly one of:')
    const list = READER_V5_RULES.slice(slots, READER_V5_RULES.indexOf('Rules:'))
    for (const slot of ALL_SLOTS.filter((each) => !each.startsWith('detail:'))) {
      expect(list, slot).toMatch(new RegExp(`\\b${slot}\\b`))
    }
    const never = /Nothing else is a slot: never ([^.]+)\./.exec(list)?.[1] ?? ''
    for (const word of ['src', 'voice', 'dialogue', 'speech', 'memory', 'action']) {
      expect(never, word).toContain(word)
      expect(readSlot(word), word).toBeNull()
    }
    // The reply's "src" is read as the claim's voice; a v4 reply's "voice" still is.
    const answer = parseReaderAnswer(
      '{"c":[{"p":1,"r":"r3","s":"traits","v":"proud","q":"I am proud, said Orrin","src":"dialogue","sp":"r3"},' +
        '{"p":1,"r":"r3","s":"traits","v":"proud","q":"I am proud, said Orrin","voice":"thought","sp":"r3"},' +
        '{"p":1,"r":"r3","s":"location","v":"the nets","q":"Orrin overheard Tomas from behind the nets"}],"n":[]}'
    )
    expect(answer?.claims.map((claim) => claim.voice)).toEqual(['dialogue', 'thought', 'narration'])
    expect(estimateTokens(READER_V5_RULES)).toBeLessThanOrEqual(READER_V5_RULES_TOKENS)
  })

  it('states what each open-ended slot holds and who did it (the third live run’s wrong facts)', () => {
    for (const rule of [
      // Clara's "asked Miss Pell", Johanna's "asked her for the two next".
      'never the one it is done to ("he asked Miss Pell" is his, not hers)',
      // The green-eyes trap.
      'nor a he or she that two people named nearby could be',
      // "his second daughter", "The Captain's father".
      'never the relative: "his second daughter" is the daughter\'s',
      // "all smiles", "noticed nothing at all".
      "a lasting quality; never one act, one evening's mood",
      // "join the group", "opened the lodge gate".
      'their position or work: "steward", "guest"; never an act',
      // Hobb's "for forty years".
      'never how long something lasted',
      // "she and her sisters", "his guilt and his descent…".
      'never a list of people or a remark',
      // "would ride over", "would soon be married", "it was said … had drowned".
      'never a plan, an expectation or a report',
      'what others said or pronounced',
      // Thornmere's location.
      "a place or a thing is never anyone's location"
    ]) {
      expect(READER_V5_RULES, rule).toContain(rule)
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
    const many = Array.from(
      { length: 60 },
      (_, i) => `r${i} eyes “grey” · hair “red” · role “clerk”`
    )
    const worst = buildReaderV5Prompt({
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
