import { describe, expect, it } from 'vitest'
import { clipAtWord, flatText } from './textClip'

describe('textClip', () => {
  it('flattens white space', () => {
    expect(flatText('  a\n\tb   c ')).toBe('a b c')
  })

  it('cuts at a word past half the limit, else mid-word, with an ellipsis', () => {
    expect(clipAtWord('short  text', 20)).toBe('short text')
    expect(clipAtWord('the quick brown fox jumps', 12)).toBe('the quick…')
    expect(clipAtWord('abcdefghijklmnop qrs', 10)).toBe('abcdefghij…')
  })
})
