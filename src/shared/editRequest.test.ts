import { describe, expect, it } from 'vitest'
import { EDIT_PASS_INSTRUCTION_MAX, presetInstruction } from './editPass'
import {
  choiceForPass,
  choicePass,
  EDIT_ASK_CHOICES,
  EDIT_CHOICE_LABEL,
  EditTurn,
  findChapter,
  targetPhrase
} from './editRequest'

describe('edit request choices (F-5.26)', () => {
  it('asks with the five quick picks the author chose, in order', () => {
    expect(EDIT_ASK_CHOICES.map((c) => EDIT_CHOICE_LABEL[c])).toEqual([
      'Tighten prose',
      'Pacing & structure',
      'Dialogue',
      'Proofread',
      "Editor's notes"
    ])
  })

  it('maps each choice to its pass and instruction', () => {
    expect(choicePass('line', null)).toEqual({ type: 'line', instruction: null })
    expect(choicePass('developmental', 'ignored')).toEqual({
      type: 'developmental',
      instruction: null
    })
    expect(choicePass('proofread', null)).toEqual({ type: 'proofread', instruction: null })
    expect(choicePass('critique', null)).toBeNull()
    expect(choicePass('dialogue', null)).toEqual({
      type: 'custom',
      instruction: presetInstruction('dialogue', 0, 0)
    })
    expect(choicePass('dialogue', 'Make Kael terser.')?.instruction).toBe(
      `${presetInstruction('dialogue', 0, 0)} Make Kael terser.`
    )
    expect(choicePass('custom', null)).toBeNull()
    expect(
      choicePass('custom', 'x'.repeat(EDIT_PASS_INSTRUCTION_MAX + 5))?.instruction
    ).toHaveLength(EDIT_PASS_INSTRUCTION_MAX)
  })

  it('reads a router pass as a choice, and ask as none', () => {
    expect(choiceForPass('ask')).toBeNull()
    expect(choiceForPass('dialogue')).toBe('dialogue')
    expect(choiceForPass('copy')).toBe('copy')
  })
})

describe('findChapter (F-5.26)', () => {
  const chapters = [
    { id: 'c1', title: 'Chapter 1' },
    { id: 'c2', title: 'The Crossing' },
    { id: 'c3', title: 'Chapter 3' }
  ]

  it('finds a chapter by its title, any case, with or without "chapter"', () => {
    expect(findChapter('chapter 3', chapters)).toBe('c3')
    expect(findChapter('the crossing.', chapters)).toBe('c2')
    expect(findChapter('Chapter The Crossing', chapters)).toBe('c2')
  })

  it('reads a number, in digits or words, as the chapter’s place in the book', () => {
    expect(findChapter('2', chapters)).toBe('c2')
    expect(findChapter('Chapter two', chapters)).toBe('c2')
    expect(findChapter('chapter 9', chapters)).toBeNull()
    expect(findChapter('the storm', chapters)).toBeNull()
    expect(findChapter('  ', chapters)).toBeNull()
  })
})

describe('the edit turn (F-5.26)', () => {
  it('names what the pass covers', () => {
    const base = { title: 'The ferry', excerpt: null }
    expect(targetPhrase({ ...base, kind: 'scene', nodeIds: ['s'] })).toBe('“The ferry”')
    expect(targetPhrase({ ...base, kind: 'selection', nodeIds: ['s'], excerpt: 'x' })).toBe(
      'the selection in “The ferry”'
    )
    expect(targetPhrase({ ...base, kind: 'chapter', nodeIds: ['a', 'b'] })).toBe(
      'the 2 scenes of “The ferry”'
    )
  })

  it('refuses a turn with no choice or no scene', () => {
    const turn = {
      target: { kind: 'scene', nodeIds: ['s'], title: 'S', excerpt: null },
      choices: ['line'],
      instruction: null,
      picked: null,
      passId: null
    }
    expect(EditTurn.safeParse(turn).success).toBe(true)
    expect(EditTurn.safeParse({ ...turn, choices: [] }).success).toBe(false)
    expect(EditTurn.safeParse({ ...turn, target: { ...turn.target, nodeIds: [] } }).success).toBe(
      false
    )
  })
})
