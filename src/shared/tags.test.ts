import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CATEGORY_COLOR,
  HEX_COLOR,
  TAG_CATEGORIES,
  TAG_CATEGORY_LABEL,
  toTagName
} from './tags'

describe('toTagName', () => {
  it.each([
    ['Dark Forest', 'dark-forest'],
    ['dark-forest', 'dark-forest'],
    ['Twin  Peaks!!', 'twin-peaks'],
    ['  --Shadow!', 'shadow'],
    ['Shadow', 'shadow'],
    ['shadow ', 'shadow'],
    ['Plot_Thread #3', 'plot-thread-3'],
    ['Élan', 'élan'],
    ['Zoë Marchetti', 'zoë-marchetti'],
    ['Zoe\u0308', 'zoë'],
    ['Straße 9', 'straße-9'],
    ['東京 タワー', '東京-タワー']
  ])('%j → %j', (input, expected) => {
    expect(toTagName(input)).toBe(expected)
  })

  it.each(['', '   ', '—', '!!!', '---'])('%j → empty', (input) => {
    expect(toTagName(input)).toBe('')
  })
})

describe('category maps', () => {
  it('give every category a label and a default hex color', () => {
    for (const category of TAG_CATEGORIES) {
      expect(TAG_CATEGORY_LABEL[category]).toMatch(/\S/)
      expect(DEFAULT_CATEGORY_COLOR[category]).toMatch(HEX_COLOR)
    }
  })

  it('list exactly the seven spec categories', () => {
    expect(TAG_CATEGORIES).toHaveLength(7)
    expect(Object.keys(TAG_CATEGORY_LABEL).sort()).toEqual([...TAG_CATEGORIES].sort())
    expect(Object.keys(DEFAULT_CATEGORY_COLOR).sort()).toEqual([...TAG_CATEGORIES].sort())
  })
})

describe('HEX_COLOR', () => {
  it('accepts lowercase six-digit hex only', () => {
    expect('#0d9488').toMatch(HEX_COLOR)
    expect('#0D9488').not.toMatch(HEX_COLOR)
    expect('#fff').not.toMatch(HEX_COLOR)
    expect('0d9488').not.toMatch(HEX_COLOR)
  })
})
