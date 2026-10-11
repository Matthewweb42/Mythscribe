import { describe, expect, it } from 'vitest'
import { DEFAULT_CATEGORY_COLOR } from './tags'
import { LABEL_DEFAULT_COLOUR, labelNameKey, labelSteerLines } from './storyLabels'

describe('labels (F-16.7)', () => {
  it('keeps the tag colours for tone and content', () => {
    expect(LABEL_DEFAULT_COLOUR.tone).toBe(DEFAULT_CATEGORY_COLOR.tone)
    expect(LABEL_DEFAULT_COLOUR.content).toBe(DEFAULT_CATEGORY_COLOR.content)
  })

  it('compares names case-insensitively, spaces folded', () => {
    expect(labelNameKey('  Needs   Research ')).toBe(labelNameKey('needs research'))
  })

  it('steers by tone, content and theme labels in that order, never by custom ones', () => {
    expect(
      labelSteerLines([
        { name: 'needs research', kind: 'custom' },
        { name: 'grief', kind: 'theme' },
        { name: 'wry', kind: 'tone' },
        { name: 'no gore', kind: 'content' },
        { name: 'tense', kind: 'tone' }
      ])
    ).toEqual([
      'Tone (write in it): wry, tense',
      'Content (keep to it): no gore',
      'Themes (keep in view): grief'
    ])
    expect(labelSteerLines([{ name: 'needs research', kind: 'custom' }])).toEqual([])
  })
})
