import { describe, expect, it } from 'vitest'
import { NOT_CANON_ATTR } from './pageMarks'
import {
  datedLine,
  FILED_BY_AI_HEADING,
  labelFromTag,
  pageFromLines,
  pinnedFromFields,
  pinnedPage,
  recordFromTag,
  sceneReference
} from './switchoverMapping'

describe('the switch-over mapping (F-16.15, plan P1 §6.2)', () => {
  it('makes records of name and plot-thread tags, and labels of the rest', () => {
    expect(
      recordFromTag({ name: 'mara-vell', category: 'character', aliases: [' Mara ', ''] })
    ).toEqual({ name: 'Mara Vell', categoryId: 'character', aliases: ['Mara'] })
    expect(recordFromTag({ name: 'harbour', category: 'setting', aliases: [] })?.categoryId).toBe(
      'setting'
    )
    expect(
      recordFromTag({ name: 'tide-guild', category: 'worldBuilding', aliases: [] })?.categoryId
    ).toBe('world')
    expect(
      recordFromTag({ name: 'the-mill', category: 'plotThread', aliases: [] })?.categoryId
    ).toBe('thread')
    expect(recordFromTag({ name: 'grim', category: 'tone', aliases: [] })).toBeNull()

    expect(labelFromTag({ name: 'needs-research', category: 'custom', color: '#ABCDEF' })).toEqual({
      name: 'needs research',
      kind: 'custom',
      colour: '#abcdef'
    })
    expect(labelFromTag({ name: 'grim', category: 'tone', color: 'teal' })).toEqual({
      name: 'grim',
      kind: 'tone',
      colour: '#2563eb'
    })
    expect(labelFromTag({ name: 'mara', category: 'character', color: '#dc2626' })).toBeNull()
  })

  it('reads filled fields as Label: value lines, the template first, a lost field by its id', () => {
    const defs = [
      { id: 'age', label: 'Age', multiline: false },
      { id: 'notes', label: 'Notes', multiline: true }
    ]
    expect(
      pinnedFromFields(defs, { notes: 'First.\n\nSecond.', age: '35', old: 'kept', empty: ' ' })
    ).toEqual(['Age: 35', 'Notes: First.', 'Second.', 'old: kept'])
  })

  it('dates a line at its scene', () => {
    expect(datedLine('Age', sceneReference('12.1', 'The quay'), '36')).toEqual([
      "Age (from 12.1 'The quay'): 36"
    ])
    expect(datedLine('Age', null, '36')).toEqual(['Age: 36'])
  })

  it('builds Pinned with the AI block last, every line of it Not canon', () => {
    expect(pinnedPage([], [])).toBeNull()
    expect(pinnedPage([{ text: 'Age: 35' }], ['Eyes: grey'])).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Age: 35' }] },
        {
          type: 'heading',
          attrs: { level: 3, [NOT_CANON_ATTR]: true },
          content: [{ type: 'text', text: FILED_BY_AI_HEADING }]
        },
        {
          type: 'paragraph',
          attrs: { [NOT_CANON_ATTR]: true },
          content: [{ type: 'text', text: 'Eyes: grey' }]
        }
      ]
    })
  })

  it('keeps single line breaks as hard breaks', () => {
    expect(pageFromLines([{ text: 'One\nTwo' }])).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'One' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Two' }
          ]
        }
      ]
    })
  })
})
