import { describe, expect, it } from 'vitest'
import { parsePush, validPath } from './sync'

describe('validPath', () => {
  it('takes Desk document paths', () => {
    expect(validPath('books/b1')).toBe(true)
    expect(validPath('books/b1/nodes/n_7')).toBe(true)
    expect(validPath('meta/prefs')).toBe(true)
  })
  it('refuses collections, empty segments and dot segments', () => {
    expect(validPath('books')).toBe(false)
    expect(validPath('books//b1')).toBe(false)
    expect(validPath('books/..')).toBe(false)
    expect(validPath('')).toBe(false)
  })
})

describe('parsePush', () => {
  it('takes writes and deletes', () => {
    expect(parsePush([{ path: 'books/b1', data: { title: 'Son of Ruin' } }, { path: 'books/b2', data: null }])).toHaveLength(2)
  })
  it('refuses non-object bodies and oversize documents', () => {
    expect(parsePush([{ path: 'books/b1', data: [1] }])).toMatch(/object or null/)
    expect(parsePush([{ path: 'books/b1', data: { t: 'x'.repeat(300 * 1024) } }])).toMatch(/256 KiB/)
  })
})
