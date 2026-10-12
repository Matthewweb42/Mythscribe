import { describe, expect, it } from 'vitest'
import {
  cardDue,
  CARD_OUTPUT,
  FULL_OUTPUT_CAP,
  outputCap,
  PAGE_TOKENS,
  piecesParas,
  planPages,
  planWindows,
  WINDOW_SPLIT_TOKENS,
  type ReadPiece
} from './windows'

/** One token per word, so sizes are easy to read. */
const words = (text: string): number => text.split(/\s+/).filter(Boolean).length
const para = (n: number, label = 'w'): string =>
  Array.from({ length: n }, () => label).join(' ') + '.'
const ranges = (pieces: readonly ReadPiece[]): number[][] =>
  pieces.map((piece) => piece.paragraphs.map((part) => part.p))

const TWELVE = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}.`)

describe('planWindows (F-16.16)', () => {
  it('takes each changed paragraph ±2 and merges ranges that touch', () => {
    const naming = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(ranges(planWindows(TWELVE, [5], naming, words))).toEqual([[3, 4, 5, 6, 7]])
    expect(ranges(planWindows(TWELVE, [0, 11], naming, words))).toEqual([
      [0, 1, 2],
      [9, 10, 11]
    ])
    // 3 ±2 and 7 ±2 touch at 5: one window.
    expect(ranges(planWindows(TWELVE, [3, 7], naming, words))).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8, 9]
    ])
    expect(ranges(planWindows(TWELVE, [2, 9], naming, words))).toEqual([
      [0, 1, 2, 3, 4],
      [7, 8, 9, 10, 11]
    ])
  })

  it('extends back to the last paragraph that names a record', () => {
    expect(ranges(planWindows(TWELVE, [8], new Set([1]), words))).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    ])
    // A naming paragraph inside the window is enough; none at all leaves it as it is.
    expect(ranges(planWindows(TWELVE, [8], new Set([7]), words))).toEqual([[6, 7, 8, 9, 10]])
    expect(ranges(planWindows(TWELVE, [8], new Set(), words))).toEqual([[6, 7, 8, 9, 10]])
  })

  it('splits a window over 1,500 prose tokens at paragraph boundaries', () => {
    const big = [para(600), para(600), para(600), para(600), para(600)]
    const pieces = planWindows(big, [2], new Set([0]), words)
    expect(ranges(pieces)).toEqual([[0, 1], [2, 3], [4]])
    for (const piece of pieces) expect(piece.tokens).toBeLessThanOrEqual(WINDOW_SPLIT_TOKENS)
  })
})

describe('planPages (F-16.16)', () => {
  it('packs the scene into pages of at most 2,500 tokens', () => {
    const scene = Array.from({ length: 6 }, () => para(1000))
    const pages = planPages(scene, words)
    expect(ranges(pages)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5]
    ])
    for (const page of pages) expect(page.tokens).toBeLessThanOrEqual(PAGE_TOKENS)
  })

  it('splits a longer paragraph at sentences and never truncates it', () => {
    const sentence = `W ${Array.from({ length: 998 }, () => 'w').join(' ')}.`
    const long = [sentence, sentence, sentence].join(' ')
    const pages = planPages(['Short one.', long, 'After.'], words)
    const parts = pages.flatMap((page) => page.paragraphs.filter((part) => part.p === 1))
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.map((part) => long.slice(part.start, part.end)).join('')).toBe(long)
    for (const page of pages) expect(page.tokens).toBeLessThanOrEqual(PAGE_TOKENS)
    expect(piecesParas(pages)).toEqual(new Set([0, 1, 2]))
  })

  it('keeps one sentence longer than a page whole', () => {
    const giant = `${Array.from({ length: 3000 }, () => 'w').join(' ')}.`
    const pages = planPages([giant], words)
    expect(pages).toHaveLength(1)
    expect(pages[0]?.paragraphs[0]).toEqual({ p: 0, start: 0, end: giant.length })
  })
})

describe('cardDue (P2a-D17) and outputCap (design §2.3)', () => {
  const present = new Set(['a', 'b', 'c'])
  it('asks for a card on a full read, without one, after a card quote changed, or a quarter unread', () => {
    expect(cardDue({ cardAnchor: ['a'], full: true, present, finished: 20, unread: 1 })).toBe(true)
    expect(cardDue({ cardAnchor: null, full: false, present, finished: 20, unread: 1 })).toBe(true)
    expect(cardDue({ cardAnchor: ['a', 'z'], full: false, present, finished: 20, unread: 1 })).toBe(
      true
    )
    expect(cardDue({ cardAnchor: ['a'], full: false, present, finished: 20, unread: 5 })).toBe(true)
    expect(cardDue({ cardAnchor: ['a'], full: false, present, finished: 20, unread: 4 })).toBe(
      false
    )
  })

  it('caps a full page at 720 and a window at min(600, 120 + 0.3 × prose), plus 120 for a card', () => {
    expect(outputCap({ purpose: 'full', proseTokens: 2500, cardDue: true })).toBe(FULL_OUTPUT_CAP)
    expect(outputCap({ purpose: 'window', proseTokens: 1000, cardDue: false })).toBe(420)
    expect(outputCap({ purpose: 'window', proseTokens: 1001, cardDue: false })).toBe(421)
    expect(outputCap({ purpose: 'window', proseTokens: 5000, cardDue: false })).toBe(600)
    expect(outputCap({ purpose: 'window', proseTokens: 1000, cardDue: true })).toBe(
      420 + CARD_OUTPUT
    )
  })
})
