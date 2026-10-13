import { describe, expect, it } from 'vitest'
import {
  datedScene,
  labelLine,
  nameSpans,
  noteKinValue,
  noteSentences,
  noteValue,
  pairsWith,
  type NoteParagraph,
  type NoteRecord
} from './noteValues'

const orrin: NoteRecord = {
  id: 'orrin',
  names: [
    { text: 'Orrin Vale', caseRule: 'auto', shared: false },
    { text: 'Orrin', caseRule: 'auto', shared: false },
    { text: 'Vale', caseRule: 'auto', shared: true }
  ]
}
const captain: NoteRecord = {
  id: 'captain',
  names: [{ text: 'the Captain', caseRule: 'exact', shared: false }]
}

const pinned = (ownerId: string, text: string, para = 0): NoteParagraph => ({
  ownerKind: 'record',
  ownerId,
  page: 'pinned',
  para,
  text
})
const research = (text: string): NoteParagraph => ({
  ownerKind: 'research',
  ownerId: 'doc1',
  page: null,
  para: 3,
  text
})

const one = (note: NoteParagraph, index = 0) => {
  const sentence = noteSentences(note)[index]
  if (sentence === undefined) throw new Error('no sentence')
  return sentence
}

describe('note sentences (F-16.27, P4-D8)', () => {
  it('splits a paragraph into its sentences, keeping where each sits', () => {
    const sentences = noteSentences(research('Orrin was born in 1790. His eyes are green.'))
    expect(sentences.map((each) => [each.sentence, each.text])).toEqual([
      [0, 'Orrin was born in 1790.'],
      [1, 'His eyes are green.']
    ])
  })

  it('finds a record’s names as whole words, possessives counted, a shared name never', () => {
    expect(nameSpans("Orrin Vale's eyes", orrin.names)).toEqual([{ start: 0, end: 12 }])
    expect(nameSpans('Orrinson came', orrin.names)).toEqual([])
    expect(nameSpans('Old Vale nodded', orrin.names)).toEqual([])
    // A name kept in exact case: "the captain" is not the Captain.
    expect(nameSpans('the captain of the guard', captain.names)).toEqual([])
    expect(nameSpans("the Captain's sister", captain.names)).toHaveLength(1)
    // A sentence's first word may differ in its first letter only.
    expect(nameSpans('The Captain came in.', captain.names)).toEqual([{ start: 0, end: 11 }])
  })

  it('reads Label: value lines, dated or not', () => {
    expect(labelLine('Eyes: green')).toEqual({ label: 'eyes', scene: null, value: 'green' })
    expect(labelLine("Location (from 19.1 'The portrait'): Vellmouth")).toEqual({
      label: 'location',
      scene: "19.1 'The portrait'",
      value: 'Vellmouth'
    })
    expect(labelLine('He came home late.')).toBeNull()
  })
})

describe('pairsWith (P4-D8)', () => {
  it('pairs a sentence on the record’s own Pinned page holding a slot cue or the slot’s label', () => {
    expect(pairsWith(one(pinned('orrin', 'Eyes: green')), orrin, 'eyes')).toBe(true)
    expect(pairsWith(one(pinned('orrin', 'Born: 1790')), orrin, 'born')).toBe(true)
    expect(pairsWith(one(pinned('orrin', 'Born: 1790')), orrin, 'eyes')).toBe(false)
  })

  it('pairs a sentence elsewhere only when it names the record', () => {
    expect(pairsWith(one(research('Orrin has green eyes.')), orrin, 'eyes')).toBe(true)
    expect(pairsWith(one(research('Her eyes are green.')), orrin, 'eyes')).toBe(false)
    expect(pairsWith(one(pinned('mara', 'Eyes: green')), orrin, 'eyes')).toBe(false)
  })

  it('pairs a kinship sentence by a kin word', () => {
    expect(pairsWith(one(research('Orrin is the Captain’s brother.')), orrin, 'kinship')).toBe(true)
    expect(pairsWith(one(research('Orrin is the Captain’s friend.')), orrin, 'kinship')).toBe(false)
  })
})

describe('noteValue (P4-D8)', () => {
  it('reads a Label: value line, with its dated scene', () => {
    expect(noteValue(one(pinned('orrin', 'Eyes: green')), orrin, 'eyes')).toEqual({
      value: 'green',
      scene: null
    })
    expect(
      noteValue(
        one(pinned('orrin', "Location (from 12.1 'The quay'): the harbour")),
        orrin,
        'location'
      )
    ).toEqual({ value: 'the harbour', scene: "12.1 'The quay'" })
  })

  it('reads a plain sentence by the slot’s literal pattern, names masked', () => {
    expect(noteValue(one(research("Orrin's eyes are green.")), orrin, 'eyes')).toEqual({
      value: 'green',
      scene: null
    })
    expect(noteValue(one(research('Orrin Vale was born in 1790.')), orrin, 'born')).toEqual({
      value: 'in 1790',
      scene: null
    })
  })

  it('reads nothing it cannot parse, and nothing a marker undoes', () => {
    expect(noteValue(one(research('Orrin may have green eyes.')), orrin, 'eyes')).toBeNull()
    expect(noteValue(one(research("Orrin's eyes are not green.")), orrin, 'eyes')).toBeNull()
    expect(noteValue(one(pinned('orrin', 'Dies at Waterloo, 1815.')), orrin, 'alive')).toBeNull()
  })
})

describe('noteKinValue (P4-D8: the object named, the kin word read)', () => {
  it('reads the kin word after the object’s possessive, or before "of" the object', () => {
    expect(noteKinValue(one(research("Orrin is the Captain's brother.")), orrin, captain)).toBe(
      'brother'
    )
    expect(noteKinValue(one(research('Orrin, brother of the Captain.')), orrin, captain)).toBe(
      'brother'
    )
  })

  it('never reads a kin word about the other person, and needs the object named', () => {
    expect(
      noteKinValue(one(research("The Captain is Orrin's brother.")), orrin, captain)
    ).toBeNull()
    expect(noteKinValue(one(research('Orrin is a brother.')), orrin, captain)).toBeNull()
  })
})

describe('datedScene (P4-D8)', () => {
  const scenes = [
    { nodeId: 'a', ref: '12.1', title: 'The quay' },
    { nodeId: 'b', ref: '12.2', title: 'The storm' },
    { nodeId: 'c', ref: '13.1', title: 'The storm' }
  ]

  it('names a scene by its title, then by its number', () => {
    expect(datedScene("12.1 'The quay'", scenes)).toBe('a')
    expect(datedScene("12.2 'The storm'", scenes)).toBe('b')
    expect(datedScene("'The quay'", scenes)).toBe('a')
    expect(datedScene('13.1', scenes)).toBe('c')
  })

  it('names none when it is ambiguous or gone', () => {
    expect(datedScene("'The storm'", scenes)).toBeNull()
    expect(datedScene("19.1 'The portrait'", scenes)).toBeNull()
  })
})
