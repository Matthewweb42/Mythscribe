import { describe, expect, it } from 'vitest'
import { sceneRefs } from './sceneRef'

describe('sceneRefs (F-16.18)', () => {
  it('numbers chapters across parts and scenes within each chapter', () => {
    const refs = sceneRefs({
      chapters: ['c1', 'c2', 'c3'],
      scenes: [
        { id: 'a', title: 'A', chapterId: 'c1' },
        { id: 'b', title: 'B', chapterId: 'c1' },
        // c2 holds no scenes but still counts, as compile counts it.
        { id: 'c', title: 'C', chapterId: 'c3' },
        { id: 'd', title: 'D', chapterId: 'c3' }
      ]
    })
    expect(Object.fromEntries(refs)).toEqual({ a: '1.1', b: '1.2', c: '3.1', d: '3.2' })
  })

  it('gives a chapter that is a document its number, and a scene outside chapters its title or place', () => {
    const refs = sceneRefs({
      chapters: ['c1'],
      scenes: [
        { id: 'p', title: '  Prologue ', chapterId: null },
        { id: 'c1', title: 'Chapter One', chapterId: 'c1' },
        { id: 'x', title: '', chapterId: null }
      ]
    })
    expect(Object.fromEntries(refs)).toEqual({ p: 'Prologue', c1: '1', x: 'Scene 3' })
  })
})
