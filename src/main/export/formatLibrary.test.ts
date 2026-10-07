import { describe, expect, it } from 'vitest'
import { COMPILE_FORMATS_MAX, findCompileFormat, type CompileFormat } from '@shared/compileFormat'
import { createFormat, deleteFormat, saveFormat } from './formatLibrary'

const ebook = (): CompileFormat => {
  const format = findCompileFormat([], 'builtin:ebook')
  if (!format) throw new Error('no ebook')
  return format
}

describe('format library (Compile v2)', () => {
  it('duplicates a built-in under a copy name, then a library format under a chosen name', () => {
    const first = createFormat([], 'builtin:ebook', undefined, 'my:1')
    expect(first.format).toMatchObject({
      id: 'my:1',
      name: 'Ebook copy',
      sections: ebook().sections
    })
    const second = createFormat(first.library, 'my:1', 'Ann ebook', 'my:2')
    expect(second.library.map((f) => f.name)).toEqual(['Ann ebook', 'Ebook copy'])
    expect(createFormat([], 'builtin:ebook', undefined).format.id).toMatch(/^my:/)
  })

  it('refuses an unknown source, a taken name, and the cap', () => {
    const { library } = createFormat([], 'builtin:ebook', 'Mine', 'my:1')
    expect(() => createFormat(library, 'nope', 'X')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    expect(() => createFormat(library, 'builtin:ebook', ' mine ')).toThrowError(
      expect.objectContaining({ code: 'ALREADY_EXISTS' })
    )
    const full = Array.from({ length: COMPILE_FORMATS_MAX }, (_, i) => ({
      ...ebook(),
      id: `my:${i}`,
      name: `F${i}`
    }))
    expect(() => createFormat(full, 'builtin:ebook', 'One more')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' })
    )
  })

  it('saves a renamed, customised format and refuses built-ins, unknown ids, and taken names', () => {
    let library = createFormat([], 'builtin:ebook', 'A', 'my:1').library
    library = createFormat(library, 'builtin:ebook', 'B', 'my:2').library
    const edited = { ...library[0]!, name: 'C', sceneSeparator: { kind: 'blankLine' as const } }
    const saved = saveFormat(library, edited)
    expect(saved.library.map((f) => [f.id, f.name])).toEqual([
      ['my:2', 'B'],
      ['my:1', 'C']
    ])
    expect(saved.format.sceneSeparator).toEqual({ kind: 'blankLine' })
    expect(() => saveFormat(library, ebook())).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => saveFormat(library, { ...edited, id: 'my:9' })).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
    expect(() => saveFormat(library, { ...edited, name: 'b' })).toThrowError(
      expect.objectContaining({ code: 'ALREADY_EXISTS' })
    )
  })

  it('deletes a library format and refuses built-ins and unknown ids', () => {
    const { library } = createFormat([], 'builtin:ebook', 'A', 'my:1')
    expect(deleteFormat(library, 'my:1')).toEqual([])
    expect(() => deleteFormat(library, 'builtin:ebook')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => deleteFormat(library, 'my:2')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })
})
