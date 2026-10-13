import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  JUDGE_CONFIRM_INPUT_TOKENS,
  JUDGE_CONFIRM_MAX_TOKENS,
  JUDGE_CONFIRM_RULES,
  JUDGE_CONTEXT_CHARS,
  JUDGE_ITEM_TOKENS,
  JUDGE_ITEMS_TOKENS,
  JUDGE_PAIRS_MAX,
  JUDGE_PROMPT_VERSION,
  JUDGE_RULES,
  JUDGE_SENTINEL,
  buildJudgeConfirmPrompt,
  buildJudgePrompt,
  judgeBatches,
  judgeItem,
  judgeItemKeyText,
  judgeItemText,
  judgeMaxTokens,
  judgeQuestion,
  parseJudgeAnswer,
  parseJudgeConfirm,
  type JudgePair,
  type JudgeQuestion,
  type JudgeSide
} from './judge.v1'

const side = (over: Partial<JudgeSide>): JudgeSide => ({
  place: '1.1 ¶0',
  at: { order: 0, para: 0 },
  says: 'grey',
  voice: 'narration',
  mode: 'now',
  flashback: false,
  year: null,
  quote: "Mara's eyes were grey",
  text: "The quay was cold. Mara's eyes were grey. She waited.",
  ...over
})

const eyes: JudgePair = {
  question: { rule: 'C1', name: 'Mara Vell', slot: 'eyes' },
  a: side({ year: 1811 }),
  b: side({
    place: '1.2 ¶3',
    at: { order: 1, para: 3 },
    says: 'brown',
    quote: "Mara's eyes were brown",
    text: "Rain fell. Mara's eyes were brown. Orrin did not look up."
  }),
  between: ['Three winters later']
}

const note: JudgePair = {
  question: { rule: 'C6', name: 'Orrin', slot: 'eyes' },
  a: side({
    place: '2.1 ¶1',
    at: { order: 2, para: 1 },
    says: 'brown',
    quote: "Orrin's eyes were brown",
    text: "Orrin's eyes were brown."
  }),
  b: side({
    place: 'Orrin’s Pinned page',
    at: null,
    says: 'green',
    voice: null,
    mode: null,
    quote: 'Eyes: green',
    text: 'Eyes: green.'
  }),
  between: []
}

/** One question of each rule (and variant), as plan P4 §2.2 words them. */
const QUESTIONS: [JudgeQuestion, string][] = [
  [{ rule: 'C1', name: 'Mara Vell', slot: 'eyes' }, 'Mara Vell · eyes. Can both be true?'],
  [
    { rule: 'C2', variant: 'dead', name: 'Hobb' },
    'One passage has Hobb die; the other has Hobb present. Can both be true?'
  ],
  [
    { rule: 'C2', variant: 'body', name: 'Mara', slot: 'hair' },
    'Mara’s hair differs between these two appearances with no change shown. Can both be true?'
  ],
  [
    { rule: 'C3', name: 'Bel', secret: 'the secret engagement' },
    'In one passage Bel passes on the secret engagement; in the other Bel learns it. Can both be true?'
  ],
  [
    {
      rule: 'C4',
      variant: 'birth',
      name: 'Anne',
      age: '17',
      born: '1795',
      year: 1815,
      source: 'typed'
    },
    'Anne: stated age 17; born 1795; the story year of the scene with the age is 1815 (typed by the author). Can both be true?'
  ],
  [
    { rule: 'C4', variant: 'falls', name: 'Lottie' },
    'Lottie’s stated age falls from the earlier passage to the later one. Can both be true?'
  ],
  [
    { rule: 'C5', thread: 'Lottie’s match' },
    'One passage resolves Lottie’s match (a plot thread); the other, later, advances it. Can both be true?'
  ],
  [
    { rule: 'C6', name: 'Orrin', slot: 'eyes' },
    "One passage is the book, the other the author's note. Can both be true of Orrin’s eyes?"
  ],
  [{ rule: 'C7', name: 'The Captain', slot: 'history' }, 'The Captain · history. Can both be true?']
]

describe('judge.v1 prompt (F-16.27)', () => {
  it('matches the golden messages: rules (cached), then the pairs, numbered', () => {
    const built = buildJudgePrompt([judgeItem(eyes), judgeItem(note)], 'ab')
    expect(built.version).toBe(JUDGE_PROMPT_VERSION)
    expect(built.messages).toMatchSnapshot()
    expect(built.messages).toHaveLength(2)
    expect(built.messages[0]).toEqual({ role: 'system', content: JUDGE_RULES })
    expect(JUDGE_RULES.startsWith(JUDGE_SENTINEL)).toBe(true)
    const user = built.messages[1]?.content ?? ''
    expect(user.startsWith('Pairs:\n1. Mara Vell · eyes. Can both be true?\n')).toBe(true)
    expect(user).toContain(
      "A [1.1 ¶0 · earlier · narration, now · story year 1811] says grey: The quay was cold. Mara's eyes were grey. She waited."
    )
    expect(user).toContain(
      "B [1.2 ¶3 · later · narration, now] says brown: Rain fell. Mara's eyes were brown."
    )
    expect(user).toContain('Between: “Three winters later”')
    expect(user).toContain('\n\n2. One passage is the book')
    expect(user).toContain('B [Orrin’s Pinned page · note] says green: Eyes: green.')
    expect(user).toContain('A [2.1 ¶1 · book · narration, now] says brown:')
    expect(built.sent).toBe(2)
    // 20 + 26 a pair.
    expect(built.maxTokens).toBe(72)
  })

  it('keeps both rules at 450 tokens or under, telling notes are timeless and may describe the future', () => {
    expect(estimateTokens(JUDGE_RULES)).toBeLessThanOrEqual(450)
    expect(estimateTokens(JUDGE_CONFIRM_RULES)).toBeLessThanOrEqual(450)
    for (const rules of [JUDGE_RULES, JUDGE_CONFIRM_RULES]) {
      expect(rules.startsWith(JUDGE_SENTINEL)).toBe(true)
      expect(rules).toContain("Notes are the author's timeless canon")
      expect(rules).toContain('may describe the future')
      expect(rules).toContain('Reading order is story order, except in a flashback')
      expect(rules).toContain('Judge only from the words given')
    }
    expect(JUDGE_RULES).toContain('"w" (at most 8 words) only with "c"')
    expect(JUDGE_CONFIRM_RULES).toContain('"w" (at most 20 words) with every verdict')
  })

  it.each(QUESTIONS)('words the %o question order-neutrally and positively', (question, text) => {
    expect(judgeQuestion(question)).toBe(text)
    const item = judgeItemText({ ...eyes, question }, 1, 'ab')
    expect(item.startsWith(`1. ${text}\n`)).toBe(true)
    // Plan P4 rule 5: no item states an absence.
    for (const words of ['does not know', "doesn't know", 'never', 'no scene', 'not learn']) {
      expect(item.toLowerCase()).not.toContain(words)
    }
  })

  it('sends the swapped call byte-identical but for the sides (the question and hints stay)', () => {
    const ab = buildJudgePrompt([judgeItem(eyes)], 'ab')
    const ba = buildJudgePrompt([judgeItem(eyes)], 'ba')
    expect(ba.messages[0]).toEqual(ab.messages[0])
    expect(ba.order).toBe('ba')
    const abLines = (ab.messages[1]?.content ?? '').split('\n')
    const baLines = (ba.messages[1]?.content ?? '').split('\n')
    expect(baLines).toHaveLength(abLines.length)
    // Pairs:, the question, A, B, Between.
    expect(baLines[0]).toBe(abLines[0])
    expect(baLines[1]).toBe(abLines[1])
    expect(baLines[4]).toBe(abLines[4])
    // Each passage keeps its own place and relative order; only the label changes.
    expect(baLines[2]).toBe(abLines[3]?.replace(/^B /u, 'A '))
    expect(baLines[3]).toBe(abLines[2]?.replace(/^A /u, 'B '))
    expect(baLines[2]).toContain('1.2 ¶3 · later')
  })

  it('reads relative order within one scene and one paragraph', () => {
    const same: JudgePair = {
      ...eyes,
      b: side({ at: { order: 0, para: 4 }, place: '1.1 ¶4', says: 'brown' })
    }
    const text = judgeItemText(same, 1, 'ab')
    expect(text).toContain('A [1.1 ¶0 · same scene, earlier ·')
    expect(text).toContain('B [1.1 ¶4 · same scene, later ·')
    const paragraph = judgeItemText({ ...eyes, b: side({ says: 'brown' }) }, 1, 'ab')
    expect(paragraph).toContain('· same paragraph ·')
    // A presence (no voice) reads "on the page"; a flashback and a year are marked.
    const presence = judgeItemText(
      { ...eyes, b: side({ voice: null, mode: null, flashback: true, at: { order: 3, para: 0 } }) },
      1,
      'ab'
    )
    expect(presence).toContain('· later · on the page · flashback]')
  })

  it('keys an item without its number or scene places, so a scene move keeps the key', () => {
    const item = judgeItem(eyes)
    const moved = judgeItem({
      ...eyes,
      a: { ...eyes.a, place: '7.12 ¶0', at: { order: 40, para: 0 } },
      b: { ...eyes.b, place: '7.13 ¶3', at: { order: 41, para: 3 } }
    })
    expect(moved.chars).toBe(item.chars)
    expect(judgeItemKeyText(moved, 'ab')).toBe(judgeItemKeyText(item, 'ab'))
    expect(judgeItemKeyText(item, 'ab')).not.toContain('1.2')
    expect(judgeItemKeyText(item, 'ab')).not.toBe(judgeItemKeyText(item, 'ba'))
    // Swapping which comes first changes what the judge reads: a new key.
    const swapped = judgeItem({
      ...eyes,
      a: { ...eyes.a, at: { order: 5, para: 0 } }
    })
    expect(judgeItemKeyText(swapped, 'ab')).not.toBe(judgeItemKeyText(item, 'ab'))
  })

  it('caps the output at min(300, 20 + 26 a pair)', () => {
    expect(judgeMaxTokens(1)).toBe(46)
    expect(judgeMaxTokens(10)).toBe(280)
    expect(judgeMaxTokens(20)).toBe(outputBudget('judge'))
  })

  it('maxed: ten long pairs stay within 260 tokens each and the 3,000 cap', () => {
    const long = `${'word '.repeat(400)}Mara's eyes were grey. ${'tail '.repeat(400)}`
    const huge: JudgePair = {
      question: { rule: 'C1', name: 'Mara Vell of the long name '.repeat(8), slot: 'eyes' },
      a: side({
        text: long,
        says: 'grey '.repeat(40),
        place: '12.10 ¶13',
        year: 1811,
        flashback: true
      }),
      b: side({
        text: long,
        says: 'brown '.repeat(40),
        place: '12.11 ¶14',
        at: { order: 9, para: 14 },
        year: 1815
      }),
      between: ['Three winters later '.repeat(10), 'Years passed '.repeat(10), 'A third']
    }
    const item = judgeItem(huge)
    expect(item.chars).toBe(JUDGE_CONTEXT_CHARS[JUDGE_CONTEXT_CHARS.length - 1])
    expect(estimateTokens(judgeItemText(huge, 10, 'ab', item.chars))).toBeLessThanOrEqual(
      JUDGE_ITEM_TOKENS
    )
    const items = Array.from({ length: 14 }, () => item)
    const built = buildJudgePrompt(items, 'ab')
    const total = estimateTokens(built.messages.map((message) => message.content).join('\n'))
    expect(total).toBeLessThanOrEqual(inputBudget('judge'))
    expect(built.sent).toBeLessThanOrEqual(JUDGE_PAIRS_MAX)
    expect(estimateTokens(built.messages[1]?.content ?? '')).toBeLessThanOrEqual(
      JUDGE_ITEMS_TOKENS + 10
    )
    // The between line holds two hints at most.
    expect(built.messages[1]?.content).not.toContain('A third')
    // A short pair keeps its whole context.
    expect(judgeItem(eyes).chars).toBe(JUDGE_CONTEXT_CHARS[0])
  })

  it('batches at most 10 pairs and 2,500 tokens of pairs, in the order given', () => {
    const short = Array.from({ length: 23 }, (_, i) => ({ id: i, item: judgeItem(eyes) }))
    const batches = judgeBatches(short)
    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 3])
    expect(batches.flat().map((each) => each.id)).toEqual(short.map((each) => each.id))
    const long = `${'word '.repeat(400)}Mara's eyes were grey.`
    const wide = judgeItem({
      ...eyes,
      a: side({ text: long }),
      b: side({ text: long, at: { order: 1, para: 0 } })
    })
    const heavy = judgeBatches(Array.from({ length: 12 }, (_, i) => ({ id: i, item: wide })))
    for (const batch of heavy) {
      expect(batch.length).toBeLessThanOrEqual(JUDGE_PAIRS_MAX)
      const tokens = batch.reduce(
        (sum, each) =>
          sum + estimateTokens(`${judgeItemText(each.item.pair, 10, 'ab', each.item.chars)}\n\n`),
        0
      )
      expect(tokens).toBeLessThanOrEqual(JUDGE_ITEMS_TOKENS)
    }
  })

  it('renders the stronger check: one pair at ±3 sentences, its own reply, 90 out, under 1,000 in', () => {
    const wide: JudgePair = {
      ...eyes,
      a: side({
        text: `${'Before it. '.repeat(30)}Mara's eyes were grey. ${'After it. '.repeat(30)}`
      })
    }
    const built = buildJudgeConfirmPrompt(wide)
    expect(built.messages[0]).toEqual({ role: 'system', content: JUDGE_CONFIRM_RULES })
    expect(built.messages[1]?.content.startsWith('Pair:\n1. Mara Vell · eyes.')).toBe(true)
    expect(built.maxTokens).toBe(JUDGE_CONFIRM_MAX_TOKENS)
    expect(built.sent).toBe(1)
    const total = estimateTokens(built.messages.map((message) => message.content).join('\n'))
    expect(total).toBeLessThanOrEqual(JUDGE_CONFIRM_INPUT_TOKENS)
    // Wider than a batch item: more of the context goes.
    expect((built.messages[1]?.content ?? '').length).toBeGreaterThan(
      judgeItemText(wide, 1, 'ab').length
    )
    const huge = `${'word '.repeat(2000)}Mara's eyes were grey. ${'tail '.repeat(2000)}`
    const maxed = buildJudgeConfirmPrompt({
      ...wide,
      a: side({ text: huge }),
      b: side({ text: huge })
    })
    expect(
      estimateTokens(maxed.messages.map((message) => message.content).join('\n'))
    ).toBeLessThanOrEqual(JUDGE_CONFIRM_INPUT_TOKENS)
  })
})

describe('parseJudgeAnswer', () => {
  it('reads verdicts by number, the first for a number given twice, w only with c and cut to 8 words', () => {
    const rulings = parseJudgeAnswer(
      '{"v":[{"i":1,"r":"c","w":"grey eyes against brown in two scenes of the book"},{"i":2,"r":"ok","w":"a change"},{"i":3,"r":"u"},{"i":1,"r":"ok"}]}'
    )
    expect([...rulings]).toEqual([
      [1, { r: 'c', w: 'grey eyes against brown in two scenes of' }],
      [2, { r: 'ok', w: null }],
      [3, { r: 'u', w: null }]
    ])
  })

  it('skips an unknown verdict, reads a fenced reply, and salvages a cut-off one', () => {
    const fenced = parseJudgeAnswer('```json\n{"v":[{"i":1,"r":"maybe"},{"i":2,"r":"c"}]}\n```')
    expect([...fenced]).toEqual([[2, { r: 'c', w: null }]])
    const cut = parseJudgeAnswer('{"v":[{"i":1,"r":"c","w":"values differ"},{"i":2,"r":"o')
    expect([...cut]).toEqual([[1, { r: 'c', w: 'values differ' }]])
    expect(parseJudgeAnswer('not json').size).toBe(0)
    expect(parseJudgeAnswer('{"v":"none"}').size).toBe(0)
  })

  it('reads the stronger check: a verdict with up to 20 words, or nothing', () => {
    expect(parseJudgeConfirm('{"r":"ok","w":"the note describes the future"}')).toEqual({
      r: 'ok',
      w: 'the note describes the future'
    })
    expect(parseJudgeConfirm(`{"r":"c","w":"${'word '.repeat(30)}"}`)?.w?.split(' ')).toHaveLength(
      20
    )
    expect(parseJudgeConfirm('{"r":"maybe"}')).toBeNull()
    expect(parseJudgeConfirm('{"r":"c"')).toBeNull()
  })
})
