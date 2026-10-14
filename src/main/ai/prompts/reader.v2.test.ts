import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget } from '@shared/ai'
import {
  TOPIC_ROSTER_MAX_TOKENS,
  TOPIC_ROSTER_TOKENS,
  topicLinesTokens
} from '@shared/memory/topics'
import { FULL_OUTPUT_CAP, PAGE_TOKENS, outputCap } from '@shared/memory/windows'
import { READER_ROSTER_HEADING, READER_RULES } from './reader.v1'
import {
  READER_ANCHORED_HEADING,
  READER_NO_TOPICS,
  READER_SENTINEL,
  READER_TOPICS_HEADING,
  READER_TOPIC_LINES_HEADING,
  READER_V2_ANCHORED_TOKENS,
  READER_V2_NEAR_TOKENS,
  READER_V2_PROMPT_VERSION,
  READER_V2_RECORD_ROSTER_TOKENS,
  READER_V2_RULES,
  READER_V2_RULES_TOKENS,
  READER_V2_TOPIC_LINES_TOKENS,
  READER_V2_TOPICS_TOKENS,
  buildReaderV2Prompt,
  readerV2PageTokens,
  type BuildReaderV2PromptInput
} from './reader.v2'

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
  maxTokens: outputCap({ purpose: 'full', proseTokens: 40, cardDue: true })
}

const windowRead: BuildReaderV2PromptInput = {
  ...firstRead,
  topics: TOPICS,
  position: 'Scene 1.2 “The Nets”, the changed paragraphs',
  card: 'Tomas sells the map; Orrin hears it. · where the quay · POV r1',
  near: ['r1 eyes “grey” · hair “red”', 'r2 role “harbourmaster”'],
  topicLines: ['s1 the sold map: r3 overheard 1.1 (from r2); r2 knew before 1.1'],
  anchored: [
    'c1 r3 knows s1 overheard from r2 ¶1',
    'c2 t1 thread opens “Ashby says he is coming back” ¶2, re-checking',
    's1 revealed “Tomas sold the map on the quay” ¶0, re-checking'
  ],
  paragraphs: SCENE.slice(0, 2).map((text, p) => ({ p, text })),
  cardDue: false,
  maxTokens: outputCap({ purpose: 'window', proseTokens: 25, cardDue: false })
}

const text = (messages: { content: string }[]): string => messages.map((m) => m.content).join('\n')

describe('reader.v2 prompt (F-16.22, F-16.23)', () => {
  it('matches the golden messages for a first read, a window read and a page with a new secret', () => {
    const first = buildReaderV2Prompt(firstRead)
    expect(first.version).toBe(READER_V2_PROMPT_VERSION)
    expect(first.messages).toMatchSnapshot()
    expect(first.maxTokens).toBe(720)
    const window = buildReaderV2Prompt(windowRead)
    expect(window.messages).toMatchSnapshot()
    expect(window.maxTokens).toBe(outputCap({ purpose: 'window', proseTokens: 25, cardDue: false }))
    // A page proposing a new secret: the same request, the topics roster listing the others.
    const fresh = buildReaderV2Prompt({ ...firstRead, topics: TOPICS })
    expect(fresh.messages[0]?.content.endsWith(TOPICS.join('\n'))).toBe(true)
  })

  it('orders the rules, the record roster, the topics roster, then the tail; the sentinel is v1’s', () => {
    const [system, user] = buildReaderV2Prompt(windowRead).messages
    expect(system?.role).toBe('system')
    expect(system?.content.startsWith(READER_SENTINEL)).toBe(true)
    expect(READER_RULES.startsWith(READER_SENTINEL)).toBe(true)
    const content = system?.content ?? ''
    expect(content.startsWith(READER_V2_RULES)).toBe(true)
    const records = content.indexOf(READER_ROSTER_HEADING)
    const topics = content.indexOf(READER_TOPICS_HEADING)
    expect(records).toBeGreaterThanOrEqual(READER_V2_RULES.length)
    expect(topics).toBeGreaterThan(records)
    expect(content.indexOf(ROSTER.join('\n'))).toBeGreaterThan(records)
    expect(content.indexOf(ROSTER.join('\n'))).toBeLessThan(topics)
    expect(content.endsWith(TOPICS.join('\n'))).toBe(true)
    expect(user?.role).toBe('user')
    const tail = user?.content ?? ''
    const order = [
      'Scene 1.2',
      'Typed:',
      'Card now:',
      'Known about',
      READER_TOPIC_LINES_HEADING,
      READER_ANCHORED_HEADING,
      'Paragraphs:'
    ]
    const at = order.map((marker) => tail.indexOf(marker))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(tail.endsWith('Card: no')).toBe(true)
  })

  it('says so when no secret or thread exists yet, and never lists who does not know', () => {
    const system = buildReaderV2Prompt(firstRead).messages[0]?.content ?? ''
    expect(system.endsWith(`${READER_TOPICS_HEADING}\n${READER_NO_TOPICS}`)).toBe(true)
    expect(READER_V2_RULES).toContain('never list who does not know')
    // The tail carries what was proved only: no scoped absence line ever reaches the reader.
    expect(buildReaderV2Prompt(windowRead).messages.at(-1)?.content).not.toMatch(
      /No scene shows|does not know|doesn't know|checked up to/
    )
  })

  it('keeps the rules under 1,150 tokens; the record prefix is the same for every scene, with or without topics', () => {
    expect(estimateTokens(READER_V2_RULES)).toBeLessThanOrEqual(READER_V2_RULES_TOKENS)
    const a = buildReaderV2Prompt(firstRead).messages[0]?.content ?? ''
    const b = buildReaderV2Prompt(windowRead).messages[0]?.content ?? ''
    // The cached prefix (rules and record roster) does not move when the topics do.
    const prefix = (system: string): string =>
      system.slice(0, system.indexOf(READER_TOPICS_HEADING))
    expect(prefix(a)).toBe(prefix(b))
    expect(buildReaderV2Prompt(windowRead).messages[0]).toEqual(
      buildReaderV2Prompt({ ...windowRead, near: [], anchored: [] }).messages[0]
    )
  })

  it('caps the near, topic and anchored blocks, and trims near, then topic lines, then anchored over the budget', () => {
    const many = Array.from(
      { length: 200 },
      (_, i) => `r${i} eyes “grey” · hair “red” · role “clerk”`
    )
    const lines = Array.from(
      { length: 50 },
      (_, i) => `s${i} the secret number ${i}: r1 overheard 1.${i} (from r2)`
    )
    const capped = buildReaderV2Prompt({
      ...windowRead,
      near: many,
      topicLines: lines,
      anchored: many
    })
    const tail = capped.messages.at(-1)?.content ?? ''
    const block = (heading: string, next: string): string =>
      tail.slice(tail.indexOf(heading), tail.indexOf(next))
    expect(estimateTokens(block('Known about', READER_TOPIC_LINES_HEADING))).toBeLessThanOrEqual(
      READER_V2_NEAR_TOKENS + 20
    )
    expect(
      estimateTokens(block(READER_TOPIC_LINES_HEADING, READER_ANCHORED_HEADING))
    ).toBeLessThanOrEqual(READER_V2_TOPIC_LINES_TOKENS + 20)
    expect(estimateTokens(block(READER_ANCHORED_HEADING, 'Paragraphs:'))).toBeLessThanOrEqual(
      READER_V2_ANCHORED_TOKENS + 20
    )
  })

  it('stays within the 6,000-token input cap at its worst: full rosters, a 2,500-token page, every block full', () => {
    const page = Array.from({ length: 25 }, (_, p) => ({ p, text: 'word '.repeat(80).trim() }))
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
      topicLinesTokens([...topics, `s${i} the secret of the hall ${i} · secret`]) <=
      TOPIC_ROSTER_TOKENS;
      i += 1
    ) {
      topics.push(`s${i} the secret of the hall ${i} · secret`)
    }
    const many = Array.from(
      { length: 60 },
      (_, i) => `r${i} eyes “grey” · hair “red” · role “clerk”`
    )
    const worst = buildReaderV2Prompt({
      ...windowRead,
      roster,
      topics,
      near: many,
      topicLines: many,
      anchored: many,
      paragraphs: page,
      cardDue: true,
      maxTokens: outputCap({ purpose: 'full', proseTokens: 2_500, cardDue: true })
    })
    expect(estimateTokens(text(worst.messages))).toBeLessThanOrEqual(inputBudget('reader'))
    expect(inputBudget('reader')).toBe(6_000)
    expect(worst.trimmed.near).toBeGreaterThan(0)
    expect(worst.trimmed.rosterOver).toBe(0)
    expect(worst.maxTokens).toBe(FULL_OUTPUT_CAP)
    // The window and both rosters are never trimmed.
    const all = text(worst.messages)
    for (const line of [...roster, ...topics]) expect(all).toContain(line)
    expect(all).toContain(`¶24 ${'word '.repeat(80).trim()}`)
  })

  it('never drops a topic: a roster past its 400 tokens takes the overflow out of the near lines', () => {
    const topics = Array.from(
      { length: 80 },
      (_, i) => `s${i + 1} the long secret about the hall ${i} · secret`
    )
    const over = topicLinesTokens(topics) - READER_V2_TOPICS_TOKENS
    expect(over).toBeGreaterThan(0)
    const built = buildReaderV2Prompt({
      ...windowRead,
      topics,
      near: Array.from({ length: 50 }, (_, i) => `r${i} eyes “grey”`)
    })
    expect(built.trimmed.rosterOver).toBe(over)
    expect(built.messages[0]?.content.endsWith(topics.join('\n'))).toBe(true)
    expect(built.trimmed.near).toBeGreaterThan(0)
  })

  it('fits a topics roster at its ceiling: the near lines, then the page, give the overflow', () => {
    const topics: string[] = []
    for (
      let i = 1;
      topicLinesTokens([...topics, `s${i} the hidden matter ${i} · secret`]) <=
      TOPIC_ROSTER_MAX_TOKENS;
      i += 1
    ) {
      topics.push(`s${i} the hidden matter ${i} · secret`)
    }
    const pageTokens = readerV2PageTokens(topics)
    expect(pageTokens).toBe(
      PAGE_TOKENS - (topicLinesTokens(topics) - READER_V2_TOPICS_TOKENS - READER_V2_NEAR_TOKENS)
    )
    expect(readerV2PageTokens(TOPICS)).toBe(PAGE_TOKENS)
    const roster: string[] = []
    for (
      let i = 1;
      estimateTokens([...roster, ''].join('\n')) < READER_V2_RECORD_ROSTER_TOKENS - 20;
      i += 1
    ) {
      roster.push(`r${i} Character Number ${i} (Number ${i}) · character`)
    }
    // A page as the pipeline plans it beside this roster, every other block full.
    const lines = Math.floor(pageTokens / 101)
    const page = Array.from({ length: lines }, (_, p) => ({ p, text: 'word '.repeat(80).trim() }))
    const many = Array.from(
      { length: 60 },
      (_, i) => `r${i} eyes “grey” · hair “red” · role “clerk”`
    )
    const worst = buildReaderV2Prompt({
      ...windowRead,
      roster,
      topics,
      near: many,
      topicLines: many,
      anchored: many,
      paragraphs: page,
      cardDue: true,
      maxTokens: outputCap({ purpose: 'full', proseTokens: pageTokens, cardDue: true })
    })
    expect(estimateTokens(text(worst.messages))).toBeLessThanOrEqual(inputBudget('reader'))
    expect(worst.trimmed.rosterOver).toBeGreaterThan(READER_V2_NEAR_TOKENS)
    // The roster and the page are whole.
    const all = text(worst.messages)
    for (const line of topics) expect(all).toContain(line)
    expect(all).toContain(`¶${lines - 1} ${'word '.repeat(80).trim()}`)
  })

  it('keeps the output caps: 720 for a page, the window formula, plus 120 when the card is due', () => {
    const due = buildReaderV2Prompt({
      ...windowRead,
      cardDue: true,
      maxTokens: outputCap({ purpose: 'window', proseTokens: 25, cardDue: true })
    })
    expect(due.messages.at(-1)?.content.endsWith('Card: yes')).toBe(true)
    expect(due.maxTokens).toBe(
      outputCap({ purpose: 'window', proseTokens: 25, cardDue: false }) + 120
    )
    expect(buildReaderV2Prompt({ ...firstRead, maxTokens: 5_000 }).maxTokens).toBe(720)
  })
})
