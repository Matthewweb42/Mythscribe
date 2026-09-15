import { describe, expect, it } from 'vitest'
import {
  CRITIQUE_CATEGORIES,
  CRITIQUE_CATEGORY_LABEL,
  CritiqueNote,
  DEFAULT_HONESTY,
  findQuote,
  HONESTY_LABEL,
  HONESTY_LEVELS,
  normalizeForMatch,
  straightenQuotes
} from './critique'

describe('the honesty setting and the categories (F-14.8)', () => {
  it('runs from encouraging to brutal with direct as the default and a label for each', () => {
    expect(HONESTY_LEVELS).toEqual(['encouraging', 'direct', 'brutal'])
    expect(DEFAULT_HONESTY).toBe('direct')
    for (const level of HONESTY_LEVELS) expect(HONESTY_LABEL[level]).toBeTruthy()
  })

  it('labels every category', () => {
    for (const category of CRITIQUE_CATEGORIES) {
      expect(CRITIQUE_CATEGORY_LABEL[category]).toBeTruthy()
    }
  })
})

describe('CritiqueNote', () => {
  it('accepts a cited issue with a fix and praise without one', () => {
    expect(
      CritiqueNote.safeParse({
        kind: 'issue',
        category: 'filterWords',
        quote: 'She felt the cold creep in.',
        why: 'The filter word keeps the reader outside her.',
        fix: 'The cold crept in.',
        flagged: false,
        violation: null
      }).success
    ).toBe(true)
    expect(
      CritiqueNote.safeParse({
        kind: 'praise',
        category: 'pacing',
        quote: 'Then silence.',
        why: 'The fragment lands the beat.',
        fix: null,
        flagged: false,
        violation: null
      }).success
    ).toBe(true)
  })

  it('refuses an empty quote, an unknown category, or an empty fix', () => {
    const base = {
      kind: 'issue',
      category: 'clarity',
      quote: 'x',
      why: 'y',
      fix: null,
      flagged: false,
      violation: null
    }
    expect(CritiqueNote.safeParse({ ...base, quote: '' }).success).toBe(false)
    expect(CritiqueNote.safeParse({ ...base, category: 'style' }).success).toBe(false)
    expect(CritiqueNote.safeParse({ ...base, fix: '' }).success).toBe(false)
  })
})

describe('quote matching', () => {
  it('straightens curly quotes and apostrophes only', () => {
    expect(straightenQuotes('“It’s late,” she said.')).toBe('"It\'s late," she said.')
    expect(straightenQuotes('plain "text"')).toBe('plain "text"')
  })

  it('normalizes whitespace runs and line breaks to one space and trims', () => {
    expect(normalizeForMatch('  The storm\n\nbroke   at dusk. ')).toBe('The storm broke at dusk.')
  })

  it('finds a quote across a paragraph break and through curly quotes, never an empty or absent one', () => {
    const scene = 'The storm broke at dusk.\n\n“We should go,” she said.'
    expect(findQuote(scene, 'at dusk. "We should go,"')).toBe(true)
    expect(findQuote(scene, '“We should go,” she said.')).toBe(true)
    expect(findQuote(scene, '')).toBe(false)
    expect(findQuote(scene, 'We should stay')).toBe(false)
  })
})
