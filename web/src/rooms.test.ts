import { describe, expect, it } from 'vitest'
import { cleanNotes, newToken, validToken } from './rooms'

describe('reader link tokens', () => {
  it('are 32 URL-safe characters and differ each time', () => {
    const a = newToken(), b = newToken()
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(validToken(a)).toBe(true)
    expect(a).not.toBe(b)
  })
  it('refuses anything else', () => {
    expect(validToken('short')).toBe(false)
    expect(validToken('x'.repeat(31) + '/')).toBe(false)
    expect(validToken('x'.repeat(33))).toBe(false)
  })
})

describe('cleanNotes', () => {
  it('keeps the reading page note shape and trims long fields', () => {
    const out = cleanNotes([{ i: 3, lid: 'L1', id: 'n1', scope: 'chapter', quote: 'q'.repeat(2000), text: 'Nice', kind: 'q', chTitle: 'One', at: 5, extra: 'dropped' }])
    expect(out).toEqual([{ i: 3, lid: 'L1', id: 'n1', scope: 'chapter', quote: 'q'.repeat(1200), text: 'Nice', kind: 'q', chTitle: 'One', at: 5 }])
  })
  it('defaults odd values instead of storing them', () => {
    const [n] = cleanNotes([{ scope: 'everything', i: 1.5, at: 'soon', lid: 7 }]) as Record<string, unknown>[]
    expect(n).toMatchObject({ scope: 'scene', i: null, at: 0, lid: '' })
  })
  it('refuses what is not a list of notes', () => {
    expect(cleanNotes('x')).toBeTypeOf('string')
    expect(cleanNotes([1])).toBeTypeOf('string')
    expect(cleanNotes(Array.from({ length: 2001 }, () => ({})))).toBeTypeOf('string')
  })
})
