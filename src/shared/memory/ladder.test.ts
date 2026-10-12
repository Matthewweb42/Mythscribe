import { describe, expect, it } from 'vitest'
import {
  nameInSentence,
  pronounPerson,
  resolveSubject,
  unknownName,
  type LadderSentence
} from './ladder'
import type { LiteralName } from './literal'

const name = (recordId: string, start: number, end: number, ambiguous = false): LiteralName => ({
  recordId,
  kind: 'character',
  start,
  end,
  ambiguous
})

const sentence = (position: number, text: string, names: LiteralName[] = []): LadderSentence => ({
  position,
  text,
  names
})

const base = {
  recordId: 'mara',
  voice: 'narration' as const,
  speakerId: null,
  before: [],
  typedPov: null,
  isCharacter: () => true
}

describe('the ladder’s subject step (F-16.17)', () => {
  it('tells first person from third', () => {
    expect(pronounPerson('I was born in the north')).toBe('first')
    expect(pronounPerson('My father was a clergyman')).toBe('first')
    expect(pronounPerson('She walked to the quay')).toBe('third')
    expect(pronounPerson('the beautiful expression of her dark eyes')).toBe('third')
    expect(pronounPerson('A single man of large fortune')).toBeNull()
    // "Theirs" and "There" are not one another.
    expect(pronounPerson('There was a ship')).toBeNull()
  })

  it('finds a new name in its sentence as written, on word boundaries', () => {
    expect(nameInSentence('Hesk was a smuggler.', 'Hesk')).toEqual({ start: 0, end: 4 })
    expect(nameInSentence('Heskith was a smuggler.', 'Hesk')).toBeNull()
    expect(nameInSentence('They saw hesk.', 'Hesk')).toBeNull()
    expect(nameInSentence('Old  Hesk Varn left.', 'Hesk Varn')).toEqual({ start: 5, end: 14 })
  })

  it('pins a fact to the record its sentence names', () => {
    expect(
      resolveSubject({
        ...base,
        quote: [sentence(1, "Mara's eyes were grey.", [name('mara', 0, 4)])]
      })
    ).toEqual({ kind: 'named', text: 'Mara' })
  })

  it('makes a shared alias wait on its owners', () => {
    const text = "Harrow's temper was short."
    expect(
      resolveSubject({
        ...base,
        recordId: 'mr',
        quote: [sentence(1, text, [name('mrs', 0, 6, true), name('mr', 0, 6, true)])]
      })
    ).toEqual({ kind: 'shared', candidates: ['mr', 'mrs'], text: 'Harrow' })
  })

  it('sends a pronoun or a description to the checker with every character named in reach', () => {
    const before = [
      sentence(2, 'The two women sat by the window.'),
      sentence(1, 'Clara and Lise came in.', [name('clara', 0, 5), name('lise', 10, 14)])
    ]
    expect(
      resolveSubject({
        ...base,
        recordId: 'clara',
        before,
        quote: [sentence(3, 'She had green eyes.')]
      })
    ).toEqual({
      kind: 'antecedent',
      candidates: ['clara', 'lise'],
      naming: 1,
      namedAt: { clara: 1, lise: 1 },
      unnamed: null
    })
    // A description with no pronoun goes the same way.
    expect(
      resolveSubject({
        ...base,
        recordId: 'ashby',
        before: [
          sentence(1, 'His name is Ashby.', [name('ashby', 12, 17)]),
          sentence(0, 'Mara met him.', [name('mara', 0, 4)])
        ],
        quote: [sentence(2, 'A single man of large fortune.')]
      })
    ).toEqual({
      kind: 'antecedent',
      candidates: ['ashby', 'mara'],
      naming: 0,
      namedAt: { ashby: 1, mara: 0 },
      unnamed: null
    })
    // No one named within reach: refused.
    expect(resolveSubject({ ...base, quote: [sentence(0, 'She walked to the quay.')] })).toEqual({
      kind: 'none'
    })
  })

  it('offers the women named before a man named last, so a forced choice cannot happen', () => {
    // "Clara and Lise sat by the window. Tomas brought the tea. She had green eyes."
    expect(
      resolveSubject({
        ...base,
        recordId: 'clara',
        before: [
          sentence(1, 'Tomas brought the tea.', [name('tomas', 0, 5)]),
          sentence(0, 'Clara and Lise sat by the window.', [
            name('clara', 0, 5),
            name('lise', 10, 14)
          ])
        ],
        quote: [sentence(2, 'She had green eyes.')]
      })
    ).toEqual({
      kind: 'antecedent',
      candidates: ['tomas', 'clara', 'lise'],
      naming: 0,
      namedAt: { tomas: 1, clara: 0, lise: 0 },
      unnamed: null
    })
  })

  it('marks a proposed record nothing in reach names, for a role the text gives', () => {
    // "Mr. Harrow … his wife … She was a woman of mean understanding."
    expect(
      resolveSubject({
        ...base,
        recordId: 'mrs',
        before: [
          sentence(1, 'Her mind was less difficult to develop.'),
          sentence(0, 'Mr. Harrow could not make his wife understand him.', [name('mr', 0, 10)])
        ],
        quote: [sentence(2, 'She was a woman of mean understanding.')]
      })
    ).toEqual({
      kind: 'antecedent',
      candidates: ['mr', 'mrs'],
      naming: 0,
      namedAt: { mr: 0 },
      unnamed: 'mrs'
    })
  })

  it('refuses a sentence that names someone the scan does not know and points to nobody', () => {
    const before = [sentence(0, 'Rynna Falsire came in.', [name('rynna', 0, 13)])]
    expect(
      resolveSubject({
        ...base,
        recordId: 'rynna',
        before,
        quote: [sentence(1, 'Jem Falsire had green eyes.')]
      })
    ).toEqual({ kind: 'none' })
    expect(unknownName(sentence(1, 'Jem Falsire had green eyes.'))).toBe(true)
    expect(unknownName(sentence(1, 'They met Hesk at the quay.'))).toBe(true)
    // A capitalised word opening a sentence may be any word; a known name is no unknown one.
    expect(unknownName(sentence(1, 'Hope filled the room.'))).toBe(false)
    expect(unknownName(sentence(1, 'They met Mara.', [name('mara', 9, 13)]))).toBe(false)
    // A pronoun still points back: the unknown name is the checker's to weigh.
    expect(
      resolveSubject({
        ...base,
        recordId: 'rynna',
        before,
        quote: [sentence(1, 'She looked at Jem Falsire.')]
      })
    ).toMatchObject({ kind: 'antecedent', candidates: ['rynna'] })
  })

  it('pins first person to a speaker, or to the typed POV, and to no one else', () => {
    const line = [sentence(0, '"I was born in Elsmere," he said.')]
    expect(
      resolveSubject({
        ...base,
        recordId: 'tomas',
        voice: 'dialogue',
        speakerId: 'tomas',
        quote: line
      })
    ).toEqual({ kind: 'firstPerson', via: 'speaker', recordId: 'tomas' })
    expect(resolveSubject({ ...base, voice: 'dialogue', speakerId: 'tomas', quote: line })).toEqual(
      { kind: 'none' }
    )
    const told = [sentence(0, 'I was born in the north.')]
    expect(resolveSubject({ ...base, typedPov: 'mara', quote: told })).toEqual({
      kind: 'firstPerson',
      via: 'pov',
      recordId: 'mara'
    })
    expect(resolveSubject({ ...base, typedPov: 'tomas', quote: told })).toEqual({ kind: 'none' })
  })
})
