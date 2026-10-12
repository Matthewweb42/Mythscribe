import { describe, expect, it } from 'vitest'
import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import { outputCap } from '@shared/memory/windows'
import {
  READER_ANCHORED_TOKENS,
  READER_NEAR_TOKENS,
  READER_PROMPT_VERSION,
  READER_ROSTER_HEADING,
  READER_ROSTER_TOKENS,
  READER_RULES,
  READER_RULES_TOKENS,
  READER_SENTINEL,
  buildReaderPrompt,
  type BuildReaderPromptInput
} from './reader.v1'

const ROSTER = [
  'r1 Mara Vell (Mara; Captain Vell) · character',
  'r2 Tomas Harrow (Tomas) · character',
  'r3 the Quay · place',
  'r1 +Ry'
]

const SCENE = [
  "Mara's eyes were grey. She walked to the quay.",
  'Tomas was already there, coiling rope.',
  '"You are late," he said.'
]

const firstRead: BuildReaderPromptInput = {
  roster: ROSTER,
  position: 'Scene 1.1 “The Quay”, the whole scene',
  typed: 'POV r1 · place r3 · year 1811',
  card: null,
  near: [],
  anchored: [],
  paragraphs: SCENE.map((text, p) => ({ p, text })),
  cardDue: true,
  maxTokens: outputCap({ purpose: 'full', proseTokens: 40, cardDue: true })
}

const windowRead: BuildReaderPromptInput = {
  ...firstRead,
  position: 'Scene 1.1 “The Quay”, the changed paragraphs',
  card: 'Mara meets Tomas on the quay at dawn. · where the quay · POV r1',
  near: ['r1 eyes “grey” · hair “red”', 'r2 role “harbourmaster”'],
  anchored: ['c1 r1 eyes “grey” ¶0', 'c2 r1 location “the quay” ¶0, re-checking'],
  paragraphs: SCENE.slice(0, 2).map((text, p) => ({ p, text })),
  cardDue: false,
  maxTokens: outputCap({ purpose: 'window', proseTokens: 25, cardDue: false })
}

const text = (messages: { content: string }[]): string => messages.map((m) => m.content).join('\n')

describe('reader.v1 prompt (F-16.17)', () => {
  it('matches the golden messages for a first read and a window read', () => {
    const first = buildReaderPrompt(firstRead)
    expect(first.version).toBe(READER_PROMPT_VERSION)
    expect(first.messages).toMatchSnapshot()
    expect(first.maxTokens).toBe(720)
    const window = buildReaderPrompt(windowRead)
    expect(window.messages).toMatchSnapshot()
    expect(window.maxTokens).toBe(outputCap({ purpose: 'window', proseTokens: 25, cardDue: false }))
  })

  it('asks a card-due window for the card, at the window cap plus 120', () => {
    const due = buildReaderPrompt({
      ...windowRead,
      cardDue: true,
      maxTokens: outputCap({ purpose: 'window', proseTokens: 25, cardDue: true })
    })
    expect(due.messages.at(-1)?.content.endsWith('Card: yes')).toBe(true)
    expect(due.maxTokens).toBe(
      outputCap({ purpose: 'window', proseTokens: 25, cardDue: false }) + 120
    )
    expect(buildReaderPrompt(windowRead).messages.at(-1)?.content.endsWith('Card: no')).toBe(true)
  })

  it('orders rules, roster, then the tail, and opens with the sentinel', () => {
    const [system, user] = buildReaderPrompt(windowRead).messages
    expect(system?.role).toBe('system')
    expect(system?.content.startsWith(READER_SENTINEL)).toBe(true)
    expect(system?.content.startsWith(READER_RULES)).toBe(true)
    expect(system?.content.indexOf(READER_ROSTER_HEADING)).toBeGreaterThan(READER_RULES.length - 1)
    expect(system?.content.endsWith(ROSTER.join('\n'))).toBe(true)
    expect(user?.role).toBe('user')
    const tail = user?.content ?? ''
    const order = ['Scene 1.1', 'Typed:', 'Card now:', 'Known about', 'Facts listed', 'Paragraphs:']
    const at = order.map((marker) => tail.indexOf(marker))
    expect(at.every((index) => index >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(tail).toContain('¶1 Tomas was already there, coiling rope.')
  })

  it('keeps the rules under 900 tokens and a full roster under 1,600; the system turn is the same for every scene', () => {
    expect(estimateTokens(READER_RULES)).toBeLessThanOrEqual(READER_RULES_TOKENS)
    const roster = Array.from(
      { length: 120 },
      (_, i) => `r${i + 1} Character Number ${i} · character`
    )
    expect(estimateTokens(roster.join('\n'))).toBeLessThanOrEqual(READER_ROSTER_TOKENS)
    const a = buildReaderPrompt(firstRead).messages[0]
    const b = buildReaderPrompt(windowRead).messages[0]
    expect(a).toEqual(b)
  })

  it('caps the near and anchored blocks, and trims near first, then anchored, over the budget', () => {
    const many = Array.from(
      { length: 200 },
      (_, i) => `r${i} eyes “grey” · hair “red” · role “clerk”`
    )
    const capped = buildReaderPrompt({ ...windowRead, near: many, anchored: many })
    const tail = capped.messages.at(-1)?.content ?? ''
    const block = (heading: string, next: string): string =>
      tail.slice(tail.indexOf(heading), tail.indexOf(next))
    expect(estimateTokens(block('Known about', 'Facts listed'))).toBeLessThanOrEqual(
      READER_NEAR_TOKENS + 20
    )
    expect(estimateTokens(block('Facts listed', 'Paragraphs:'))).toBeLessThanOrEqual(
      READER_ANCHORED_TOKENS + 20
    )
    // A page at the 2,500-token cap with a long roster: still within the input budget, near first.
    const page = Array.from({ length: 25 }, (_, p) => ({ p, text: 'word '.repeat(80).trim() }))
    const roster = Array.from(
      { length: 160 },
      (_, i) => `r${i + 1} Character Number ${i} · character`
    )
    const worst = buildReaderPrompt({
      ...windowRead,
      roster,
      near: many,
      anchored: many,
      paragraphs: page
    })
    expect(estimateTokens(text(worst.messages))).toBeLessThanOrEqual(inputBudget('reader'))
    expect(worst.trimmed.near).toBeGreaterThan(0)
    expect(worst.maxTokens).toBeLessThanOrEqual(outputBudget('reader'))
  })
})
