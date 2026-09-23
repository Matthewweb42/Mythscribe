import { describe, expect, it } from 'vitest'
import type { Entity } from '@shared/ipc/contract'
import { entityFixture } from './entityFixture'
import { EXCERPT_MAX, categoriesOf, excerptOf, matchesQuery } from './entityView'

const byId = (id: string): Entity => {
  const found = entityFixture.find((e) => e.id === id)
  if (!found) throw new Error(`no fixture ${id}`)
  return found
}

describe('entityView (F-9.2)', () => {
  it('matchesQuery searches the name, every field, and the blank page, case-insensitively', () => {
    expect(matchesQuery(byId('e-mara'), '')).toBe(true)
    expect(matchesQuery(byId('e-mara'), 'mar')).toBe(true)
    expect(matchesQuery(byId('e-mara'), 'scar')).toBe(true) // appearance
    expect(matchesQuery(byId('e-aldous'), 'stars')).toBe(true) // body
    expect(matchesQuery(byId('e-mara'), 'stars')).toBe(false)
    expect(matchesQuery(byId('e-guild'), 'culture')).toBe(true) // category field
  })

  it('excerptOf takes the first filled template field, skipping the world category', () => {
    expect(excerptOf(byId('e-mara'))).toBe('27')
    expect(excerptOf(byId('e-forest'))).toBe('Wilderness')
    expect(excerptOf(byId('e-blood'))).toBe('Every spell costs the caster a memory.')
    expect(excerptOf(byId('e-guild'))).toBe('')
  })

  it('excerptOf falls back to the body and collapses whitespace', () => {
    expect(excerptOf(byId('e-aldous'))).toBe(
      'The old cartographer who taught Mara to read the stars.'
    )
    const structuredWithBody: Entity = { ...byId('e-guild'), body: '  two\n\nlines  here ' }
    expect(excerptOf(structuredWithBody)).toBe('two lines here')
    const blankWithFields: Entity = { ...byId('e-mara'), template: 'blank', body: 'page' }
    expect(excerptOf(blankWithFields)).toBe('page')
  })

  it('excerptOf cuts a long value with an ellipsis', () => {
    const long: Entity = { ...byId('e-aldous'), body: 'word '.repeat(60) }
    const excerpt = excerptOf(long)
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(excerpt.endsWith(' …')).toBe(false)
  })

  it('categoriesOf lists the distinct categories in first-seen order, trimmed, blanks skipped', () => {
    const blank: Entity = { ...byId('e-guild'), id: 'e-x', fields: { category: '  ' } }
    const dup: Entity = { ...byId('e-guild'), id: 'e-y', fields: { category: 'Culture' } }
    expect(categoriesOf([...entityFixture, blank, dup])).toEqual(['Magic system', 'Culture'])
    expect(categoriesOf([])).toEqual([])
  })
})
