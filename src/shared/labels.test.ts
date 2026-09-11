import { describe, expect, it } from 'vitest'
import { levelLabel, sectionLabel, skeletonSummary } from './labels'

describe('sectionLabel', () => {
  it.each([
    ['novel', 'front', 'Front Matter'],
    ['novel', 'manuscript', 'Manuscript'],
    ['novel', 'end', 'End Matter'],
    ['epic', 'front', 'Front Matter'],
    ['epic', 'manuscript', 'Series'],
    ['epic', 'end', 'End Matter'],
    ['webnovel', 'front', 'Front Matter'],
    ['webnovel', 'manuscript', 'Volume 1'],
    ['webnovel', 'end', 'End Matter']
  ] as const)('%s / %s → %s', (format, section, expected) => {
    expect(sectionLabel(format, section)).toBe(expected)
  })
})

describe('levelLabel', () => {
  it.each([
    ['novel', 'part', 'Part'],
    ['novel', 'chapter', 'Chapter'],
    ['novel', 'scene', 'Scene'],
    ['epic', 'part', 'Part'],
    ['epic', 'chapter', 'Chapter'],
    ['epic', 'scene', 'Scene'],
    ['webnovel', 'part', 'Arc'],
    ['webnovel', 'chapter', 'Chapter'],
    ['webnovel', 'scene', 'Scene']
  ] as const)('%s / %s → %s', (format, level, expected) => {
    expect(levelLabel(format, level)).toBe(expected)
  })
})

describe('skeletonSummary', () => {
  it('describes the seeded skeleton per format', () => {
    expect(skeletonSummary('novel')).toBe('Manuscript → Part 1–2 → Chapter 1–3 → Scene 1')
    expect(skeletonSummary('epic')).toBe('Series → Part 1–2 → Chapter 1–3 → Scene 1')
    expect(skeletonSummary('webnovel')).toBe('Volume 1 → Arc 1–2 → Chapter 1–3 → Scene 1')
  })
})
