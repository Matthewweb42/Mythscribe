import { describe, expect, it } from 'vitest'
import { titleTagProposal } from './titleTags'

const scene = (title: string): { title: string; hierarchyLevel: 'scene' } => ({
  title,
  hierarchyLevel: 'scene'
})
const none: ReadonlySet<string> = new Set()

describe('titleTagProposal (F-2.8)', () => {
  it('offers the kebab-cased title of a part, chapter, or scene', () => {
    expect(titleTagProposal(scene('Fallen Creator'), none, [])).toBe('fallen-creator')
    expect(titleTagProposal({ title: 'The Long Night', hierarchyLevel: 'chapter' }, none, [])).toBe(
      'the-long-night'
    )
    expect(titleTagProposal({ title: 'Zoë’s Return', hierarchyLevel: 'part' }, none, [])).toBe(
      'zoë-s-return'
    )
  })

  it('never offers for a node without a hierarchy level', () => {
    expect(titleTagProposal({ title: 'Fallen Creator', hierarchyLevel: null }, none, [])).toBeNull()
  })

  it('never offers a title that kebab-cases to nothing', () => {
    expect(titleTagProposal(scene('  —  '), none, [])).toBeNull()
    expect(titleTagProposal(scene(''), none, [])).toBeNull()
  })

  it('never offers the titles the tree generates, in any format', () => {
    for (const title of ['Untitled Scene', 'Untitled Chapter', 'Untitled Part', 'Untitled Arc']) {
      expect(titleTagProposal(scene(title), none, [])).toBeNull()
    }
    expect(titleTagProposal(scene('Untitled document'), none, [])).toBeNull()
  })

  it('never offers a level word plus a number or roman numeral', () => {
    for (const title of ['Scene 1', 'Chapter 12', 'Part 2', 'Arc 1', 'Part III', 'chapter iv']) {
      expect(titleTagProposal(scene(title), none, [])).toBeNull()
    }
    // A level word with a real name after it is a title the author chose.
    expect(titleTagProposal(scene('Chapter Zero'), none, [])).toBe('chapter-zero')
    expect(titleTagProposal(scene('Scene 1 Revisited'), none, [])).toBe('scene-1-revisited')
  })

  it('never offers a name the bank holds or the author dismissed', () => {
    expect(titleTagProposal(scene('Fallen Creator'), new Set(['fallen-creator']), [])).toBeNull()
    expect(titleTagProposal(scene('Fallen Creator'), none, ['fallen-creator'])).toBeNull()
    expect(titleTagProposal(scene('Fallen Creator'), new Set(['fallen']), ['creator'])).toBe(
      'fallen-creator'
    )
  })
})
